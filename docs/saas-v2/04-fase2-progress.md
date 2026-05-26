# SaaS v2 — Fase 2 Progress (Recicladora)

> **Propósito**: punto de entrada para retomar Fase 2 (validar que el motor sirve para verticales no-alimentarias).
>
> **Documentos hermanos**:
> - [`00-design.md`](./00-design.md) — diseño completo
> - [`02-foundation-progress.md`](./02-foundation-progress.md) — Fase 0 (referencia)
> - [`03-fase1-progress.md`](./03-fase1-progress.md) — Fase 1 cerrada (referencia)

---

## 1. Dónde estamos ahora

**Fase 2 (Recicladora): 6a + 6b + 6d + 6c + 6e + 6f — TODOS CERRADOS.** Suite total 36/525/9 snaps — todo verde.

### Hitos

| # | Hito | Estado | Notas |
|---|---|:-:|---|
| 6a | Script `provision-recicladora.js` (tenant + flags + scrap-types + grades + product-kinds) | ✅ | sin migration nueva — todo via APIs REST existentes |
| 6e | Turno simulado completo Recicladora (`simulate-recicladora-shift.js`) | ✅ | turno cerrado, validado, snapshot OK. 7 gaps identificados |
| 6b | Refactor `recordScrap` para usar `scrap_type_id` (FK), `recovery_value_pct`, `is_abnormal` | ✅ | helpers `scrapTypeResolver` + `abnormalScrapEvaluator` + `addScrap` también refactorizado. 23 tests nuevos. Backward compat 100% |
| 6d | `pt_goes_to_wip_first=false`: capturePackage directo a PT, validateShift salta WIP→PT | ✅ | `recordPackageCaptured` + `recordProductionValidation` leen el flag. 7 tests en `saas-v2-pt-goes-to-wip-first.test.js`. Backward compat: true (default) mantiene flujo WIP. |
| 6c | NRV multi-calidad en `validateShift` + `buildShiftSummary` | ✅ | `expected_sale_price × kg` por grade >1; cal-1 absorbe residuo. Edge case NRV≥totalCost → nrvWarning. Fix gap 4.2 (products API). 17 tests en `saas-v2-nrv-multi-quality.test.js`. |
| 6f | Refactor `capturePackage` para aceptar `quality_grade_id` (no solo bool isSecondQuality) | ✅ | `qualityGradeResolver.js` completo (paths id/gradeNumber/isSecondQuality/productDefault). 22 tests en `saas-v2-capture-quality-grade.test.js`. Backward compat 100%. |

---

## 2. Bloque 6a — provision-recicladora.js (cerrado)

Patrón idéntico a [`provision-palomitas.js`](../../saas-base/scripts/provision-palomitas.js): HTTP via supertest contra `app.js`, idempotente.

### Configuración aplicada

**Flags** (§6.3 del design):
- `uses_lots=false`, `uses_expiry=false`, `uses_fefo=false` — no aplica trazabilidad alimentaria
- `uses_handover=true`, `uses_supervisor=true`, `supervisor_validates=true`
- `pt_goes_to_wip_first=true` — QA por tipo/color antes de liberar a PT
- `mp_goes_to_wip_first=true`
- `allow_second_quality_in_order=true` — común sacar 1ª/2ª/3ª en una corrida
- `default_intra_shift_proration='weight'`
- `cost_method='weighted_avg'`
- `treat_abnormal_scrap_as_loss=true`
- `allergen_mode='alert_only'` (no aplica, pero deja la lógica en alerta inocua)

**Scrap types** (3 nuevos + 4 defaults desactivados):
| Code | Destination | Recovery % |
|---|---|---|
| `contaminacion` | discard | 0 |
| `finos_polvo` | sell | 10 |
| `etiquetas_tapas` | sell | 5 |

Desactivados: `arranque`, `operacion`, `contaminada`, `desecho` (defaults palomitas-style que no aplican).

**Quality grades** (renombrados, 3 activos):
- 1: primera — "Primera (pellet limpio)"
- 2: segunda — "Segunda (color mixto)"
- 3: tercera — "Tercera (rebabas / off-spec)"

**Product kinds** creados:
- `pellet` — attributes: color, tipo_resina, densidad_g_cm3
- `molido` — attributes: tipo_resina, tamano_particula_mm

### Credenciales

```
Slug:        recicladora-piloto
Admin email: admin@recicladora-piloto.local
Admin pass:  Recicladora!2026
```

### Comandos

```bash
cd "C:/Users/admin/CLON ERP CLAUDE/saas-base"
node scripts/provision-recicladora.js   # primera vez: crea todo / siguiente: skips

# Reset (CASCADE limpia todo):
psql ... -c "DELETE FROM tenants WHERE slug = 'recicladora-piloto';"
```

---

## 3. Hallazgo importante: no hace falta migración nueva

El plan original (§7.4) hablaba de "Migración 115 — `tenant_scrap_types.linked_raw_material_id`". **Esa columna ya existe** desde la migración 122 (Fase 0). El esquema de Fase 0 ya cubre todo lo que Fase 2 necesita:

| Necesidad | Donde está | Status |
|---|---|:-:|
| `tenant_scrap_types.linked_raw_material_id` | migración 122 | ✅ existe |
| `tenant_scrap_types.default_recovery_value_pct` | migración 122 | ✅ existe |
| `tenant_scrap_types.is_normal` | migración 122 | ✅ existe |
| `shift_scrap.scrap_type_id` (FK) | migración 122 | ✅ existe (junto con enum legacy por compat) |
| `shift_scrap.recovery_value_pct` | migración 122 | ✅ existe |
| `shift_scrap.is_abnormal` | migración 122 | ✅ existe |
| `tenant_quality_grades` (N calidades configurables) | migración 123 | ✅ existe |
| `shift_progress.quality_grade_id` | migración 123 | ✅ existe |
| `products.expected_sale_price` (para NRV) | migración 128 | ✅ existe |
| `products.default_quality_grade_id` | migración 128 | ✅ existe |
| `production_orders.accept_second_quality_for_fulfillment` | migración 129 | ✅ existe |
| `tenant_process_config.pt_goes_to_wip_first` | migración 116 | ✅ existe |

**Fase 2 es 100% trabajo de servicio** (sin SQL nuevo), salvo que aparezca un gap durante 6c/6d.

---

## 4. Gaps detectados por 6e (turno simulado)

El script [`simulate-recicladora-shift.js`](../../saas-base/scripts/simulate-recicladora-shift.js) corre end-to-end: crea warehouses + MP + producto + receta + stock + orden + turno + 3 capturas con calidades distintas + scrap + close + validate. Esto es lo que descubrió:

### 4.1 [WAREHOUSE_TYPES_LEGACY]
Módulo legacy `/api/warehouses` acepta solo tipos hardcoded: `raw_material/wip/finished_product/regrind/resale`. NO usa el catálogo SaaS v2 `tenant_warehouse_types` (con system_role `input/wip/output/scrap/blocked/resale`).

**Impacto**: "Merma vendible" tuvo que crearse como `type='regrind'` con `resin_type='PE'` forzado. Refactor pendiente — pero no bloqueante para Fase 2 (workaround viable).

### 4.2 [PRODUCT_PATCH_FIELDS]
`POST` y `PATCH /api/products` NO aceptan: `product_kind_id`, `default_quality_grade_id`, `expected_sale_price`, `is_produced`. Las columnas existen en DB (migración 128), pero el productService viejo no las expone.

**Impacto**: bloqueante para 6c (NRV requiere `expected_sale_price`). Workaround actual: UPDATE directo en DB.

### 4.3 [CAPTURE_QUALITY_GRADE_API]  → genera bloque 6f
`POST /api/production/shifts/:id/packages` NO acepta `quality_grade_id`. Solo soporta el booleano legacy `isSecondQuality` (+ opcionalmente `secondQualityProductId`). La columna `shift_progress.quality_grade_id` (migración 123) queda en NULL.

**Impacto**: **bloqueante para 6c**. Sin distinguir 3 calidades en la API, no se puede aplicar NRV multi-calidad. Refactor obligatorio del endpoint capturePackage + chain interno hasta `recordPackageCaptured`.

**Snapshot real del turno simulado**:
```
shift_progress (3):
  - 600 kg / 1u, is_sq=false, grade_id=NULL   ← debería ser primera
  - 200 kg / 1u, is_sq=true,  grade_id=NULL   ← debería ser segunda
  - 100 kg / 1u, is_sq=true,  grade_id=NULL   ← debería ser tercera (indistinguible)
```

### 4.4 [SCRAP_ENUM_LEGACY]
`POST /api/production/shifts/:id/scrap` requiere `scrapType` del enum hardcoded `scrap_type`: `arranque/operacion/contaminada/desecho`. Cualquier code SaaS v2 (`finos_polvo`, `etiquetas_tapas`) responde **500** con error de Postgres:
```
la sintaxis de entrada no es válida para el enum scrap_type: «finos_polvo»
```

**Impacto**: bloqueante para 6b. La función `recordScrap` (productionService.js:1406) sigue insertando solo en columnas legacy.

### 4.5 [SCRAP_TYPE_FK_NOT_POPULATED]
Aun con valor enum legacy aceptado, `recordScrap` NO resuelve a `tenant_scrap_types.id`. La FK `shift_scrap.scrap_type_id` queda NULL. Mismo problema con `recovery_value_pct` (NULL siempre).

### 4.6 [SCRAP_RECOVERY_NOT_POPULATED]
`recordScrap` no copia `default_recovery_value_pct` del catálogo a `shift_scrap.recovery_value_pct`. Tampoco evalúa `is_abnormal` contra `expected_scrap_pct`.

**Snapshot real**:
```
shift_scrap (1):
  - 50 kg desecho → venta, st_id=NULL, rec_pct=NULL, abnormal=false
```
Deberíamos haber tenido `st_id=<UUID de finos_polvo>`, `rec_pct=10`, `abnormal=false` (50/1200 = 4% < 15% esperado).

### 4.7 [PT_GOES_TO_WIP_FIRST_NEVER_READ]
El flag `tenant_process_config.pt_goes_to_wip_first` está en el schema (migración 116) y el script lo activa exitosamente vía PATCH — pero `grep -rn 'pt_goes_to_wip_first' saas-base/src/modules/production/` da **0 resultados**. La única referencia en productionService es vía el modelo D Opción C heredado del legacy (siempre mete a WIP por `recordPackageCaptured`).

**Impacto**: bloque 6d. El flag es un no-op. Tenants con `pt_goes_to_wip_first=false` también van a WIP, y tenants con `=true` no tienen endpoint de "supervisor libera de WIP → producto_terminado" — esa transición la hace `validateShift` (genérico) sin diferenciar el flag.

---

## 5. Estado final de Fase 2 — todos los bloques cerrados

Todos los bloques de Fase 2 están implementados y probados. La Recicladora es un vertical válido.

### Gaps menores pendientes (no bloqueantes para MVP)

- **[WAREHOUSE_TYPES_LEGACY]** — `/api/warehouses` solo acepta tipos hardcoded. Workaround: usar `type='regrind'` para almacén merma vendible.
- **[PRODUCT_PATCH_FIELDS extra]** — `product_kind_id` expuesto pero crear/actualizar la FK de kind con validación cross-tenant pendiente.

---

## 5. Verificar que todo sigue funcionando

```bash
cd "C:/Users/admin/CLON ERP CLAUDE/saas-base"
npm run migrate                 # debe decir "Already up to date"
npm test -- --forceExit         # 32 suites / 456 tests / 9 snapshots verdes (estado heredado de Fase 1)
```

---

**Última actualización**: 2026-05-24 después de 6b. Refactor de recordScrap + addScrap con catálogo SaaS v2 operativo. Helpers `scrapTypeResolver.js` (path id|code, validación cross-tenant + inactivo) + `abnormalScrapEvaluator.js` (cascada order_pct > recipe_pct, comparado contra MP cargado en turno). Backward compat: si el code no resuelve a catálogo, persiste solo en columnas legacy. Re-simulación end-to-end con `finos_polvo`: scrap_type_id poblado, recovery_value_pct=10, is_abnormal=false (50 < 1200×15%=180). 23 tests nuevos, suite 33/479. GAPs restantes: 6c (NRV), 6d (pt_goes_to_wip_first), 6f (capturePackage con quality_grade_id), más los 2 menores (warehouses legacy, product PATCH fields).
