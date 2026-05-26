# SaaS v2 — Fase 1 Progress

> **Propósito**: punto de entrada para retomar el trabajo de Fase 1 (recetas + lotes + refactor de production). Si llegas aquí cold, **10 min de lectura = ramp-up completo**.
>
> **Documentos hermanos**:
> - [`00-design.md`](./00-design.md) — diseño completo (~32k palabras)
> - [`01-golden-master-pattern.md`](./01-golden-master-pattern.md) — patrón de tests de caracterización para el refactor
> - [`02-foundation-progress.md`](./02-foundation-progress.md) — Fase 0 cerrada (referencia)

---

## 1. Dónde estamos ahora

**Fase 1 (Recetas + Lotes + Refactor production): 100% cerrada.** Bloques 5d-5h completos. Trazabilidad backward/forward operativa con reversión real en edit/delete. Expiración automática de lotes + alertas de discrepancia de alérgenos.

Hasta ahora:
- Migration 127: recipes + recipe_components + permisos `recipes:*`.
- Migration 128: products extendida + trigger `sync_products_default_recipe_id`.
- Migration 129: production_orders extendida + trigger `sync_production_order_recipe_version`.
- Migration 130: motor de lotes — `raw_material_lots`, `product_lots`, `lot_consumption` + extensiones a shift_progress.lot_id, shift_mp_loads.lot_id, inventory_movements XOR.
- Migration 131 (bonus): `tenant_allergens` + `raw_material_allergens` + `product_allergens`. 8 alérgenos NOM-051 sembrados. Service+endpoints REST para el catálogo.
- Módulos: `src/modules/recipes/` (4 endpoints) + extensión a `src/modules/process-config/` (allergens, +4 endpoints).
- **Refactor production — Bloques 5a-5c (helpers, sin tocar productionService.js)**:
  - `src/modules/production/recipeResolver.js` — puerta de entrada del refactor; unifica lectura de "qué MP consume esta orden" detrás de 4 modos (recipe / legacy_formula / legacy_single / none).
  - `src/modules/production/lotNumberGenerator.js` — función pura para generar lot_numbers según patrón configurable (§4.5.1). 9 variables soportadas.
  - `src/modules/production/lotSelector.js` — selector FEFO/FIFO §4.6 con greedy para cubrir cantidades. `listAvailableLots()` + `selectLotsForQuantity()`. Excluye lotes no-active, depleted y caducados (en FEFO).
- **Refactor production — Bloques 5d-2 + 5e (createOrder/updateOrder/preview con recipe_id)**:
  - `getOrderStockAvailability` (5d-1) usa `resolveRecipeForOrder` internamente. Shape preservado para legacy.
  - `previewStockForNewOrder` (5d-2) acepta `recipeId + totalPtKg` como path nuevo. Modo legacy (mpFormula + lengthMm) intacto.
  - Nueva función `previewStockForRecipe()` interna: calcula requiredKg por componente como `(totalPtKg / yield_quantity) × component.quantity × (1 + reprocessFactor)`. Reproceso preferido desde `recipe.expected_scrap_pct`, fallback al tenant.
  - `createOrder` / `updateOrder` (5e) aceptan `recipe_id`. Mutuamente excluyente con mp_formula (400 si ambos). Si recipe_id set: NO inserta order_mp_formula. Trigger §129 popula `recipe_version_at_creation` automáticamente. updateOrder soporta limpiar con `recipeId=null`.
  - **Bug pre-existente arreglado**: había un `PATCH /orders/:id` duplicado en routes.js que sombreaba updateOrder. Express tomaba la primera ruta (que llamaba releaseOrder mal). Eliminada — ahora PATCH funciona correctamente.
- **Refactor production — Bloque 5f (`loadMp` con motor de lotes)**:
  - `loadMp` ahora lee `tenant_process_config` (uses_lots / uses_expiry / uses_fefo / cost_method).
  - Si `uses_lots=true`: acepta `lotId` manual o auto-selecciona vía `lotSelector` (FEFO si `uses_fefo+uses_expiry`, FIFO si no).
  - Valida lote (status='active', misma MP, qty suficiente), lock `FOR UPDATE`, decrementa `quantity_remaining`, marca `status='depleted'` si llega a 0.
  - Popula `shift_mp_loads.lot_id` (+ `unit_id`, `quantity` nuevos) y crea `inventory_movement` (movement_type='production_mp_consumption', warehouse=lot.warehouse_id, qty=-kg) con `raw_material_lot_id` set.
  - **Divergencia legacy↔lots intencional**: con lotes, la salida física de MP ocurre al cargar (loadMp); en legacy ocurre al producir (capturePackage). Justificable porque con lotes el operador tiene que decir QUÉ lote físico está usando en el momento del consumo. capturePackage (5g) absorbió esta diferencia.
  - Multi-lot greedy → 409 'cargue uno a la vez'. Shortfall → 409 'falta Xkg'. Sin lotes activos → 409.
  - Guards en `editMpLoad`/`deleteMpLoad`: rechazan con 400 si `lot_id != null`. La reversión del consumo de lote (refund + movimiento compensación) se difiere al bloque **5f.1**.
  - `extension de recordMovement`: acepta `rawMaterialLotId` / `productLotId` (XOR enforced por código + constraint im_lot_xor).
- **Refactor production — Bloque 5g (capturePackage/addPackage/closeShift con product_lots + lot_consumption)**:
  - **Migration 132**: agrega `tenant_process_config.product_lot_granularity` (default `'per_shift'`, valores válidos `per_shift` / `per_package` / `per_attribute_set`).
  - **Helper `productLotResolver.js`**: `resolveLotPattern()` (cascada producto → tenant → DEFAULT) + `nextSequenceForDay()` (SEQ por tenant×producto×día).
  - **Helper `productLotMaintainer.js`**: `ensureProductLotForPackage()` (crea o aumenta product_lot según granularidad; `per_attribute_set` lanza 501) + `distributeRawMaterialLotsToProductLots()` (genera lot_consumption proporcional al peso en closeShift, idempotente) + `validateAllergenConsistency()` (§5h).
  - **`capturePackage` / `addPackage`** ramifican legacy vs lot-mode:
    - Lot-mode: llama a `captureLotModeInventory()` que ensure product_lot, popula `shift_progress.lot_id`, crea `inventory_movement` PT→WIP con `product_lot_id`. **NO debita MP** (ya se hizo en loadMp; sin doble conteo).
    - Legacy: comportamiento idéntico, `recordPackageCaptured()` intacto.
  - **`closeShift`** ejecuta `distributeRawMaterialLotsToProductLots` + `validateAllergenConsistency` (§5h) cuando `uses_lots=true`.
  - `inventoryService.getWarehouseId` ahora exportado.
- **Bloque 5f.1 (`editMpLoad`/`deleteMpLoad` con reversión real de lote)**:
  - Helper `applyLotConsumptionDelta(client, { lotId, delta, ... })`: lock FOR UPDATE, valida saldo si delta>0, decrementa quantity_remaining, transiciona status active↔depleted (incluyendo **reactivación depleted→active automática** cuando refund deja qty>0), crea inventory_movement compensatorio (quantity=-delta).
  - `editMpLoad`: invoca el helper con delta = newKg - oldKg.
  - `deleteMpLoad`: invoca con delta = -oldKg (refund completo).
- **Bloque 5g.1 (`editPackage`/`deletePackage` con ajuste de product_lot)**:
  - Helper `applyProductLotDelta(client, { lotId, delta, ... })`: lock FOR UPDATE, ajusta quantity_produced/remaining, **DELETE el lote si quedó vacío** (CASCADE limpia lot_consumption), crea movimiento PT compensatorio.
  - `editPackage`: en lot-mode, no llama revertInventoryMovements; usa el helper. Rechaza cambios de isSecondQuality (requeriría reasignar lote). Si shift está pending_handover, re-corre `distributeRawMaterialLotsToProductLots` (idempotente).
  - `deletePackage`: en lot-mode, refund completo + DELETE shift_progress. Re-distribute si pending_handover.
- **Bloque 5h (alertas + expiración + alérgenos)**:
  - **Migration 133**: tabla `tenant_alerts` (type, severity, status pending/acknowledged/resolved, payload jsonb, source_type/source_id, ack/resolve metadata). Permisos `alerts:read` / `alerts:acknowledge` asignados a super_admin/owner/admin/supervisor.
  - **Service `alertService.js`** (módulo `src/modules/alerts/`): `dispatchAlert()` con dedupe por (tenant×type×source) + audit + console.log con prefijo `[ALERT]`. `listAlerts()`, `acknowledgeAlert()`, `resolveAlert()`.
  - **Service `expirationService.js`** (módulo `src/modules/production/`): `markExpiredLots({ tenantId? })` (UPDATE status='expired' donde expiry_date<=NOW; dispatcha `lot_expired`) + `getExpiringLots({ tenantId, daysAhead?, dispatch? })` (lista lotes que vencen en N días, default `tenant_process_config.expiry_alert_days`; opcionalmente dispatcha `lot_expiring`).
  - **`validateAllergenConsistency` en `closeShift`**: por cada product_lot, calcula alérgenos heredados (lot_consumption → raw_material_lots → raw_material_allergens) y los compara con product_allergens declarados. Acción según `tenant_process_config.allergen_mode`:
    - `strict`: 400 con detalle → bloquea cierre (rollback de la transacción).
    - `priority_only`: 400 si discrepancia incluye alérgeno NOM-051 priority; los no-priority disparan alertas.
    - `alert_only`: siempre dispatchAlert, nunca bloquea.
  - **Endpoints**: `POST /api/lots/run-expiration-check` (trigger manual), `GET /api/lots/expiring?days=N&dispatch=true`, `GET /api/alerts?status&type&limit&offset`, `PATCH /api/alerts/:id/acknowledge`, `PATCH /api/alerts/:id/resolve`.
  - **Cron opt-in**: `ENABLE_LOT_EXPIRY_CRON=true` registra `lots.mark-expired` cada hora a los :15 que recorre tenants con `uses_lots=true`. Default off para no afectar dev/tests.
  - **Hook de "notificación" para SMTP/Slack**: pasa por `alertService.dispatchAlert` — futuro publisher se enchufa ahí sin tocar callers.
- 235 tests nuevos en 5d-5h. Suite total: **32 suites / 456 tests verdes** (9 snapshots golden master intactos).

### Hitos planeados

| # | Hito | Estado | Migration(s) |
|---|---|:-:|---|
| 1 | `recipes` + `recipe_components` + CRUD | ✅ | 127 |
| 2 | `products` extendida + trigger `default_recipe_id` sync | ✅ | 128 |
| 3 | `production_orders` extendida + trigger `recipe_version_at_creation` | ✅ | 129 |
| 4 | Motor de lotes: `raw_material_lots`, `product_lots`, `lot_consumption` + extensiones | ✅ | 130 |
| 4b | (bonus) `tenant_allergens` + tablas de unión, seed NOM-051 | ✅ | 131 |
| 5 | Refactor `productionService.js` con golden masters como red de seguridad | 🚧 en progreso | — (sin migration) |
| 5a | Helper `recipeResolver.js` (puerta de entrada) | ✅ | — |
| 5b | Helper `lotNumberGenerator.js` (función pura §4.5.1) | ✅ | — |
| 5c | Helper `lotSelector.js` (FEFO/FIFO §4.6) | ✅ | — |
| 5d-1 | Integrar resolver en `getOrderStockAvailability` | ✅ | — |
| 5d-2 | `previewStockForNewOrder` extendido (path recipeId+totalPtKg) | ✅ | — |
| 5e | `createOrder`/`updateOrder` aceptan `recipe_id` (mutuamente excluyente con mp_formula) | ✅ | — |
| 5f | `loadMp` con lotes: lotSelector/manual, decrement, inventory_movement con lot_id | ✅ | — |
| 5f.1 | `editMpLoad`/`deleteMpLoad` con reversión (refund quantity_remaining + reactivación depleted→active + movimiento compensatorio) | ✅ | — |
| 5g | `capturePackage`/`addPackage`/`closeShift` con product_lots + lot_consumption + granularidad configurable | ✅ | 132 |
| 5g.1 | `editPackage`/`deletePackage` con ajuste de product_lot (delta a quantity_produced, DELETE si vacío, re-distribute en pending_handover) | ✅ | — |
| 5h | tenant_alerts + expirationService (markExpired/getExpiring) + alertService (dispatch/list/ack/resolve) + validación de alérgenos en closeShift (strict/priority_only/alert_only) + cron opt-in `ENABLE_LOT_EXPIRY_CRON` | ✅ | 133 |

---

## 2. Verificar que todo sigue funcionando

```bash
cd "C:/Users/admin/CLON ERP CLAUDE/saas-base"

npm run migrate
# Esperado: "Already up to date."

npm test -- --forceExit
# Esperado:
#   Test Suites: 32 passed, 32 total
#   Tests:       456 passed, 456 total
#   Snapshots:   9 passed, 9 total
```

---

## 3. Inventario actual de Fase 1

### 3.1 Migrations aplicadas

```
127_recipes.js
  ├── CREATE TABLE recipes        (id, tenant_id, product_id, version, name,
  │                                yield_quantity, yield_unit_id, expected_scrap_pct,
  │                                valid_from, valid_until, is_active)
  ├── CREATE TABLE recipe_components (id, recipe_id, raw_material_id, quantity,
  │                                  unit_id, is_optional, substitute_group,
  │                                  notes, sort_order)
  ├── Partial unique: solo una receta con valid_until IS NULL por producto
  └── Permisos recipes:read / recipes:update (asignados a owner/admin/supervisor)

128_products_extensions.js  (aditivo puro + trigger)
  ├── ALTER TABLE products: +8 columnas (product_kind_id, is_produced,
  │                          custom_attributes, default_recipe_id, shelf_life_days,
  │                          default_quality_grade_id, expected_sale_price,
  │                          lot_number_pattern)
  ├── CHECK constraints: custom_attributes objeto, shelf_life > 0, price >= 0
  ├── FUNCTION sync_products_default_recipe_id() + TRIGGER en recipes
  │   → mantiene products.default_recipe_id apuntando a la vigente
  └── productsService viejo intacto

129_production_orders_extensions.js  (aditivo puro + trigger)
  ├── ALTER TABLE production_orders: +7 columnas (recipe_id, recipe_version_at_creation,
  │                                   accept_second_quality_for_fulfillment, expected_scrap_pct,
  │                                   custom_attributes, additional_costs, additional_costs_notes)
  ├── CHECK constraints: custom_attributes objeto, scrap_pct 0-100, costs >=0,
  │                       recipe_version_at_creation requiere recipe_id (CHECK)
  ├── FUNCTION sync_production_order_recipe_version() + TRIGGER en production_orders
  │   → popula recipe_version_at_creation desde recipes.version cuando recipe_id cambia
  └── productionService viejo intacto

130_lots.js  (motor de lotes — la pieza más densa de Fase 1)
  ├── CREATE TABLE raw_material_lots  (FEFO/FIFO + cuarentena + COA + multi-status)
  ├── CREATE TABLE product_lots       (origin produced/received/adjusted, calidad obligatoria)
  ├── CREATE TABLE lot_consumption    (columna vertebral de trazabilidad backward/forward)
  ├── shift_progress: +lot_id (FK product_lots), +dynamic_attributes JSONB
  ├── shift_mp_loads: +lot_id (FK raw_material_lots), +unit_id, +quantity
  ├── inventory_movements: +raw_material_lot_id, +product_lot_id (XOR constraint)
  └── CHECKs múltiples (status enum, qty positives, qty_remaining ≤ produced/received,
      expiry ≥ production_date, origin-specific FK requirements)

131_tenant_allergens.js  (declaración de alérgenos NOM-051/NOM-251)
  ├── CREATE TABLE tenant_allergens   (catálogo, seed default 8 NOM-051 prioritarios)
  ├── CREATE TABLE raw_material_allergens (unión MP↔alérgeno, declaration enum)
  ├── CREATE TABLE product_allergens      (unión PT↔alérgeno, declaration enum)
  └── Extiende seed_tenant_process_template_defaults — auto-seed para tenants nuevos
```

### 3.2 Módulo `src/modules/recipes/`

```
recipes/
├── recipesService.js  — CRUD versionado (POST crea nueva versión, PATCH metadata)
└── routes.js          — 4 endpoints REST
```

### 3.3 Endpoints

| Recurso | GET list | GET id | POST | PATCH | Filtros (query) |
|---|:-:|:-:|:-:|:-:|---|
| recipes | ✅ | ✅ (con components) | ✅ (versionado) | ✅ (solo metadata) | `productId`, `vigentOnly`, `isActive` |

### 3.4 Tests

```
tests/integration/recipes.test.js                       (21 tests)
  ├── POST: crear, versionar, vigentOnly, camelCase
  ├── Validaciones: product/yield/scrap/components/duplicados/cross-tenant
  ├── GET por id (incluye components ordenados)
  └── PATCH solo metadata

tests/integration/saas-v2-products-extensions.test.js   (17 tests, SQL directo)
  ├── Defaults + CHECKs + FKs cross-catálogo
  └── Trigger sync_products_default_recipe_id en 4 escenarios
      (crear v1, crear v2 cierra v1, cerrar manual, DELETE)

tests/integration/saas-v2-production-orders-extensions.test.js  (13 tests, SQL+API)
  ├── Defaults + CHECKs (custom_attributes, scrap, costs)
  └── Trigger sync_production_order_recipe_version
      (INSERT con recipe → version, UPDATE cambio recipe → version, nulify → null)

tests/integration/saas-v2-lots.test.js  (22 tests, SQL directo)
  ├── raw_material_lots: defaults, CHECKs status/qty/expiry, UNIQUE (rm,lot)
  ├── product_lots: origin produced/received/adjusted con FKs requeridas
  ├── lot_consumption: vincula MP→PT, qty positiva
  └── Extensiones: shift_progress.lot_id+dynamic_attributes, shift_mp_loads.*,
      inventory_movements XOR

tests/integration/process-config-allergens.test.js  (20 tests, API+SQL)
  ├── 8 NOM-051 sembrados al crear tenant
  ├── CRUD via API con permisos tenant_catalogs:*
  └── Tablas de unión via SQL (declaration enum, UNIQUE per_rm/product, CASCADE)
```

---

## 4. Decisiones tomadas

### 4.1 Patrón "versioned aggregates" para recipes (decisión clave)

- **POST** crea una nueva versión vigente. Si ya hay vigente para el producto, la cierra automáticamente (`valid_until = NOW()`) en la misma transacción.
- **PATCH** solo permite metadata no-material: `name`, `is_active`. Cualquier cambio en `yield_quantity`, `expected_scrap_pct`, `yield_unit_id` o `components` requiere POST de una nueva versión.
- **Razón**: preservar trazabilidad de costeo. Una `production_order` que referencia `recipe_id` debe ver components inmutables incluso después de meses.
- **Si quieres cambiar este patrón**: el lugar es `recipesService.updateRecipe`. Si una receta no tiene órdenes referenciándola, podría permitirse PATCH in-place — pero hoy día aún no existe `production_orders.recipe_id` (vendrá en migration 129), así que no es ambiguo.

### 4.2 Constraint partial unique

```sql
CREATE UNIQUE INDEX recipes_one_vigente_per_product
  ON recipes (product_id) WHERE valid_until IS NULL;
```

Garantiza a nivel BD que es imposible tener dos vigentes simultáneamente. El service también hace la transición atómica, pero el constraint es la red final.

### 4.3 FK con CASCADE vs RESTRICT

- `recipes → tenants/products`: **CASCADE**. Si se borra el tenant o el producto, la receta no tiene sentido sola.
- `recipes → tenant_units (yield_unit_id)`: **RESTRICT**. Una unidad referenciada por una receta no se debería borrar.
- `recipe_components → recipes`: **CASCADE**. Componentes son parte de la receta.
- `recipe_components → raw_materials`: **RESTRICT**. Una MP referenciada por una receta vigente no se debería borrar (rompería el costeo).

**Implicación en tests**: el cleanup de `factory.js` pre-borra `recipes` (y por CASCADE, `recipe_components`) antes del DELETE del tenant. De lo contrario, el CASCADE del tenant podría intentar borrar `raw_materials` antes que `recipe_components`, violando RESTRICT.

### 4.4 Permisos

Nuevo recurso `recipes` con `:read` y `:update`. Asignado a:
- super_admin (global)
- owner / admin / supervisor (per-tenant)

NO se siguió el patrón genérico `tenant_catalogs:*` (que cubre todos los catálogos de configuración) porque recipes son runtime / operativo, no catálogo de configuración. La frontera: catálogos = "qué soporta el tenant", recipes = "qué produce y cómo".

---

## 5.5 Mapeo de funciones críticas de productionService → helpers

Dry-run hecho 2026-05-22 antes de empezar la integración. Las 40+ funciones de productionService.js se clasifican en 4 grupos según el helper que necesitan:

### Grupo A — Solo lectura de mp_formula/raw_material_id (BAJO riesgo)

| Función | Líneas | Helper aplicable | Notas |
|---|---|---|---|
| `getOrdersQueue` | 38-73 | recipeResolver (opcional) | Solo LEFT JOIN para info display |
| `listOrders` | 74-117 | recipeResolver (opcional) | idem |
| `getOrder` | 118-143 | recipeResolver | Lee mp_formula para response; sustitución directa |
| `getShift` / `getActiveShifts` | ~870-900 | recipeResolver | Devuelven mp_formula en response |
| `getOrderMpFormulaHistory` | ~2220-2250 | (sin cambios) | Pura lectura legacy, queda como está |

### Grupo B — Cálculo de MP requerida (MEDIO riesgo, este bloque)

| Función | Líneas | Helper aplicable | Cambio |
|---|---|---|---|
| **`getOrderStockAvailability`** | **463-585** | **recipeResolver** | **Target del bloque 5d** ✅ |
| `previewStockForNewOrder` | 341-461 | — | NO recibe orderId; refactor requiere cambio de firma + nuevo cálculo basado en `recipe.yield_quantity`. **Defiere a bloque 5d-2** |

### Grupo C — Escritura crítica (ALTO riesgo, requiere mucho cuidado)

| Función | Líneas | Helpers necesarios | Cambio |
|---|---|---|---|
| `createOrder` / `updateOrder` | 144-277 | — | Aceptar `recipeId` además de `mpFormula`. Si recipe_id: NO insertar order_mp_formula ✅ |
| `loadMp` | ~1130 (5f) | lotSelector | Popular `shift_mp_loads.lot_id` + descontar `quantity_remaining` + inventory_movement con raw_material_lot_id ✅ |
| `editMpLoad` / `deleteMpLoad` (5f.1) | ~1770, ~1815 | — | Reversar consumo de lote (refund quantity_remaining + movimiento compensación). Hoy guard 400. |
| `capturePackage` / `addPackage` (5g) | ~965, ~2095 | lotNumberGenerator, productLotResolver, productLotMaintainer | Generar `product_lot` según granularidad + movimiento PT→WIP con product_lot_id (sin MP, ya en loadMp) ✅ |
| `closeShift` (5g) | ~3000 | productLotMaintainer | distribución `lot_consumption` proporcional al peso ✅ |
| `editPackage` / `deletePackage` (5g.1) | 1697+, 1789+ | — | Reversar quantity_produced/remaining del product_lot + recálculo lot_consumption. Hoy guard 400. |

### Grupo D — Mantener intacto (legacy versioning)

| Función | Líneas | Razón |
|---|---|---|
| `updateOrderMpFormula` (versionado interno) | 2118-2200 | Sistema de versionado legacy de la fórmula; equivalente al recipes versionado pero para órdenes individuales. Coexistirán mientras haya órdenes legacy. |

### Plan de orden de ataque

1. ✅ **5d-1**: `getOrderStockAvailability` — shape preservado, golden masters verdes.
2. ✅ **5d-2**: `previewStockForNewOrder` con path nuevo (`recipeId + totalPtKg`).
3. ✅ **5e**: `createOrder`/`updateOrder` aceptan `recipe_id`.
4. ✅ **5f**: `loadMp` — lotSelector/manual + decrement + inventory_movement con raw_material_lot_id.
5. ✅ **5g**: `capturePackage`/`addPackage`/`closeShift` — product_lots, lot_consumption proporcional.
6. ✅ **5f.1 + 5g.1**: reversión real en edit/delete con reactivación depleted→active automática y DELETE del product_lot vacío.
7. ✅ **5h**: tenant_alerts + expirationService + validación de alérgenos en closeShift + cron opt-in.
8. **5i**: cleanup migrations (eliminar order_mp_formula cuando todas las órdenes hayan migrado, post-MVP).

---

## 5. Receta para el siguiente paso (Hito 5d: empezar integración real)

**Plan del refactor (strangler fig)**: helpers primero, integración después. Decisión: refactor agresivo sin compat layer, respaldado por golden masters (decisión heredada de §4 de saas-design-decisions).

**Bloques completados (helpers, cero cambios en productionService)**:
- ✅ **5a — `recipeResolver.js`** (9 tests). `resolveRecipeForOrder()` → componentes normalizados en 4 modos.
- ✅ **5b — `lotNumberGenerator.js`** (33 tests). `generate(pattern, ctx)` → string. 9 variables soportadas.
- ✅ **5c — `lotSelector.js`** (20 tests). `listAvailableLots()` + `selectLotsForQuantity()` con greedy + shortfall. Soporta `weighted_avg`/`fifo`/`fefo`/`standard`. Excluye lotes no-active, depleted, caducados (FEFO).

**Fase 1 cerrada al 100%**. Opciones para próxima sesión:

1. **Fase 2 — vertical Recicladora (no-alimentario)**: validar que el motor funciona sin acoplar a plástico. Crear tenant tipo recicladora, modelar su proceso (recepción de scrap, segregación, molido, peletizado), corre sin uses_lots y sin alérgenos, valida que el Process Template realmente flexibiliza.
2. **Frontend de recipes / lots / alerts**: validar APIs en pantalla. Útil para detectar gaps de DX antes del piloto real.
3. **Configurar Palomitas end-to-end**: extender `scripts/provision-palomitas.js` con MPs reales (granos, aceite, sal, mantequilla), recetas, alérgenos. Hacer un turno real simulado para asegurar que la trazabilidad ya queda hilada.
4. **5i (post-MVP cleanup)**: dropear `order_mp_formula` cuando todas las órdenes hayan migrado a recipe_id.
5. **Webhook real para alertas**: agregar `tenant_process_config.alert_webhook_url` y enchufar publisher SMTP/Slack en `alertService.dispatchAlert`.

---

## 6. Próximos pasos en orden

### Camino A — Continuar el refactor incremental

Bloques helpers (5c y siguientes) según el plan de §5. Cada bloque: helper puro o función refactorizada con tests verdes antes y después.

### ~~Camino A' — Migration 131 (allergens)~~ ✅

Hecho. Las 3 tablas y catálogo NOM-051 están listas. La lógica de "detección automática de discrepancias al cerrar lote" (§4.9.2) sigue siendo código del refactor.

### Camino B — Refactor productionService antes que migrations 128-130

Validar y completar los golden masters primero. Después meter las migrations sabiendo que cualquier regresión la detectamos.

Tradeoff: tarda más pero reduce riesgo del refactor masivo del final. Si Fase 1 se va a hacer en bloques de 30 min, Camino A está bien; si se va a hacer en una semana corrida, Camino B es más seguro.

### Camino C — Configurar Palomitas con recetas reales

Extender `scripts/provision-palomitas.js` para crear MPs (granos, aceite, sal, mantequilla) usando el rawMaterialService viejo + 1-2 productos PT + sus recipes vía la API nueva. Valida el flujo completo end-to-end.

### Camino D — Frontend de recipes

Pantalla de "Configurar recetas" consumiendo `/api/recipes`. Útil para ver cómo se siente la API en un contexto real.

---

## 7. Gotchas y notas técnicas

### 7.-1 Triggers de la 129 y 130

- **`sync_production_order_recipe_version` (129, BEFORE INSERT/UPDATE production_orders)**: si seteas `recipe_id`, el trigger popula `recipe_version_at_creation` desde `recipes.version`. Si nulificas `recipe_id`, también nulifica la versión. El CHECK `po_recipe_version_implies_recipe` es red de seguridad redundante.
- **inventory_movements XOR (130)**: a lo sumo uno de `raw_material_lot_id` / `product_lot_id` puede estar set. Ambos NULL está OK (compat con flujo sin lotes).

### 7.0 Trigger `sync_products_default_recipe_id`

`products.default_recipe_id` se mantiene automáticamente apuntando a la receta con `valid_until IS NULL` del producto. **Nunca lo setees manualmente** — el trigger lo sobrescribirá en el próximo cambio en `recipes`.

Cubre 4 escenarios:
- INSERT recipe vigente → product.default_recipe_id = recipe.id
- UPDATE recipe.valid_until=NOW (cerrar) → product.default_recipe_id = NULL (o la siguiente vigente si hay)
- DELETE recipe vigente → product.default_recipe_id = NULL
- UPDATE recipe.product_id (raro) → actualiza ambos productos

Hay un backfill al final de la migration 128 que setea default_recipe_id para productos que ya tengan recetas vigentes al momento.

### 7.1 `recipe_components.raw_material_id` es RESTRICT

Si en un test creas raw_materials que aparecen en recipes, el cleanup de tenants explota a menos que pre-borres las recipes. **Factory.js ya está actualizado** para hacer esto.

### 7.2 Versionado en SaaS v2

Hay 3 lugares con versionado, todos diferentes:
- `tenant_product_kinds.attribute_schema/capture_schema`: wrapper `{version: N, fields: []}` con auto-increment cuando los fields cambian semánticamente.
- `recipes.version`: entero auto-asignado por producto, calculado como `MAX(version)+1`.
- `order_recipe_snapshots` (futuro, §2.4.2): snapshot de la receta usada por una orden con su versión congelada.

No confundirlos. Cada uno resuelve un problema distinto.

### 7.3 `recipes.is_active` vs `valid_until`

- `valid_until IS NULL` = receta "vigente" (la única editable como current).
- `is_active = false` = receta descontinuada por completo, no usable ni siquiera la vigente.

Combinaciones válidas:
- vigente + activa = caso normal
- vigente + inactiva = "el producto temporalmente no se fabrica"
- cerrada + activa = histórica usable (puede aparecer en GET)
- cerrada + inactiva = histórica oculta (filtrar `isActive=true`)

### 7.4 Substitute groups

Componentes con el mismo `substitute_group` son intercambiables al momento de consumir MP. Ejemplo: dos aceites alternativos con `substitute_group='aceite'`. Solo se necesita consumir uno de los dos en cada corrida. El cálculo de costeo en órdenes deberá tener esto en cuenta (post-MVP detail).

---

## 8. Cómo navegar el código nuevo

| Path | Por qué importa |
|---|---|
| `saas-base/src/db/migrations/127_recipes.js` | Estructura de tablas + partial unique + permisos |
| `saas-base/src/db/migrations/128_products_extensions.js` | 8 columnas + trigger sync default_recipe_id |
| `saas-base/src/db/migrations/129_production_orders_extensions.js` | 7 columnas + trigger sync recipe_version |
| `saas-base/src/db/migrations/130_lots.js` | 3 tablas nuevas + extensiones a shifts e inventory_movements |
| `saas-base/src/db/migrations/131_tenant_allergens.js` | tenant_allergens + 2 tablas de unión + seed 8 NOM-051 |
| `saas-base/src/modules/process-config/tenantAllergensService.js` | CRUD del catálogo |
| `saas-base/src/modules/production/recipeResolver.js` | Helper §5a — puerta de entrada del refactor |
| `saas-base/src/modules/production/lotNumberGenerator.js` | Helper §5b — generador puro de lot_numbers |
| `saas-base/src/modules/production/lotSelector.js` | Helper §5c — selector FEFO/FIFO con greedy |
| `saas-base/src/modules/recipes/recipesService.js` | Toda la lógica de versionado vive aquí |
| `saas-base/src/modules/recipes/routes.js` | 4 endpoints REST |
| `saas-base/tests/integration/recipes.test.js` | 21 tests recipes |
| `saas-base/tests/integration/saas-v2-products-extensions.test.js` | 17 tests products + trigger |
| `saas-base/tests/integration/saas-v2-production-orders-extensions.test.js` | 13 tests production_orders + trigger |
| `saas-base/tests/integration/saas-v2-lots.test.js` | 22 tests motor de lotes |
| `saas-base/tests/integration/process-config-allergens.test.js` | 20 tests allergens (API + SQL) |
| `saas-base/tests/integration/saas-v2-recipe-resolver.test.js` | 9 tests recipeResolver (4 modos + edge cases) |
| `saas-base/tests/integration/saas-v2-lot-number-generator.test.js` | 33 tests lotNumberGenerator (ejemplos design + bordes + validaciones) |
| `saas-base/tests/integration/saas-v2-lot-selector.test.js` | 20 tests lotSelector (weighted_avg/fifo/fefo + exclusiones + shortfall) |
| `saas-base/tests/integration/saas-v2-orders-with-recipe.test.js` | 15 tests createOrder/updateOrder/preview con recipe_id (§5d-2+5e) |
| `saas-base/tests/integration/saas-v2-load-mp-lots.test.js` | 16 tests loadMp con/sin lotes (§5f) — legacy, manual, FIFO/FEFO, errores, guards edit/delete |
| `saas-base/tests/integration/saas-v2-product-lots.test.js` | 13 tests product_lots (§5g/5g.1) — legacy, per_shift, per_package, per_attribute_set→501, distribución, edit+delta, delete+vaciado |
| `saas-base/tests/integration/saas-v2-expiration-alerts.test.js` | 14 tests (§5h) — markExpired, getExpiring, alertService (dedupe/ack/resolve), validación alérgenos por modo, endpoints |
| `saas-base/src/db/migrations/132_tenant_lot_granularity.js` | tenant_process_config.product_lot_granularity (per_shift/per_package/per_attribute_set) |
| `saas-base/src/db/migrations/133_tenant_alerts.js` | tabla tenant_alerts + permisos alerts:read/acknowledge |
| `saas-base/src/modules/production/productLotResolver.js` | Helper §5g — resolveLotPattern (cascada) + nextSequenceForDay |
| `saas-base/src/modules/production/productLotMaintainer.js` | Helper §5g/5h — ensureProductLotForPackage + distributeRawMaterialLotsToProductLots + validateAllergenConsistency |
| `saas-base/src/modules/production/expirationService.js` | Helper §5h — markExpiredLots + getExpiringLots |
| `saas-base/src/modules/alerts/alertService.js` + `routes.js` | Service §5h — dispatchAlert (dedupe + audit + console) + list/ack/resolve + REST |
| `saas-base/src/modules/lots/routes.js` | Endpoints §5h — POST run-expiration-check + GET expiring |
| `saas-base/src/crons.js` (extension) | Cron opt-in `lots.mark-expired` cuando ENABLE_LOT_EXPIRY_CRON=true |
| `saas-base/tests/helpers/factory.js` | `cleanupTestTenants` extendido para pre-borrar recipes |
| `saas-base/tests/helpers/productionFactory.js` | helper `loadMp` extendido con `lotId`/`unitId`/`quantity` |
| `saas-base/src/modules/inventory/inventoryService.js` | `recordMovement` acepta `rawMaterialLotId`/`productLotId` (XOR), `getWarehouseId` exportado |
| `saas-base/src/app.js` línea ~95 | Registro del router |

---

**Última actualización**: 2026-05-23 después de los bloques 5f.1 + 5g.1 + 5h: Fase 1 cerrada al 100%. Reversión real en editMpLoad/deleteMpLoad/editPackage/deletePackage con reactivación depleted→active y DELETE del product_lot vacío. Sistema completo de alertas (tabla tenant_alerts + dispatchAlert con dedupe + endpoints) + expirationService + validación de alérgenos en closeShift con 3 modos (strict/priority_only/alert_only). Cron opt-in con `ENABLE_LOT_EXPIRY_CRON=true`. Suite 32/456 verde, 9 snapshots golden master intactos.
