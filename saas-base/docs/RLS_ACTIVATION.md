# Activar el doble candado (RLS) en producción

Este documento explica cómo encender el doble candado entre clientes a nivel de base de datos. La mecánica completa ya está implementada (ver migrations 099-101, `src/db/index.js`, `src/middleware/tenantResolver.js`). Por seguridad, el interruptor viene apagado.

## Por qué hacerlo

Hoy cada query del backend filtra manualmente por `tenant_id`. Si algún día se escribe una query nueva sin ese filtro, los clientes podrían ver datos de otros. Activar RLS pone un segundo candado dentro de PostgreSQL: aunque el código se olvide del filtro, la base de datos lo aplica automáticamente.

Cuando RLS está activo y el backend corre con el rol `app_runtime`:

- Queries dentro de un request → solo ven filas del tenant del request.
- Queries de un cron job o webhook (envueltas en `withBypass`) → ven todo.
- Queries sin contexto y sin bypass → **devuelven cero filas**. Esto convierte un leak silencioso en un bug visible.

## Requisitos previos

1. **Migrations 099, 100 y 101 aplicadas** (ya las corriste si ejecutaste `npm run migrate`).
2. **Tener acceso a la base de datos como `postgres`** (superuser) para poder cambiar la contraseña del nuevo rol.

## Pasos para activar

### 1. Definir contraseña del rol `app_runtime`

Conéctate a la BD como `postgres` y ejecuta:

```sql
ALTER ROLE app_runtime WITH PASSWORD 'una_password_segura_y_aleatoria';
```

Anota esa contraseña — la vas a poner en el `.env` en el siguiente paso.

### 2. Cambiar el backend para usar el rol nuevo

En el archivo `.env` del backend, cambia:

```env
DB_USER=postgres
DB_PASSWORD=tu_password_de_postgres
```

por:

```env
DB_USER=app_runtime
DB_PASSWORD=una_password_segura_y_aleatoria
```

### 3. Reiniciar el backend

```bash
npm start
```

A partir de aquí, el backend ya **no es superuser**. Las queries pasan por RLS — pero el **interruptor sigue apagado**, así que todo se comporta como antes.

**Verifica que todo funciona normal** (login, listados, crear cosas, timbrar). Si algo falla, revisa los logs: probablemente alguna query nueva que no tenía el filtro de tenant y ahora devuelve vacío, o un caller cross-tenant que olvidé envolver en `withBypass`.

Si necesitas volver atrás: cambia `DB_USER` de regreso a `postgres` y reinicia. Cero migrations a revertir.

### 4. Encender el interruptor

Una vez que validaste que el sistema corre bien con `app_runtime`, prende el doble candado. La activación es automática vía `withTenant`/`withBypass` en el código — no hay un toggle global, está siempre listo. **A partir del paso 2, RLS ya está activo en cada request** porque `tenantResolver` setea `app.rls_enforce=true`.

(Si quieres apagarlo temporalmente sin volver a `postgres`, simplemente cambia el código de `applyRlsContext` en `src/db/index.js` para que siempre setee `app.rls_enforce='false'`. Pero idealmente no lo apagues — el doble candado debe estar siempre prendido en producción.)

## Cómo verificar que está funcionando

Conéctate a la BD como `app_runtime` (después del paso 1):

```sql
-- Sin tenant context: 0 filas
SET app.rls_enforce = 'true';
SET app.tenant_id = '';
SELECT COUNT(*) FROM products;   -- debe ser 0

-- Con tenant context válido: las filas de ese tenant
SET app.tenant_id = 'UUID-DE-UN-TENANT';
SELECT COUNT(*) FROM products;   -- las del tenant
```

Si estos resultados son los esperados, el doble candado está funcionando.

## Casos especiales (`withBypass`)

Los siguientes endpoints/jobs corren sin tenant context porque operan cross-tenant. Ya están envueltos en `withBypass(...)`:

- `POST /api/tenants/provision` — crea un tenant nuevo.
- `POST /api/billing/webhook` — Stripe webhooks (identifican el tenant del payload).
- Cron jobs `production.activate-pending-shifts`, `quotations.expire-stale`, `banxico.ensure-rate` — operan globalmente.

Si en el futuro agregas nuevos puntos que necesitan ver datos cross-tenant, usa el helper:

```js
const { withBypass } = require('./db')

await withBypass(async () => {
  // Aquí RLS no aplica — útil para queries cross-tenant explícitas
  const all = await query('SELECT * FROM tenants')
})
```

## Si algo se rompe

**Volver a `postgres`:** edita `.env`, restaura `DB_USER=postgres` y la contraseña, reinicia. RLS deja de aplicarse instantáneamente.

**Identificar la query problemática:** los logs muestran cada query con su contexto. Una query que esperaba N filas y ahora devuelve 0 probablemente no tiene tenant context.

**Tablas nuevas:** cada vez que crees una tabla con `tenant_id`, agrega manualmente:

```sql
ALTER TABLE nueva_tabla ENABLE ROW LEVEL SECURITY;
ALTER TABLE nueva_tabla FORCE  ROW LEVEL SECURITY;
CREATE POLICY rls_tenant ON nueva_tabla
  AS PERMISSIVE FOR ALL
  USING (NOT rls_enforce() OR tenant_id IS NULL OR tenant_id = current_tenant_id())
  WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());
```

(O re-ejecuta la lógica de la migration 101, que recorre todas las tablas con `tenant_id`.)
