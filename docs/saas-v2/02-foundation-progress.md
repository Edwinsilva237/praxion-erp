# SaaS v2 — Foundation Progress

> **Propósito de este documento**: punto de entrada para retomar el trabajo de Fase 0 sin fricción. Si llegas aquí (humano o agente nuevo) y necesitas avanzar, **leerlo completo toma 10 minutos** y deja todo listo para continuar.
>
> **Documentos hermanos**:
> - [`00-design.md`](./00-design.md) — diseño completo del SaaS v2 (~32k palabras, no leer todo de un tirón)
> - [`01-golden-master-pattern.md`](./01-golden-master-pattern.md) — patrón para tests del refactor

---

## 1. Dónde estamos ahora

**Fase 0 (Foundation): 10 de 10 hitos completados (100%). 🎉**

Sandbox tiene 11 migrations SaaS v2 aplicadas + 1 módulo nuevo (`process-config`) con 7 services + meta-schema validator (ajv) + 29 endpoints + 240 tests pasando. `raw_materials` extendida con 9 columnas nuevas (aditivo puro, código viejo intacto).

### Hitos del Foundation

| # | Hito | Estado | Migration(s) |
|---|---|:-:|---|
| 1 | `tenant_process_config` (flags globales) | ✅ | 116 |
| 2 | Permisos `process_config:*` y `tenant_catalogs:*` | ✅ | 117, 119 |
| 3 | Auto-seed trigger en tenants | ✅ | 120 |
| 4 | `tenant_units` + conversiones | ✅ | 118 |
| 5 | `tenant_warehouse_types` + extensión a warehouses | ✅ | 121 |
| 6 | `tenant_scrap_types` + extensión a shift_scrap | ✅ | 122 |
| 7 | `tenant_quality_grades` + extensión a shift_progress | ✅ | 123 |
| 8 | `tenant_shift_roles` + `production_shift_members` | ✅ | 124 |
| 9 | `tenant_product_kinds` (JSONB attribute/capture schemas) | ✅ | 125 |
| 10 | `raw_materials.item_kind` + `custom_attributes` + `unit_id` | ✅ | 126 |

Después de Fase 0 sigue Fase 1 (Palomitas) con recipes, lotes, etc.

---

## 2. Cómo verificar que todo sigue funcionando

```bash
cd "C:/Users/admin/CLON ERP CLAUDE/saas-base"

# 1. Verifica que las migrations están aplicadas
npm run migrate
# Output esperado: "Already up to date." (sin migrations nuevas)

# 2. Corre la suite completa
npm test -- --forceExit
# Output esperado:
#   Test Suites: 20 passed, 20 total
#   Tests:       240 passed, 240 total
#   Snapshots:   9 passed, 9 total
#   Time:        ~69 s
```

Si los números bajan, algo se rompió. Si suben, alguien agregó tests.

---

## 3. Inventario completo de lo que existe

### 3.1 Migrations aplicadas (orden cronológico)

```
116_tenant_process_config.js
117_process_config_permissions.js
118_tenant_units.js               (incluye tenant_unit_conversions + seed por tenant)
119_tenant_catalogs_permissions.js
120_tenant_catalogs_auto_seed.js  (trigger AFTER INSERT en tenants + función central)
121_tenant_warehouse_types.js     (extiende warehouses.warehouse_type_id + backfill enum→FK)
122_tenant_scrap_types.js          (extiende shift_scrap + backfill enum→FK + linked_raw_material_id)
123_tenant_quality_grades.js       (extiende shift_progress.quality_grade_id + backfill is_second_quality→1/2)
124_tenant_shift_roles.js          (catálogo de roles + tabla production_shift_members; sin trigger de sync todavía)
125_tenant_product_kinds.js        (familias de producto + attribute_schema/capture_schema JSONB con wrapper {version, fields[]})
126_raw_materials_extensions.js    (extensión aditiva: item_kind, unit_id, custom_attributes, default_warehouse_id, expected_yield_pct, requires_lot_tracking, requires_coa, default_shelf_life_days, standard_cost)
```

### 3.2 Módulo `process-config/` (7 services + validator + 1 routes)

```
src/modules/process-config/
├── processConfigService.js    — tenant_process_config (flags globales)
├── unitsService.js            — tenant_units + conversiones + convert() (motor)
├── warehouseTypesService.js   — tenant_warehouse_types
├── scrapTypesService.js       — tenant_scrap_types (linked_raw_material_id, allows_reprocess_of_expired)
├── qualityGradesService.js    — tenant_quality_grades (mínimo 1 activa)
├── shiftRolesService.js       — tenant_shift_roles (mínimo 1 activa + 1 requerida activa)
├── productKindsService.js     — tenant_product_kinds (JSONB schemas + auto-increment de version)
├── schemaValidator.js         — meta-schema con ajv + canonicalJSON para comparar JSONB
└── routes.js                  — 29 endpoints registrados bajo /api/process-config
```

Registrado en `src/app.js` línea ~94: `app.use('/api/process-config', ...)`.

### 3.3 Endpoints disponibles

| Recurso | GET list | GET id | POST | PATCH | Extra |
|---|:-:|:-:|:-:|:-:|---|
| process-config (flags) | ✅ | — | — | ✅ | — |
| units | ✅ | ✅ | ✅ | ✅ | — |
| unit-conversions | ✅ | — | ✅ | — | `POST /convert` |
| warehouse-types | ✅ | ✅ | ✅ | ✅ | — |
| scrap-types | ✅ | ✅ | ✅ | ✅ | — |
| quality-grades | ✅ | ✅ | ✅ | ✅ | — |
| shift-roles | ✅ | ✅ | ✅ | ✅ | — |
| product-kinds | ✅ | ✅ | ✅ | ✅ | — |

**Permisos requeridos:**
- `process_config:read/update` para `/api/process-config` (flags globales)
- `tenant_catalogs:read/update` para todos los demás (units, warehouse-types, scrap-types, quality-grades)

### 3.4 Tests

```
tests/integration/
├── process-config.test.js                    (16 tests)
├── process-config-units.test.js              (28 tests)
├── process-config-warehouse-types.test.js    (22 tests)
├── process-config-scrap-types.test.js        (19 tests)
├── process-config-quality-grades.test.js     (18 tests)
├── process-config-shift-roles.test.js        (23 tests)
├── process-config-product-kinds.test.js      (26 tests)
└── saas-v2-raw-materials-extensions.test.js  (14 tests — SQL directo, sin endpoints v2 todavía)
```

**Total nuevo de SaaS v2: 166 tests.** Más los 74 tests preexistentes (auth, billing, crud, isolation, reconcile + 9 golden masters de production).

---

## 4. Receta para agregar el siguiente catálogo (mecánico)

Tomando como referencia migrations 121, 122, 123, el patrón es **muy repetible**. Para añadir el próximo (`tenant_shift_roles`, `tenant_product_kinds`, etc.):

### Paso 1 — Migration

Crear `src/db/migrations/<N>_tenant_<nombre>.js` con:

1. **CREATE TABLE** con `tenant_id` FK a tenants ON DELETE CASCADE, columnas de la sección §2.2.X del [`00-design.md`](./00-design.md), `created_at/updated_at/created_by_user_id/updated_by_user_id` siguiendo la convención.
2. **CHECK constraints** para enums; **UNIQUE** `(tenant_id, code)` si aplica.
3. Índices: `(tenant_id, is_active)` típicamente.
4. **TRIGGER set_updated_at** invocando `trigger_set_updated_at()` (ya existe).
5. **Extensión aditiva** a tabla existente si aplica (ej. `shift_X.X_type_id` FK opcional + `CREATE INDEX IF NOT EXISTS`).
6. **`CREATE OR REPLACE FUNCTION seed_tenant_process_template_defaults(p_tenant_id UUID)`** copiando el bloque actual y agregando el nuevo INSERT al final.
7. **Aplicar seed a tenants existentes**:
   ```sql
   DO $$ DECLARE t_id UUID;
   BEGIN
     FOR t_id IN SELECT id FROM tenants LOOP
       PERFORM seed_tenant_process_template_defaults(t_id);
     END LOOP;
   END $$;
   ```
8. **Backfill** desde columna enum vieja si aplica (UPDATE ... FROM ...).
9. **down**: DROP TABLE + DROP COLUMN si aplica.

### Paso 2 — Service

Crear `src/modules/process-config/<X>Service.js` con la estructura de los existentes:
- Constantes para enums permitidos
- `list<X>()`, `get<X>()`, `create<X>()`, `update<X>()`
- Validaciones: tipos, rangos, enums, refs cross-tabla (ej. FK existe en el tenant)
- Audit log en create/update
- Errores con `.status = 400/404/409` para que el route handler haga `handleSvcError`

### Paso 3 — Routes

Editar `src/modules/process-config/routes.js`:
- `require` el nuevo service
- Agregar bloque al final con 4 rutas: GET list, GET id, POST, PATCH
- Todas con `checkPermission('tenant_catalogs', 'read'|'update')`
- Body acepta tanto snake_case como camelCase (`req.body.foo_bar ?? req.body.fooBar`)
- Use `handleSvcError(err, res, next)` que ya está al inicio

### Paso 4 — Tests

Crear `tests/integration/process-config-<x>.test.js` siguiendo el patrón:
- `afterAll` global (no por describe — ver anti-patrón en `01-golden-master-pattern.md`)
- 3 describes: GET (lista, filtros, by id), POST (create + validaciones), PATCH (update + soft-delete + 404)
- Apuntar a ~18-22 tests por catálogo

### Paso 5 — Verificación

```bash
npm run migrate                                         # aplicar migration
npm test -- tests/integration/process-config-<x>      # tests del catálogo nuevo
npm test -- --forceExit                                # suite completa, todo verde
```

**Tiempo estimado por migration completa**: 30-45 min.

---

## 5. Gotchas y decisiones importantes

### 5.1 La función central de seed

`seed_tenant_process_template_defaults(p_tenant_id UUID)` es **la pieza más importante** del Foundation. Vive en migration 120 originalmente y cada migration que agrega un catálogo **la reescribe completa** con `CREATE OR REPLACE` agregando su INSERT al final.

**Cómo se ejecuta:**
- Cuando se crea un tenant nuevo → trigger AFTER INSERT en tenants.
- Cuando se aplica una nueva migration → loop sobre tenants existentes (auto-heal).

**Por qué importa**: si te saltas esto, los tests fallarán porque `createTenant` en el factory de tests crea tenants nuevos que esperan tener los catálogos sembrados.

### 5.2 FKs sin ON DELETE CASCADE

Varias tablas viejas tienen FKs a `raw_materials`, `production_orders` y `production_shifts` **sin CASCADE**. Cuando borras un tenant en tests, la cascade falla por la FK.

Solución: `tests/helpers/factory.js` → `cleanupTestTenants()` pre-borra todas las hijas problemáticas antes de borrar el tenant. Si agregas una nueva tabla con FK sin CASCADE a alguna de estas, **agrégala al cleanup**.

Tablas actualmente pre-borradas en cleanup: `shift_progress`, `shift_scrap`, `shift_incidents`, `shift_mp_loads`, `order_mp_formula`.

### 5.3 Backward compat = columnas enum viejas se mantienen

Cada migration que reemplaza un enum (`warehouses.type`, `shift_scrap.scrap_type`, `shift_progress.is_second_quality`) **NO borra** la columna vieja. Solo agrega FK nuevo + backfill. Las cleanup migrations al final del proyecto (118+) borrarán todo lo viejo de un golpe.

Por ahora coexisten. El código nuevo del refactor debería leer del FK; el código viejo de production sigue leyendo del enum.

### 5.4 snake_case vs camelCase en body de routes

PostgreSQL devuelve columnas en snake_case. Frontend tiende a usar camelCase. Los routes aceptan **ambos**:

```js
req.body.default_destination ?? req.body.defaultDestination
```

Para no obligar al frontend a transformar.

### 5.5 Permisos `tenant_catalogs:*` son genéricos

Un solo par de permisos (`read`/`update`) cubre TODOS los catálogos del tenant. No hay `units:read`, `scrap_types:read`, etc. La granularidad por catálogo se difiere a post-MVP si algún tenant la pide.

### 5.6 El motor de conversión de unidades

`unitsService.convert()` resuelve en 3 fallbacks:
1. Conversión directa `from → to` si está en `tenant_unit_conversions`
2. Inversa `to → from` (calcula 1/factor al vuelo)
3. Vía base: `from → base → to` (dos saltos automáticos)

Esto significa que el seed solo tiene 8 conversiones pero el motor cubre cualquier par del mismo `unit_type`. Para el costeo futuro, esto es clave: las recetas pueden expresarse en cualquier unidad y el motor las convierte sin código nuevo.

### 5.7 Defaults sembrados (snapshot mental)

| Catálogo | Cantidad | Ejemplos |
|---|---|---|
| tenant_process_config | 1 fila | uses_lots=false, cost_method='weighted_avg', allergen_mode='priority_only', operation_mode='industrial' |
| tenant_units | 15 | kg(base), g, ton, L(base), mL, pza(base), docena, caja, tarima, m(base), cm, mm, m²(base), h(base), min |
| tenant_unit_conversions | 8 | kg→g (1000), ton→kg (1000), L→mL (1000), docena→pza (12), m→cm (100), m→mm (1000), cm→mm (10), h→min (60) |
| tenant_warehouse_types | 5 | materia_prima (input), embalaje (input), producto_terminado (output), merma (scrap, discard), wip (wip) |
| tenant_scrap_types | 4 | arranque, operacion (reprocess 30%), contaminada, desecho — todos is_normal=true |
| tenant_quality_grades | 3 | primera (counts=true, → producto_terminado), segunda, tercera (counts=false, → producto_terminado) |
| tenant_shift_roles | 5 | capturista (required, unique, can_capture/handover), supervisor (unique, can_validate/handover), calidad, alimentador (no-unique), maquinista (unique) |
| tenant_product_kinds | 0 | sin seed — cada tenant crea sus kinds (palomitas_dulces, pellet_pe, etc.) |
| raw_materials (extendida) | — | columnas nuevas con defaults: item_kind='raw_material', requires_lot_tracking=false, requires_coa=false; resto NULL |

Si necesitas saber el ID de un seed sembrado, el code es estable y único: `SELECT id FROM tenant_X WHERE tenant_id = ? AND code = ?`.

---

## 6. Próximos pasos en orden

**Foundation cerrado al 100%.** Las siguientes opciones son los caminos para arrancar Fase 1 (Palomitas).

### Camino A — Configurar primer tenant Palomitas (validación temprana)

**✅ EJECUTADO 2026-05-22 vía [`scripts/provision-palomitas.js`](../../saas-base/scripts/provision-palomitas.js).** Script idempotente HTTP (supertest contra app.js, sin server). Resultado: tenant 'palomitas-piloto' configurado en una pasada, segunda corrida 100% no-op (todos los pasos detectaron estado existente). Findings de DX en §10 más abajo.

Con los 6 catálogos completos + tipos de producto + raw_materials extendida, se puede configurar manualmente un tenant Palomitas via API:

```bash
# 1. Provisionar tenant nuevo (recibe los 6 catálogos auto-seeded)
POST /api/tenants/provision { slug: 'palomitas-piloto', ... }

# 2. Activar flags de alimentos
PATCH /api/process-config {
  uses_lots: true,
  uses_expiry: true,
  uses_fefo: true,
  cost_method: 'fifo',
  expiry_alert_days: 7
}

# 3. Personalizar tipos de merma (palomitas no usa los 4 defaults)
POST /api/process-config/scrap-types { code: 'sin_reventar', name: 'Granos sin reventar', default_destination: 'discard' }
POST /api/process-config/scrap-types { code: 'quemado', name: 'Quemado', default_destination: 'discard' }
DELETE /api/process-config/scrap-types/<arranque-id> (soft-delete)

# 4. Calidad única (palomitas no tiene 2da)
PATCH /api/process-config/quality-grades/<segunda-id> { is_active: false }
PATCH /api/process-config/quality-grades/<tercera-id> { is_active: false }

# 5. Crear el product_kind con captura schema-driven
POST /api/process-config/product-kinds {
  code: 'palomitas_dulces',
  name: 'Palomitas dulces',
  base_unit_id: <kg-id>,
  requires_lots: true,
  default_shelf_life_days: 180,
  default_quality_grade_id: <primera-id>,
  attribute_schema: { fields: [
    { code: 'sabor', label: 'Sabor', type: 'select',
      options: ['mantequilla','caramelo','queso','natural'], required: true },
    { code: 'tamano_bolsa', label: 'Tamaño', type: 'select',
      options: ['50g','100g','200g'], required: true },
  ]},
  capture_schema: { fields: [
    { code: 'peso_kg', label: 'Peso (kg)', type: 'number', unit_code: 'kg', required: true },
    { code: 'color', label: 'Color', type: 'select',
      options: ['blanco','amarillento'], required: true, lot_critical: true },
  ]},
}
```

Es ejercicio útil para validar la usabilidad de las APIs antes de empezar Fase 1.

### Camino B — Empezar Fase 1 (recipes + lotes + refactor de production)

Con Foundation cerrado, el próximo bloque del design (§2.2.9, §2.2.10, §2.4.2, §4) es:

1. **Migration 127** — `recipes` + `recipe_components` (reemplaza `order_mp_formula`).
2. **Migration 128** — `products` extendida con `product_kind_id`, `is_produced`, `custom_attributes`, `default_recipe_id`, etc. (§2.3.2).
3. **Migration 129** — `production_orders` extendida con `recipe_id`, `recipe_version_at_creation`, `accept_second_quality_for_fulfillment`, `custom_attributes`, `additional_costs` (§2.3.4).
4. **Migration 130** — `product_lots` + extensiones a `shift_progress.lot_id`, `shift_mp_loads.lot_id` (§4).
5. **Refactor `productionService.js`** detrás de los golden masters que ya existen.

Aquí ya entran las decisiones de Sección 4 (motor de lotes) y Sección 6 (handover/runtime). Volver a leer §4 del design antes de empezar.

### Camino C — Frontend de configuración (paralelo)

Si hay capacidad frontend, las pantallas de configuración del Process Template (`pages/Configuracion/Procesos/...`) se pueden empezar ahora. La pantalla más útil sería **Unidades + Conversiones** porque es donde más fácil se ve el valor (motor `convert()` en acción), o **Tipos de producto** que es la pieza que más diferencía a un tenant de otro.

### Camino D — Validación comercial

R-C1 del plan: identificar 2 tenants candidatos por vertical (8 totales). Sin esto, todo el Foundation se está construyendo a ciegas. Puede correr en paralelo con cualquiera de los anteriores.

---

## 7. Cómo navegar el repo

### Archivos críticos a conocer

| Path | Por qué importa |
|---|---|
| `saas-base/src/db/migrations/120_tenant_catalogs_auto_seed.js` | Función central de seed. Cada nueva tabla la extiende. |
| `saas-base/src/modules/process-config/routes.js` | Donde se registra cada nuevo recurso REST |
| `saas-base/src/app.js` línea ~94 | Donde el router de process-config se monta |
| `saas-base/tests/helpers/factory.js` | `cleanupTestTenants()` — agregar nuevas tablas hijas |
| `saas-base/tests/helpers/productionFactory.js` | Helpers HTTP para tests (no de SaaS v2 pero útil para tests de production) |
| `docs/saas-v2/00-design.md` | Diseño completo (referencia, no leer de un tirón) |
| `docs/saas-v2/01-golden-master-pattern.md` | Patrón para los tests del refactor de production |
| `docs/saas-v2/02-foundation-progress.md` | **Este documento.** Punto de entrada de cada sesión nueva. |

### Atajos para localizar cosas

```bash
# Ver todas las migrations SaaS v2 (116+)
ls saas-base/src/db/migrations/ | sort -V | grep -E "11[6-9]|12[0-9]"

# Ver lista de endpoints process-config
grep -n "router\." saas-base/src/modules/process-config/routes.js | head -30

# Contar tests por archivo
for f in saas-base/tests/integration/process-config*.test.js; do
  echo "$f: $(grep -c '^\s*test(' "$f") tests"
done
```

---

## 8. Riesgos / pendientes que vale la pena recordar

1. **Migration 125 con JSONB schemas necesita decisión** sobre meta-schema (JSON Schema Draft) y librería de validación (`ajv` recomendado). Es la única migration con incertidumbre técnica seria.

2. **Tests del refactor de productionService.js** (los golden masters) NO han ejercido los cambios todavía — siguen ejerciendo el código viejo. Cuando empecemos el refactor, hay que correrlos antes Y después de cada PR.

3. **No hay frontend SaaS v2 todavía.** Cada migration completa el backend pero el admin solo puede interactuar vía API directa. Es OK para Fase 0 pero un Frontend mínimo de Unidades + Calidades + Warehouse Types sería bueno antes de Fase 1.

4. **Validación comercial** sigue pendiente. R-C1 del riesgo doc — sin tenants identificados, todo este Foundation se está construyendo "a ciegas". Idealmente, en paralelo con Foundation o entre Fases, ir identificando candidatos.

5. **`order_mp_formula` se está volviendo obsoleta**: cuando llegue migration 127 (`recipes`), hay que decidir si los tenants existentes se quedan con `mp_formula` para órdenes pasadas o se migran. Decisión documentada en §2.6.4.

---

## 9. Si necesitas hacer rollback

Cada migration tiene su `down`. Para revertir las últimas N (en orden inverso):

```bash
cd "C:/Users/admin/CLON ERP CLAUDE/saas-base"
npm run migrate:rollback   # revierte la última aplicada
# repetir N veces para revertir las últimas N
```

**Cuidado**: los rollbacks de 120, 121, 122, 123 mantienen sembrado lo previo (la función `seed_tenant_process_template_defaults` solo se REPLACE no DROP). Es intencional para no romper tenants existentes.

---

## 10. Findings del piloto Palomitas (Camino A ejecutado)

Validación de las APIs de SaaS v2 corriendo el script de provisión completo. Lo que funcionó bien y lo que vale anotar como fricción para Fase 1.

### Funcionó sin fricción ✅

- **Auto-seed por trigger** entrega los 6 catálogos al tenant nuevo sin intervención.
- **Snake_case y camelCase** ambos aceptados en bodies de POST/PATCH (probado con snake_case en todo el script).
- **Validación FK cross-catálogo** correcta — `base_unit_id` y `default_quality_grade_id` rechazados si no son del tenant.
- **Auto-increment de schema.version** sale en 1 al crear (esperado).
- **Soft-delete (is_active=false)** funciona y la última activa se protege en `quality_grades` (probado: desactivar segunda y tercera deja solo primera, y un intento de desactivar primera devolvería 400).
- **Endpoints respondieron con los status codes esperados** (201/200/400/404/409) sin sorpresas.

### Fricciones leves (no bloquean Fase 1) ⚠️

1. **No hay `DELETE` REST** en scrap-types/quality-grades/etc.; el script usa PATCH `is_active=false`. Es por diseño (soft-delete), pero un alias `DELETE /:id` que internamente haga PATCH sería más idiomático REST y reduciría confusión para integradores. **Acción**: post-MVP, agregar el alias.
2. **No hay endpoint para borrar un tenant** — el script imprime un SQL `DELETE FROM tenants WHERE slug = ...` como instrucción de reset. Para piloto/demo sería útil un endpoint `DELETE /api/tenants/:slug` con guard de admin platform. **Acción**: post-MVP si se vuelve fricción real.
3. **Backend imprime debug logs muy verbosos** durante el script (cada query); el output útil queda enterrado. **Acción**: ajustar `LOG_LEVEL` cuando se corra el script, o silenciar en el script con `process.env.LOG_LEVEL = 'warn'` al inicio. No es fricción de las APIs, es config.

### Estado del tenant piloto (snapshot)

```
Slug:        palomitas-piloto
Admin email: admin@palomitas-piloto.local
Admin pass:  Palomitas!2026

Flags:               uses_lots=true, uses_expiry=true, uses_fefo=true, cost_method=fifo, expiry_alert_days=7
Scrap types activos: desecho, sin_reventar, quemado
Quality grades:      1: primera (única activa)
Product kinds:       palomitas_dulces (base=kg, shelf=180d, attr_v=1 con sabor/tamano/orgánico, cap_v=1 con peso/color/humedad)
```

Reset: `DELETE FROM tenants WHERE slug = 'palomitas-piloto';` (CASCADE limpia todo).

---

## 11. Glosario rápido de términos del Foundation

| Término | Significado |
|---|---|
| Process Template | Configuración por tenant del proceso productivo (todos los catálogos + flags) |
| Catálogo | Tabla `tenant_X` configurable por tenant (units, warehouse_types, etc.) |
| Foundation | Fase 0 — armar los catálogos base. Pre-requisito de todo lo demás. |
| Seed function | `seed_tenant_process_template_defaults` — siembra catálogos a un tenant |
| system_role | Rol funcional del almacén (input/output/scrap/wip) — lo que el motor entiende |
| linked_raw_material_id | Mermas reprocesables que se vuelven MP (papas rotas → combos) |

---

**Fin del documento de progreso. Última actualización**: 2026-05-22 después de migration 126 — **Foundation cerrado**.

> **Nota migration 124**: `production_shift_members` se creó pero el trigger de sincronización con `production_shifts.operator_id/supervisor_id` (design §2.4.1) se difirió. Se introducirá durante el refactor de `productionService.js`, una vez que los golden masters den red de seguridad. Por ahora la tabla es aditiva y no se escribe desde código.
>
> **Nota migration 125**: política de schema evolution implementada al mínimo — meta-schema validado con `ajv`, version del schema auto-incrementa cuando los fields cambian semánticamente (comparación canónica con keys ordenadas, necesario porque PostgreSQL JSONB reordena keys). La política completa de §2.2.8 (modal de confirmación al borrar campos con datos históricos) se implementa cuando existan datos reales referenciando product_kinds.
>
> **Nota migration 126**: extensión aditiva pura a `raw_materials`. NO se creó un service v2 — `rawMaterialService.js` viejo sigue siendo el único endpoint, los campos nuevos quedan disponibles pero solo se setean vía SQL directo por ahora. El service v2 vendrá durante el refactor de producción (Camino B en §6), cuando los golden masters cubran el código que consume `raw_materials`.

Si retomas el trabajo, empieza por ejecutar la sección 2 ("Cómo verificar que todo sigue funcionando") y leer la sección 4 ("Receta para agregar el siguiente catálogo"). Con eso estás listo para producir en 10 minutos.
