# Patrón de Golden Master Tests

> **Propósito**: capturar el comportamiento exacto del `productionService.js` actual antes de refactorizarlo, para que cualquier cambio de implementación mantenga la salida idéntica (o requiera actualizar el snapshot conscientemente).
> **Documento padre**: `00-design.md` §5.4 (refactor de production) y §8.2 R-T1 (riesgo de regresiones).

## Por qué golden master y no unit tests "puros"

El `productionService.js` actual (3,363 líneas) tiene mucha lógica entrelazada con la BD: queries SQL complejas, joins, agregaciones. Escribir unit tests "puros" (mockeando la DB) requeriría:

- Reescribir cada test cuando cambie un query.
- Acoplar tests a la implementación, no al comportamiento.
- Perder el efecto de los joins reales y datos sembrados.

Golden master tests **HTTP-level** ofrecen mejor relación valor/esfuerzo:

- Testeamos la **API pública** (la única superficie que el frontend conoce).
- El refactor puede cambiar libremente queries, funciones internas, organización de archivos — mientras la respuesta HTTP sea idéntica.
- Si el refactor mejora algo (más campos, otro orden), el snapshot diff es **obvio en el PR** y el reviewer decide si es intencional.

## Estructura del test

Cada golden master test sigue esta estructura:

```js
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario, normalizeForSnapshot } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

describe('Golden master: <ENDPOINT>', () => {
  let client, tenantInfo, scenario

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: '<short>', planSlug: 'owner' })
    const sess = await loginAs({ slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    scenario = await seedProductionScenario(client, { /* opciones */ })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('Captura el shape esperado', async () => {
    const res = await client.get('<endpoint>').expect(200)

    // 1. Verificaciones estructurales (independientes del snapshot)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(N)

    // 2. Verificaciones de negocio explícitas
    expect(res.body[0].priority).toBe('urgente')

    // 3. Golden master snapshot (normalizado)
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Casos secundarios sin snapshot', async () => {
    // Tests adicionales que NO usan snapshot — verifican comportamiento
    // específico con assertions explícitas (filtros, exclusiones, etc.)
  })
})
```

## Normalización de campos no-determinísticos

`normalizeForSnapshot()` (en `tests/helpers/productionFactory.js`) reemplaza valores no-determinísticos por placeholders estables:

| Campo | Reemplazo |
|---|---|
| UUIDs (`product_id`, `tenant_id`, etc.) | `<UUID>` |
| Timestamps ISO (`created_at`, `released_at`) | `<TIMESTAMP>` |
| Fechas (`delivery_date`) | `<DATE>` |
| `order_number` (incluye fecha/secuencia) | `<ORDER_NUMBER>` |

Si un test descubre un campo nuevo con variabilidad (ej. un hash, un nombre auto-generado con timestamp), agregar la regla en `normalizeField()`.

## Tres tipos de assertions en un golden master test

| Tipo | Cuándo usar | Ejemplo |
|---|---|---|
| **Estructural** | Confirmar tipo y cardinalidad | `expect(res.body).toHaveLength(2)` |
| **Negocio explícita** | Lo que el doc dice que debe pasar (orden, filtros, status) | `expect(res.body[0].priority).toBe('urgente')` |
| **Snapshot completo** | Captura el resto del shape | `expect(normalize(res.body)).toMatchSnapshot()` |

Los tres se complementan. Una assertion estructural sin snapshot no detecta cambios sutiles en campos calculados. Un snapshot sin assertions explícitas oculta el "por qué" cuando falla.

## Cuándo actualizar el snapshot

**Permitido (con justificación en el PR):**
- Refactor agrega un campo nuevo opcional en la respuesta.
- Bug fix corrige un valor que estaba mal calculado.
- Decisión deliberada de cambiar formato (ej. fecha en otro formato).

**No permitido:**
- "El snapshot falla, lo actualizo y ya." Sin entender por qué cambió, hay riesgo de aceptar una regresión.

**Comando para regenerar snapshots:**
```bash
npm test -- tests/integration/production-queue --updateSnapshot
```

El PR que actualiza snapshots **debe**:
1. Explicar en el commit message qué cambió y por qué.
2. Incluir el diff del snapshot en el código (ya lo hace git).
3. Pasar code review explícito al cambio del snapshot.

## Mezcla HTTP + DB en fixtures

Hay dos formas de sembrar datos para tests:

| Tipo de dato | Approach | Razón |
|---|---|---|
| Productos, raw materials, órdenes, quality specs | **HTTP** (via API pública) | Testea creación end-to-end. Si la API cambia, los tests fallan apropiadamente. |
| Stock de inventario, warehouses, niveles min/max | **DB directa** (via `query` + `withBypass`) | El flujo HTTP requiere documentos completos (adjustments con razón + notas + lines). Para fixtures internas, demasiado brittle. |

**Regla**: si hay un endpoint público que crea el dato en un solo POST sin requisitos burocráticos (razón, audit, etc.), usar HTTP. Si requiere documento contable o múltiples pasos, usar DB directa.

**Importante**: las inserciones DB directas usan `withBypass()` para saltar RLS. Esto es seguro **solo en tests** — nunca usarlo en código de producción.

## Lecciones aprendidas durante el bootstrap

1. **Tenants nuevos no tienen warehouses auto-seeded**. La migración 040 solo seedea para tenants existentes al aplicarla; nuevos tenants nacen sin almacenes. Los factories que necesitan stock deben **crear el warehouse si no existe**.

2. **FK de `order_mp_formula.raw_material_id` no tiene ON DELETE CASCADE** (migración 039). Al borrar tenants en cleanup, el CASCADE de `raw_materials` falla si hay órdenes con fórmula activa. **Solución aplicada**: `cleanupTestTenants()` pre-borra `order_mp_formula` antes del DELETE del tenant. Si en futuras migraciones se agregan más FKs sin cascade, hay que extender el cleanup.

## Setup deterministico de fixtures

`seedProductionScenario()` (en `productionFactory.js`) crea un escenario reproducible:

- 1 raw material con cost_per_kg fijo
- 1 producto con SKU único por timestamp
- N órdenes con prioridades predeterminadas (urgente → alta → normal → baja)
- Las primeras K liberadas (para que aparezcan en queue)

Si un test necesita un escenario distinto (ej. con paquetes capturados, con incidencias), extender el factory con `seedShiftWithProgress()`, `seedShiftWithIncidents()`, etc. — **no** modificar `seedProductionScenario()` rompiendo escenarios existentes.

## Funciones del `productionService` a cubrir

En orden de prioridad para crear golden masters (basado en complejidad y uso):

| # | Función / Endpoint | Notas |
|---|---|---|
| 1 | `GET /api/production/queue` | ✅ Hecho — `tests/integration/production-queue.test.js` |
| 2 | `GET /api/production/orders` | ✅ Hecho — `tests/integration/production-orders.test.js` (mismo archivo que #3) |
| 3 | `GET /api/production/orders/:id` | ✅ Hecho — comparte archivo con #2 |
| 4 | `POST /api/production/orders/preview-stock` | ✅ Hecho — `tests/integration/production-preview-stock.test.js` (con #5) |
| 5 | `GET /api/production/orders/:id/stock-availability` | ✅ Hecho — comparte archivo con #4 |
| 6 | `GET /api/production/shifts/active` | ✅ Hecho — `tests/integration/production-shifts-active.test.js` |
| 7 | `GET /api/production/shifts/:id/summary` | ✅ Hecho — `tests/integration/production-shift-summary.test.js` — el más complejo, captura toda la lógica Modelo D Opción C |
| 8 | `GET /api/production/shifts/history` | ✅ Hecho — `tests/integration/production-shifts-history.test.js` |
| 9 | `GET /api/production/scheduled-shifts` | ✅ Hecho — `tests/integration/production-scheduled-shifts.test.js` |
| 10 | `POST /api/production/orders` (createOrder) | Side effect: crea orden + audit log — post-MVP si surge necesidad |

**Los 9 endpoints read-only están cubiertos al 100%.** Side-effect endpoints (10+) requieren testing más cuidadoso (verificar el side effect + snapshot del response). Quedan diferidos hasta que el refactor lo requiera.

## Anti-patrones a evitar

1. **Snapshots gigantes sin estructuralS**. Un snapshot de 500 líneas sin assertions explícitas es difícil de revisar. Combinar siempre con estructurales.

2. **Tests que dependen del orden de creación**. Si dos órdenes se crean en el mismo milisegundo, el orden por `created_at` es indeterminado. Usar siempre campos de negocio (priority, sort_order) para ordenar — no timestamps.

3. **Compartir scenario entre tests**. Cada `describe` debe ser self-contained. Si dos describes comparten setup costoso, considerar `beforeAll` a nivel de archivo, pero no entre archivos.

4. **Snapshot de errores con stack traces**. Los stack traces cambian con cada refactor. Si testeas error responses, normaliza el campo `stack` a `<STACK>` o excluye con `.toEqual({ error: expect.any(String) })`.

5. **Olvidar limpieza**. `cleanupTestTenants()` y `pool.end()` en `afterAll` son obligatorios. Si una suite falla a la mitad, queda con conexiones abiertas y data sucia.

6. **Múltiples `afterAll(pool.end)` en un mismo archivo** ❌. Cuando un archivo tiene 2+ `describe`, **no** llamar `pool.end()` en cada uno — el primero cierra el pool y los demás fallan con "Cannot use a pool after calling end on the pool". Patrón correcto:

   ```js
   // Al inicio del archivo (a nivel del módulo, no dentro de describe)
   afterAll(async () => {
     await cleanupTestTenants()
     await pool.end()
   })

   describe('Suite A', () => { /* beforeAll, tests */ })
   describe('Suite B', () => { /* beforeAll, tests */ })
   ```

   Este `afterAll` global se ejecuta una sola vez al final del archivo, después de TODOS los describes. Cada describe puede tener su propio `beforeAll` para sembrar su escenario sin problema.

## Ejecución

```bash
# Correr solo el golden master de queue
npm test -- tests/integration/production-queue

# Correr todos los golden masters de production
npm test -- tests/integration/production

# Regenerar snapshots después de cambio intencional
npm test -- tests/integration/production-queue --updateSnapshot

# Si los tests dejan tenants residuales
npm run test:clean
```

## Próximos pasos

1. Validar que este primer test corre limpio en sandbox.
2. Si funciona → escribir golden master #2 (`GET /api/production/orders`) siguiendo este patrón.
3. Cuando los primeros 5 estén verdes → empezar el refactor del `productionService.js` con confianza.
4. Cada función refactorizada debe pasar **al menos** un golden master sin actualizar snapshot.
