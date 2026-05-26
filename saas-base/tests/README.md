# Pruebas automáticas

## Cómo correr

```bash
npm test                              # toda la suite
npm test -- tests/integration/auth    # un archivo o carpeta
npm run test:clean                    # limpiar tenants test-* residuales
```

Las pruebas son de **integración**: levantan el app real (sin escuchar puerto) y hacen requests HTTP a través de `supertest`. Tocan la base de datos de desarrollo (`saas_base`) creando tenants con prefijo `test-` que se limpian al final de cada suite.

## Variables en modo test

`tests/setup.js` setea automáticamente:

- `NODE_ENV=test` — desactiva schedulers (`crons.js`) y handler de Sentry para evitar conflictos con jest.
- `BCRYPT_ROUNDS=4` — bcrypt rápido (en prod son 12).
- Rate limits altos para que tests rápidos no se auto-bloqueen.
- `REDIS_URL=""`, `STRIPE_SECRET_KEY=""`, `R2_BUCKET=""` — fallbacks síncronos, no requiere servicios externos.

## Cobertura actual (28 tests)

**`isolation.test.js`** — Aislamiento entre clientes (5 tests):
- Tenant A no ve productos de B.
- Cross-tenant attack (token A + header B) → 403.
- Tenant A no puede leer ni modificar productos de B por UUID.
- Cada tenant solo ve sus propios usuarios.

**`auth.test.js`** — Autenticación (8 tests):
- Login correcto / email mal / password mal / tenant inexistente.
- Endpoint protegido sin token / con token inválido.
- Refresh token rota / refresh con token inválido.

**`billing.test.js`** — Enforcement de planes (7 tests):
- Plan Gratis: 3er usuario bloqueado con 402.
- Plan Owner: sin límite, crea muchos usuarios.
- Trial vencido / suscripción canceled bloquean timbrar con 402.
- past_due en grace period permite timbrar.
- Endpoints `/api/billing/plans` y `/api/billing/subscription`.

**`crud.test.js`** — Operaciones básicas (8 tests):
- Productos: crear, listar, obtener por ID, actualizar, rechazo SKU duplicado.
- Business partners: crear cliente, listar.
- GET /api/tenants/current.

## Cómo agregar nuevos tests

1. Crear archivo `tests/integration/<modulo>.test.js`.
2. Importar helpers:
   ```js
   const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
   const { pool } = require('../../src/db')
   ```
3. Pattern típico:
   ```js
   describe('Mi módulo', () => {
     let client, tInfo

     beforeAll(async () => {
       tInfo = await createTenant({ label: 'mimodulo', planSlug: 'owner' })
       const sess = await loginAs({ slug: tInfo.tenant.slug, email: tInfo.email, password: tInfo.password })
       client = authedClient({ slug: tInfo.tenant.slug, token: sess.token })
     })

     afterAll(async () => {
       await cleanupTestTenants()
       await pool.end()
     })

     test('mi caso', async () => {
       const res = await client.post('/api/mi-endpoint', { foo: 'bar' })
       expect(res.status).toBe(201)
     })
   })
   ```

## Si algo se atora

```bash
npm run test:clean   # borrar tenants test-* manualmente
```

Si jest se cuelga al terminar (output "Have you considered --detectOpenHandles"), agregar `--forceExit` ya está en los scripts. Es esperable porque tenemos conexiones de pg activas que se cierran con `pool.end()` en `afterAll` — si una suite falla antes del afterAll, las conexiones quedan.
