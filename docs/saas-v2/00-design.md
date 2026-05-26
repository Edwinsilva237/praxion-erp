# SaaS v2 — Documento de Diseño

> **Estado**: Diseño completo. Implementación Fase 0 al 50% — ver `02-foundation-progress.md`.
> **Última actualización**: 2026-05-22 (después de migration 123)
> **Autores**: Usuario + Claude
> **Documentos relacionados**:
> - [`02-foundation-progress.md`](./02-foundation-progress.md) — **Estado de implementación + receta para continuar.** Léelo primero si vienes a retomar el trabajo.
> - [`01-golden-master-pattern.md`](./01-golden-master-pattern.md) — Patrón de tests para el refactor del `productionService`.

---

## Índice

1. [Visión y alcance](#1-visión-y-alcance)
2. [Modelo de datos del Process Template](#2-modelo-de-datos-del-process-template)
3. [Motor de costeo y recosteo](#3-motor-de-costeo-y-recosteo)
4. [Lotes, caducidad y trazabilidad](#4-lotes-caducidad-y-trazabilidad)
5. [Mapeo del código actual](#5-mapeo-del-código-actual)
6. [Validación contra los 4 verticales](#6-validación-contra-los-4-verticales)
7. [Plan de fases del MVP](#7-plan-de-fases-del-mvp)
8. [Riesgos y mitigaciones](#8-riesgos-y-mitigaciones) ← *Sección actual*

---

## 1. Visión y alcance

### 1.1 Qué es

Convertir el ERP actual (hoy una **app vertical** construida para una planta de extrusión de plástico que produce esquineros PP/PE) en un **SaaS multi-tenant comercial** capaz de operar procesos productivos completamente distintos, configurándose por tenant sin tocar código.

El motor genérico que ya existe (cola de órdenes, turnos, captura, handover entre operadores, validación supervisor, kardex de inventario, fiscal/CFDI) se conserva. Lo que está **acoplado al plástico** (tipos de resina, gramos por metro lineal, mezcla con regrind, modelo D Opción C de costeo) se reemplaza por una **capa de configuración por tenant** + un **schema-driven capture form**.

### 1.2 Qué NO es

**A nivel funcional:**

- **NO es** un ERP genérico de manufactura discreta (ensamble, manufactura por estaciones, MRP completo). No modela procesos intermedios ni enrutamiento WIP entre estaciones — un proceso es **una etapa**: MP + Embalaje → PT + Merma.
- **NO es** un sistema de planeación de producción avanzada (APS, scheduling de capacidad finita, secuenciamiento de máquinas).
- **NO es** un sistema de calidad ISO/HACCP completo (no hay módulo de auditorías, no-conformidades, etc.).
- **NO es** self-service de tenant onboarding en MVP — los primeros tenants se configuran manualmente con apoyo del equipo.

**A nivel de alcance del refactor:**

Este documento cubre **únicamente el módulo de producción y sus piezas adyacentes** (materias primas, recetas, almacenes de producción, costeo de la fabricación). El resto del ERP **se queda como está** y no se toca:

- **Ventas, cotizaciones, notas de remisión, facturación CFDI (FacturAPI)** — sin cambios
- **Compras, recepción de mercancía, facturas de proveedor, pagos** — sin cambios
- **Cuentas por cobrar/pagar, conciliación bancaria, complementos de pago** — sin cambios
- **Catálogo de socios de negocio (clientes/proveedores)** — sin cambios
- **Caja chica, financieros, tipos de cambio** — sin cambios
- **Admin/tenants/users/roles/permisos** — sin cambios (la plataforma multi-tenant ya existe)

→ Esto importa porque el ERP ya vende **productos que NO se producen** (reventa, importación). El catálogo de productos es **unificado**.

### 1.3 Verticales objetivo

| # | Vertical | Características | Razón del orden |
|---|---|---|---|
| 1 | **Palomitas de maíz** | Alimento simple, pocos insumos, lotes obligatorios | Primer vertical alimentario — fuerza descubrir abstracciones de lotes/caducidad temprano cuando refactorizar es barato |
| 2 | **Recicladora de plásticos** | Industrial no-alimentario, multi-calidad (1ª/2ª/3ª), merma con valor | Valida que el motor funciona fuera de alimentos. Cercano al código actual. |
| 3 | **Frituras** | Alimento con múltiples sabores, alérgenos, embalaje crítico | Escala complejidad alimentaria |
| 4 | **Pastelería** | Recetas largas, decoración, vida útil corta, perecederos | Caso más complejo de alimentos — si encaja, el motor cubre cualquier alimento |

### 1.4 Cómo se integra producción con el resto del ERP

El producto terminado de producción **es uno más del catálogo de productos** que ofrece el tenant. Convive con productos de reventa, productos importados, productos comprados a terceros. La misma tabla `products`, el mismo SKU, el mismo flujo de inventario, el mismo motor de ventas y facturación.

```
        ┌─────────────────────────────────────────────────┐
        │              CATÁLOGO ÚNICO DE PRODUCTOS         │
        │  (un SKU por producto, sin importar su origen)   │
        └────────────────────┬────────────────────────────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                          │
        ▼                                          ▼
   ┌──────────┐                              ┌──────────┐
   │ PRODUCTOS │                              │ PRODUCTOS│
   │FABRICADOS│                              │ DE REVENTA│
   └─────┬────┘                              └─────┬────┘
         │                                          │
         ▼                                          ▼
   ┌──────────────┐                          ┌──────────┐
   │ PRODUCCIÓN   │                          │  COMPRAS │
   │ (este doc)   │                          │ (no toca)│
   └─────┬────────┘                          └─────┬────┘
         │                                          │
         └──────────────┬───────────────────────────┘
                        ▼
              ┌─────────────────┐
              │   INVENTARIO    │
              │  (movimientos)  │
              │   no se toca    │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │     VENTAS      │
              │   FACTURACIÓN   │
              │   no se toca    │
              └─────────────────┘
```

**Lo único que cambia desde la perspectiva del producto fabricado:**

- El producto fabricado lleva metadatos adicionales del lado de producción (receta, ficha técnica, schema de captura, atributos custom como sabor/color/grados).
- Esos metadatos viven en **tablas nuevas** que **referencian** `products.id`, no que la sobrescriben.
- El producto de reventa simplemente **no tiene** esas tablas asociadas — sigue funcionando idéntico que hoy.

**Implicación para el refactor:**

- Los campos que se agregan a `products` son **aditivos**: nuevas columnas opcionales (NULL por default) o tablas nuevas FK a products. Nunca renombramos ni eliminamos columnas que ventas/compras consumen.
- Cualquier tabla compartida (`products`, `warehouses`, `inventory_stock`, `inventory_movements`, `inventory_levels`) se **extiende**, no se rediseña.
- Los nuevos `warehouse_type` que produce la configuración del tenant (MP, Embalaje, Merma, etc.) **conviven** con los tipos existentes que ya usan compras/ventas.

### 1.5 Estado actual del código

**Lo que ya existe y funciona** (motor genérico — se conserva):

- Ciclo de orden: `draft → released → in_progress → fulfilled → completed`
- Cola de órdenes con prioridades y reordenamiento drag-drop
- Turnos con operador/supervisor, apertura/cierre/validación
- Handover entre turno saliente y entrante
- Captura de paquetes con peso real vs teórico
- Cargas de MP, mermas, incidencias
- Correcciones dual-mode (operador <30 min vs supervisor con razón)
- Programación de turnos
- Kardex de inventario con movimientos referenciados
- Niveles min/max/reorder_point automáticos
- CFDI 4.0 vía FacturAPI (se conserva como dependencia)
- Multi-tenant ya implementado en el esquema (tenant_id en cada tabla)

**Lo que está acoplado al plástico** (se refactoriza):

- Enums hardcoded: `resin_type` (PP/PE), `material_type` (virgin/regrind), `scrap_type`, `warehouse_type`, `incident_category`
- Atributos fijos en `products`: `length_mm`, `width_mm`, `thickness_mm`, `grams_per_linear_meter`
- Fórmula de mezcla con máximo 4 materiales (`order_mp_formula`)
- Modelo D Opción C de costeo (regrind a `avg_cost × 1.2`, virgen consumo real)
- Captura fija (`real_weight_kg`, `length_mm`, segunda calidad con producto destino único)
- Tipos de almacén fijos: `raw_material`, `regrind`, `wip`, `finished_product`, `resale`

**Lo que no existe y hay que construir** (nuevo):

- Sistema de Process Templates por tenant
- Registro de unidades configurables con conversiones
- Schema dinámico de atributos por tipo de producto (JSONB + validación)
- BOM/Recetas con N componentes (sin límite de 4)
- Lotes y caducidad (obligatorio para 3 de 4 verticales)
- Captura overhead con frecuencia y base de prorrateo configurables
- Recosteo mensual con variance report (estimated vs real)
- Estrategia de costeo pluggable (descartar Modelo D fijo)

### 1.6 Decisiones consolidadas

#### Process Template (configuración por tenant)

| Área | Decisión |
|---|---|
| Almacenes | MP, Embalaje, Merma (con destino: reprocesa/desecha/vende), PT |
| Flujo PT | Configurable: directo a disponible **o** pasa por WIP hasta validación |
| Calidades | N configurable (cap 5), default 3 (apta/segunda/tercera) |
| Unidades | Configurables por tipo de item (MP/Embalaje/PT) con conversiones |
| Receta/BOM | N componentes, sin límite duro |
| Captura | Schema-driven según producto (sabor, peso, litros, color…) |
| Roles del turno | Capturista obligatorio + N opcionales (calidad, supervisor, alimentador, etc.) |
| Handover | Configurable: ¿existe?, ¿quién entrega?, ¿quién recibe? |
| Supervisor | Opcional por tenant; si existe, define qué libera/valida |
| Lotes/trazabilidad | Flag por tenant (obligatorio para alimentos por NOM-251) |
| Una orden | 1 PT objetivo + sub-productos por calidad |
| Cumplimiento de orden | Default solo calidad 1; flag opcional para aceptar segundas |
| Incidencias | Captura libre, sin catálogo |
| Procesos intermedios | **Fuera de alcance MVP** (1 etapa: MP → PT + Merma) |
| OEE | No es módulo; campo "velocidad estándar" opcional + reporte futuro |

#### Modelo de costeo

| Área | Decisión |
|---|---|
| Estructura | Híbrido: por orden (MP + embalaje real) + prorrateo por turno (overhead) |
| Prorrateo intra-turno | Por tiempo (default), configurable |
| Merma normal con valor | RESTA del costo a valor de recuperación |
| Merma normal sin valor | Implícita (queda en el costo de las unidades buenas) |
| Merma anormal | Cuenta de pérdida, fuera del costo del producto |
| Captura overhead | Catálogo por tenant con frecuencia (mensual/quincenal/semanal/evento) + base de prorrateo individual |
| Recosteo mensual | Estimated + real guardados ambos — nunca se sobrescribe la historia |
| Cierre de mes | Manual, rol contable, con re-aperturas controladas |
| Gastos anuales | Captura única, prorrateo automático 1/12 |

### 1.7 Restricciones del proyecto

- **Equipo**: usuario + Claude. Sin equipo adicional.
- **Financiamiento**: la planta actual (operando con otro sistema, no con este código).
- **Sin deadline**. Calidad > velocidad.
- **Dependencia inamovible**: FacturAPI para CFDI 4.0 — se conserva la integración existente.
- **Camino elegido**: **C (Híbrido)**. Extraer motor genérico que ya existe, construir capa de configuración encima. La planta actual no depende de este código, así que hay libertad total para refactorizar.

### 1.8 Compliance — alimentos (3 de 4 verticales)

Palomitas, frituras y pastelería son alimentos procesados regulados en México por:

- **NOM-251-SSA1-2009** — Buenas Prácticas de Higiene
- **NOM-051-SCFI/SSA1-2010** — Etiquetado
- Vigilancia de **COFEPRIS**

Implicaciones técnicas no negociables:

- **Lotes obligatorios** en MP y PT
- **Caducidad/vida útil** por lote
- **FIFO/FEFO** en inventario
- **Trazabilidad backward** — dado un lote de PT, identificar qué lotes de MP se usaron (para retiros sanitarios)
- **Alérgenos** declarados en producto y heredados por lote

→ Para tenants no-alimentarios (recicladora) los lotes son opcionales via flag. **Pero el motor de lotes existe en el MVP, no es post-MVP.**

### 1.9 Glosario rápido

| Término | Significado en este documento |
|---|---|
| **Process Template** | Configuración por tenant que define su proceso productivo: catálogos, unidades, schema de captura, roles, calidades, etc. |
| **Tenant** | Cliente del SaaS — una empresa con su propia planta y proceso. |
| **Vertical** | Industria objetivo (palomitas, recicladora, frituras, pastelería). |
| **MP** | Materia prima. |
| **PT** | Producto terminado. |
| **WIP** | Work in progress (producto en proceso, no liberado a inventario disponible). |
| **Overhead** | Costos indirectos del turno: renta, luz, nómina, mantenimiento, depreciación. |
| **Variance** | Diferencia entre overhead estimado (aplicado durante el mes) y overhead real (capturado al cierre). |
| **FIFO/FEFO** | First In First Out / First Expired First Out — orden de consumo de lotes. |

---

---

## 2. Modelo de datos del Process Template

### 2.1 Filosofía del diseño

El modelo está organizado en **tres capas**:

```
┌────────────────────────────────────────────────────────────────┐
│  CAPA 1 — CATÁLOGOS POR TENANT  (tablas nuevas, configurables) │
│  Unidades, tipos de almacén, tipos de merma, calidades,         │
│  roles de turno, tipos de producto, recetas, overhead…          │
└─────────────────────────┬──────────────────────────────────────┘
                          │ FK
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  CAPA 2 — EXTENSIONES A TABLAS EXISTENTES  (columnas aditivas)  │
│  products, raw_materials, warehouses, production_orders,        │
│  production_shifts, shift_progress, shift_scrap, shift_mp_loads │
└─────────────────────────┬──────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  CAPA 3 — TABLAS DE RUNTIME  (lo que produce el día a día)      │
│  Snapshots de receta, capturas dinámicas, lotes, movimientos    │
└────────────────────────────────────────────────────────────────┘
```

**Principios de diseño:**

1. **Aditivo, nunca destructivo** — ninguna columna existente se elimina ni renombra. Las extensiones son columnas nuevas (NULL-able) y tablas FK.
2. **Catálogos > enums** — todo enum que el tenant podría querer cambiar se reemplaza por una tabla `tenant_*`.
3. **Schema-driven con JSONB** — los atributos custom (sabor, color, longitud, sabor) viven en JSONB validado contra un schema definido por el tenant. Evitamos EAV (entity-attribute-value) porque es lento y agreste de consultar.
4. **Multi-tenant en todo** — cada tabla nueva lleva `tenant_id` con FK y un índice compuesto `(tenant_id, ...)`.
5. **Auditoría heredada** — todas las tablas nuevas heredan el patrón `created_at`, `updated_at`, `created_by_user_id` que ya usa el ERP. **Convención uniforme**: nunca usar variantes como `change_by_user_id`, `modified_by_user_id`, etc. Solo `created_by_user_id`/`updated_by_user_id`/`finalized_by_user_id` con verbos consistentes.
6. **Soft-delete por flag `is_active`** — no se usa `deleted_at` en ninguna tabla. Política uniforme: `is_active=false` para inactivar; histórico jamás se borra (cumplimiento NOM-251 y auditoría).

---

### 2.2 Capa 1 — Catálogos por tenant (tablas nuevas)

#### 2.2.1 `tenant_process_config` — configuración global del tenant

Una sola fila por tenant. Almacena los **flags** que activan/desactivan capacidades del motor.

**Versionado parcial (Decisión C)**: los flags que **afectan retroactivamente al costeo** (`cost_method`, `treat_abnormal_scrap_as_loss`) tienen su propia tabla satélite `tenant_cost_config_history` con `(valid_from, valid_until)`. Esto permite recostear correctamente períodos pasados con el método vigente en ese momento. Los demás flags solo registran cambios en `audit_logs` y no se versionan formalmente.

**Tabla satélite `tenant_cost_config_history`:**

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID FK | — |
| `cost_method` | VARCHAR(20) | `weighted_avg` / `fifo` / `standard` |
| `treat_abnormal_scrap_as_loss` | BOOLEAN | — |
| `valid_from` | TIMESTAMPTZ | — |
| `valid_until` | TIMESTAMPTZ NULL | NULL = vigente |
| `changed_by_user_id` | UUID FK | — |
| `change_reason` | TEXT | Obligatorio si reemplaza versión anterior |

El motor de costeo SIEMPRE consulta `tenant_cost_config_history` con el `valid_from/valid_until` del turno/orden que se está costeando, no el flag actual de `tenant_process_config`.

| Columna | Tipo | Default | Descripción |
|---|---|---|---|
| `tenant_id` | UUID PK | — | FK a `tenants.id` |
| `uses_lots` | BOOLEAN | false | Activar trazabilidad por lotes (obligatorio para alimentos) |
| `uses_expiry` | BOOLEAN | false | Manejar fecha de caducidad por lote |
| `uses_fefo` | BOOLEAN | false | Aplicar FEFO en consumo de MP |
| `uses_handover` | BOOLEAN | true | Requiere handover entre turnos |
| `uses_supervisor` | BOOLEAN | true | Existe rol de supervisor |
| `supervisor_validates` | BOOLEAN | true | Supervisor libera turno antes de cerrar |
| `pt_goes_to_wip_first` | BOOLEAN | true | PT pasa por WIP antes de disponible; si false, va directo a disponible |
| `mp_goes_to_wip_first` | BOOLEAN | true | MP consumida pasa por WIP en captura |
| `allow_second_quality_in_order` | BOOLEAN | false | Las segundas/terceras cuentan al cumplimiento de la orden |
| `default_intra_shift_proration` | VARCHAR(20) | 'time' | Default: `time` / `units` / `weight` / `manual` |
| `cost_method` | VARCHAR(20) | 'weighted_avg' | Default: `weighted_avg` / `fifo` / `standard` |
| `treat_abnormal_scrap_as_loss` | BOOLEAN | true | Merma sobre % normal va a cuenta de pérdida |
| `allergen_mode` | VARCHAR(20) | 'priority_only' | `strict` / `priority_only` / `alert_only` (ver §4.9) |
| `expiry_alert_days` | INTEGER | 7 | Días antes de caducidad para alertar (NULL = sin alerta) |
| `lot_number_pattern` | VARCHAR(80) | NULL | Patrón default tenant-wide para generación de lotes (ver §4.5) |
| `operation_mode` | VARCHAR(20) | 'industrial' | `industrial` / `small` / `micro` — escala operativa (ver §6.6 hallazgo #7) |
| `allow_adhoc_shifts` | BOOLEAN | false | Permite turnos sin programación previa (recomendado true para small/micro) |
| `simplified_overhead` | BOOLEAN | false | UI simplificada: un solo monto mensual en lugar de catálogo detallado |
| `created_at`, `updated_at` | TIMESTAMPTZ | NOW() | — |

#### 2.2.2 `tenant_units` — registro de unidades de medida

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | FK a tenants |
| `code` | VARCHAR(20) | `kg`, `L`, `pza`, `m`, `m2`, `caja`, `tarima`, etc. |
| `name` | VARCHAR(80) | "Kilogramo", "Pieza", "Caja de 24" |
| `symbol` | VARCHAR(10) | `kg`, `L`, `pz` |
| `unit_type` | VARCHAR(20) | `weight` / `volume` / `count` / `length` / `area` / `time` |
| `is_base` | BOOLEAN | Es la unidad base de su tipo (1 base por tenant por unit_type) |
| `decimals` | SMALLINT | Cuántos decimales mostrar (kg=3, pza=0, L=2) |
| `is_active` | BOOLEAN | — |
| `sort_order` | INTEGER | — |
| `created_at`, `created_by_user_id` | — | — |

**Constraint:** UNIQUE `(tenant_id, code)`. Constraint check: solo una `is_base=true` por `unit_type`.

#### 2.2.3 `tenant_unit_conversions` — conversiones entre unidades del mismo tipo

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `from_unit_id` | UUID | FK a tenant_units |
| `to_unit_id` | UUID | FK a tenant_units |
| `factor` | NUMERIC(18,6) | from × factor = to (ej. 1 caja = 24 pza → factor 24) |
| `is_active` | BOOLEAN | — |

**Constraint:** from y to deben tener el mismo `unit_type`.

#### 2.2.4 `tenant_warehouse_types` — tipos de almacén configurables

Reemplaza el enum hardcoded (`raw_material`, `regrind`, `wip`, `finished_product`, `resale`).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `code` | VARCHAR(30) | `materia_prima`, `embalaje`, `merma`, `producto_terminado`, etc. |
| `name` | VARCHAR(80) | Lo que ve el usuario |
| `system_role` | VARCHAR(20) | **Qué rol cumple en el motor**: `input` / `wip` / `output` / `scrap` / `blocked` / `resale` |
| `default_scrap_destination` | VARCHAR(20) | Solo aplica si `system_role='scrap'`: `reprocess` / `discard` / `sell`. Sirve como **default** del almacén; cada `tenant_scrap_types.default_destination` puede override por tipo de merma específico. |
| `color` | VARCHAR(7) | Color en UI (`#FF5733`) |
| `sort_order` | INTEGER | — |
| `is_active` | BOOLEAN | — |

**Concepto clave**: `code` es el nombre del tenant, `system_role` es lo que el motor consume. Esto permite que un tenant tenga "Cámara de refrigeración" como `code` pero internamente sea `system_role='output'`.

**Precedencia de `default_destination` en mermas**: `tenant_scrap_types.default_destination` (por tipo de merma) **gana** sobre `tenant_warehouse_types.default_scrap_destination` (por almacén). El almacén solo aplica como fallback si el tipo de merma no lo especifica.

#### 2.2.5 `tenant_scrap_types` — tipos de merma configurables

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `code` | VARCHAR(30) | `arranque`, `contaminada`, `quemada`, `granos_sin_reventar`, etc. |
| `name` | VARCHAR(80) | — |
| `default_destination` | VARCHAR(20) | `reprocess` / `discard` / `sell` |
| `default_recovery_value_pct` | NUMERIC(5,2) | % del costo original que se recupera (0–100). 0 si no tiene valor. |
| `is_normal` | BOOLEAN | TRUE = normal (entra al costo); FALSE = anormal (cuenta de pérdida) |
| `linked_raw_material_id` | UUID NULL | FK a `raw_materials`. Si está set, al registrarse esta merma el sistema **incrementa el stock** del raw_material vinculado. Permite que mermas reprocesables (papas rotas → combos, regrind, etc.) funcionen como MP consumible (ver §6.6 hallazgo #1). |
| `allows_reprocess_of_expired` | BOOLEAN DEFAULT false | Si TRUE, lotes que caducan no se bloquean sino que pasan a este tipo de merma para reproceso (ver §4.8.3). |
| `sort_order` | INTEGER | — |
| `is_active` | BOOLEAN | — |

#### 2.2.6 `tenant_quality_grades` — calidades configurables

N calidades por tenant (rango **1-5**, default 3). Mínimo 1 (siempre hay al menos "calidad apta"), máximo 5.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `grade_number` | SMALLINT | 1, 2, 3, 4, 5 (1 = mejor) |
| `code` | VARCHAR(30) | `primera`, `segunda`, `tercera` |
| `name` | VARCHAR(80) | "Calidad apta", "Segunda" |
| `counts_for_order_fulfillment` | BOOLEAN | Default: true para grade=1, false para los demás |
| `goes_to_warehouse_type_id` | UUID | FK a `tenant_warehouse_types` (típicamente PT principal o PT bloqueado) |
| `default_color` | VARCHAR(7) | — |
| `sort_order` | INTEGER | — |
| `is_active` | BOOLEAN | — |

**Constraint:** UNIQUE `(tenant_id, grade_number)`. CHECK `grade_number BETWEEN 1 AND 5`.

#### 2.2.7 `tenant_shift_roles` — roles del turno configurables

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `code` | VARCHAR(30) | `capturista`, `calidad`, `supervisor`, `alimentador`, `maquinista` |
| `name` | VARCHAR(80) | — |
| `is_required` | BOOLEAN | Capturista=true, resto=false |
| `is_unique_per_shift` | BOOLEAN | Solo 1 supervisor por turno; pero puede haber 2 alimentadores |
| `can_capture` | BOOLEAN | Tiene permiso de capturar paquetes |
| `can_validate` | BOOLEAN | Puede liberar/validar turno |
| `can_handover` | BOOLEAN | Puede entregar/recibir turno |
| `sort_order` | INTEGER | — |
| `is_active` | BOOLEAN | — |

#### 2.2.8 `tenant_product_kinds` — tipos de producto del tenant

Define las "familias" de productos que produce el tenant, y para cada familia los **atributos custom** y el **schema de captura**.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `code` | VARCHAR(50) | `palomitas_dulces`, `pellet_pe`, `pan_dulce`, `frituras_papa` |
| `name` | VARCHAR(120) | — |
| `is_produced` | BOOLEAN | TRUE = se fabrica (tiene receta + captura); FALSE = solo reventa/compra |
| `base_unit_id` | UUID | FK a `tenant_units` (la unidad en la que se mide el inventario de este kind) |
| `attribute_schema` | JSONB | Schema de atributos custom (ver detalle abajo) |
| `capture_schema` | JSONB | Schema de qué se captura en `shift_progress` (ver detalle abajo) |
| `requires_lots` | BOOLEAN | Si productos de este kind usan lotes (heredado del flag global pero overridable) |
| `default_shelf_life_days` | INTEGER | Vida útil default en días (NULL = sin caducidad) |
| `default_quality_grade_id` | UUID | FK a `tenant_quality_grades` (qué grade es el default al capturar) |
| `is_active` | BOOLEAN | — |

**Detalle de `attribute_schema` (JSONB):**

Un array de definiciones de atributos. Ejemplo para `palomitas_dulces`:

```json
[
  {
    "code": "sabor",
    "label": "Sabor",
    "type": "select",
    "options": ["mantequilla", "caramelo", "queso", "natural"],
    "required": true
  },
  {
    "code": "tamano_bolsa",
    "label": "Tamaño bolsa",
    "type": "select",
    "options": ["50g", "100g", "200g"],
    "required": true
  },
  {
    "code": "es_orgánico",
    "label": "Orgánico",
    "type": "boolean",
    "default": false
  }
]
```

Tipos soportados: `text`, `number`, `boolean`, `select`, `multiselect`, `date`, `color`.

**Detalle de `capture_schema` (JSONB):**

Lista de campos que el operador captura por cada paquete (microlote). Ejemplo para `pellet_pe`:

```json
[
  {
    "code": "peso_kg",
    "label": "Peso (kg)",
    "type": "number",
    "unit_code": "kg",
    "required": true,
    "validation": {"min": 0, "max": 1000}
  },
  {
    "code": "color_observado",
    "label": "Color observado",
    "type": "select",
    "options": ["blanco", "amarillento", "gris"],
    "required": true,
    "lot_critical": true
  },
  {
    "code": "humedad_pct",
    "label": "Humedad (%)",
    "type": "number",
    "required": false
  }
]
```

**Campos especiales del schema:**

- `lot_critical: true` — si dos microlotes del mismo (producto × turno × calidad) capturan valores **distintos** en este campo, se generan **lotes separados** (`product_lots` independientes). Útil cuando un atributo afecta la identidad física del producto (color, sabor, etc.).
- `ui_hint` — pista de presentación para el frontend (`preset_buttons`, `large_keypad`, `barcode_scanner`).
- `presets` — array de valores comunes para botones de acceso rápido.

**Regla precisa de agrupación de lotes**: un microlote pertenece al mismo `product_lot` si comparte: `(product_id, shift_id, quality_grade_id, all_lot_critical_attribute_values)`. Si cualquiera difiere, se crea lote nuevo.

Esto es lo que vuelve a la UI **schema-driven**: el frontend genera el formulario dinámicamente leyendo `capture_schema`.

**Política de evolución de schema (Decisión B):**

`attribute_schema` y `capture_schema` cambian con el tiempo (tenants agregan/quitan campos). Para evitar romper datos históricos:

| Operación | Comportamiento |
|---|---|
| **Agregar campo** | Permitido siempre. Datos viejos quedan sin el campo (NULL implícito). Si es `required`, solo aplica a capturas nuevas. |
| **Renombrar campo** (cambiar `code`) | Permitido con migración explícita: sistema ofrece "rename code X → Y en todos los registros" o "tratar como campo nuevo y dejar histórico con el code viejo". |
| **Cambiar tipo de campo** | **Bloqueado** si hay datos históricos. Requiere migración manual: usuario debe crear campo nuevo, migrar datos con UI, luego marcar el viejo como `deprecated`. |
| **Quitar campo** | Modal de confirmación: "N registros históricos tienen este campo. Datos quedarán en `dynamic_attributes` pero no aparecerán en UI ni en reportes nuevos. ¿Continuar?" — al confirmar, el campo se marca `deprecated: true` en el schema, no se borra físicamente. |
| **Cambiar `options` de un select** | Permitido (agregar nuevas opciones). Quitar opciones existentes: solo si no hay datos históricos con esa opción, o modal de confirmación. |

**Convención técnica**: el `attribute_schema` lleva un campo `version` (entero auto-incremental). Cada registro de `products.custom_attributes` también almacena `_schema_version: N` para saber con qué versión se capturó. Los reportes consultan ambos.

**Meta-schema (validador del schema)**: el JSON que define `attribute_schema` y `capture_schema` se valida contra un meta-schema fijo (JSON Schema Draft 2020-12) en backend usando `ajv`. La UI valida primero con el mismo schema para feedback inmediato.

**UI hints para líneas de alta velocidad:**

Los campos del schema pueden incluir hints de UI para acelerar la captura en líneas rápidas (ej. 1 producto cada 30 segundos):

```json
{
  "code": "unidades",
  "type": "number",
  "default": 24,
  "ui_hint": "preset_buttons",
  "presets": [
    {"label": "Caja completa", "value": 24},
    {"label": "Media caja", "value": 12},
    {"label": "Pallet", "value": 960}
  ]
}
```

**Patrones de captura por velocidad de línea:**

| Velocidad de línea | Estrategia | Frecuencia de captura |
|---|---|---|
| Lenta (< 1 unidad/min) | Captura por unidad o por microlote pequeño | Por unidad o cada 5-10 unidades |
| Media (1-30 unidades/min) | Captura por empaque secundario (caja) | Cada 5-15 min |
| Rápida (30-120 unidades/min) | Captura por pallet o cumulativa horaria | Cada 30-60 min |
| Muy rápida (> 120 unidades/min) | Captura por pallet o asistida por scanner (post-MVP) | Cada turno o automática |

**El modelo no impone una granularidad** — el operador (o el `capture_schema`) decide cuántas unidades agrupa por microlote. Un turno puede tener desde 1 microlote (pallet único al cierre) hasta cientos (captura por caja en línea rápida con scanner).

Todos los microlotes del mismo (producto × turno × calidad) se asocian automáticamente al **mismo `product_lot`** — no se genera un lote por microlote.

#### 2.2.9 `recipes` — recetas/BOM por producto

Reemplaza `order_mp_formula` (hardcoded a 4 materiales).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `product_id` | UUID | FK a `products` (el PT que produce esta receta) |
| `version` | INTEGER | 1, 2, 3… (auto-increment por producto) |
| `name` | VARCHAR(120) | Opcional, default: `"Receta v{version}"` |
| `yield_quantity` | NUMERIC(18,6) | Cuánto PT se obtiene de una corrida estándar de la receta |
| `yield_unit_id` | UUID | FK a `tenant_units` |
| `expected_scrap_pct` | NUMERIC(5,2) | % de merma normal esperada (para distinguir anormal) |
| `valid_from` | TIMESTAMPTZ | NOW() al crear |
| `valid_until` | TIMESTAMPTZ | NULL = vigente; se setea al crear nueva versión |
| `is_active` | BOOLEAN | — |
| `created_at`, `created_by_user_id` | — | — |

**Constraint:** Solo una receta con `valid_until IS NULL` por producto.

#### 2.2.10 `recipe_components` — ingredientes de la receta

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `recipe_id` | UUID | FK a `recipes` |
| `raw_material_id` | UUID | FK a `raw_materials` (incluye MP y embalaje gracias al `item_kind`) |
| `quantity` | NUMERIC(18,6) | Cantidad por la corrida estándar |
| `unit_id` | UUID | FK a `tenant_units` |
| `is_optional` | BOOLEAN | Saborizantes opcionales, decoraciones |
| `substitute_group` | VARCHAR(40) | Si dos componentes son intercambiables (ej. "aceite_a" y "aceite_b" con mismo `substitute_group='aceite'`) |
| `notes` | TEXT | — |
| `sort_order` | INTEGER | — |

#### 2.2.11 `tenant_overhead_items` — catálogo de gastos indirectos

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `name` | VARCHAR(120) | "Renta", "Luz CFE", "Nómina supervisor", "Mantenimiento preventivo" |
| `category` | VARCHAR(30) | `costo_fijo` / `servicios` / `mano_obra_indirecta` / `mantenimiento` / `depreciacion` / `otros` |
| `capture_frequency` | VARCHAR(20) | `monthly` / `biweekly` / `weekly` / `event` / `annual` |
| `allocation_base` | VARCHAR(20) | `shifts` / `hours` / `units` / `weight` / `lines` / `equal` |
| `applies_to_line_id` | UUID | NULL = todas las líneas; si != NULL, solo prorratea entre turnos de esa línea |
| `default_estimated_amount` | NUMERIC(18,2) | Monto que se prellena cada vez que se abre un período nuevo |
| `is_active` | BOOLEAN | — |
| `created_at`, `created_by_user_id` | — | — |

#### 2.2.12 `tenant_overhead_periods` — captura por período

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `overhead_item_id` | UUID | FK a `tenant_overhead_items` |
| `period_start` | DATE | Inicio del período (1 de mes, lunes de la semana, etc.) |
| `period_end` | DATE | Fin del período |
| `estimated_amount` | NUMERIC(18,2) | Monto estimado al inicio del período |
| `real_amount` | NUMERIC(18,2) | Monto real (NULL hasta que se captura) |
| `is_finalized` | BOOLEAN | TRUE cuando el real se captura y se cierra el período |
| `finalized_at` | TIMESTAMPTZ | — |
| `finalized_by_user_id` | UUID | — |
| `notes` | TEXT | — |
| `created_at` | TIMESTAMPTZ | — |

**Constraint:** UNIQUE `(tenant_id, overhead_item_id, period_start)`.

---

### 2.3 Capa 2 — Extensiones a tablas existentes

**Regla**: solo columnas nuevas NULL-able. Nada se renombra ni elimina.

#### 2.3.1 `raw_materials` (extendida)

Esta tabla pasa a ser el catálogo unificado de **MP + Embalaje + Aditivos**.

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `item_kind` | VARCHAR(20) DEFAULT `'raw_material'` | `raw_material` / `packaging` / `additive` |
| `unit_id` | UUID NULL | FK a `tenant_units` (reemplaza la columna `unit` string en cleanup migrations) |
| `custom_attributes` | JSONB NULL | Atributos custom del tenant (color, sabor, grado, etc.) |
| `default_warehouse_id` | UUID NULL | Almacén default al recibir |
| `expected_yield_pct` | NUMERIC(5,2) NULL | % de rendimiento esperado (para alertas en consumos anómalos) |
| `requires_lot_tracking` | BOOLEAN DEFAULT false | Si TRUE, la recepción de este item requiere captura obligatoria de lote (en lugar de opcional). Para tenants alimentarios con MP crítica. |
| `requires_coa` | BOOLEAN DEFAULT false | Si TRUE, requiere Certificado de Análisis adjunto para que el lote entre en estado `active`. |
| `default_shelf_life_days` | INTEGER NULL | Vida útil default si el proveedor no informa expiry. |
| `standard_cost` | NUMERIC(18,6) NULL | Costo estándar para `cost_method='standard'` (post-MVP). |

#### 2.3.2 `products` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `product_kind_id` | UUID NULL | FK a `tenant_product_kinds`. NULL = producto de reventa no clasificado |
| `is_produced` | BOOLEAN DEFAULT false | TRUE = se fabrica via módulo producción; FALSE = reventa/importación. **Derivado**: TRUE si el producto tiene una `recipes` con `valid_until IS NULL`; admin puede sobrescribir manualmente. |
| `custom_attributes` | JSONB NULL | Valores de los atributos definidos en `product_kind.attribute_schema` |
| `default_recipe_id` | UUID NULL | FK a `recipes` (atajo: cuál receta usar por default al crear una orden) |
| `shelf_life_days` | INTEGER NULL | Override del default del kind. NULL = usa default del kind |
| `default_quality_grade_id` | UUID NULL | FK a `tenant_quality_grades` |
| `expected_sale_price` | NUMERIC(18,2) NULL | Precio NRV para asignación de costo en multi-calidad (ver §3.4). Para cal-1 puede ser igual al `base_price`; para cal-2/3 se define explícitamente. |
| `lot_number_pattern` | VARCHAR(80) NULL | Override del patrón del tenant (`tenant_process_config.lot_number_pattern`). **Regla**: si NULL hereda del tenant; si set, sobrescribe. |

**Productos existentes** quedan con `is_produced=false`, `product_kind_id=NULL`. Las ventas no notan diferencia. Los datos se migran solo si el tenant decide reactivarlos.

#### 2.3.3 `warehouses` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `warehouse_type_id` | UUID NULL | FK a `tenant_warehouse_types` (reemplaza gradualmente la columna `type` string) |

**Backward compat:** la columna `type` string se mantiene. Trigger sincroniza ambos.

#### 2.3.4 `production_orders` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `recipe_id` | UUID NULL | FK a `recipes` (la receta seleccionada al crear la orden) |
| `recipe_version_at_creation` | INTEGER NULL | Snapshot del version de la receta al momento de crear |
| `accept_second_quality_for_fulfillment` | BOOLEAN | Override por orden del flag global |
| `expected_scrap_pct` | NUMERIC(5,2) NULL | Override del esperado en la receta |
| `custom_attributes` | JSONB NULL | Atributos específicos de la orden que no están en el schema del producto. Ej: `{"texto": "Feliz cumpleaños Ana", "color_betun": "azul", "topper": "flor"}` — resuelve pedidos personalizados (ver §6.5). |
| `additional_costs` | NUMERIC(18,2) NULL | Costos directos extras no contemplados en la receta (mano de obra especial, materiales fuera de catálogo, decoración tercerizada). Suman al costo final. |
| `additional_costs_notes` | TEXT NULL | Descripción de los costos adicionales para auditoría. |

`raw_material_id`, `length_mm`, `mp_formula` se mantienen por backward compat — se ignoran cuando `recipe_id` está set.

#### 2.3.5 `production_shifts` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `intra_shift_proration_method` | VARCHAR(20) NULL | Override del default del tenant |

#### 2.3.6 `shift_progress` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `quality_grade_id` | UUID NULL | FK a `tenant_quality_grades`. Reemplaza `is_second_quality` |
| `dynamic_attributes` | JSONB NULL | Valores capturados según `capture_schema` del producto |
| `lot_id` | UUID NULL | FK a `product_lots` (Sección 4) |

**Backward compat:** `is_second_quality` y `second_quality_product_id` se mantienen. Trigger: si `quality_grade_id` es NULL, se infiere del booleano antiguo.

#### 2.3.7 `shift_scrap` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `scrap_type_id` | UUID NULL | FK a `tenant_scrap_types`. Reemplaza el enum `scrap_type` |
| `recovery_value_pct` | NUMERIC(5,2) NULL | Override del default del tipo |
| `dynamic_attributes` | JSONB NULL | — |
| `is_abnormal` | BOOLEAN DEFAULT false | Marcado por el sistema si supera el % esperado |

#### 2.3.8 `shift_mp_loads` (extendida)

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `unit_id` | UUID NULL | FK a `tenant_units` (si el load viene en unidad distinta a kg) |
| `quantity` | NUMERIC(18,6) NULL | Cantidad en `unit_id` (kg se mantiene en la columna `kg`) |
| `lot_id` | UUID NULL | FK al lote de MP consumido (Sección 4) |

---

### 2.4 Capa 3 — Tablas de runtime nuevas

#### 2.4.1 `production_shift_members` — miembros del turno con roles configurables

Reemplaza los campos rígidos `operator_id`/`supervisor_id` de `production_shifts`.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `shift_id` | UUID | FK a `production_shifts` |
| `user_id` | UUID | FK a `users` |
| `role_id` | UUID | FK a `tenant_shift_roles` |
| `joined_at` | TIMESTAMPTZ | Cuándo entró al turno (puede ser sustitución a media corrida) |
| `left_at` | TIMESTAMPTZ NULL | NULL si sigue en el turno |
| `notes` | TEXT | — |

**Backward compat:** `production_shifts.operator_id` y `supervisor_id` se mantienen — un trigger los popula desde `production_shift_members` con el rol correspondiente para que el código viejo siga funcionando mientras se migra.

#### 2.4.2 `order_recipe_snapshots` — versionado de receta usada por orden

Reemplaza `order_mp_formula` con un modelo más flexible (sin límite de 4 materiales).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `order_id` | UUID | FK a `production_orders` |
| `recipe_id` | UUID | FK a `recipes` (la receta de origen) |
| `recipe_version` | INTEGER | Versión congelada |
| `snapshot_data` | JSONB | Snapshot completo de componentes (raw_material_id, quantity, unit_id, etc.) |
| `valid_from` | TIMESTAMPTZ | — |
| `valid_until` | TIMESTAMPTZ NULL | NULL = vigente |
| `change_reason` | TEXT | Obligatorio si reemplaza un snapshot anterior |
| `created_by_user_id` | UUID | — |
| `created_at` | TIMESTAMPTZ | — |

#### 2.4.3 `shift_overhead_application` — aplicación de overhead al turno

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `shift_id` | UUID | FK a `production_shifts` |
| `overhead_item_id` | UUID | FK a `tenant_overhead_items` |
| `period_id` | UUID | FK a `tenant_overhead_periods` |
| `estimated_amount` | NUMERIC(18,2) | Lo que se aplicó al cerrar el turno (estimado) |
| `real_amount` | NUMERIC(18,2) NULL | Lo que se aplicó al recostear (real) |
| `allocation_basis_value` | NUMERIC(18,6) | Cuánto del divisor le tocó a este turno (ej. 8.5 horas, 1500 kg) |
| `created_at` | TIMESTAMPTZ | — |
| `recosted_at` | TIMESTAMPTZ NULL | Cuándo se actualizó con el real |

**Esto es lo que permite el recosteo**: las dos columnas viven juntas para siempre. La Sección 3 detalla el flujo.

---

### 2.5 Lo que se conserva intacto (lista corta)

Para evitar dudas, estas tablas **NO se tocan** ni se extienden:

- `tenants`, `users`, `roles`, `permissions`, `audit_logs`
- `business_partners`, `partner_billing_preferences`, `fiscal_profiles`
- `sales_orders`, `sales_order_lines`, `quotations`, `delivery_notes`, `delivery_records`
- `invoices`, `invoice_lines`, `cfdi40_fields`, `payment_complements`, `ar_payments`
- `purchase_orders` (v1 y v2), `supplier_invoices` (`supplier_receipts` recibe la única extensión aditiva en §4.4.4)
- `bank_accounts`, `petty_cash_*`, `exchange_rates`
- `attachments`, `email_*`, `system_messages`
- `inventory_stock`, `inventory_movements`, `inventory_levels`, `inventory_adjustments`, `inventory_counts` (extensiones opcionales de lotes en §4.4.1)
- `tenant_shift_config` (configuración existente de horarios/duración de turnos — sigue siendo la fuente de verdad para "cuántos turnos espera el tenant en un período"; lo consume el motor de prorrateo de overhead)
- `scheduled_shifts` (programación de turnos — sin cambios)

→ Los nuevos `reference_type` para movimientos de inventario (lotes, recipe consumption) se **agregan al enum existente**, no lo reemplazan.

---

### 2.6 Estrategia de migración (refactor agresivo)

> **Decisión clave**: el repo v1 está respaldado en otro lugar intacto. Por lo tanto, el SaaS v2 **no preserva código viejo** dentro del mismo repo. Refactorizamos/eliminamos agresivamente sin compat layer dual.

#### 2.6.1 Patrón de migración

Cada migración nueva sigue este patrón:

1. **Agregar columnas nuevas** como NULL-able sin default disruptivo.
2. **Crear tablas catálogo nuevas** vacías.
3. **Sembrar catálogos** con valores que reflejen los enums viejos (ej. crear un `tenant_warehouse_types` con `code='raw_material', system_role='input'` que mapea al enum). Las tablas de mapeo enum→FK se documentan en §2.6.4.
4. **Backfill**: popular las columnas FK nuevas desde los enums viejos (`warehouses.type='raw_material'` → `warehouse_type_id = (el id correspondiente)`).
5. **Cutover de código**: el código nuevo lee únicamente las columnas/tablas nuevas. **No hay cascada v1/v2.**
6. **Cleanup migrations** (al final del proyecto): drop columnas enum viejas, drop tablas obsoletas (`order_mp_formula` reemplazada por `order_recipe_snapshots`, etc.).

**No hay triggers de backward compat ni archivos `*_v1.js`.** El refactor del `productionService.js` reescribe la lógica directamente — la versión v1 queda preservada en el repo respaldado, no en este código.

#### 2.6.2 Tests de caracterización como red de seguridad

Antes de refactorizar `productionService.js`, se generan **golden master tests** que capturan el comportamiento actual exacto contra fixtures de datos reales. Esto reemplaza al compat layer como mecanismo de detección de regresiones:

- Cada función pública del servicio tiene un test que ejecuta con inputs reales y captura el output como snapshot.
- El refactor se valida contra estos snapshots, **no contra el código v1 corriendo en paralelo**.
- Si el comportamiento debe cambiar intencionalmente, se actualiza el snapshot con justificación en el PR.

#### 2.6.3 Orden recomendado de migraciones

```
M-001  Crear tenant_process_config (1 fila por tenant con defaults v2)
M-002  Crear tenant_units + tenant_unit_conversions + seed por tenant
M-003  Crear tenant_warehouse_types + seed + extend warehouses.warehouse_type_id
M-004  Crear tenant_scrap_types + seed + extend shift_scrap.scrap_type_id
M-005  Crear tenant_quality_grades + seed + extend shift_progress.quality_grade_id
M-006  Crear tenant_shift_roles + seed + production_shift_members
M-007  Crear tenant_product_kinds + extend products + extend raw_materials.item_kind
M-008  Crear recipes + recipe_components + extend production_orders.recipe_id
M-009  Crear order_recipe_snapshots
M-010  Crear tenant_overhead_items + tenant_overhead_periods + shift_overhead_application
```

No hay flag `process_engine_version` — todos los tenants son v2.

**Lotes y caducidad (M-012+) se difieren a la Sección 4. Cleanup migrations se documentan en §5.9.**

#### 2.6.4 Mapeo de seed enum → catálogo

Para que el backfill funcione, las migrations de seed crean estos mapeos explícitos:

**`warehouses.type` → `tenant_warehouse_types`:**
| Enum viejo | Code catálogo | system_role |
|---|---|---|
| `raw_material` | `materia_prima` | `input` |
| `regrind` | `regrind` | `scrap` |
| `wip` | `wip` | `wip` |
| `finished_product` | `producto_terminado` | `output` |
| `resale` | `reventa` | `resale` |

**`shift_scrap.scrap_type` → `tenant_scrap_types`:**
| Enum viejo | Code catálogo | is_normal | default_destination |
|---|---|---|---|
| `arranque` | `arranque` | true | `discard` |
| `operacion` | `operacion` | true | `reprocess` |
| `contaminada` | `contaminada` | true | `discard` |
| `desecho` | `desecho` | true | `discard` |

**`shift_progress.is_second_quality` → `quality_grade_id`:**
| Booleano viejo | grade_number | code |
|---|---|---|
| false | 1 | `primera` |
| true | 2 | `segunda` |

Estos mapeos viven en `seed-default-catalogs.js` (M-113) y se documentan en el repo.

---

### 2.7 Diagrama resumen de relaciones (texto)

```
tenant_process_config (1 por tenant)
       │
       ▼
tenant_units ────────► tenant_unit_conversions
       │
       ├────► tenant_product_kinds (con attribute_schema, capture_schema)
       │         │
       │         └────► products (extended) ────► recipes ──► recipe_components ──► raw_materials (extended)
       │                                          │
       │                                          └──► order_recipe_snapshots ──► production_orders (extended)
       │
       ├────► tenant_warehouse_types ────► warehouses (extended)
       │
       ├────► tenant_scrap_types ────► shift_scrap (extended)
       │
       ├────► tenant_quality_grades ────► shift_progress (extended)
       │
       ├────► tenant_shift_roles ────► production_shift_members ────► production_shifts (extended)
       │
       └────► tenant_overhead_items ────► tenant_overhead_periods
                       │
                       └────► shift_overhead_application ────► production_shifts
```

---

### 2.8 Decisiones de diseño (resueltas)

| # | Pregunta | Resolución |
|---|---|---|
| 1 | `tenant_process_config` ¿una fila por tenant o versionada? | **Una fila por tenant**. Cambios quedan en `audit_logs`. Versionar agregaría complejidad sin valor inmediato. |
| 2 | Substitutos en recetas (`substitute_group`) ¿MVP o post? | **Campo en el schema sí; lógica de selección automática post-MVP**. Por ahora el operador elige manualmente al consumir. |
| 3 | `recipe_components.is_optional` ¿se materializa en el snapshot de la orden? | **Sí**. Si un componente opcional no se va a usar en esta corrida, se omite del snapshot. |
| 4 | ¿Productos de reventa pueden tener `product_kind_id`? | **Sí, opcional**. Permite agruparlos en reportes aunque no tengan receta ni captura. |
| 5 | `tenant_unit_conversions` ¿bidireccional automática o explícita? | **Explícita (1 row = 1 dirección)**. Si el tenant define "caja = 24 pza", el motor calcula "pza = 1/24 caja" automáticamente sin row adicional. |
| 6 | ¿MP y Embalaje en la misma tabla con discriminador `item_kind`? | **Sí, unificados en `raw_materials`**. Misma estructura (costo unitario, almacenes), solo cambia el discriminador. Evita duplicar la mitad del esquema. |
| 7 | ¿Atributos custom en JSONB o EAV? | **JSONB**. Soporta validación contra el `attribute_schema` del kind, es consultable con índices GIN en PostgreSQL, y evita el infierno de joins de EAV. |

---

---

## 3. Motor de costeo y recosteo

### 3.1 Componentes del costo de una orden

El costo de producción de una orden tiene cuatro componentes:

```
Costo_Orden = (1) Costo de MP consumida
            + (2) Costo de Embalaje consumido
            + (3) Prorrateo de overhead del turno
            − (4) Valor de recuperación de mermas con valor

Costo_Unitario_Calidad_1 = (Costo_Orden − Valor_NRV_de_calidades_inferiores)
                            / Unidades_Calidad_1
```

**Detalle de cada componente:**

| # | Componente | Captura | Valuación |
|---|---|---|---|
| 1 | MP consumida | `shift_mp_loads` (cargas reales) | Según `cost_method` del tenant: promedio ponderado / FIFO / estándar |
| 2 | Embalaje consumido | `shift_mp_loads` con `item_kind='packaging'` | Igual que MP |
| 3 | Overhead del turno | `shift_overhead_application` (prorrateo desde `tenant_overhead_periods`) | Estimated → recosteado al cierre del mes |
| 4 | Recuperación de merma | `shift_scrap` con `tenant_scrap_types.default_recovery_value_pct > 0` | Valor recuperable a `% × cost_of_input_material` |

### 3.2 Estrategia de costeo (`cost_method` por tenant)

Tres métodos disponibles, elegibles en `tenant_process_config.cost_method`:

| Método | Cómo valúa el consumo de MP | Cuándo conviene |
|---|---|---|
| **`weighted_avg`** (default) | Costo promedio ponderado del stock disponible al momento de consumir | Mayoría de tenants; balance entre simplicidad y precisión |
| **`fifo`** | Costo del lote más antiguo disponible (combinado con FEFO para alimentos) | Tenants con materias primas que tienen costo variable o caducidad |
| **`standard`** | Costo estándar predefinido en `raw_materials.standard_cost` | Tenants que prefieren estabilidad de precio y manejan variaciones aparte |

**Implicaciones técnicas:**

- `weighted_avg` ya está implementado en el ERP actual (`inventory_movements.avg_cost`).
- `fifo` requiere que cada movimiento de inventario quede asociado a un lote o "capa de costo". Esto encaja directamente con el módulo de lotes (Sección 4) — un lote ya es naturalmente una capa de costo.
- `standard` requiere agregar `raw_materials.standard_cost` (extensión aditiva) y registrar la variación contra costo real como cuenta separada.

**MVP: implementar `weighted_avg` y `fifo`**. `standard` se difiere — es valioso pero menos común en plantas chicas/medianas.

### 3.3 Tratamiento de mermas en el costeo

Tres tratamientos según el tipo de merma (configurado en `tenant_scrap_types`):

| Tipo | `is_normal` | `default_recovery_value_pct` | Efecto en costo |
|---|---|---|---|
| **Normal con valor de recuperación** | true | > 0 | RESTA del costo: `recovered_value = scrap_kg × material_cost × pct/100` |
| **Normal sin valor** (desecho) | true | 0 | No suma ni resta. Queda **implícita** en el costo dividido entre unidades buenas. |
| **Anormal / excesiva** | false | — | Sale del costo del producto → va a cuenta de pérdida del período |

**¿Cuándo una merma es "anormal"?**

El sistema marca automáticamente `shift_scrap.is_abnormal = true` cuando:

```
scrap_kg_de_esta_corrida > orden.expected_scrap_pct × mp_total_consumido
```

Donde `expected_scrap_pct` viene de la orden (override) o de la receta (default).

La merma anormal:
- **Se descuenta del costo del producto** (no infla el costo unitario).
- **Genera una entrada contable** en cuenta de "Pérdida por merma anormal" del período.
- **Aparece en el variance report** como alerta.

→ Configurable: si `tenant_process_config.treat_abnormal_scrap_as_loss = false`, todo se trata como normal (más simple para tenants chicos sin contabilidad de costos sofisticada).

### 3.4 Multi-calidad: asignación del costo

Cuando una corrida produce calidades distintas (cal-1, cal-2, cal-3), se aplica el **método de Net Realizable Value (NRV)** — estándar en contabilidad de costos para productos conjuntos:

```
1. Calidades inferiores (cal-2, cal-3) se valúan a su NRV
   = precio de venta esperado × unidades obtenidas
   (configurado en products.expected_sale_price por grade)

2. El costo restante se asigna a calidad 1:
   Costo_Cal_1 = Costo_Total_Orden − Σ NRV_de_calidades_inferiores

3. Costo unitario cal-1 = Costo_Cal_1 / Unidades_Cal_1
```

**Ejemplo numérico:**

Orden: 100 kg de pellet PE. Resultado: 90 kg cal-1 + 10 kg cal-2.

- Costo total orden: $10,000
- NRV cal-2: 10 kg × $50/kg (precio esperado) = $500
- Costo asignado a cal-1: $10,000 − $500 = $9,500
- Costo unitario cal-1: $9,500 / 90 kg = **$105.56/kg**
- Costo unitario cal-2: **$50/kg** (= su NRV)

**Edge cases:**

- Si NRV cal-2 > Costo_Total: se reporta como anomalía (precio de venta de la inferior excede el costo total — raro pero posible). El sistema asigna cal-1 a `costo / unidades` (sin descontar) y emite warning.
- Si solo hay cal-1: el método NRV no aplica, todo el costo va a cal-1.

**Tabla adicional necesaria** (extensión a `products`):

```
products.expected_sale_price (NUMERIC NULL)
   Precio NRV para esta calidad. Para cal-1 se usa el base_price.
   Para cal-2/3 se define explícitamente.
```

→ Decisión de diseño: cada **calidad** se modela como un **producto separado** con su propio SKU. Esto ya es el patrón actual (`shift_progress.second_quality_product_id`). El nuevo modelo lo generaliza vía `quality_grade_id`.

### 3.5 Captura de overhead — el catálogo por tenant

Recordatorio de la Sección 2: `tenant_overhead_items` define **qué gastos** hay y **cómo se prorratean**. `tenant_overhead_periods` captura **cuánto** cuesta cada gasto **por período**.

**Flujo de captura:**

```
1. Tenant crea su catálogo de overhead (una vez al setup):
   - Renta:         mensual, base=shifts,  $50,000 estimado
   - Luz CFE:       mensual, base=hours,   $35,000 estimado
   - Nómina:        quincenal, base=shifts, $60,000 estimado
   - Mantto. línea1: por evento, base=hours, monto variable

2. Al iniciar cada período, el sistema:
   - Crea automáticamente las filas en tenant_overhead_periods
   - Prellena con default_estimated_amount

3. Durante el período:
   - Los turnos consumen el estimado vía shift_overhead_application
   - Los gastos "por evento" se capturan cuando ocurren

4. Al cierre del período:
   - Usuario (rol contable) captura real_amount
   - Sistema recalcula shift_overhead_application.real_amount
   - Sistema cierra el período (is_finalized = true)
   - Se genera variance report
```

### 3.6 Prorrateo de overhead al turno

Cada vez que un turno cierra (`status = pending_handover` o `closed`), el motor calcula su contribución a cada overhead item del período activo.

**Fórmula general:**

```
shift_overhead_application.estimated_amount
   = tenant_overhead_periods.estimated_amount
   × (shift_basis_value / expected_total_basis_for_period)
```

Donde `shift_basis_value` y `expected_total_basis_for_period` dependen del `allocation_base`:

| `allocation_base` | `shift_basis_value` | `expected_total_basis_for_period` |
|---|---|---|
| `shifts` | 1 | Turnos esperados en el período (calc. desde `tenant_shift_config` × días) |
| `hours` | Horas reales del turno | Horas esperadas en el período (config tenant) |
| `units` | Unidades buenas (cal-1) producidas en el turno | Unidades esperadas en el período |
| `weight` | Kg producidos en el turno | Kg esperados en el período |
| `lines` | 1 si el turno pertenece a `applies_to_line_id` | Turnos de esa línea esperados |
| `equal` | 1 | Total de turnos que correrán (simple equal split) |

**Problema del divisor expected** y **fórmula explícita** (Decisión D): al cerrar el turno 5 de 90 del mes, no sabemos cuántos correrán los siguientes 25 días. La estrategia es **extrapolación lineal con piso del estimado inicial**:

```
1. AL INICIO DEL PERÍODO:
   expected_total_basis_for_period = max(
     configured_initial_estimate,   -- desde tenant_shift_config o manual del usuario
     0                              -- protección
   )

2. A MEDIDA QUE CORREN TURNOS (recalculo a cada cierre de turno):
   days_elapsed = días desde period_start hasta hoy
   days_remaining = días desde hoy hasta period_end
   days_total = days_elapsed + days_remaining

   if days_elapsed == 0:
     expected = configured_initial_estimate
   else:
     accumulated_so_far = sum(basis_value de turnos cerrados del período)
     daily_rate_observed = accumulated_so_far / days_elapsed
     projected_remainder = daily_rate_observed × days_remaining

     expected_total_basis_for_period = max(
       configured_initial_estimate,
       accumulated_so_far + projected_remainder
     )

3. AL CIERRE DEL PERÍODO:
   actual_total_basis = sum(basis_value de TODOS los turnos del período)
   real_amount_por_turno = period.real_amount × (shift_basis / actual_total_basis)
```

**Caso especial — turnos ad-hoc (`allow_adhoc_shifts=true`)**: no hay `configured_initial_estimate` confiable desde `tenant_shift_config`. En su lugar:
- Si hay datos del período anterior: `expected = promedio_3_meses_anteriores_de_basis`.
- Si no hay datos históricos: `expected = accumulated_so_far` (todo overhead se prorratea entre los turnos que efectivamente corran). El usuario verá el costo estabilizarse hacia el fin del período.

Esto puede generar pequeños ajustes al cierre incluso si el `estimated_amount` no cambió, porque el divisor real difiere del proyectado. Es **correcto contablemente** y se refleja en el variance report (Volume Variance, §3.9.3).

### 3.7 Turnos multi-orden: prorrateo intra-turno

Cuando un turno corre **una sola orden**, todo el overhead del turno va a esa orden.

Cuando un turno corre **múltiples órdenes**, hay que prorratear según `tenant_process_config.default_intra_shift_proration` (overridable por turno):

| Método | `order_basis_value` | Cuándo conviene |
|---|---|---|
| `time` (default) | Minutos dedicados a cada orden (rastreado por cambios de orden activa en `shift_active_order_log`) | Cuando órdenes duran tiempos distintos |
| `units` | Unidades producidas de cada orden | Cuando productos son comparables |
| `weight` | Kg producidos de cada orden | Cuando varían tamaños mucho |
| `manual` | % definido por supervisor al cerrar turno | Tenants que prefieren control |

**Tracking del tiempo dedicado a cada orden:**

Tabla nueva: `shift_active_order_log` (necesaria para `time` proration):

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `shift_id` | UUID FK | — |
| `order_id` | UUID FK | — |
| `started_at` | TIMESTAMPTZ | Cuando el operador puso esta orden activa |
| `ended_at` | TIMESTAMPTZ NULL | NULL = sigue activa |

Cada vez que el operador cambia la orden activa, se cierra la fila anterior y se abre una nueva. Esto ya es compatible con `production_shifts.production_order_id` actual — solo agregamos el log de cambios.

### 3.8 Cierre de mes y recosteo

**Flujo de cierre:**

```
1. Usuario (rol contable) entra a "Cierre de mes" → selecciona el período (ej. Abril 2026).
2. Sistema muestra todos los tenant_overhead_periods abiertos del mes:
   - Renta:         estimado $50,000  real [________]  ← captura
   - Luz CFE:       estimado $35,000  real [________]
   - Nómina:        estimado $60,000  real [________]
   ...
3. Usuario captura reales. Sistema valida (no permite real = NULL).
4. Usuario hace click en "Cerrar período".
5. Sistema:
   a. Marca todos los tenant_overhead_periods como is_finalized=true.
   b. Para cada shift del mes, recalcula shift_overhead_application.real_amount:
      real_amount = real_period_amount × (shift_basis_value / actual_total_basis_for_period)
   c. Actualiza shift_cost_snapshot.real_overhead_total para cada shift.
   d. Recalcula real_unit_cost para cada orden que tuvo turnos en el mes.
   e. Genera variance report.
6. Usuario revisa variance report y firma cierre.
7. Período queda bloqueado (solo admin puede reabrir, con razón).
```

**Tabla nueva necesaria: `order_cost_snapshots`**

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `order_id` | UUID FK | — |
| `snapshot_type` | VARCHAR(20) | `estimated` (al cerrar la orden) / `recosted` (después de cierre de mes) |
| `mp_cost` | NUMERIC(18,2) | Costo de MP |
| `packaging_cost` | NUMERIC(18,2) | Costo de embalaje |
| `overhead_cost` | NUMERIC(18,2) | Prorrateo de overhead (estimated o real según snapshot_type) |
| `scrap_recovery_value` | NUMERIC(18,2) | Resta por recuperación |
| `nrv_value_lower_grades` | NUMERIC(18,2) | Resta por NRV de cal-2/3 |
| `total_cost_to_grade_1` | NUMERIC(18,2) | Costo asignado a cal-1 |
| `units_grade_1` | NUMERIC(18,6) | Unidades cal-1 |
| `unit_cost_grade_1` | NUMERIC(18,6) | total_cost_to_grade_1 / units_grade_1 |
| `created_at` | TIMESTAMPTZ | — |
| `notes` | TEXT | — |

→ Una orden tendrá típicamente **2 filas**: uno `estimated` (al cerrar la orden) y uno `recosted` (al cierre de mes). Permite ver la variación a nivel orden.

### 3.9 Variance reports

Al cerrar un mes, el sistema genera tres reportes:

#### 3.9.1 Variance por overhead item

```
Mes: Abril 2026

Concepto       │ Estimado  │ Real      │ Variación │ %
───────────────┼───────────┼───────────┼───────────┼──────
Renta          │  $50,000  │  $50,000  │       $0  │  0.0%
Luz CFE        │  $35,000  │  $38,420  │  +$3,420  │ +9.8% ⚠
Nómina         │ $120,000  │ $123,500  │  +$3,500  │ +2.9%
Mantenimiento  │  $15,000  │  $22,800  │  +$7,800  │+52.0% ⚠⚠
───────────────┼───────────┼───────────┼───────────┼──────
TOTAL          │ $220,000  │ $234,720  │ +$14,720  │ +6.7%

⚠ = variación > 5%
⚠⚠ = variación > 25%
```

#### 3.9.2 Variance por producto (impacto en costo unitario)

```
Mes: Abril 2026

SKU          │ Producto         │ Costo Est. │ Costo Real │ Δ Unit │ Δ %
─────────────┼──────────────────┼────────────┼────────────┼────────┼──────
PAL-MTQ-50G  │ Palomitas Mtq.   │   $4.20    │   $4.35    │ +$0.15 │ +3.6%
PAL-CAR-100G │ Palomitas Caram. │   $7.80    │   $8.05    │ +$0.25 │ +3.2%
FRI-PAP-200G │ Papas Original   │   $9.40    │   $9.65    │ +$0.25 │ +2.7%
```

#### 3.9.3 Volume variance (uso del overhead vs lo planeado)

```
Mes: Abril 2026

Base       │ Planeado │ Real    │ Variación │ %
───────────┼──────────┼─────────┼───────────┼─────
Turnos     │    90    │    87   │    -3     │ -3.3%
Horas-máq. │  720h    │  698h   │   -22h    │ -3.1%
Unidades   │ 45,000   │ 43,200  │  -1,800   │ -4.0%
```

→ Esto le dice al tenant si **subutilizó capacidad** (overhead repartido entre menos turnos, costo unitario sube) o **sobreutilizó** (más turnos absorben mejor).

### 3.10 Cálculo en tiempo real durante un turno activo

Durante un turno corriente (`status='active'`), el motor mantiene un **costo estimado en vivo** que el supervisor puede consultar:

```
Costo_Acumulado_Turno (en cualquier momento):
  + MP consumida hasta ahora × cost_per_kg (según método)
  + Embalaje consumido hasta ahora
  + Prorrateo proyectado de overhead (asumiendo el turno completa su duración esperada)
  − Mermas con valor capturadas hasta ahora
```

Esto se almacena en una vista materializada o se calcula on-demand desde:
- `shift_mp_loads` (MP/embalaje cargado)
- `shift_scrap` (mermas con valor)
- `tenant_overhead_periods` activos (proyección)

→ La sección de **dashboard del turno** muestra: "Costo unitario estimado actual: $X — proyección al cierre: $Y".

### 3.11 Resumen de tablas nuevas / extensiones de esta sección

**Tablas nuevas (Capa 3):**

- `shift_active_order_log` — tracking de cambios de orden activa para prorrateo por tiempo
- `order_cost_snapshots` — snapshot dual (estimated + recosted)

**Extensiones aditivas:**

- `raw_materials.standard_cost` (NUMERIC NULL) — para método de costeo standard, post-MVP
- `products.expected_sale_price` (NUMERIC NULL) — para NRV de calidades inferiores
- `shift_scrap.is_abnormal` ya estaba en Sección 2.3.7 — confirmado

**Lo que reemplaza `shift_cost_snapshot` actual:**

La tabla `shift_cost_snapshot` existente se mantiene pero se le agregan columnas:

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `estimated_overhead_total` | NUMERIC NULL | Overhead aplicado al cerrar el turno (estimated del período activo) |
| `real_overhead_total` | NUMERIC NULL | Overhead recalculado al cierre de mes (real del período cerrado) |
| `recosted_at` | TIMESTAMPTZ NULL | Cuándo se recosteó |
| `recosted_by_user_id` | UUID NULL | Quién ejecutó el recosteo |

### 3.12 Ejemplo paso a paso

**Setup:**

- Tenant: Palomitas Industriales
- Producto: PAL-MTQ-50G (Palomitas Mantequilla 50g)
- Receta: 100 kg maíz + 5 L aceite + 2 kg mantequilla → 80 kg palomitas (yield)
- Overhead: Renta $30K/mes, Luz $20K/mes, Nómina $50K/mes (todo prorrateo `shifts`, expected 60 turnos/mes)

**Día 1 — Apertura del período (1 de Abril):**

Sistema crea `tenant_overhead_periods`:
- Renta: estimated $30,000, base = shifts, expected_divisor = 60 turnos
- Luz: estimated $20,000, base = hours, expected_divisor = 480h
- Nómina: estimated $50,000, base = shifts, expected_divisor = 60

→ Tasa por turno: Renta $500, Luz $41.67/h (× 8h = $333), Nómina $833. **Total overhead/turno: ~$1,667**.

**Día 2 — Turno 1 corre la orden #100 (1000 bolsas de PAL-MTQ-50G):**

Captura:
- MP cargada: 100 kg maíz a $15/kg = $1,500
- 5 L aceite a $40/L = $200
- 2 kg mantequilla a $80/kg = $160
- Embalaje: 1,000 bolsas a $0.30 = $300
- Mermas: 5 kg granos sin reventar (`recovery_value_pct=0` → no resta)
- Resultado: 950 unidades cal-1 + 50 unidades cal-2 (precio NRV cal-2 = $1.50/un)

Cálculo de costo al cierre del turno:
```
MP:        $1,860
Embalaje:  $300
Overhead:  $1,667 (estimado)
Recovery:  $0
─────────────────
Subtotal:  $3,827
NRV cal-2: 50 × $1.50 = $75 (resta)
─────────────────
Costo cal-1: $3,752
Unit cost cal-1: $3,752 / 950 = $3.95/bolsa
```

→ Se inserta `order_cost_snapshots` con `snapshot_type='estimated'`.

**Día 30 — Cierre del mes:**

Contabilidad captura reales:
- Renta: $30,000 (igual)
- Luz: $22,800 (+14%)
- Nómina: $50,500 (+1%)
- Mantenimiento (no había): $8,000 (gasto no planeado)

Realidad de turnos del mes: **57 turnos** (no 60 esperados), 456 horas.

Sistema recalcula `shift_overhead_application` para el turno del día 2:
- Renta real: $30,000 / 57 = $526.32 (subió de $500)
- Luz real: $22,800 / 456h × 8h = $400 (subió de $333)
- Nómina real: $50,500 / 57 = $885.96 (subió de $833)
- Mantenimiento: $8,000 / 57 = $140.35 (nuevo)
- **Total overhead real del turno: $1,952.63**

Recosteo de la orden #100:
```
MP:        $1,860 (igual)
Embalaje:  $300 (igual)
Overhead:  $1,952.63 (real)
Recovery:  $0
─────────────────
Subtotal:  $4,112.63
NRV cal-2: $75
─────────────────
Costo cal-1: $4,037.63
Unit cost cal-1: $4,037.63 / 950 = $4.25/bolsa
```

→ Se inserta segundo `order_cost_snapshots` con `snapshot_type='recosted'`.

**Variance:**
- Costo estimado: $3.95/bolsa
- Costo real: $4.25/bolsa
- Variación: +$0.30 (+7.6%)

→ Aparece en el variance report con bandera ⚠ (> 5%).

### 3.13 Decisiones de diseño (resueltas)

| # | Decisión | Resolución |
|---|---|---|
| 1 | ¿Soportar FIFO en MVP? | **Sí**, junto con weighted_avg. Standard se difiere. |
| 2 | Asignación de costo en multi-calidad | **NRV (Net Realizable Value)**: cal-2/3 a precio esperado, cal-1 absorbe el resto. |
| 3 | ¿Treat abnormal scrap as loss obligatorio? | **Configurable** vía `tenant_process_config.treat_abnormal_scrap_as_loss`. Default true (mejor contabilidad), false para tenants sin sofisticación. |
| 4 | Captura de overhead por evento (mantenimiento) | **Sí**, vía `capture_frequency='event'` en `tenant_overhead_items`. La fecha del período se setea cuando ocurre. |
| 5 | ¿Permitir recosteo manual de una sola orden sin cerrar el mes? | **No en MVP**. El recosteo es batch al cierre de mes. Reabrir un mes específicamente para ajustar una orden es admin-only post-MVP. |
| 6 | ¿Cómo manejar gastos anuales (predial, seguro)? | Se capturan una vez con `capture_frequency='annual'` y `period_start/end` anual. El sistema prorratea 1/12 a cada `tenant_overhead_periods` mensual automático. |

---

---

## 4. Lotes, caducidad y trazabilidad

### 4.1 Por qué este módulo existe

Tres de los cuatro verticales objetivo (palomitas, frituras, pastelería) son **alimentos procesados** sujetos en México a:

- **NOM-251-SSA1-2009** — Buenas Prácticas de Higiene
- **NOM-051-SCFI/SSA1-2010** — Etiquetado obligatorio (incluye fecha de caducidad/consumo preferente)
- **NOM-251 art. 5.10** — Trazabilidad: "El responsable sanitario debe contar con un sistema de identificación que permita rastrear el producto y sus ingredientes."
- **COFEPRIS** — Autoridad sanitaria que audita y puede ordenar **retiros de producto**.

**Las cuatro capacidades no negociables que esto exige:**

1. **Lote único por unidad producida** — cada producto sale con un identificador rastreable.
2. **Caducidad por lote** — fecha calculada desde la producción + vida útil del producto.
3. **Trazabilidad backward** — dado un lote de PT, identificar qué lotes de MP se usaron.
4. **Recall** — dado un lote contaminado de MP, identificar TODOS los lotes de PT afectados y dónde están (inventario, vendidos, en tránsito).

Para tenants **no-alimentarios** (recicladora), los lotes son **opcionales** vía `tenant_process_config.uses_lots=false`. El motor de lotes existe en el código, pero las UI y validaciones lo omiten.

### 4.2 Modelo conceptual

```
┌────────────────────────┐         ┌────────────────────────┐
│  raw_material_lots     │         │   product_lots          │
│  (lotes de MP/embalaje)│         │   (lotes de PT)         │
│                        │         │                         │
│  lot_number            │         │  lot_number             │
│  expiry_date           │         │  expiry_date            │
│  quantity_remaining    │         │  quantity_produced      │
│  status                │         │  quality_grade_id       │
└──────────┬─────────────┘         │  status                 │
           │                       └──────────┬──────────────┘
           │                                  │
           │      ┌────────────────────────┐  │
           └────▶│   lot_consumption       │◀─┘
                  │   (links MP → PT)       │
                  │                         │
                  │  raw_material_lot_id    │
                  │  product_lot_id         │
                  │  quantity_consumed      │
                  │  shift_progress_id      │
                  └─────────────────────────┘

Los movimientos de inventario (inventory_movements) llevan
lot_id en la columna que aplique (MP o PT).
```

### 4.3 Tablas nuevas

#### 4.3.1 `raw_material_lots` — lotes de materia prima y embalaje

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `raw_material_id` | UUID | FK a `raw_materials` (que con `item_kind` cubre MP, embalaje, aditivos) |
| `lot_number` | VARCHAR(60) | Identificador interno (auto-generado o manual) |
| `manufacturer_lot` | VARCHAR(120) | Lote del proveedor (puede diferir del interno) |
| `manufacture_date` | DATE | Fecha de manufactura informada por el proveedor |
| `expiry_date` | DATE | Caducidad declarada por el proveedor |
| `best_before_date` | DATE | Consumo preferente (anterior a caducidad) |
| `received_at` | TIMESTAMPTZ | Cuándo entró al almacén |
| `supplier_id` | UUID | FK a `business_partners` (proveedor) |
| `supplier_receipt_id` | UUID NULL | FK a `supplier_receipts` (origen de la entrada) |
| `supplier_receipt_line_id` | UUID NULL | FK a línea específica del receipt |
| `warehouse_id` | UUID | Almacén donde se almacenó |
| `quantity_received` | NUMERIC(18,6) | Cantidad recibida (en `raw_materials.unit_id`) |
| `quantity_remaining` | NUMERIC(18,6) | Lo que queda (actualizado por movimientos) |
| `unit_cost` | NUMERIC(18,6) | Costo unitario de este lote (para FIFO) |
| `total_cost` | NUMERIC(18,2) | quantity_received × unit_cost |
| `status` | VARCHAR(20) | `active` / `quarantined` / `expired` / `recalled` / `depleted` |
| `quarantine_reason` | TEXT NULL | Si está en cuarentena, por qué |
| `coa_attachment_id` | UUID NULL | FK a `attachments` (Certificado de Análisis) |
| `notes` | TEXT NULL | — |
| `created_at`, `created_by_user_id` | — | — |

**Estado del lote (`status`):**

| Estado | Descripción | Disponible para consumo |
|---|---|---|
| `active` | Normal, disponible | Sí |
| `quarantined` | Bloqueado por sospecha (contaminación, COA pendiente) | No |
| `expired` | Caducidad alcanzada (cron job lo marca automáticamente) | No (excepto reproceso si aplica) |
| `recalled` | Retirado por orden sanitaria del proveedor o interna | No |
| `depleted` | `quantity_remaining = 0`. Mantiene historial. | No |

#### 4.3.2 `product_lots` — lotes de producto terminado (producido **o** recibido para reventa)

Esta tabla cubre dos orígenes:
- **Lotes producidos** internamente (vía órdenes de producción).
- **Lotes recibidos de proveedor** para productos terminados de reventa (PT comprados, no producidos — ej. un distribuidor de botanas que también produce algunas).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `product_id` | UUID | FK a `products` |
| `lot_number` | VARCHAR(60) | Identificador interno |
| `origin` | VARCHAR(20) | `produced` / `received` / `adjusted` — cómo entró el lote al sistema |
| `produced_at` | TIMESTAMPTZ NULL | Fecha/hora de producción. NULL si `origin='received'` |
| `production_date` | DATE | Fecha que aparece en la etiqueta (producción o lo declarado por proveedor) |
| `expiry_date` | DATE | Calculado: `production_date + product.shelf_life_days` (o declarado por proveedor si `received`) |
| `best_before_date` | DATE NULL | — |
| `production_order_id` | UUID NULL | FK a `production_orders`. NULL si `origin='received'` |
| `shift_id` | UUID NULL | FK a `production_shifts`. NULL si `origin='received'` |
| `quality_grade_id` | UUID | FK a `tenant_quality_grades`. **Un lote pertenece a una sola calidad.** Para reventa: default = grade 1. |
| `quantity_produced` | NUMERIC(18,6) | Cantidad inicial del lote (producida o recibida) |
| `quantity_remaining` | NUMERIC(18,6) | Cantidad disponible actual |
| `unit_cost` | NUMERIC(18,6) | Costo unitario (estimated). Para reventa: costo del receipt. |
| `unit_cost_recosted` | NUMERIC(18,6) NULL | Costo unitario después de recosteo de mes (solo aplica a producidos) |
| `warehouse_id` | UUID | Almacén donde se almacenó al ingresar |
| `supplier_id` | UUID NULL | Solo si `origin='received'` — FK a `business_partners` |
| `supplier_receipt_id` | UUID NULL | Solo si `origin='received'` — FK al receipt origen |
| `supplier_receipt_line_id` | UUID NULL | Línea específica del receipt |
| `manufacturer_lot` | VARCHAR(120) NULL | Lote del proveedor (solo `received`) |
| `manufacture_date` | DATE NULL | Solo `received` — fecha de manufactura del proveedor |
| `status` | VARCHAR(20) | `active` / `quarantined` / `expired` / `recalled` / `depleted` |
| `notes` | TEXT | — |
| `created_at`, `created_by_user_id` | — | — |

**Constraint:**
- Si `origin='produced'`: `production_order_id` y `shift_id` deben estar set.
- Si `origin='received'`: `supplier_id` y `supplier_receipt_id` deben estar set; `production_order_id` y `shift_id` deben ser NULL.
- `lot_consumption` solo se popula para `origin='produced'` (los recibidos no tienen MP que rastrear backward — pero sí pueden ser rastreados forward al venderlos).

#### 4.3.3 `lot_consumption` — qué lotes de MP entraron en qué lotes de PT

Esta tabla es la **columna vertebral de la trazabilidad**. Cada vez que se captura producción, el motor registra qué lotes de MP se consumieron contra el lote de PT generado.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `product_lot_id` | UUID | FK a `product_lots` |
| `raw_material_lot_id` | UUID | FK a `raw_material_lots` |
| `quantity_consumed` | NUMERIC(18,6) | En unidad del MP |
| `unit_id` | UUID | FK a `tenant_units` |
| `shift_id` | UUID | FK a `production_shifts` |
| `shift_progress_id` | UUID NULL | FK a la captura específica que generó el consumo |
| `shift_mp_load_id` | UUID NULL | FK a la carga de MP origen del consumo |
| `consumed_at` | TIMESTAMPTZ | — |
| `created_at` | TIMESTAMPTZ | — |

**Índices críticos:**

- `(product_lot_id)` — para trazabilidad backward: "qué MP usó este lote de PT"
- `(raw_material_lot_id)` — para recall forward: "qué PT lotes usaron esta MP"

#### 4.3.4 `tenant_allergens` — catálogo de alérgenos

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | — |
| `tenant_id` | UUID | — |
| `code` | VARCHAR(30) | `gluten`, `dairy`, `nuts`, `soy`, `eggs`, `fish`, `shellfish`, `sesame` |
| `name` | VARCHAR(80) | "Gluten", "Lácteos", "Frutos secos" |
| `is_priority` | BOOLEAN | Alérgeno prioritario de la NOM-051 (8 grandes) |
| `sort_order` | INTEGER | — |
| `is_active` | BOOLEAN | — |

**Seed default**: los 8 alérgenos prioritarios de NOM-051. Tenants pueden agregar más (apio, mostaza, etc.).

#### 4.3.5 `raw_material_allergens` y `product_allergens`

Tablas de unión simples para declarar alérgenos:

```
raw_material_allergens
  raw_material_id, allergen_id, declaration ('contains' | 'may_contain')

product_allergens
  product_id, allergen_id, declaration ('contains' | 'may_contain')
```

**Regla de herencia:**

Un `product_lot` hereda los alérgenos declarados de **su producto** (siempre) **+** los alérgenos de **los `raw_material_lots` consumidos** (como `may_contain` si no coinciden con declarados).

Esto permite detectar **contaminación cruzada accidental**: si la receta no declara gluten pero alguno de los MP consumidos sí lo contiene, se marca el lote para revisión.

### 4.4 Extensiones a tablas existentes

#### 4.4.1 `inventory_movements`

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `raw_material_lot_id` | UUID NULL | FK a `raw_material_lots` (para movimientos de MP/embalaje) |
| `product_lot_id` | UUID NULL | FK a `product_lots` (para movimientos de PT) |

**Constraint**: solo uno de los dos puede estar set (XOR). Si el movimiento es de MP, lleva `raw_material_lot_id`; si es de PT, lleva `product_lot_id`. Movimientos de ajuste o consolidación pueden tener ambos NULL si el tenant no usa lotes.

#### 4.4.2 `products`

Ya está en Sección 2 (`shelf_life_days`). Se agrega:

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `lot_number_pattern` | VARCHAR(80) NULL | Plantilla para auto-generar `lot_number`. Default global del tenant si NULL. |

#### 4.4.3 `raw_materials`

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `default_shelf_life_days` | INTEGER NULL | Cuánto dura este MP típicamente (para alertas si proveedor no informa expiry) |
| `requires_coa` | BOOLEAN DEFAULT false | Exige Certificado de Análisis para entrar a estado `active` |

#### 4.4.4 `supplier_receipts` y `supplier_receipt_lines`

Esta es la única extensión **al módulo de compras** — pero es **estrictamente aditiva** y **opcional**. Aplica tanto a recepciones de **MP/embalaje** como a recepciones de **productos terminados de reventa**.

**`supplier_receipts`**: sin cambios.

**`supplier_receipt_lines`** (extensión):

| Columna nueva | Tipo | Descripción |
|---|---|---|
| `lot_data` | JSONB NULL | Captura de lote en el momento de recepción: `{ lot_number, manufacturer_lot, manufacture_date, expiry_date, best_before_date, coa_attachment_id }` |
| `raw_material_lot_id` | UUID NULL | FK al `raw_material_lots` creado (cuando la línea es de MP/embalaje) |
| `product_lot_id` | UUID NULL | FK al `product_lots` creado con `origin='received'` (cuando la línea es de PT de reventa) |

**Constraint:** una línea con `lot_data` lleva **exactamente uno** de los dos FK según el tipo de item recibido:
- Si `supplier_receipt_lines.item_kind = 'raw_material'` o `'packaging'` → `raw_material_lot_id`
- Si `supplier_receipt_lines.item_kind = 'product'` (producto terminado de reventa) → `product_lot_id`

**Flujo:**

1. El módulo de compras recibe la mercancía normalmente (no cambia).
2. **Si** `tenant_process_config.uses_lots=true` **y** el item recibido tiene `requires_lot_tracking=true` (sea MP, embalaje o PT de reventa), la UI de recepción muestra un panel opcional para capturar `lot_data`.
3. Al confirmar el receipt, un **trigger** (o lógica de servicio) crea:
   - Un `raw_material_lots` (si la línea es MP/embalaje), **o**
   - Un `product_lots` con `origin='received'` (si la línea es PT de reventa).
4. Las líneas que no capturan lote no crean lote — comportamiento idéntico al actual.

**Productos terminados de reventa con lotes:**

Un tenant puede operar como:
- **Solo productor**: produce sus propios PT, no revende.
- **Productor + distribuidor**: produce algunos PT y revende otros comprados a terceros (ej. una pastelería que también revende mermeladas envasadas de un proveedor).
- **Solo distribuidor**: no produce nada, solo revende (este caso no es target del SaaS, pero el modelo lo soporta).

Para el segundo caso (mixto, que es común), el sistema:
- Permite que `products` tenga lotes provenientes de producción **y** de receptions.
- Cada lote tiene su `origin` para distinguir.
- Trazabilidad forward funciona igual para ambos (al vender, se rastrea el lote).
- Trazabilidad backward solo aplica a producidos.
- Recall puede activarse para cualquiera de los dos orígenes.

→ **Cero impacto** en tenants no-alimentarios o que solo venden producidos. Tenants con productos de reventa con trazabilidad obtienen el mismo motor.

### 4.5 Generación de lotes — patrones y formatos

#### 4.5.1 Patrón configurable por tenant/producto

`tenant_process_config.lot_number_pattern` define la plantilla default. Variables soportadas:

| Variable | Significado | Ejemplo |
|---|---|---|
| `{YYYY}` | Año 4 dígitos | `2026` |
| `{MM}` | Mes | `05` |
| `{DD}` | Día | `22` |
| `{JJJ}` | Día juliano | `142` |
| `{SHIFT}` | Número de turno | `2` |
| `{LINE}` | Código de línea | `L1` |
| `{SKU}` | SKU del producto | `PAL-MTQ-50G` |
| `{SEQ}` | Secuencia diaria por producto | `001` |

**Ejemplos de patrones:**

- `{YYYY}{MM}{DD}-{SKU}-{SEQ}` → `20260522-PAL-MTQ-50G-001`
- `LOT-{YYYY}{JJJ}-{LINE}-{SHIFT}` → `LOT-2026142-L1-2`
- `{SKU}/{YYYY}{MM}/{SEQ}` → `PAL-MTQ-50G/202605/047`

**Sobreescritura manual**: el operador puede sobrescribir el lote auto-generado si la situación lo amerita (raro, requiere razón en `notes`).

#### 4.5.2 Múltiples lotes en un mismo turno

Decisión de diseño: **un lote por (producto × turno × calidad)**.

Si un turno produce 950 cal-1 + 50 cal-2 del mismo SKU, genera **dos lotes**:
- `product_lots` para cal-1 con 950 unidades
- `product_lots` para cal-2 con 50 unidades

Si el turno produce dos SKUs distintos (raro pero posible con multi-orden), genera lotes separados por SKU también.

**Excepción**: si el `capture_schema` del producto incluye atributos críticos (color, sabor) y dos capturas del mismo turno difieren en esos atributos, se generan lotes separados. Esto se determina por **una "huella" del producto + atributos críticos**.

→ Configurable: el tenant marca qué atributos del `capture_schema` son `lot_critical`.

### 4.6 Consumo de MP — FIFO y FEFO

Cuando un turno consume MP, el motor selecciona automáticamente los lotes según el método configurado:

| Método (`tenant_process_config`) | Selección de lote |
|---|---|
| `weighted_avg` sin lotes | No selecciona lote específico. El consumo se valúa al `avg_cost` del stock total. |
| `fifo` sin lotes | First In First Out por `received_at` del movimiento. Sin trazabilidad de lote. |
| `fifo` + `uses_lots=true` | Selecciona el `raw_material_lot` con `received_at` más antiguo y `quantity_remaining > 0`. |
| `fefo` + `uses_lots=true` + `uses_expiry=true` | Selecciona el lote con `expiry_date` más cercano (que no esté caducado). Si dos lotes empatan en expiry, desempate por `received_at`. |

**Lógica de selección:**

```sql
-- Pseudocódigo del selector FEFO
SELECT id, quantity_remaining
FROM raw_material_lots
WHERE tenant_id = :t
  AND raw_material_id = :rm
  AND warehouse_id = :wh
  AND status = 'active'
  AND quantity_remaining > 0
  AND (expiry_date IS NULL OR expiry_date > NOW())
ORDER BY
  COALESCE(expiry_date, 'infinity') ASC,  -- FEFO
  received_at ASC                          -- desempate FIFO
LIMIT N;
```

**Consumo parcial de múltiples lotes:**

Si el consumo de 100 kg requiere más de un lote (lote A tiene 60 kg, lote B tiene 80 kg), el motor:
1. Consume los 60 kg de A (quantity_remaining → 0, status → `depleted`).
2. Consume 40 kg de B (quantity_remaining → 40).
3. Genera **dos filas** en `lot_consumption` apuntando al mismo `product_lot_id`.

**Override manual del operador:**

Cuando el operador hace `loadMp`, puede seleccionar manualmente el lote a consumir si:
- Hay un motivo (lote específico para una orden, sustitución por cuarentena, etc.)
- La acción queda registrada con razón.
- El sistema valida que el lote elegido no esté `expired`/`recalled`/`quarantined`.

### 4.7 Trazabilidad backward y forward

#### 4.7.1 Backward — "¿Qué MP se usó en este lote de PT?"

Query directa contra `lot_consumption`:

```sql
SELECT rml.*, lc.quantity_consumed
FROM lot_consumption lc
JOIN raw_material_lots rml ON rml.id = lc.raw_material_lot_id
WHERE lc.product_lot_id = :pt_lot_id;
```

UI: "Trazabilidad del lote PAL-MTQ-50G/202605/047":
- 60 kg de maíz, lote `MAIZ-PROV-X-2026140` (recibido 2026-05-20, proveedor "Granos del Bajío")
- 5 L de aceite, lote `ACE-Y-2026130` (recibido 2026-05-10, proveedor "Aceites Industriales")
- 2 kg de mantequilla, lote `MTQ-Z-2026142` (recibido 2026-05-22, proveedor "Lácteos del Norte")

#### 4.7.2 Forward — "¿Qué PT se hizo con este lote de MP?" (recall)

Query inversa:

```sql
SELECT pl.*, lc.quantity_consumed
FROM lot_consumption lc
JOIN product_lots pl ON pl.id = lc.product_lot_id
WHERE lc.raw_material_lot_id = :mp_lot_id;
```

Devuelve la lista de lotes de PT afectados. Luego se cruzan con `inventory_movements` para encontrar **dónde está cada lote actualmente**:

- En inventario: cuántas unidades quedan, en qué almacén.
- Vendidos: a qué clientes, vía qué notas de remisión / facturas (cruce con `delivery_records` y `invoices`).
- En tránsito: si hay rutas activas.

→ La pantalla de recall genera:
- Lista de clientes a notificar.
- Total de unidades a retirar.
- Estimación del costo del retiro.

### 4.8 Caducidad — alertas, bloqueos y ajustes

#### 4.8.1 Cron diario de expiración

Un job diario revisa todos los lotes (MP y PT) y:

1. **Lotes con `expiry_date < today`**: status → `expired`. Inventario del lote queda bloqueado para venta/consumo normal.
2. **Lotes con `expiry_date - today ≤ N días`** (configurable por tenant): genera **alerta**.

Tabla de configuración: `tenant_process_config.expiry_alert_days` (default 7 para alimentos, NULL para no-alimentos).

#### 4.8.2 Ajuste automático de inventario al expirar

Cuando un lote expira, el motor:

1. Crea un `inventory_movements` con `reference_type = 'lot_expiry'`.
2. Mueve la cantidad remanente a un almacén tipo `scrap` o `blocked` (configurable).
3. El costo de las unidades expiradas va a **cuenta de pérdida por caducidad** (similar a merma anormal).

#### 4.8.3 Reproceso de expirados (opcional)

Para tenants con MP que tiene segunda vida (ej. ingredientes de panadería para producto de segunda calidad, regrind en recicladora):

- Flag `tenant_scrap_types.allows_reprocess_of_expired`.
- Al expirar, en vez de bloquear, el motor mueve el lote a un almacén `scrap` específico de reproceso.
- El reproceso vuelve a entrar al inventario con costo reducido (configurable).

### 4.9 Alérgenos — declaración y herencia

#### 4.9.1 Declaración

- En `product_allergens`: declarados manualmente al crear el producto.
- En `raw_material_allergens`: declarados manualmente al crear la MP.

#### 4.9.2 Herencia y detección automática

Al cerrar un `product_lot`, el motor:

1. Lee los `product_allergens` declarados → marca el lote.
2. Lee los `raw_material_allergens` de cada MP consumida vía `lot_consumption`.
3. **Si hay algún MP con un alérgeno que el producto NO declara**, se genera una **alerta de discrepancia**:
   - "Producto PAL-MTQ-50G no declara 'gluten' pero MP 'Mantequilla compuesta' lote XYZ contiene gluten."
   - El supervisor decide: marcar el lote `quarantined`, agregar el alérgeno al producto, o ignorar (queda en `audit_logs`).

#### 4.9.3 Etiquetado (NOM-051)

Tabla derivada `product_lot_allergens` se materializa al cierre del lote para uso en etiquetas:

| Columna | Tipo | Descripción |
|---|---|---|
| `product_lot_id` | UUID FK | — |
| `allergen_id` | UUID FK | — |
| `declaration` | VARCHAR(20) | `contains` / `may_contain` |
| `source` | VARCHAR(20) | `declared` / `inherited` |

La impresión de etiquetas (post-MVP) consulta esta tabla.

### 4.10 Workflow de recall

Cuando se detecta contaminación o defecto:

1. **Origen**: usuario marca un `raw_material_lots.status = 'recalled'` (o un `product_lots` directo) con razón obligatoria.
2. **Sistema calcula impacto**:
   - Si es MP: todos los `product_lots` enlazados vía `lot_consumption`.
   - Si es PT: directamente este lote.
3. **Sistema cambia estado** de los lotes afectados a `recalled`.
4. **Sistema bloquea inventario**: los movimientos de salida se rechazan.
5. **Sistema genera plan de retiro**:
   - Para inventario propio: lista de almacenes y cantidades a aislar.
   - Para producto vendido: lista de clientes, fechas de entrega, notas de remisión a contactar.
6. **Usuario contabilidad** registra costo del retiro como `inventory_movements` tipo `recall`.
7. **Audit log**: todo el flujo queda registrado con timestamps y usuarios.

### 4.11 Activación opcional por tenant

Resumen del comportamiento según flags:

| Tenant tipo | `uses_lots` | `uses_expiry` | `uses_fefo` | `uses_allergens` |
|---|---|---|---|---|
| Recicladora | false | false | false | false |
| Palomitas | true | true | true | true |
| Frituras | true | true | true | true |
| Pastelería | true | true | true | true |

**Cuando `uses_lots=false`**: el módulo es invisible. Las tablas existen pero están vacías. `inventory_movements.raw_material_lot_id` y `product_lot_id` siempre NULL. Los selectores FIFO/FEFO usan los movimientos en vez de lotes.

**Cuando `uses_lots=true, uses_expiry=false`**: lotes sí, caducidad no. Útil para reciclaje con trazabilidad de origen (qué lote de plástico crudo se procesó cuándo).

### 4.12 Resumen del impacto en otros módulos

| Módulo | Cambio | Tipo |
|---|---|---|
| Producción (este doc) | Genera lotes de PT al capturar; consume lotes de MP vía FEFO/FIFO; alertas | Core |
| Compras (`supplier_receipts`) | Captura opcional de `lot_data` al recibir MP, embalaje o PT de reventa; trigger crea el lote correspondiente (raw_material_lots o product_lots) | **Aditivo** — único módulo "no producción" que se toca |
| Inventario (`inventory_movements`) | Columnas FK a lotes (NULL para tenants sin lotes) | Aditivo |
| Ventas | El lote queda asociado al movimiento de salida automáticamente vía FEFO. Sin cambios de UI ni de flujo. | Transparente |
| Reportes | Nuevos: trazabilidad, recall, vencimientos próximos, costo por lote | Adicional |

→ **El boundary "compras no se toca" se respeta al 99%**. La única excepción es agregar columnas opcionales para captura de lote en el receipt — sin esto, la trazabilidad backward es imposible. **Aplica tanto a MP como a productos terminados de reventa** cuando el tenant los maneja.

### 4.13 Matriz de captura — dónde se ingresa cada dato

Resumen de **quién captura qué, dónde y cuándo**. Esta tabla es la referencia para diseñar las pantallas del MVP.

#### 4.13.1 Al configurar el tenant (Admin, setup inicial)

| Información | Pantalla | Tabla | Frecuencia |
|---|---|---|---|
| Catálogo de alérgenos (8 prioritarios sembrados auto) | Configuración → Catálogos → Alérgenos | `tenant_allergens` | Una vez + ajustes |
| Patrón de número de lote | Configuración → Procesos → Patrón de lote | `tenant_process_config.lot_number_pattern` | Una vez |
| Modo de alérgenos (strict/priority_only/alert_only) | Configuración → Procesos → Compliance | `tenant_process_config` | Una vez |
| Días de alerta antes de caducidad | Configuración → Procesos → Caducidad | `tenant_process_config.expiry_alert_days` | Una vez |
| Tipos de almacén, mermas, calidades, roles de turno | Configuración → Catálogos | tablas `tenant_*` | Una vez + ajustes |

#### 4.13.2 Al dar de alta MP, Embalaje y Productos (Admin, una vez por SKU)

| Información | Pantalla | Tabla |
|---|---|---|
| Alérgenos que contiene cada MP (contains / may_contain) | Catálogo de Materias Primas → Editar → tab "Alérgenos" | `raw_material_allergens` |
| Alérgenos declarados de cada producto (lo que va en etiqueta) | Catálogo de Productos → Editar → tab "Alérgenos" | `product_allergens` |
| Vida útil del producto (días) | Catálogo de Productos → Editar | `products.shelf_life_days` |
| Si la MP requiere COA | Catálogo de MP → Editar → flag | `raw_materials.requires_coa` |
| Si la MP/PT requiere trazabilidad por lote | Catálogo → Editar → flag | `raw_materials.requires_lot_tracking` |
| Receta del producto (componentes, cantidades) | Catálogo de Productos → Editar → tab "Receta" | `recipes` + `recipe_components` |
| Precio NRV de calidades inferiores | Catálogo de Productos → Editar → tab "Calidades" | `products.expected_sale_price` |

#### 4.13.3 Al recibir mercancía del proveedor (Almacenista, cada receipt)

Aplica a **MP, embalaje y PT de reventa** cuando el tenant tiene `uses_lots=true` y el item tiene `requires_lot_tracking=true`.

| Información | Pantalla | Campo destino |
|---|---|---|
| Número de lote del proveedor (`manufacturer_lot`) | Compras → Recepción → línea → panel "Lote" | `supplier_receipt_lines.lot_data.manufacturer_lot` |
| Fecha de manufactura | mismo panel | `lot_data.manufacture_date` |
| Fecha de caducidad | mismo panel | `lot_data.expiry_date` |
| Fecha consumo preferente | mismo panel | `lot_data.best_before_date` |
| Certificado de Análisis (COA) | mismo panel → adjuntar | `attachments` + `lot_data.coa_attachment_id` |
| Número de lote interno | Auto-generado según patrón; sobrescribible | `raw_material_lots.lot_number` / `product_lots.lot_number` |

#### 4.13.4 Al producir (Operador, durante el turno)

La mayoría de información es **derivada automáticamente** por el motor. El operador solo captura lo que el `capture_schema` del producto le pide.

| Información | Cómo se captura | Tabla |
|---|---|---|
| Lote de PT generado | **Automático** al primer paquete del turno; se reutiliza para el resto del mismo (producto × turno × calidad) | `product_lots` (origin=produced) |
| Caducidad del PT | **Automática**: `production_date + product.shelf_life_days` | `product_lots.expiry_date` |
| Qué lotes de MP se consumieron | **Automático**: FEFO selecciona, sistema registra | `lot_consumption` |
| Atributos del paquete (sabor, color, peso, etc.) | Operador → formulario dinámico según `capture_schema` | `shift_progress.dynamic_attributes` |
| Calidad asignada del paquete | Operador → selector de calidad | `shift_progress.quality_grade_id` |
| Merma generada (peso, tipo, destino) | Operador → registro de scrap | `shift_scrap` |
| Alérgenos del lote (declarados + heredados) | **Automático al cierre del lote**: lee declared del producto + detected de los MP consumidos | `product_lot_allergens` (tabla derivada) |

#### 4.13.5 Composición visualizada del lote (lo que el sistema deriva)

Lo que un usuario ve al consultar un lote de PT NO está en una sola tabla — el sistema **deriva la vista** uniendo varias:

```
Vista "Contenido del lote PT" = product_lots
                              + lot_consumption (qué MP entró)
                              + raw_material_lots (de cada MP, sus datos)
                              + business_partners (proveedores)
                              + product_lot_allergens (alérgenos efectivos)
                              + inventory_movements (estado actual)
                              + delivery_records (a qué clientes se vendió)
```

Esto permite que la pantalla de "Trazabilidad del lote" muestre toda la cadena sin que nadie la haya capturado explícitamente — todo viene de las capturas atómicas de cada momento.

### 4.14 Decisiones de diseño (resueltas)

| # | Decisión | Resolución |
|---|---|---|
| 1 | ¿Crear lotes automáticos o requerir input manual? | **Automático con override manual**. El patrón se configura en `tenant_process_config.lot_number_pattern`; el operador puede sobrescribir con razón. |
| 2 | ¿Un lote por turno o uno por captura (microlote)? | **Uno por (producto × turno × calidad)**. Capturas múltiples del mismo SKU+grade+turno se acumulan en el mismo lote. Atributos críticos pueden subdividir. |
| 3 | ¿Lotes de MP se crean en compras o en producción? | **En compras (extensión aditiva)**. Si un MP llega sin lote (compra rápida o tenant que no lo capturó), el sistema lo deja `NULL` — el motor lo trata como "sin trazabilidad" y los tenants alimentarios reciben warning. |
| 4 | ¿La caducidad se calcula al producir o al expirar el lote? | **Se calcula al producir** (`production_date + shelf_life_days`). Stored, no calculado on-the-fly, para que cambios en `shelf_life_days` del producto no afecten lotes ya producidos. |
| 5 | Si MP llega expirada o cerca de expirar, ¿bloquear receipt? | **Warning, no bloqueo**. El usuario decide aceptarla con razón (puede ser MP justo en límite que se va a usar inmediatamente). |
| 6 | ¿Alérgenos heredados disparan acción automática? | **Híbrido por tipo + configurable por tenant.** Default `priority_only`: los 8 alérgenos prioritarios de NOM-051 bloquean automáticamente (cuarentena), el resto solo alerta. Configurable a `strict` (todo bloquea) o `alert_only` (solo alerta). Supervisor con permiso `production:override_allergen_quarantine` libera con razón obligatoria. |
| 7 | ¿Permitir vender lotes expirados? | **No, salvo override de admin** con razón. Las ventas verifican `product_lots.status='active'` antes de generar movimiento de salida. |
| 8 | ¿Trazabilidad de embalaje? | **Opcional**. Cuando el embalaje lleva info crítica (códigos de barras, fechas), sí. Cuando es genérico (bolsas anónimas), no. Configurado en `raw_materials.requires_lot_tracking`. |
| 9 | ¿Trazabilidad de productos terminados de reventa? | **Sí**, vía `product_lots.origin='received'`. Mismo mecanismo de captura en `supplier_receipt_lines.lot_data`, mismo motor de recall. Solo difiere en que no tiene trazabilidad backward (no se produjeron, no hay MP que rastrear). |

---

---

## 5. Mapeo del código actual

### 5.1 Filosofía del mapeo

Cada archivo/módulo del código actual se clasifica en **una de cuatro categorías**:

| Categoría | Símbolo | Significado |
|---|---|---|
| **Intacto** | ✅ | Cero cambios. El módulo funciona idéntico en v1 y v2. |
| **Extensión aditiva** | ➕ | Se agregan columnas/funciones/endpoints **nuevos** sin tocar los existentes. El código viejo sigue funcionando. |
| **Refactor** | 🔧 | Se reorganiza el código existente — se extraen abstracciones, se reemplazan partes hardcoded. Algunas funciones cambian signatura. |
| **Nuevo** | 🆕 | Módulo / archivo / pantalla que no existe hoy. Se crea desde cero. |

**Principio guía**: ningún tenant `v1` (la planta actual) debe romperse durante el refactor. Todos los cambios respetan backward compatibility hasta que se decida deprecar v1.

---

### 5.2 Backend — módulos que NO se tocan

Estos módulos quedan **completamente intactos**. Cero cambios de código, migrations o API.

| Módulo | Por qué no se toca |
|---|---|
| ✅ `admin` | Funciones de administración no afectadas |
| ✅ `attachments` | Adjuntos genéricos (incluido COA) usan la implementación actual |
| ✅ `audit` | El sistema de auditoría se hereda; v2 agrega nuevas entradas pero usa el mismo motor |
| ✅ `auth` | Autenticación no cambia |
| ✅ `bank-accounts` | Cuentas bancarias fuera de alcance |
| ✅ `billing` | Facturación del SaaS al tenant |
| ✅ `business-partners` | Clientes y proveedores (mismas tablas para ventas y compras) |
| ✅ `email` | Envío de correos |
| ✅ `exchange-rates` | Tipos de cambio |
| ✅ `financials` | Módulo financiero genérico |
| ✅ `fiscal-profiles` | Perfiles fiscales CFDI |
| ✅ `invoicing` | Facturación a clientes (FacturAPI) |
| ✅ `pettyCash` | Caja chica |
| ✅ `platformAdmin` | Admin de plataforma del SaaS |
| ✅ `quotations` | Cotizaciones |
| ✅ `roles` | Sistema de roles y permisos (se le agregan nuevos permisos, pero el motor no cambia) |
| ✅ `sales` | Ventas — el flujo de venta queda idéntico. Los lotes se asocian al movimiento de salida vía FEFO automático. |
| ✅ `systemMessages` | Mensajes del sistema |
| ✅ `tenants` | Multi-tenancy ya implementado |
| ✅ `users` | Gestión de usuarios |
| ✅ `reports` | Reportes existentes. Se agregan nuevos archivos para reportes nuevos (trazabilidad, variance, etc.) pero los reportes actuales no cambian. |

**Lista de archivos específicos sin cambios**: aproximadamente **150 archivos** del backend quedan intactos.

---

### 5.3 Backend — módulos con extensión aditiva

Estos módulos reciben **columnas nuevas, endpoints nuevos o funciones nuevas**, sin modificar el código existente.

#### 5.3.1 `inventory` ➕

| Archivo | Cambio | Tipo |
|---|---|---|
| `inventoryService.js` | Funciones nuevas: `createLot()`, `consumeLotFIFO()`, `consumeLotFEFO()`, `expireLot()`, `recallLot()`. Las funciones existentes (`recordPackageCaptured`, `recordProductionValidation`, etc.) se extienden para popular `lot_id` opcionalmente. | ➕ |
| `inventoryLevelsService.js` | Sin cambios al motor. Se agrega capacidad de calcular niveles por lote para reportes de vencimiento próximo. | ➕ |
| `warehouseService.js` | Sin cambios al CRUD existente. Se agrega lectura desde `tenant_warehouse_types` cuando `warehouse_type_id` está populado. | ➕ |
| `inventoryCountService.js` | Extensión opcional: counts pueden ser por lote en tenants con lotes. | ➕ |
| `routes.js`, `warehouseRoutes.js` | Endpoints nuevos: `GET /lots`, `GET /lots/:id`, `POST /lots/:id/quarantine`, `POST /lots/:id/recall`. | ➕ |

#### 5.3.2 `products` ➕

| Archivo | Cambio |
|---|---|
| `productService.js` | Funciones nuevas: `createRecipe()`, `updateRecipe()`, `getActiveRecipe()`, `linkAllergens()`. Las funciones existentes (`getProduct`, `listProducts`) se extienden para retornar `product_kind_id`, `custom_attributes`, `default_recipe_id`. **No se modifica la signatura pública** — campos nuevos son opcionales en la respuesta. |
| `routes.js` | Endpoints nuevos: `GET/POST/PATCH /products/:id/recipes`, `GET/PATCH /products/:id/allergens`, `GET/PATCH /products/:id/custom-attributes`. |

#### 5.3.3 `raw-materials` ➕

| Archivo | Cambio |
|---|---|
| `rawMaterialService.js` | Soporte para `item_kind` (raw_material / packaging / additive). Funciones de catálogo se extienden para filtrar por kind. Funciones nuevas: `linkAllergens()`, `setRequiresCoa()`. |
| `routes.js` | Endpoints nuevos: `GET /raw-materials?kind=packaging`, `GET/PATCH /raw-materials/:id/allergens`. |

#### 5.3.4 `purchases` ➕ (**la única excepción al "no tocar compras"**)

| Archivo | Cambio |
|---|---|
| `purchasesService.js` o equivalente | Función nueva: al confirmar un `supplier_receipt`, si las líneas traen `lot_data`, crear `raw_material_lots` (MP/embalaje) o `product_lots` con `origin='received'` (PT de reventa). |
| Routes | Endpoint extendido: `POST /supplier-receipts/:id/confirm` ahora acepta `lot_data` opcional por línea. **Comportamiento sin `lot_data` queda 100% idéntico.** |

→ Este es el **único cambio en compras**, estrictamente aditivo y opcional.

#### 5.3.5 Otros

| Módulo | Cambio |
|---|---|
| `roles` ➕ | Se siembran nuevos permisos: `production:override_allergen_quarantine`, `production:override_lot_consumption`, `finance:close_period`, `finance:reopen_period`. |
| `reports` ➕ | Archivos nuevos para reportes de trazabilidad, recall, variance, vencimientos próximos. Los reportes existentes no cambian. |

---

### 5.4 Backend — refactor significativo

#### 5.4.1 `production/productionService.js` 🔧 — **el archivo más impactado del proyecto**

**Estado actual**: 3,363 líneas, con muchas decisiones hardcoded:

- Lógica de `mp_formula` (máx 4 materiales) — embedded en `createOrder`, `releaseOrder`, `changeOrderFormula`.
- Modelo D Opción C de costeo — embedded en `getShiftSummary`, `validateShift`, `recordProductionValidation`.
- Cálculo de peso teórico desde `grams_per_linear_meter` × `length_mm` — embedded en `previewStockForNewOrder`.
- Manejo de `second_quality_product_id` — patrón fijo para una segunda calidad.
- Detección de `out_of_range` con tolerancia ±5% hardcoded.

**Estrategia de refactor**: dividir el archivo en piezas con responsabilidades claras. **No se mantiene lógica v1 en este repo** (está respaldada en repo separado). Tests de caracterización (golden master) protegen contra regresiones durante el refactor.

```
production/
├── productionService.js        (orquestador, queda más delgado, ~800 líneas)
├── routes.js                   (sin cambios estructurales, solo se agregan endpoints)
├── scheduledShiftService.js    ✅ intacto
├── shiftConfigService.js       ✅ intacto
│
├── orderService.js             🆕 (extraído: ciclo de orden, cola, prioridades, cierre)
├── shiftLifecycleService.js    🆕 (extraído: apertura, cierre, handover, force-close)
├── captureService.js           🆕 (extraído: capturePackage, loadMp, recordScrap)
│
├── recipeService.js            🆕 (lee recetas de `recipes` + `recipe_components`; gestiona snapshot por orden)
├── captureSchemaService.js     🆕 (genera y valida el formulario dinámico de captura)
├── qualityGradeService.js      🆕 (resuelve calidad usando `tenant_quality_grades`)
└── corrections/                ✅ intacto (la lógica de correcciones dual-mode se conserva)
```

**Qué se conserva del `productionService.js` actual:**

- ✅ Estructura de turnos (apertura, cierre, handover, force-close).
- ✅ Cola de órdenes y prioridades.
- ✅ Modelo de correcciones dual-mode (operador vs supervisor).
- ✅ Validación y cierre de turno.
- ✅ Reapertura de órdenes/turnos.
- ✅ Audit logs.

**Qué se refactoriza:**

- 🔧 `createOrder` — recibe `recipe_id` en vez de `mpFormula`. Si el tenant es v1, sigue aceptando `mpFormula` y traduce internamente.
- 🔧 `previewStockForNewOrder` — usa receta para calcular consumo teórico en lugar de `grams_per_linear_meter × length_mm`.
- 🔧 `capturePackage` — usa `capture_schema` del producto para validar `dynamic_attributes`. Genera lote si tenant usa lotes. Resuelve calidad vía `quality_grade_id`.
- 🔧 `recordScrap` — usa `tenant_scrap_types` en lugar del enum hardcoded. Marca `is_abnormal` si supera el `expected_scrap_pct` de la receta.
- 🔧 `getShiftSummary` — usa el `costEngine` nuevo (Sección 3) en lugar del cálculo embebido.
- 🔧 `validateShift` y `recordProductionValidation` — usan el motor de costeo nuevo + crean `product_lots` si aplica.
- 🔧 `changeOrderFormula` — usa `order_recipe_snapshots` en lugar de `order_mp_formula` versioning.

**Estrategia de migración (sin compat layer):**

1. Cada función se reescribe en su versión v2 final, no en cascada.
2. **Golden master tests** protegen contra regresiones — capturan output de la versión v1 (corriendo en el repo respaldado o en sandbox temporal) y validan que la v2 produzca lo mismo en casos equivalentes.
3. La lógica v1 NO se mantiene en este repo — está respaldada en otro repo intacto del usuario.
4. **Cleanup migrations** al final del proyecto eliminan columnas y tablas obsoletas (ver §5.9.3).

#### 5.4.2 Resumen del refactor de producción

| Aspecto | Antes | Después |
|---|---|---|
| Líneas en `productionService.js` | 3,363 | ~800 (orquestador) |
| Archivos del módulo | 4 | ~12 |
| Lógica hardcoded a esquineros | Embebida | **Eliminada** del repo (preservada en backup) |
| Soporte multi-vertical | No | Sí (via Process Template) |
| Compat layer | N/A | **No existe** — refactor agresivo, red de seguridad por tests |

---

### 5.5 Backend — módulos nuevos

Los siguientes módulos son **completamente nuevos** y se crean desde cero:

#### 5.5.1 `process-config/` 🆕

Gestión de la configuración por tenant (Sección 2).

```
process-config/
├── routes.js
├── processConfigService.js     (CRUD de tenant_process_config)
├── unitsService.js              (tenant_units, tenant_unit_conversions)
├── warehouseTypesService.js    (tenant_warehouse_types)
├── scrapTypesService.js        (tenant_scrap_types)
├── qualityGradesService.js     (tenant_quality_grades)
├── shiftRolesService.js        (tenant_shift_roles)
└── productKindsService.js      (tenant_product_kinds + schemas)
```

#### 5.5.2 `recipes/` 🆕

```
recipes/
├── routes.js
├── recipeService.js            (CRUD de recipes + recipe_components)
├── recipeVersioning.js         (lógica de valid_from/valid_until)
└── recipeValidator.js          (validar que componentes existan, % sumen, etc.)
```

#### 5.5.3 `lots/` 🆕

```
lots/
├── routes.js
├── lotService.js               (CRUD de raw_material_lots y product_lots)
├── lotGenerator.js             (auto-generación según patrón)
├── lotConsumptionService.js    (registrar consumo, FEFO/FIFO)
├── expiryService.js            (cron diario, alertas, bloqueo)
├── traceabilityService.js      (backward y forward)
└── recallService.js            (workflow de recall completo)
```

#### 5.5.4 `allergens/` 🆕

```
allergens/
├── routes.js
├── allergenCatalogService.js   (tenant_allergens, seed NOM-051)
├── productAllergenService.js   (product_allergens, raw_material_allergens)
└── allergenInheritanceService.js (cálculo de product_lot_allergens al cerrar lote)
```

#### 5.5.5 `overhead-costing/` 🆕

```
overhead-costing/
├── routes.js
├── overheadItemService.js      (CRUD de tenant_overhead_items)
├── overheadPeriodService.js    (apertura/cierre de períodos)
├── overheadApplicationService.js (prorrateo al turno)
├── costEngine.js               🆕 corazón del motor de costeo
├── recostingService.js         🆕 cierre de mes y variance
└── varianceReportService.js    🆕 generación de reportes
```

#### 5.5.6 Crons nuevos (en `src/crons.js`)

| Cron | Frecuencia | Función |
|---|---|---|
| `expiryCheck` | Diario 06:00 | Marca lotes expirados, dispara alertas |
| `expiryAlerts` | Diario 07:00 | Envía emails de "lotes próximos a expirar" |
| `recostingReminders` | Día 5 de cada mes | Recordatorio al rol contable de cerrar el mes anterior |

---

### 5.6 Frontend — páginas que NO se tocan

| Carpeta | Estado |
|---|---|
| ✅ `pages/Login`, `pages/Dashboard` | Sin cambios |
| ✅ `pages/Ventas/*` | Sin cambios (los lotes se asocian transparentemente) |
| ✅ `pages/Compras/*` (excepto Recepción) | Sin cambios |
| ✅ `pages/Cotizaciones/*` | Sin cambios |
| ✅ `pages/Clientes/*`, `pages/Proveedores/*` | Sin cambios |
| ✅ `pages/Facturacion/*` | Sin cambios |
| ✅ `pages/Financieros/*`, `pages/CajaChica/*`, `pages/Bancos/*` | Sin cambios |
| ✅ `pages/Admin/*` (usuarios, roles, tenants) | Sin cambios |

---

### 5.7 Frontend — páginas con refactor

#### 5.7.1 `pages/Produccion/*` 🔧 — refactor mayor

Todas las pantallas de producción necesitan adaptarse al motor configurable. El cambio más visible: la **captura** ya no es un formulario fijo con campos predefinidos (peso, longitud) — es un **formulario dinámico** generado a partir del `capture_schema` del producto.

| Página | Cambio principal |
|---|---|
| `ProduccionOrdenes.jsx` | UI de fórmula MP (máx 4) → selector de receta. Preview de stock usa receta nueva. |
| `ProduccionCaptura.jsx` | **Mayor refactor**. Formulario dinámico desde `capture_schema`. Muestra lote generado. Selector de calidad. |
| `ProduccionValidacion.jsx` | Resumen de costo desde nuevo costEngine. Muestra alertas de merma anormal, alérgenos heredados. |
| `ProduccionCostos.jsx` | Reemplazada por nueva pantalla de gastos indirectos (ver 5.8). La existente se conserva temporalmente para tenants v1. |
| `ProduccionResumen.jsx` | Agrega sección de lotes producidos, alérgenos del lote, trazabilidad. |
| `ProduccionHistorico.jsx` | Filtros nuevos (por lote, por receta, por calidad). |
| `ProduccionProgramacion.jsx` | Sin cambios mayores (la programación es genérica). |

#### 5.7.2 `pages/Compras/Recepcion.jsx` 🔧

La pantalla de recepción **agrega un panel opcional** "Información de lote" que aparece solo si:
- `tenant_process_config.uses_lots = true`
- El item de la línea tiene `requires_lot_tracking = true`

Sin esos flags, la pantalla luce idéntica a hoy.

#### 5.7.3 `pages/Catalogos/Productos.jsx` ➕

Se agregan tabs nuevos: "Receta", "Alérgenos", "Atributos custom", "Calidades NRV". Los tabs existentes no cambian.

#### 5.7.4 `pages/Catalogos/MateriasPrimas.jsx` ➕

Se agrega: filtro por `item_kind`, tabs "Alérgenos" y "COA". Existentes intactos.

#### 5.7.5 `pages/Inventario/*` ➕

Se agregan vistas opcionales:
- "Por lote" en stock (cuando `uses_lots=true`).
- "Próximos a vencer" en dashboard de inventario.

---

### 5.8 Frontend — páginas nuevas

#### 5.8.1 Configuración del Process Template 🆕

```
pages/Configuracion/
├── Procesos.jsx                🆕 Hub principal
├── procesos/
│   ├── Unidades.jsx            🆕 tenant_units + conversions
│   ├── TiposAlmacen.jsx        🆕 tenant_warehouse_types
│   ├── TiposMerma.jsx          🆕 tenant_scrap_types
│   ├── Calidades.jsx           🆕 tenant_quality_grades
│   ├── RolesTurno.jsx          🆕 tenant_shift_roles
│   ├── TiposProducto.jsx       🆕 tenant_product_kinds (editor de schemas)
│   ├── Flags.jsx               🆕 tenant_process_config (toggles globales)
│   └── PatronLote.jsx          🆕 lot_number_pattern
```

#### 5.8.2 Trazabilidad y Recall 🆕

```
pages/Trazabilidad/
├── LoteDetalle.jsx             🆕 vista del lote con backward + forward
├── BusquedaLote.jsx            🆕 buscador por lot_number, fecha, producto
├── RecallWizard.jsx            🆕 workflow de recall paso a paso
└── VencimientosProximos.jsx    🆕 dashboard de alertas
```

#### 5.8.3 Costeo y cierre de mes 🆕

```
pages/Costeo/
├── GastosIndirectos.jsx        🆕 CRUD de tenant_overhead_items
├── PeriodosOverhead.jsx        🆕 captura de estimated + real por período
├── CierreDeMes.jsx             🆕 wizard de cierre + validación
├── VarianceReport.jsx          🆕 reporte de variación
└── TendenciaCostos.jsx         🆕 dashboard histórico de costo unitario
```

#### 5.8.4 Alérgenos 🆕

```
pages/Alergenos/
├── Catalogo.jsx                🆕 tenant_allergens (CRUD + seed NOM-051)
└── DiscrepanciasLotes.jsx      🆕 alertas de discrepancia detectadas
```

---

### 5.9 Migrations

#### 5.9.1 Migrations existentes — sin cambios

Las **115 migrations existentes** (`000_schema_migrations.js` a `115_impersonation_sessions.js`) **no se tocan**. Quedan como fundamento del esquema actual.

#### 5.9.2 Migrations nuevas

Continúan la numeración desde donde quedan las actuales (`116_...` en adelante). Aplicado hasta ahora:

- `116_tenant_process_config.js` ✅ aplicada — crea tabla + seed por tenant
- `117_process_config_permissions.js` ✅ aplicada — permisos process_config:read/update

Pendientes (con numeración orientativa):

```
116_tenant_process_config.js              ✅ APLICADA — tabla + seed por tenant
117_process_config_permissions.js         ✅ APLICADA — permisos read/update
118_tenant_units.js                       (siguiente)
119_tenant_unit_conversions.js
120_tenant_warehouse_types.js + warehouses.warehouse_type_id
121_tenant_scrap_types.js + shift_scrap.scrap_type_id
                                          -- incluye: linked_raw_material_id,
                                             allows_reprocess_of_expired
122_tenant_quality_grades.js + shift_progress.quality_grade_id
123_tenant_shift_roles.js + production_shift_members
124_tenant_product_kinds.js + products.product_kind_id + custom_attributes
125_raw_materials_item_kind.js + custom_attributes + unit_id
126_recipes.js + recipe_components
127_products_recipe_link.js (default_recipe_id, expected_sale_price)
128_production_orders_recipe_link.js      -- incluye: custom_attributes (JSONB),
                                             additional_costs, additional_costs_notes
129_order_recipe_snapshots
130_shift_active_order_log
131_tenant_overhead_items
132_tenant_overhead_periods
133_shift_overhead_application
134_order_cost_snapshots
135_shift_progress_dynamic_attributes + lot_id
136_shift_scrap_dynamic_attributes + is_abnormal
137_shift_mp_loads_lot_id + unit_id

-- Lotes y trazabilidad (Sección 4) --
138_raw_material_lots
139_product_lots + origin enum
140_lot_consumption
141_inventory_movements_lot_links
142_supplier_receipt_lines_lot_data
143_tenant_allergens (con seed NOM-051)
144_raw_material_allergens
145_product_allergens
146_product_lot_allergens
147_products_shelf_life_days + lot_number_pattern_per_product
148_raw_materials_lot_flags (requires_coa, requires_lot_tracking)

-- Seeds y backfill --
149_seed_default_catalogs_for_existing_tenants
150_backfill_warehouses_warehouse_type_id
151_backfill_shift_scrap_scrap_type_id
152_backfill_shift_progress_quality_grade_id
153_backfill_recipes_from_order_mp_formula
```

#### 5.9.3 Cleanup migrations (al final del proyecto)

Una vez que el código v2 está estable y todos los tenants usan las nuevas columnas, se aplican las **cleanup migrations** que eliminan las columnas/tablas obsoletas. Como el repo v1 está respaldado, no hay riesgo de perder lógica viejaa.

```
118_drop_warehouses_type_enum.js              -- columna 'type' string ya no necesaria
119_drop_shift_scrap_scrap_type_enum.js
120_drop_shift_progress_is_second_quality.js  -- reemplazada por quality_grade_id
121_drop_shift_progress_second_quality_product_id.js
122_drop_order_mp_formula_table.js            -- reemplazada por order_recipe_snapshots
123_drop_raw_materials_unit_string.js         -- reemplazada por unit_id FK
124_drop_products_length_mm_width_mm_thickness_mm.js  -- reemplazada por custom_attributes
125_drop_products_grams_per_linear_meter_spec.js
126_drop_product_quality_specs_legacy.js
```

→ **38 migrations principales (116-153)** + **9 cleanup migrations** = **47 migrations** en total. Las cleanup se ejecutan en una fase post-validación, después de que todos los verticales (Palomitas → Pastelería) estén operando estables.

Los ajustes de §6 (linked_raw_material_id, custom_attributes/additional_costs en órdenes, operation_mode) están integrados a las migrations 121, 128 y 116 respectivamente — no requieren migrations adicionales.

**Estado actual del trabajo:** Las migrations 116 y 117 ya están aplicadas en sandbox; el módulo `process-config` está implementado con 16 tests pasando. Ver `docs/saas-v2/02-foundation-progress.md` (al crear) para el detalle de avance de Fase 0.

---

### 5.10 Resumen de impacto en código

| Categoría | Backend (módulos) | Backend (archivos aprox.) | Frontend (páginas) | Migrations |
|---|---|---|---|---|
| ✅ Sin cambios | 21 | ~150 | ~40 | 79 existentes |
| ➕ Extensión aditiva | 5 | ~15 | ~6 | (incluidas en nuevas) |
| 🔧 Refactor significativo | 1 (production) | ~10 | ~7 (Producción + Recepción) | 0 — el refactor no requiere migrations destructivas |
| 🆕 Nuevo | 5 (process-config, recipes, lots, allergens, overhead-costing) | ~35 | ~17 | 38 nuevas |
| **Total** | **32 módulos** | **~210 archivos** | **~70 páginas** | **117 migrations** |

#### Cuánto código nuevo vs cuánto existente se modifica

- **Líneas existentes modificadas**: estimado ~3,000 (refactor de `productionService.js` y extensiones)
- **Líneas nuevas a escribir** (backend): estimado ~12,000–15,000
- **Líneas nuevas a escribir** (frontend): estimado ~8,000–10,000
- **Líneas que NO se tocan**: la inmensa mayoría del ERP — fácil 100,000+ líneas intactas

→ **El refactor es localizado al módulo de producción + módulos nuevos.** El resto del ERP no se entera.

---

### 5.11 Riesgos del refactor (preview de Sección 8)

Dos riesgos específicos de esta sección que vale la pena anotar ahora:

1. **El `productionService.js` actual no tiene tests automatizados completos** (revisar). Si se refactoriza sin red de seguridad, el riesgo de regresiones es alto. → Mitigación: antes de refactorizar, añadir tests de caracterización ("golden master tests") que capturen el comportamiento actual exacto contra fixtures reales. **Esta es la única red de seguridad** ahora que no hay compat layer dual.

2. **47 migrations en total (38 principales + 9 cleanup)**. Si se ejecutan en mal orden o con datos sucios, pueden fallar a medio camino. → Mitigación: cada migration debe ser idempotente y tener `down()` funcional, y se prueban primero en sandbox. Las cleanup migrations se aplican **después** de validar que todos los verticales operan estables — no en bloque con las principales.

---

---

## 6. Validación contra los 4 verticales

### 6.1 Cómo leer esta sección

Por cada vertical objetivo, se muestra la configuración completa que ese tenant tendría al ser dado de alta. El objetivo es **validar que el modelo del Process Template no requiere código a la medida** — todo se resuelve por configuración.

Estructura por vertical:
- **Perfil del negocio** — qué hace, escala, particularidades
- **Flags de `tenant_process_config`**
- **Catálogos típicos** (unidades, almacenes, mermas, calidades, roles, alérgenos)
- **Tipos de producto y schemas de captura**
- **Ejemplo de producto con su receta**
- **Captura del operador** durante un turno
- **Overhead típico**
- **Validación**: ¿el modelo cubre? ¿qué necesita ajuste?

---

### 6.2 Vertical 1 — Palomitas de Maíz 🍿

#### Perfil
- Planta mediana, 1-2 líneas de producción.
- Productos: palomitas saborizadas en bolsas individuales.
- Distribución a tiendas de conveniencia y supermercados.
- Vida útil 6 meses.
- Regulado por COFEPRIS.

#### Flags (`tenant_process_config`)
```
uses_lots                     = true
uses_expiry                   = true
uses_fefo                     = true
uses_handover                 = true
uses_supervisor               = true
supervisor_validates          = true
pt_goes_to_wip_first          = false   ← sale directo a disponible
mp_goes_to_wip_first          = true
allow_second_quality_in_order = false
default_intra_shift_proration = 'time'
cost_method                   = 'fifo'  ← maíz y aceite caducan, hay que rotar
treat_abnormal_scrap_as_loss  = true
allergen_mode                 = 'priority_only'
```

#### Catálogos
- **Unidades**: kg, g, L, mL, pza, bolsa, caja, tarima · *Conversiones*: 1 caja = 24 bolsas, 1 tarima = 40 cajas
- **Tipos de almacén**: Almacén MP · Almacén Embalaje · Almacén PT · Almacén Merma
- **Tipos de merma**: "Granos sin reventar" (discard, 0%), "Quemado" (discard, 0%), "Arranque" (discard, 0%)
- **Calidades**: 1 (Apta) — única calidad
- **Roles del turno**: Capturista (required), Supervisor
- **Alérgenos**: gluten, lácteos, soya (prioritarios sembrados auto)

#### `tenant_product_kinds`: "Palomitas"
```json
attribute_schema: [
  {code: "sabor", type: "select", options: ["mantequilla","caramelo","queso","natural"], required: true},
  {code: "tamano_bolsa", type: "select", options: ["50g","100g","200g"], required: true}
]

capture_schema: [
  {code: "peso_kg", type: "number", unit: "kg", required: true, validation:{min:0, max:50}},
  {code: "unidades", type: "number", required: true}
]

default_shelf_life_days: 180
```

#### Producto ejemplo: PAL-MTQ-50G "Palomitas Mantequilla 50g"
**Receta** (versión 1, yield 1.5 kg = ~30 bolsas):
| Componente | Cantidad |
|---|---|
| Maíz palomero | 1 kg |
| Aceite vegetal | 50 mL |
| Mantequilla saborizada | 20 g |
| Sal | 5 g |
| Bolsa metalizada 50g (embalaje) | 30 pza |

`expected_scrap_pct: 8%`

**Alérgenos declarados del producto**: Lácteos
**Alérgenos heredados de MP**: Soya (potencial, vía aceite)

#### Captura típica del operador (turno de 8h)
1. Operador abre turno, hereda orden activa de turno anterior.
2. Cada hora aproximadamente captura 1 microlote:
   - peso_kg: 5.2 kg (~104 bolsas)
   - unidades: 104
   - quality_grade: 1 (Apta)
3. Sistema genera **un solo `product_lot`** para todo el turno: `PAL-MTQ-50G-2026142-2-001`.
4. Sistema descuenta MP vía FEFO desde lotes de maíz/aceite recibidos.
5. Operador captura merma al cierre: 1.2 kg granos sin reventar.

#### Overhead típico
| Concepto | Frecuencia | Base | Monto estimado |
|---|---|---|---|
| Renta | Mensual | shifts | $30,000 |
| Luz | Mensual | hours | $20,000 |
| Nómina operadores | Quincenal | shifts | $80,000 |
| Mantto. reventadora | Por evento | hours | variable |

#### Validación
✅ **Modelo cubre 100%.** Caso "feliz" — pocos ingredientes, una calidad, sin sub-productos. Sirve para validar el flujo end-to-end del MVP.

---

### 6.3 Vertical 2 — Recicladora de Plásticos ♻️

#### Perfil
- Recibe plástico mezclado por kg, lo clasifica, lava, muele y opcionalmente peletiza.
- Productos: pellets y molidos por tipo de resina y color.
- Sin caducidad. Sin alérgenos.
- Alta variabilidad de calidad de salida.

#### Flags
```
uses_lots                     = false  ← opcional; puede activarse para trazar origen
uses_expiry                   = false
uses_fefo                     = false
uses_handover                 = true
uses_supervisor               = true
supervisor_validates          = true
pt_goes_to_wip_first          = true   ← QA por tipo/color antes de liberar
mp_goes_to_wip_first          = true
allow_second_quality_in_order = true   ← común sacar 1ª, 2ª y 3ª de la misma corrida
default_intra_shift_proration = 'weight'
cost_method                   = 'weighted_avg'
treat_abnormal_scrap_as_loss  = true
allergen_mode                 = 'alert_only'  ← no aplica realmente
```

#### Catálogos
- **Unidades**: kg, tonelada, bolsa (25kg), tarima · *Conversiones*: 1 ton = 1000 kg, 1 tarima = 40 bolsas de 25 kg
- **Tipos de almacén**: MP Cruda · MP Clasificada (wip) · PT · Desperdicio (scrap)
- **Tipos de merma**:
  - "Contaminación" (discard, 0%)
  - "Finos/Polvo" (sell, 10% del costo MP) — se vende a otra recicladora
  - "Etiquetas y tapas" (sell, 5%)
- **Calidades**: 1 (Primera — pellet limpio), 2 (Segunda — color mixto), 3 (Tercera — rebabas)
- **Roles del turno**: Capturista (required), Supervisor, Operador de molino

#### `tenant_product_kinds`: "Pellet" y "Molido"
```json
// Pellet
attribute_schema: [
  {code: "color", type: "select", options: ["blanco","negro","gris","mixto","natural"]},
  {code: "tipo_resina", type: "select", options: ["PE","PP","PET","HDPE","LDPE"]},
  {code: "densidad_g_cm3", type: "number", required: false}
]

capture_schema: [
  {code: "peso_kg", type: "number", unit: "kg", required: true},
  {code: "color_observado", type: "select", options:["blanco","amarillento","gris"], required: true},
  {code: "humedad_pct", type: "number", required: false}
]
```

#### Producto ejemplo: PEL-PE-BL "Pellet PE blanco"
**Receta**:
| Componente | Cantidad |
|---|---|
| Plástico crudo PE | 1.18 kg |
| Bolsa 25kg (embalaje) | 1/25 pza |

`expected_scrap_pct: 15%` (contaminación + finos)

#### Captura típica
- Cada cambio de lote físico → microlote nuevo (~2-3 por turno).
- Operador declara calidad observada (1, 2 o 3) en cada captura.
- Sistema genera **3 `product_lots` distintos** si la corrida sacó las 3 calidades.
- Merma: 150 kg/turno de finos/polvo → se vende → resta del costo.

#### Overhead típico
| Concepto | Frecuencia | Base | Monto |
|---|---|---|---|
| Renta nave | Mensual | shifts | $60,000 |
| Luz (alta, molinos) | Mensual | hours | $90,000 |
| Nómina | Quincenal | shifts | $150,000 |
| Cuchillas molino | Por evento | hours | variable |
| Combustible montacargas | Mensual | shifts | $15,000 |

#### Validación
✅ **Modelo cubre 100%.**
- Confirma que `uses_lots=false` funciona limpio (el módulo es invisible).
- Confirma multi-calidad con NRV: cal-2 y cal-3 a precio de venta esperado, cal-1 absorbe lo restante.
- Confirma merma con valor de recuperación (`sell`).
- Valida `pt_goes_to_wip_first=true` (QA antes de liberar).
- `allergen_mode='alert_only'` confirma que la lógica no estorba cuando no aplica.

⚠ **Detalle a validar**: en recicladora a veces una sola corrida usa **varios tipos de MP** (PE crudo de varios proveedores con calidades distintas). Esto se maneja con receta multi-componente — pero implica que cada componente puede ser `is_optional` o tener `substitute_group`. **Ya está en el modelo** (Sección 2.2.10).

---

### 6.4 Vertical 3 — Frituras 🍟

#### Perfil
- Línea continua de papas/totopos.
- Múltiples sabores por producto.
- Alérgenos críticos: lácteos (saborizante queso), gluten (en algunos saborizantes).
- Merma valuada: papas rotas se reprocesan para "combos".

#### Flags
```
uses_lots                     = true
uses_expiry                   = true
uses_fefo                     = true
uses_handover                 = true
uses_supervisor               = true
supervisor_validates          = true
pt_goes_to_wip_first          = false  ← sale directo a venta
mp_goes_to_wip_first          = true
allow_second_quality_in_order = false  ← rotas no cuentan al PT objetivo
default_intra_shift_proration = 'time'
cost_method                   = 'fifo'
treat_abnormal_scrap_as_loss  = true
allergen_mode                 = 'priority_only'
```

#### Catálogos
- **Unidades**: kg, g, L, mL, pza, bolsa, caja
- **Tipos de almacén**: MP · Embalaje · Saborizantes · PT · Merma Reproceso · Merma Desecho
- **Tipos de merma**:
  - "Rotas/Quebradas" (reprocess, 30%) → a Merma Reproceso
  - "Quemadas" (discard, 0%)
  - "Sin saborizar" (reprocess, 80%) → se vuelve a saborizar
  - "Cortes irregulares" (sell, 20%) → snacks a granel
- **Calidades**: 1 (Apta), 2 (Combo — rotas reprocesadas)
- **Roles del turno**: Capturista (req.), Calidad, Supervisor, Alimentador
- **Alérgenos**: gluten, lácteos, soya, ajonjolí (prioritarios sembrados)

#### `tenant_product_kinds`: "Frituras saladas"
```json
attribute_schema: [
  {code: "sabor", type: "select", options:["original","limon","chile","queso","adobada","crema_y_finas_hierbas"]},
  {code: "tamano", type: "select", options:["50g","100g","200g","450g"]}
]
capture_schema: [
  {code: "peso_kg", type: "number", unit:"kg", required: true},
  {code: "unidades", type: "number", required: true},
  {code: "temperatura_aceite_c", type: "number", required: false}
]
default_shelf_life_days: 90
```

#### Producto ejemplo: FRI-PAP-LIM-100G "Papas Limón 100g"
**Receta**:
| Componente | Cantidad | Allergen note |
|---|---|---|
| Papa cruda | 0.4 kg | — |
| Aceite vegetal | 50 mL | (puede contener soya) |
| Sal | 2 g | — |
| Saborizante limón | 3 g | — |
| Bolsa metalizada 100g | 1 pza | — |

`expected_scrap_pct: 12%` · yield 0.1 kg PT por corrida estándar

**Alérgenos declarados**: ninguno
**Heredados de MP**: trazas de soya (alerta automática — operador la declara explícitamente o se ignora con razón)

#### Captura típica
- Cada hora: peso, unidades, calidad.
- Merma: rotas → almacén Merma Reproceso (no se pierde el valor); quemadas → desecho.
- Producto "Combo" puede ser su propio SKU separado (FRI-COMBO-200G) que se produce **a partir de Merma Reproceso** como MP en otra corrida.

#### Overhead típico
| Concepto | Frecuencia | Base | Monto |
|---|---|---|---|
| Renta | Mensual | shifts | $50,000 |
| Luz/gas | Mensual | hours | $40,000 |
| Aceite freidora (consumible no-receta) | Mensual | hours | $25,000 |
| Nómina | Quincenal | shifts | $120,000 |
| Saborizantes (consumibles menores) | Mensual | weight | $30,000 |

#### Validación
✅ **Modelo cubre 99%.**

⚠ **Caso especial detectado**: el "Combo" (FRI-COMBO-200G) se produce **a partir de Merma Reproceso** como si fuera MP. Esto requiere:
1. La merma reprocesable entra a `Merma Reproceso` (almacén tipo `scrap` con `default_destination='reprocess'`).
2. Cuando se produce el Combo, la "MP" es el item de merma — necesita ser **un `raw_materials` con `item_kind='raw_material'`** que apunte al almacén de merma.
3. **Ajuste al modelo**: la merma reprocesable necesita auto-crear (o linkear) un `raw_materials` que la represente como insumo consumible. Esto se diseña en el motor de mermas (Sección 4.8.3 ya menciona "Reproceso de expirados" — el patrón es similar).

**Decisión propuesta**: cada `tenant_scrap_types` con `default_destination='reprocess'` requiere un `linked_raw_material_id` que define **qué MP se crea/incrementa** al generarse esa merma. Es un campo nuevo opcional.

→ Agregar a Sección 2 como ajuste menor.

---

### 6.5 Vertical 4 — Pastelería 🍰

#### Perfil
- El más complejo de los 4. Recetas largas (10-20 componentes). Vida útil corta (2-7 días). Alérgenos críticos.
- Múltiples calidades por errores de decoración.
- Turnos típicamente de madrugada/mañana.

#### Flags
```
uses_lots                     = true
uses_expiry                   = true
uses_fefo                     = true
uses_handover                 = true
uses_supervisor               = true
supervisor_validates          = true
pt_goes_to_wip_first          = false   ← sale directo (no tiempo para WIP en perecederos)
mp_goes_to_wip_first          = true
allow_second_quality_in_order = true    ← decoración fallida cuenta como segunda
default_intra_shift_proration = 'time'
cost_method                   = 'fefo'
treat_abnormal_scrap_as_loss  = true
allergen_mode                 = 'priority_only'
expiry_alert_days             = 2       ← vida corta: alertar agresivamente
```

#### Catálogos
- **Unidades**: kg, g, L, mL, pza, docena, charola, caja, bolsa · *Conversiones*: 1 docena = 12 pza, 1 charola = 24 pza
- **Tipos de almacén**: Almacén Seco · Refrigerado · Congelado · Decoración · Embalaje · PT · Merma
- **Tipos de merma**:
  - "Quemado/Pasado de horno" (discard, 0%)
  - "Mal decorado" (reprocess para 2ª, 50%) — el bizcocho sirve, se redecora o se etiqueta como 2ª
  - "Caducado en exhibidor" (discard, 0% — al volver de tienda)
  - "Migajas/Recortes" (sell, 10%) — para mezclas, postres
- **Calidades**: 1 (Primera), 2 (Segunda — descuento), 3 (Personal — empleados)
- **Roles del turno**: Capturista (req.), Calidad, Supervisor, Maestro panadero, Decorador
- **Alérgenos**: gluten, lácteos, huevo, frutos secos, soya (prioritarios), apio (no prioritario)

#### `tenant_product_kinds`: "Pastel", "Panque", "Galletas"
```json
// Pastel
attribute_schema: [
  {code: "sabor", type: "select", options:["chocolate","vainilla","zanahoria","red_velvet","tres_leches"]},
  {code: "tamano", type: "select", options:["chico_500g","mediano_1kg","grande_2kg","extra_4kg"]},
  {code: "decoracion", type: "select", options:["lisa","con_flores","personalizada","sin_decorar"]},
  {code: "es_sin_gluten", type: "boolean", default: false}
]
capture_schema: [
  {code: "peso_real_g", type: "number", required: true},
  {code: "calidad_decoracion", type: "select", options:["A","B","C"], required: true}
]
default_shelf_life_days: 4
```

#### Producto ejemplo: PAS-CHO-1KG "Pastel Chocolate 1kg"
**Receta** (yield 1.2 kg = ~1 pastel):
| Componente | Cantidad | Alérgeno |
|---|---|---|
| Harina de trigo | 350 g | gluten |
| Azúcar | 250 g | — |
| Mantequilla | 200 g | lácteos |
| Huevos | 4 pza | huevo |
| Leche entera | 200 mL | lácteos |
| Chocolate amargo | 100 g | lácteos (may), soya (may) |
| Cacao en polvo | 30 g | — |
| Vainilla líquida | 10 mL | — |
| Polvo para hornear | 15 g | — |
| Charola desechable | 1 pza | — |
| Caja para pastel | 1 pza | — |

`expected_scrap_pct: 5%` (poco desperdicio en recetas medidas)

**Alérgenos declarados**: gluten, lácteos, huevo, soya

#### Captura típica
- Producción por lote pequeño (10-30 pasteles).
- Cada pastel se pesa y se asigna calidad de decoración (A/B/C → calidad 1/2/3).
- Lote por producto + turno: `PAS-CHO-1KG-2026142-1-001`.
- Caducidad: 2026-05-26 (4 días después).
- Si supervisor detecta lote de mantequilla con may-contain lácteos sin declarar → alerta (ya declarado en producto, OK).

#### Overhead típico
| Concepto | Frecuencia | Base | Monto |
|---|---|---|---|
| Renta local | Mensual | shifts | $40,000 |
| Luz/gas | Mensual | hours | $35,000 |
| Refrigeración 24/7 | Mensual | shifts | $20,000 |
| Nómina maestros | Quincenal | shifts | $150,000 |
| Insumos limpieza | Mensual | shifts | $5,000 |

#### Validación
✅ **Modelo cubre 95%.**

✅ **Caso especial 1 — Producción por encargo (resuelto)**: clientes piden pastel personalizado con texto/decoración específica. Se resuelve con **SKU genérico** (ej. `PAS-CHO-PERS-1KG` "Pastel Chocolate Personalizado 1kg") + dos campos opcionales en la orden:

```
production_orders.custom_attributes (JSONB NULL)
  Ej: {"texto": "Feliz cumpleaños Ana", "color_betun": "azul", "topper": "flor de azúcar"}

production_orders.additional_costs (NUMERIC NULL)
production_orders.additional_costs_notes (TEXT NULL)
  Ej: $150 por topper comprado + decoración tercerizada
```

La receta base (la del chocolate estándar) se reutiliza. El lote, alérgenos, trazabilidad funcionan igual. El costeo agrega `additional_costs` al total.

⚠ **Caso especial 2**: **`shelf_life_days` puede variar dentro del mismo producto** según condiciones de almacenamiento (4 días si se exhibe, 2 semanas congelado). El campo actual es único por producto.

→ **Decisión**: en MVP se usa un único `shelf_life_days` (peor caso, el más conservador). Post-MVP se podría agregar `shelf_life_by_storage_condition` JSONB en producto.

⚠ **Caso especial 3**: **co-productos** — una misma corrida de masa puede generar pasteles **y** panques (mismo bizcocho, diferente decoración). Pero la decisión de Sección 2 fue "una orden = un PT objetivo + sub-productos por calidad". Esto **no cubre** dos productos distintos de la misma corrida.

→ **Decisión**: dos órdenes separadas que comparten turno. El prorrateo intra-turno (por tiempo) se encarga del costeo justo. **El modelo lo soporta**, solo es una práctica operativa.

---

### 6.6 Lo que aprendimos validando

| # | Hallazgo | Ajuste al modelo |
|---|---|---|
| 1 | Mermas reprocesables generan un nuevo MP que debe poder consumirse | Agregar `tenant_scrap_types.linked_raw_material_id` (FK opcional) → cuando la merma entra al almacén, también incrementa el raw_material vinculado |
| 2 | Productos personalizados (pastelería) | **Resuelto en MVP**: SKU genérico + `production_orders.custom_attributes` (JSONB) + `production_orders.additional_costs` (NUMERIC). 2 campos opcionales. |
| 3 | Vida útil variable según condiciones | Documentar como **post-MVP**. Default: usa el `shelf_life_days` único. |
| 4 | Co-productos de la misma corrida (pastel + panque del mismo bizcocho) | **Resuelto por práctica operativa**: dos órdenes en el mismo turno, prorrateo intra-turno. No requiere ajuste de modelo. |
| 5 | Recicladora multi-MP intercambiables | **Resuelto**: `recipe_components.substitute_group` ya existe (Sección 2.2.10). Activar lógica de selección post-MVP. |
| 6 | `allergen_mode='alert_only'` para no-alimentarios | **Resuelto**: ya está como opción de configuración. |
| 7 | **Micro-PYME que produce en horarios irregulares** (panadería casera, vende por redes) | Agregar `tenant_process_config.operation_mode` (`industrial` / `small` / `micro`) + soporte de turnos **ad-hoc** sin programación previa + captura simplificada de overhead (un solo monto mensual prorrateable). |

#### Ajustes formales requeridos al modelo

**Tres cambios** emergen de la validación contra los 4 verticales:

1. **Mermas reprocesables vinculadas a un MP**:
```diff
tenant_scrap_types:
+ linked_raw_material_id  UUID NULL  FK a raw_materials
    -- Si está set, cuando se registra esta merma, el sistema
    -- incrementa el stock del raw_material vinculado.
    -- Permite que la "Merma Reproceso" funcione como MP consumible.
```

2. **Personalización de orden** (resuelve pastelería personalizada):
```diff
production_orders:
+ custom_attributes  JSONB NULL
    -- Atributos específicos de la orden que no están
    -- en el schema del producto. Ej: {"texto": "Feliz cumpleaños",
    -- "color_betun": "azul", "topper": "flor de azúcar"}
+ additional_costs  NUMERIC(18,2) NULL
+ additional_costs_notes  TEXT NULL
    -- Costos directos extras (mano de obra especial, materiales
    -- fuera de receta, decoración tercerizada). Suman al costo
    -- final de la orden sin afectar la receta.
```

3. **Modo operativo del tenant** (resuelve micro-PYMEs):
```diff
tenant_process_config:
+ operation_mode  VARCHAR(20) DEFAULT 'industrial'
    -- 'industrial' | 'small' | 'micro'
    -- Set de defaults aplicados al crear el tenant según escala.
    -- Influencia el setup wizard y los flags por default.
+ allow_adhoc_shifts  BOOLEAN DEFAULT false
    -- Si true, permite abrir turnos sin programación previa.
    -- Default true para small/micro, false para industrial.
+ simplified_overhead  BOOLEAN DEFAULT false
    -- Si true, ofrece UI simplificada: un solo monto mensual
    -- en lugar del catálogo detallado de tenant_overhead_items.
    -- El sistema crea internamente un overhead_item único
    -- "Gastos generales" con prorrateo por unidades producidas.
```

Estos ajustes se propagan a Secciones 2, 3 y al plan de fases (Sección 7).

---

### 6.7 Cobertura del modelo

| Vertical | Cobertura sin código custom | Notas |
|---|---|---|
| Palomitas | **100%** | Caso "feliz" — todo encaja directo |
| Recicladora | **100%** | Valida no-alimentarios y multi-calidad |
| Frituras | **100%** (con ajuste #1) | Necesita `linked_raw_material_id` |
| Pastelería | **100%** (con ajuste #2) | Pedidos personalizados resueltos vía SKU + `custom_attributes` + `additional_costs` |
| Micro-PYME (panadería casera) | **100%** (con ajuste #3) | Modo `micro` + turnos ad-hoc + overhead simplificado |

**Cobertura final: 100% de los 5 perfiles validados sin código custom**, lo cual confirma que el modelo del Process Template **funciona para los 4 verticales objetivo + escalas micro**.

Los ajustes formales son **3 cambios pequeños y aditivos**:
- 1 columna nueva en `tenant_scrap_types` (mermas reprocesables como MP)
- 2 columnas nuevas en `production_orders` (personalización + costos extras)
- 3 columnas nuevas en `tenant_process_config` (modo operativo + flags de escala)

→ **Riesgo de "abstracción en el vacío" mitigado.** El diseño se hizo contra cuatro realidades concretas + el caso extremo de escala mínima (PYME casera), no contra un futuro hipotético.

---

---

## 7. Plan de fases del MVP

### 7.1 Filosofía del plan

**Principios que guían el orden:**

1. **Foundation primero, verticales después.** No tiene sentido construir Palomitas si las tablas catálogo no existen. La Fase 0 es prerrequisito de todo.
2. **Un vertical real a la vez.** Cada fase post-foundation entrega **un tenant real onboardado y produciendo**. No se pasa de fase sin un tenant productivo.
3. **El orden de verticales fuerza descubrir abstracciones temprano.** Palomitas primero (alimento simple → fuerza lotes/caducidad/alérgenos). Recicladora segundo (valida no-alimentario sin que el código se atore). Frituras y pastelería al final (mayor complejidad).
4. **Costeo avanzado en paralelo.** El recosteo mensual es independiente de los verticales — puede correr en paralelo con Fase 2.
5. **Modo PYME al final.** Necesita el motor estable y validado antes de simplificarlo para escala micro.
6. **Sin estimaciones de tiempo.** Sin deadlines duros. Cada fase termina cuando los criterios de "done" se cumplen.

**Criterios de "done" de cualquier fase:**

| Criterio | Significado |
|---|---|
| ✅ **Migrations aplicadas** | En sandbox y producción del repo, sin errores ni rollbacks pendientes |
| ✅ **Backend completo** | Servicios + endpoints + tests unitarios pasando |
| ✅ **Frontend completo** | Pantallas funcionales sin TODOs bloqueantes |
| ✅ **Tenant real onboardado** | (post-Fase 0) Un tenant del vertical objetivo configurado y produciendo |
| ✅ **Doc de configuración** | Guía de cómo dar de alta a otro tenant del mismo vertical |
| ✅ **No regresiones v1** | El tenant actual de la planta (v1) sigue funcionando idéntico si decidiéramos correrlo (aunque no esté en producción) |

---

### 7.2 Fase 0 — Foundation

**Objetivo**: construir los cimientos del Process Template para que cualquier vertical pueda configurarse encima.

**Sin esta fase, ninguna otra puede empezar.**

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migrations 080-097 | Todas las tablas catálogo + extensiones (excepto lotes y overhead detallado) |
| `tenants.process_engine_version` | Flag v1/v2 + todos los tenants existentes marcados v1 |
| `tenant_process_config` | Una fila por tenant existente con defaults compat |
| Módulo `process-config/` | CRUD completo de tenant_units, warehouse_types, scrap_types, quality_grades, shift_roles, product_kinds |
| Módulo `recipes/` | CRUD de recipes + recipe_components |
| Tests de caracterización | Golden master tests del `productionService` v1 antes de tocarlo (red de seguridad) |
| Refactor inicial de `productionService` | Extracción de `orderService`, `shiftLifecycleService`, `captureService`. La lógica v1 se aísla en `*_v1.js`. |
| Adaptadores | `recipeAdapter`, `captureSchemaAdapter`, `qualityGradeService` con cascada v1/v2 |
| Triggers de backward compat | Sincronización `warehouses.type` ↔ `warehouse_type_id`, etc. |
| Motor de costeo básico | `weighted_avg` funcional con receta nueva. FIFO se difiere a Fase 1. |

#### Entregables frontend

| Pantalla | Estado |
|---|---|
| `pages/Configuracion/Procesos.jsx` | Hub de configuración |
| `pages/Configuracion/procesos/Unidades.jsx` | Editor de unidades |
| `pages/Configuracion/procesos/TiposAlmacen.jsx` | Editor de tipos de almacén |
| `pages/Configuracion/procesos/TiposMerma.jsx` | Editor de tipos de merma |
| `pages/Configuracion/procesos/Calidades.jsx` | Editor de calidades |
| `pages/Configuracion/procesos/RolesTurno.jsx` | Editor de roles |
| `pages/Configuracion/procesos/TiposProducto.jsx` | Editor de schemas (attribute + capture) |
| `pages/Configuracion/procesos/Flags.jsx` | Toggles globales |
| `pages/Catalogos/Productos.jsx` ➕ | Tab "Receta" y "Atributos custom" |

#### Criterios de done de Fase 0

- ✅ Un tenant nuevo puede ser dado de alta y configurar sus 7 catálogos básicos via UI.
- ✅ El tenant puede crear productos con receta y atributos custom.
- ✅ Una orden de producción puede crearse, liberarse, capturarse y cerrarse usando el motor v2.
- ✅ El tenant actual (v1) no nota cambios — corre con lógica `*_v1.js`.
- ✅ Tests de caracterización pasan al 100%.

→ **Esta fase es la más grande del proyecto.** ~50% del esfuerzo total estimado.

---

### 7.3 Fase 1 — Palomitas (primer vertical alimentario)

**Objetivo**: onboardar primer tenant comercial real. Palomitas valida lotes, caducidad, alérgenos y captura schema-driven con UI rápida.

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migrations 102-112 | Lotes (MP + PT), `lot_consumption`, alérgenos, shelf_life, lot patterns |
| Módulo `lots/` | `lotService`, `lotGenerator`, `lotConsumptionService`, `expiryService`, `traceabilityService` |
| Módulo `allergens/` | Catálogo NOM-251 + declaración + herencia + cuarentena automática |
| Extensión a `purchases` | `supplier_receipt_lines.lot_data` JSONB + trigger que crea `raw_material_lots` / `product_lots` |
| FEFO en consumo de MP | Selector de lote por `expiry_date ASC, received_at ASC` |
| FIFO como método de costeo | `cost_method = 'fifo'` operativo |
| Cron `expiryCheck` | Diario 06:00, marca lotes expirados y emite alertas |
| Cron `expiryAlerts` | Diario 07:00, emails de lotes próximos a vencer |

#### Entregables frontend

| Pantalla | Tipo |
|---|---|
| `pages/Produccion/Captura.jsx` 🔧 | Refactor mayor: schema-driven dinámico + **modo captura rápida** con botones de presets |
| `pages/Compras/Recepcion.jsx` ➕ | Panel opcional "Información de lote" |
| `pages/Catalogos/Productos.jsx` ➕ | Tab "Alérgenos" y campo `shelf_life_days` |
| `pages/Catalogos/MateriasPrimas.jsx` ➕ | Tab "Alérgenos" y flag `requires_lot_tracking` |
| `pages/Alergenos/Catalogo.jsx` 🆕 | CRUD de tenant_allergens con seed NOM-051 |
| `pages/Trazabilidad/LoteDetalle.jsx` 🆕 | Vista del lote: contenido (MP que entró), alérgenos efectivos, estado |
| `pages/Trazabilidad/VencimientosProximos.jsx` 🆕 | Dashboard de alertas |

#### Onboarding del tenant Palomitas

1. Crear tenant en plataforma SaaS.
2. Aplicar plantilla "Alimentos secos" (configura defaults razonables).
3. Sembrar productos típicos del cliente, MPs, embalajes.
4. Capturar recetas con el cliente.
5. Sembrar overhead estimado (mensual).
6. Operador hace 1 turno piloto bajo supervisión.
7. Si todo OK → producción regular comienza.

#### Criterios de done

- ✅ Palomitas captura 1 turno completo (apertura → captura → cierre → validación).
- ✅ Lotes generados automáticamente con número correcto.
- ✅ Caducidad calculada y visible en inventario.
- ✅ Alérgenos heredados correctamente desde MP (alerta de "puede contener trazas").
- ✅ Trazabilidad backward funcional (consultar lote → ver MP usadas).
- ✅ Captura rápida toma < 10 segundos por microlote.

→ **Esta es la primera fase con ingresos comerciales.** Validación real del producto.

---

### 7.4 Fase 2 — Recicladora (valida no-alimentario)

**Objetivo**: onboardar segundo tenant. Recicladora valida que el motor funciona fuera del mundo alimentario, multi-calidad con NRV, y mermas con valor de recuperación.

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migración 115 | `tenant_scrap_types.linked_raw_material_id` (mermas reprocesables) |
| NRV multi-calidad operativo | `costEngine` aplica método NRV al cierre de turno |
| Recovery value de mermas | Cálculo `recovered_value = scrap_kg × material_cost × pct/100` |
| Sub-productos por calidad | Generación de N `product_lots` distintos (uno por calidad) en una corrida |
| `pt_goes_to_wip_first=true` | Flujo WIP → QA → liberado |

#### Entregables frontend

| Pantalla | Cambio |
|---|---|
| `pages/Produccion/Captura.jsx` ➕ | Selector de calidad al capturar (cuando `quality_grades > 1`) |
| `pages/Produccion/Validacion.jsx` ➕ | Visualización de calidades obtenidas, costo por calidad (NRV) |
| `pages/Catalogos/Productos.jsx` ➕ | Campo `expected_sale_price` para NRV de calidades inferiores |

#### Onboarding del tenant Recicladora

1. Crear tenant en modo `industrial` con `uses_lots=false` (no necesita trazabilidad alimentaria).
2. Aplicar plantilla "Reciclaje industrial".
3. Configurar 3 calidades (Primera/Segunda/Tercera) y NRV de cada una.
4. Sembrar productos (pellets, molidos) con sus recetas.
5. Sembrar mermas con destinos (regrind/finos vendibles).
6. Piloto + producción.

#### Criterios de done

- ✅ Recicladora produce un turno con 3 calidades simultáneas.
- ✅ Sistema genera 3 lotes distintos (uno por calidad).
- ✅ Costo unitario cal-1 absorbe correctamente la diferencia tras descontar NRV de cal-2 y cal-3.
- ✅ Mermas vendibles restan correctamente del costo.
- ✅ Flujo PT → WIP → disponible funciona.

→ **Validación clave**: confirmar que el motor sirve para **dos mundos opuestos** (alimentos vs industrial puro). Si funciona aquí, los siguientes 2 verticales son refinamientos, no descubrimientos.

---

### 7.5 Fase 3 — Overhead y recosteo

**Objetivo**: implementar el motor de costeo completo con captura de overhead, prorrateo y recosteo mensual.

**Puede correr en paralelo con Fase 2** — son independientes técnicamente.

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migraciones 095-098 (si no en Fase 0) | `tenant_overhead_items`, `tenant_overhead_periods`, `shift_overhead_application`, `order_cost_snapshots` |
| Módulo `overhead-costing/` | Completo: items, periods, application, costEngine, recostingService, varianceReportService |
| `shift_active_order_log` | Tracking de cambios de orden activa por turno (para prorrateo `time`) |
| Cron `recostingReminders` | Día 5 de cada mes: recordatorio al rol contable |
| Endpoints de cierre | `POST /finance/periods/:id/close`, validación, generación de variance |

#### Entregables frontend

| Pantalla | Tipo |
|---|---|
| `pages/Costeo/GastosIndirectos.jsx` 🆕 | CRUD de `tenant_overhead_items` con frecuencia y base de prorrateo |
| `pages/Costeo/PeriodosOverhead.jsx` 🆕 | Captura de estimated y real por período |
| `pages/Costeo/CierreDeMes.jsx` 🆕 | Wizard de cierre con validación |
| `pages/Costeo/VarianceReport.jsx` 🆕 | Reporte de variación con alertas |
| `pages/Costeo/TendenciaCostos.jsx` 🆕 | Dashboard histórico de costo unitario por producto |

#### Criterios de done

- ✅ Tenant configura su catálogo de overhead (renta, luz, nómina, etc.).
- ✅ Turnos durante el mes acumulan overhead estimado correctamente.
- ✅ Cierre de mes captura reales y recostea automáticamente.
- ✅ Variance report muestra desviaciones por gasto y por producto.
- ✅ `order_cost_snapshots` mantiene 2 filas por orden (estimated + recosted).
- ✅ Cron de recordatorio funciona.

---

### 7.6 Fase 4 — Frituras

**Objetivo**: onboardar tercer tenant. Frituras valida mermas reprocesables como MP y línea de saborización.

#### Entregables específicos

- Ya existe lo necesario tras Fases 0-3. Esta fase es principalmente **onboarding** + UX refinements.
- Si la mejora de captura rápida no se hizo bien en Fase 1, se refina aquí.
- Documentación de patrón "MP de merma reprocesada" (Combo a partir de papas rotas).

#### Criterios de done

- ✅ Frituras produce con sabores múltiples (limón, chile, queso, original).
- ✅ Papas rotas entran a almacén "Merma Reproceso" y se consumen como MP del "Combo".
- ✅ Alérgenos críticos (lácteos en saborizante queso) bloquean automáticamente si no están declarados en producto.
- ✅ Captura rápida funciona en línea continua.

---

### 7.7 Fase 5 — Pastelería

**Objetivo**: onboardar cuarto tenant. Pastelería valida recetas largas, vida útil corta y pedidos personalizados.

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migración | `production_orders.custom_attributes` (JSONB) + `additional_costs` (NUMERIC) |
| `expiry_alert_days` granular | Configurable por producto (no solo global) |
| Pedidos personalizados | Soporte de la orden con custom_attributes + costos extras |

#### Entregables frontend

| Pantalla | Cambio |
|---|---|
| `pages/Produccion/Ordenes.jsx` ➕ | Form de orden con custom_attributes (decoración personalizada) y costos extras |
| `pages/Produccion/Ordenes.jsx` ➕ | Indicador visual de pedidos personalizados (color, ícono) |
| `pages/Trazabilidad/VencimientosProximos.jsx` ➕ | Alertas más agresivas para perecederos (< 2 días) |

#### Criterios de done

- ✅ Pastelería produce pasteles estándar (no personalizados).
- ✅ Pastelería procesa pedidos personalizados con texto custom y costos extras.
- ✅ Alertas de caducidad funcionan a 1-2 días.
- ✅ Recetas con 10-15 componentes se manejan sin problemas en UI.

→ **Fin del MVP estándar.** El SaaS ya cubre los 4 verticales objetivo.

---

### 7.8 Fase 6 — Modo PYME (mercado masivo)

**Objetivo**: extender el SaaS al mercado de PYMEs caseras y pequeñas — el segmento con mayor volumen potencial.

#### Entregables backend

| Pieza | Descripción |
|---|---|
| Migración | `tenant_process_config.operation_mode`, `allow_adhoc_shifts`, `simplified_overhead` |
| Turnos ad-hoc | Endpoint `POST /shifts/start-now` sin requerir programación |
| Overhead simplificado | Si `simplified_overhead=true`, crear automáticamente un único overhead_item "Gastos generales" con prorrateo por unidades producidas |
| Plantillas de onboarding | Templates pre-cargados para "Panadería casera", "Repostería boutique", "Producción artesanal" |

#### Entregables frontend

| Pantalla | Tipo |
|---|---|
| `pages/Onboarding/SelectMode.jsx` 🆕 | Al crear tenant: ¿industrial/small/micro? Aplica defaults apropiados. |
| `pages/Onboarding/QuickSetup.jsx` 🆕 | Setup wizard simplificado para modo `micro` (5 pasos vs 15+) |
| `pages/Produccion/StartNow.jsx` 🆕 | Pantalla principal para PYME — "Iniciar producción ahora" |
| `pages/Costeo/GastosGenerales.jsx` 🆕 | Versión simplificada: un monto mensual |

#### Criterios de done

- ✅ Una panadera casera puede dar de alta su negocio en < 15 minutos sin ayuda.
- ✅ Inicia turno con un click el martes 6pm, lo cierra cuando termina.
- ✅ Compliance NOM-251 sigue activo (lotes, caducidad, alérgenos) sin friction extra.
- ✅ Captura sus gastos generales como un solo monto mensual.

→ **Esta fase abre el mercado masivo.** Es donde el SaaS escala comercialmente.

---

### 7.9 Diagrama de dependencias

```
┌──────────────────────────────────────────────────────────────┐
│                    Fase 0 — Foundation                        │
│  (catálogos, recetas, costeo básico, refactor production)     │
└──────────────────────────┬───────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌─────────────────┐
│ Fase 1        │  │ Fase 3        │  │ (otras fases    │
│ Palomitas     │  │ Overhead +    │  │  bloqueadas     │
│ (lotes, FEFO, │  │ Recosteo      │  │  hasta Fase 1)  │
│ alérgenos)    │  │ (independiente│  └─────────────────┘
└──────┬────────┘  │  de verticales)│
       │           └───────┬───────┘
       ▼                   │
┌───────────────┐          │
│ Fase 2        │◀─────────┘
│ Recicladora   │
│ (NRV, multi-  │
│  calidad)     │
└──────┬────────┘
       ▼
┌───────────────┐
│ Fase 4        │
│ Frituras      │
└──────┬────────┘
       ▼
┌───────────────┐
│ Fase 5        │
│ Pastelería    │
└──────┬────────┘
       ▼
┌───────────────┐
│ Fase 6        │
│ Modo PYME     │
└───────────────┘
```

**Lecturas del diagrama:**

- **Fase 0 bloquea todo** — es prerequisito absoluto.
- **Fase 3 (overhead) puede correr en paralelo con Fase 2** — son independientes.
- **Fases 4-5 dependen de tener el motor estable** (Fases 1-3).
- **Fase 6 (PYME) requiere el motor completo y estable** — no es buen primer caso.

---

### 7.10 Post-MVP roadmap

Lo que **no entra en el MVP** pero queda documentado:

| Capacidad | Por qué post-MVP | Cuándo retomar |
|---|---|---|
| Standard cost method | weighted_avg + FIFO cubren 95% de casos | Si llega un tenant que lo requiere explícitamente |
| Selección automática de `substitute_group` en recetas | Operador puede elegir manualmente | Cuando haya datos para entrenar la lógica |
| Procesos intermedios (multi-estación) | Caso de manufactura discreta, no de batch | Si el SaaS expande a manufactura discreta (módulo Enterprise) |
| Integración con scanner / sensores | Hardware specific, no SaaS-genérico | Cuando un tenant grande lo financie |
| OEE module completo | Datos disponibles, falta el cálculo y dashboard | Cuando 1+ tenant pague por reportes avanzados |
| Self-service tenant onboarding completo | MVP onboarda con apoyo humano | Cuando haya 5+ tenants y el patrón sea claro |
| API pública para integraciones | Útil pero no crítico para arrancar | Cuando un tenant pida integrar con su SAP/sistema legacy |
| App móvil del operador | UI web responsive cubre tablets | Cuando un tenant grande lo pida |
| Reportes regulatorios pre-construidos (NOM-251 audit pack, COFEPRIS export) | Datos están, faltan plantillas | Cuando primer tenant tenga auditoría |
| Multi-idioma | El SaaS arranca en español | Si hay clientes fuera de México |
| Vida útil variable por condiciones de almacenamiento | Casos raros, default cubre el peor caso | Si pastelería lo pide explícitamente |
| Devoluciones de venta con lotes | Caso ocasional, complejo, no bloqueante MVP | Cuando un tenant tenga incidente real |
| API pública versionada (`/v1/`, `/v2/`) | No hay integraciones externas en MVP | Cuando 1+ tenant pida integrar con su sistema |
| Rate limiting / cuotas por tenant | Pocos tenants iniciales | Cuando se alcance 20+ tenants activos |
| Observabilidad avanzada (distributed tracing) | Logging básico es suficiente para MVP | Cuando aparezcan bugs difíciles en producción |
| Catálogo de errores con i18n | Solo español en MVP | Cuando se internacionalice |
| Notas de crédito de proveedor en costeo | Caso raro de ajuste contable | Cuando un tenant tenga este flujo recurrente |
| Eliminación de datos de tenant (LFPDPPP completa) | Requerimiento de privacidad anticipado, no bloqueante | Cuando aparezca solicitud ARCO real |
| Tabla `production_order_extra_costs` con líneas tipificadas | MVP usa columna única `additional_costs` | Si pastelería personalizada lo pide |
| Selección automática de `substitute_group` en recetas | Operador elige manualmente | Cuando haya datos para entrenar la lógica |

---

### 7.11 Criterios de "MVP completo"

El MVP se considera **completo** cuando se cumplen estos criterios:

| # | Criterio | ¿Cómo se mide? |
|---|---|---|
| 1 | **4 tenants reales produciendo** | Palomitas, Recicladora, Frituras, Pastelería con al menos 1 mes de operación en el sistema |
| 2 | **Motor de costeo con recosteo mensual** | Cierres de mes ejecutados correctamente con variance reports generados |
| 3 | **Compliance NOM-251 funcional** | Trazabilidad backward + recall funcionan para los 3 tenants alimentarios |
| 4 | **Modo PYME disponible** | Al menos 1 tenant en modo `micro` operando |
| 5 | **Sin regresiones v1** | Tenant actual de planta seguiría funcionando si se le activara |
| 6 | **Documentación de configuración** | 4 guías de onboarding (una por vertical) + 1 de modo PYME |
| 7 | **Tests automatizados** | Cobertura > 70% del nuevo código + golden master tests del motor v1 |

Cumplidos los 7 criterios → MVP listo para crecimiento comercial activo.

---

### 7.12 Riesgos específicos del plan

Tres riesgos del plan de fases que conviene anticipar:

1. **Fase 0 puede crecer y atrasar todo.** Es la más grande y la más abstracta. El riesgo es perfeccionarla en lugar de cerrarla.
   → **Mitigación**: criterio rígido de done — si una pieza no la requiere Fase 1, se difiere.

2. **Onboardar 4 tenants reales requiere relación comercial.** No basta con código — necesitas que el cliente quiera ser early adopter.
   → **Mitigación**: identificar tenants candidatos antes de Fase 1. Tener 1-2 candidatos firmes por vertical, no solo 1.

3. **Refactor del `productionService` puede romper la planta v1 sin que nos enteremos.** Como la planta no está corriendo el sistema, no hay alerta natural si algo se rompe.
   → **Mitigación**: tests de caracterización en Fase 0 + correr CI contra un sandbox v1 con cada PR.

---

---

## 8. Riesgos y mitigaciones

### 8.1 Filosofía del análisis

Esta sección **NO es una lista pesimista** — es un mapa de los escenarios que podrían descarrilar el proyecto y cómo los anticipamos. Un riesgo identificado es 10x más barato de manejar que uno descubierto en producción.

**Para cada riesgo se documenta:**

- 🎯 **Descripción**: qué podría salir mal
- 📊 **Probabilidad**: Alta / Media / Baja
- 💥 **Impacto**: Alto / Medio / Bajo
- 🛡️ **Mitigación**: qué hacemos para reducirlo
- 🚨 **Señal de alerta temprana**: cómo detectarlo antes de que cause daño

**Escala de calificación combinada (Probabilidad × Impacto):**

| | Impacto Alto | Impacto Medio | Impacto Bajo |
|---|---|---|---|
| **Prob. Alta** | 🔴 Crítico | 🟠 Alto | 🟡 Medio |
| **Prob. Media** | 🟠 Alto | 🟡 Medio | 🟢 Bajo |
| **Prob. Baja** | 🟡 Medio | 🟢 Bajo | 🟢 Bajo |

---

### 8.2 Riesgos técnicos

#### R-T1 — Refactor de `productionService.js` rompe lógica existente

🎯 **Descripción**: Las 3,363 líneas del archivo actual tienen lógica entrelazada (mp_formula, modelo D, second quality, scrap). Refactorizarlo en piezas puede introducir regresiones sutiles que no se notan hasta producción.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto** (rebajado de Crítico)

🛡️ **Mitigación**:
- **Golden master tests** (caracterización) ANTES de tocar el código en Fase 0. Cada función pública del servicio queda con un test que captura su comportamiento actual exacto contra fixtures de datos reales. **Es la red de seguridad principal** ahora que no hay compat layer dual.
- **Refactor incremental**: nunca refactorizar más de 1 función por PR. Cada PR pasa los golden tests.
- **Repo v1 respaldado independiente**: si hay duda sobre comportamiento esperado, se compara contra la lógica v1 corriendo en el repo respaldado del usuario. La v1 no se preserva en este repo.
- **Code review estricto** de cada PR del refactor.

🚨 **Alerta temprana**: golden master tests fallan en CI. Comportamiento del sistema v2 no coincide con casos de prueba derivados del repo v1.

---

#### R-T2 — Migrations fallan a medio camino con datos sucios

🎯 **Descripción**: Las 38 migrations nuevas necesitan ejecutarse en orden, idempotentes, sobre data real. Si una falla en producción a la migration 18 de 38, el sistema queda en estado intermedio.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto**

🛡️ **Mitigación**:
- Cada migration debe ser **idempotente** (re-ejecutable sin efecto).
- Cada migration debe tener un **`down()` funcional** (probado en sandbox).
- **Sandbox-first**: toda migration corre en `reset-sandbox.js` antes de aplicarse a producción.
- **Transaccionalidad**: cada migration envuelta en BEGIN/COMMIT cuando sea posible.
- **Backup automático** del schema (no solo data) antes de aplicar batch de migrations.

🚨 **Alerta temprana**: tiempo de ejecución de migration > 2× el esperado en sandbox. Errores no anticipados en `migrate.js`.

---

#### R-T3 — Backfill incorrecto de enum → catálogo

🎯 **Descripción**: ~~Antes~~: Triggers de backward compat sincronizaban columnas paralelas. **Decisión actualizada**: no hay triggers ni columnas paralelas activas — solo se hace **backfill** de enum→FK al aplicar las migrations, y las columnas enum viejas se eliminan en cleanup migrations. El riesgo ahora es solo que el **backfill inicial** mapee enums a IDs equivocados.

📊 Probabilidad: **Baja** · 💥 Impacto: **Medio** · 🟢 **Bajo** (rebajado de Medio)

🛡️ **Mitigación**:
- **Mapeo enum→catálogo documentado explícitamente** en §2.6.4 (tabla de seed). Code review verifica que las migrations sigan ese mapeo.
- **Validación post-migration**: cada migration de backfill incluye una query de verificación al final (`SELECT COUNT(*) WHERE warehouse_type_id IS NULL` debe ser 0).
- **Sandbox-first**: las migrations corren en sandbox con data real antes de producción.

🚨 **Alerta temprana**: query de validación falla. Datos NULL en columnas FK donde no debería haberlos.

---

#### R-T4 — JSONB sin validación genera datos sucios

🎯 **Descripción**: `capture_schema`, `attribute_schema`, `custom_attributes`, `lot_data` son JSONB libres. Sin validación contra schema, un tenant puede capturar `{peso: "abc"}` o un schema mal formado.

📊 Probabilidad: **Alta** · 💥 Impacto: **Medio** · 🟠 **Alto**

🛡️ **Mitigación**:
- **JSON Schema validation** en el backend antes de insertar/actualizar (librerías: `ajv` en Node.js).
- **CHECK constraints** en PostgreSQL para validaciones estructurales básicas.
- **UI valida primero** — el frontend usa la misma JSON Schema para generar el formulario, así el dato malo no llega al backend.
- **Migraciones de schema**: si `attribute_schema` del kind cambia, validar que `custom_attributes` existentes sigan siendo válidos (o forzar migración de datos).

🚨 **Alerta temprana**: queries `SELECT ... WHERE jsonb_typeof(...) != 'expected'`. Excepciones en código que asume tipo.

---

#### R-T5 — Performance: recosteo masivo lento al cierre de mes

🎯 **Descripción**: Cierre de mes recalcula `shift_overhead_application.real_amount` y `order_cost_snapshots` para cada turno y orden del mes. Con 100+ tenants, miles de turnos y decenas de miles de órdenes, podría tomar horas.

📊 Probabilidad: **Media** · 💥 Impacto: **Medio** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Job queue** (`queues/` ya existe en el repo) para procesar el recosteo asíncronamente.
- **Recosteo por lotes** (chunks de 500 turnos), con progreso visible al usuario.
- **Índices apropiados** en `shift_overhead_application(tenant_id, period_id)` y `order_cost_snapshots(order_id, snapshot_type)`.
- **Precomputación**: las cifras estimated ya están al cerrar cada turno → solo se recalcula el delta.

🚨 **Alerta temprana**: tiempo de cierre de mes > 30 min para tenants medianos en sandbox.

---

#### R-T6 — FEFO falla si compras no captura lotes

🎯 **Descripción**: FEFO/FIFO depende de que cada receipt tenga `lot_data`. Si el almacenista olvida capturar o salta el panel (que es **opcional** en la UI), los lotes no existen y la trazabilidad se rompe.

📊 Probabilidad: **Alta** · 💥 Impacto: **Alto** · 🔴 **Crítico** (para alimentos)

🛡️ **Mitigación**:
- Si `tenant_process_config.uses_lots=true` Y la MP tiene `requires_lot_tracking=true` → el panel de lote es **obligatorio** (no skippable).
- Si el almacenista intenta confirmar receipt sin lot_data → error de validación claro: "Esta materia prima requiere captura de lote".
- **Auditoría retroactiva**: cron mensual que detecta MP usada en producción sin lote y emite reporte.

🚨 **Alerta temprana**: reportes de `inventory_movements` de tipo `production_mp_consume` con `raw_material_lot_id IS NULL` en tenants alimentarios.

---

#### R-T7 — Equipo de 2 (bus factor)

🎯 **Descripción**: Solo el usuario + Claude. Si el usuario se incapacita un mes, el proyecto para. Si Claude pierde contexto entre sesiones, las decisiones tomadas se olvidan.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Este documento** es la memoria persistente del proyecto. Todas las decisiones quedan aquí.
- **Memory files** en `~/.claude/projects/.../memory/` capturan contexto para sesiones futuras.
- **Commits frecuentes con mensajes detallados** — cada PR debe poder leerse y entenderse meses después.
- **CLAUDE.md** del repo debe mantenerse actualizado con cómo correr/probar/desplegar.
- **Tests son documentación**: si los tests están, cualquier desarrollador nuevo (humano o IA) puede entender el comportamiento esperado.

🚨 **Alerta temprana**: el usuario pasa más de 2 semanas sin tocar el repo. PRs sin descripción.

---

### 8.3 Riesgos comerciales

#### R-C1 — No conseguir tenants reales para validar fases

🎯 **Descripción**: Las Fases 1-5 cada una requiere un tenant real produciendo. Si no hay relación comercial concreta con candidatos antes de Fase 1, el SaaS se construye en el vacío.

📊 Probabilidad: **Alta** · 💥 Impacto: **Alto** · 🔴 **Crítico**

🛡️ **Mitigación**:
- **Identificar tenants candidatos durante Fase 0**, no después. Tener al menos 2 contactos firmes por vertical (8 contactos totales).
- **Pricing transitorio**: oferta gratuita o muy barata para primeros tenants a cambio de feedback estructurado.
- **Network del usuario**: aprovechar contactos directos antes de salir a marketing frío.
- **Validar interés con landing page + waitlist** durante Fase 0 — saber si hay demanda real antes de construir 5 fases.

🚨 **Alerta temprana**: terminamos Fase 0 sin un solo tenant candidato comprometido para Fase 1. Conversaciones comerciales que no avanzan a "vamos a probarlo".

---

#### R-C2 — Tenant abandona durante onboarding

🎯 **Descripción**: Onboardar un tenant alimentario implica capturar productos, recetas, MPs, alérgenos. Si el proceso toma 2 semanas y el tenant pierde interés, perdimos el caso de validación.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Plantillas pre-cargadas por vertical** (Sección 7.8) — el tenant arranca con un 70% de catálogos ya armados.
- **Onboarding asistido** en los primeros tenants (hands-on con ellos, no self-service).
- **Quick wins en primeros 3 días**: capturar 1 producto + 1 receta + hacer 1 turno simulado. Ver valor inmediato.
- **Compromiso comercial mínimo**: contrato simple (incluso $0) que establece expectativas mutuas.

🚨 **Alerta temprana**: tenant deja de responder mensajes. Cancela demos.

---

#### R-C3 — Tenants piden features fuera del MVP

🎯 **Descripción**: Pastelería pide pedidos personalizados completos (no solo SKU genérico). Recicladora pide procesos intermedios. Cualquier tenant pide su feature pet. Si todos se aceptan, el MVP nunca termina.

📊 Probabilidad: **Alta** · 💥 Impacto: **Medio** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Sección 1.2 "Qué NO es"** es un contrato — usar esa sección como referencia al rechazar pedidos.
- **Roadmap público** mostrando qué SÍ está en el MVP y qué está post-MVP. Da claridad al tenant.
- **Feedback loop estructurado**: tenant requests se anotan en `docs/saas-v2/backlog-post-mvp.md` — no se rechazan, se priorizan luego.
- **Premium tier futuro**: features avanzadas como procesos intermedios pueden ser argumento de upsell post-MVP.

🚨 **Alerta temprana**: la backlog post-MVP crece más rápido que las features completadas. Sprints con scope creep.

---

#### R-C4 — Modelo de pricing inadecuado

🎯 **Descripción**: Un PYME casero no paga lo mismo que una planta industrial. Si el pricing es uniforme, o se pierde el mercado masivo (PYME) o se subvalúa al industrial.

📊 Probabilidad: **Media** · 💥 Impacto: **Medio** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Tier según `operation_mode`**: micro/small/industrial = 3 precios distintos.
- **Pricing por uso** (turnos/mes, órdenes/mes, productos en catálogo) en lugar de "flat fee".
- **Investigación de mercado** antes de fijar precio: hablar con 5+ candidatos por vertical sobre disposición a pagar.

🚨 **Alerta temprana**: tenants se inscriben pero no usan (precio muy caro). O usan masivamente pero no quieren pagar (precio mal posicionado como gratis).

---

### 8.4 Riesgos regulatorios

#### R-R1 — Cambios en NOM-251 / NOM-051 durante desarrollo

🎯 **Descripción**: Las NOMs se actualizan periódicamente. Una actualización mientras construimos podría invalidar parte del diseño de lotes/etiquetado.

📊 Probabilidad: **Baja** · 💥 Impacto: **Medio** · 🟢 **Bajo**

🛡️ **Mitigación**:
- **Suscripción a actualizaciones de SE/COFEPRIS** (alertas de diario oficial).
- **Modelo flexible**: los catálogos (alérgenos, calidades) son configurables — adaptarlos a cambios de NOM es config, no código.
- **Período de gracia**: las NOMs típicamente dan 12-24 meses para cumplir cambios.

🚨 **Alerta temprana**: publicación de modificación a NOM-251 o NOM-051 en DOF.

---

#### R-R2 — COFEPRIS audita a tenant alimentario y encuentra hueco

🎯 **Descripción**: Un tenant es auditado, COFEPRIS pide demostrar trazabilidad de un lote y el sistema no responde (datos faltantes, queries no implementadas). El tenant es multado y abandona el SaaS, posiblemente demanda.

📊 Probabilidad: **Baja** · 💥 Impacto: **Alto** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Reporte regulatorio pre-construido**: "Pack de auditoría NOM-251" que exporta toda la info de un lote en formato que COFEPRIS acepta.
- **Disclaimer legal en términos de servicio**: el SaaS provee herramientas, el tenant es responsable del cumplimiento (esto **no elimina** el riesgo de imagen, pero acota la responsabilidad legal del SaaS).
- **Auditoría interna** simulada antes de que un tenant entre a producción comercial.
- **Documentación de configuración** que valide que el tenant capturó todo correctamente.

🚨 **Alerta temprana**: tenant alimentario operando sin lotes capturados. Reportes de trazabilidad con huecos.

---

#### R-R3 — Demanda por recall mal manejado

🎯 **Descripción**: Un lote sale al mercado con un MP contaminado. Recall se ejecuta pero el sistema no identifica correctamente todos los lotes afectados o todos los clientes. Consumidor enferma, demanda al tenant, el tenant demanda al SaaS.

📊 Probabilidad: **Baja** · 💥 Impacto: **Alto** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Tests exhaustivos del workflow de recall** (Sección 4.10) con datos sintéticos y casos edge.
- **Auditoría dual**: cada recall genera tanto un reporte automático como uno manual que el supervisor debe firmar.
- **Conservar logs históricos indefinidamente** (no rotar `inventory_movements`, `lot_consumption`, `audit_logs`).
- **Cláusula de limitación de responsabilidad** en términos de servicio.

🚨 **Alerta temprana**: tests de recall en sandbox no identifican el 100% de lotes esperados.

---

#### R-R4 — LFPDPPP (privacidad de datos personales)

🎯 **Descripción**: Datos de empleados (operadores) y clientes (en recall) son personales. Brecha de seguridad o mal manejo expone al SaaS a multas del INAI.

📊 Probabilidad: **Baja** · 💥 Impacto: **Medio** · 🟢 **Bajo**

🛡️ **Mitigación**:
- **Aviso de privacidad** publicado y firmado por cada tenant.
- **Cifrado en tránsito** (TLS) y **en reposo** (PostgreSQL encryption at rest).
- **Mínima recolección**: solo capturamos lo necesario para el negocio.
- **Borrado**: a solicitud del titular, datos personales borrables manteniendo trazabilidad (anonimización).

🚨 **Alerta temprana**: solicitud ARCO de un titular sin proceso definido.

---

### 8.5 Riesgos operacionales

#### R-O1 — Tenant configura mal los catálogos iniciales

🎯 **Descripción**: Tenant define mal sus unidades (kg en lugar de gramos), o sus calidades (1, 2, 3 invertidas), o su receta. Producen un mes con datos malos, luego descubren el error.

📊 Probabilidad: **Alta** · 💥 Impacto: **Medio** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Setup wizard guiado** con validaciones en cada paso.
- **Plantillas por vertical** con valores razonables ya configurados.
- **Período de validación**: las primeras 2 semanas el tenant opera en modo "piloto" — los datos pueden corregirse sin penalización.
- **Onboarding asistido** en primeros tenants (no self-service hasta tener UX probada).

🚨 **Alerta temprana**: variance reports con cifras absurdas (costo unitario 10x esperado).

---

#### R-O2 — Operador no entiende UI schema-driven

🎯 **Descripción**: El formulario dinámico de captura cambia entre productos. Operador acostumbrado a un layout fijo se confunde, captura datos incorrectos o tarda mucho.

📊 Probabilidad: **Media** · 💥 Impacto: **Medio** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Diseño UX consistente**: mismos patrones visuales (mismo color para "peso", mismo lugar para "calidad") aunque los campos cambien.
- **Modo captura rápida** (Sección 2.2.8) con botones grandes — minimiza errores.
- **Validaciones inmediatas** que detectan input fuera de rango.
- **Tutorial en planta** para operadores nuevos (primer turno acompañado).

🚨 **Alerta temprana**: tasa alta de capturas editadas/borradas en `shift_corrections`. Tiempo promedio de captura > target.

---

#### R-O3 — Cron de expiración mal configurado pierde alertas

🎯 **Descripción**: El cron diario que marca lotes expirados falla silenciosamente. Lotes vencidos no se bloquean, alertas no se envían. Tenant se entera cuando un cliente reclama.

📊 Probabilidad: **Baja** · 💥 Impacto: **Alto** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Health check** que verifica que el cron corrió en las últimas 24h.
- **Dashboard de salud del sistema** visible al admin del tenant.
- **Doble validación en venta**: aunque el cron falle, la venta verifica `product_lots.expiry_date < today` antes de generar movimiento.

🚨 **Alerta temprana**: el health check reporta "cron expiryCheck no corrió hoy".

---

#### R-O4 — Disponibilidad / uptime

🎯 **Descripción**: Sistema cae durante un turno de producción. Operador no puede capturar. Pérdida de turno = pérdida de datos = problemas de trazabilidad.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Hosting en plataforma SLA** (Render con plan adecuado, Postgres managed).
- **Modo offline degradado** en frontend: si la API cae, captura local en localStorage que sincroniza al volver conexión.
- **Backups automáticos** de Postgres (Render lo provee, validar).
- **Monitoreo** (UptimeRobot, Better Stack) con alertas al usuario en < 5 min de caída.

🚨 **Alerta temprana**: monitoreo reporta latencia alta de la API antes de la caída total.

---

#### R-O5 — Backups no probados

🎯 **Descripción**: Hay backups configurados pero nunca se ha probado restaurar. El día que se necesite, falla.

📊 Probabilidad: **Media** · 💥 Impacto: **Alto** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Drill de restauración trimestral**: restaurar el backup más reciente en sandbox y verificar que funciona.
- **Documentación del proceso de restauración** en `docs/operations/disaster-recovery.md`.
- **Multiple targets**: backup en Render + backup secundario en S3/equivalente.

🚨 **Alerta temprana**: el drill trimestral no se realizó. El último backup probado tiene > 90 días.

---

### 8.6 Riesgos financieros

#### R-F1 — Costos de infraestructura crecen antes que ingresos

🎯 **Descripción**: Postgres en Render, hosting, dominios, FacturAPI por uso. Si se onboarda 4 tenants gratis para validar, los costos suben sin ingresos.

📊 Probabilidad: **Media** · 💥 Impacto: **Medio** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Tier gratuito limitado** (ej. 1 turno/día, 50 productos en catálogo) — si quieren más, pagan.
- **Pricing por uso transparente**: tenant ve sus costos en tiempo real.
- **Modelo "first month free, then $X"** con conversion clara.
- **Stack económico**: el repo ya está en Render (económico), Postgres compartido para tenants chicos.

🚨 **Alerta temprana**: facturas mensuales de infraestructura > 30% del MRR estimado.

---

#### R-F2 — Soporte técnico escala mal con tenants

🎯 **Descripción**: Cada tenant nuevo genera N preguntas, bugs, requests. Con equipo de 2, soportar 20+ tenants es imposible sin afectar desarrollo.

📊 Probabilidad: **Alta** · 💥 Impacto: **Medio** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Documentación robusta** desde el día 1 (este documento es el inicio).
- **FAQ y knowledge base** auto-servicio.
- **Onboarding asistido solo para primeros 5-10 tenants**. A partir de ahí, self-service obligatorio.
- **Tier de soporte premium** pagado para tenants que quieran atención dedicada.

🚨 **Alerta temprana**: el usuario dedica > 50% del tiempo a soporte, < 50% a desarrollo.

---

#### R-F3 — Cash flow de desarrollo

🎯 **Descripción**: La planta actual paga el desarrollo. Si la planta cierra, cambia de prioridad o deja de pagar, el proyecto se queda sin financiamiento antes de generar MRR del SaaS.

📊 Probabilidad: **Baja** (según contexto del usuario) · 💥 Impacto: **Alto** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Plan de generación de ingresos en Fase 1** (no esperar Fase 5).
- **Reserve cash** acordada con la planta antes de empezar (cobertura mínima de N meses).
- **Plan B**: si la planta deja de pagar, qué tenants ya tienen MRR y cuánto necesita el SaaS para autosostenerse.

🚨 **Alerta temprana**: conversaciones con la planta sobre "pausa" o "reducción" del financiamiento.

---

### 8.7 Riesgos de producto / UX

#### R-P1 — Sobre-abstracción durante Fase 0

🎯 **Descripción**: La tentación de hacer "todo perfectamente abstracto" en Fase 0. Resultado: Fase 0 tarda 2× lo planeado, Fase 1 no llega.

📊 Probabilidad: **Alta** · 💥 Impacto: **Alto** · 🔴 **Crítico**

🛡️ **Mitigación**:
- **Regla "YAGNI" estricta** (You Aren't Gonna Need It): si Fase 1 no lo necesita, se difiere.
- **Criterio de done de Fase 0 publicado** (Sección 7.2) — cualquier cosa fuera de ese checklist se rechaza.
- **Time-boxing relativo**: si Fase 0 tarda más de N% del tiempo total estimado, revisar scope.

🚨 **Alerta temprana**: nuevas tablas o servicios que no están en el plan original aparecen en PRs.

---

#### R-P2 — Schema-driven UI difícil de usar bien

🎯 **Descripción**: Generar formularios dinámicamente desde JSONB es elegante en código pero puede generar UIs raras, inconsistentes o lentas si no se diseña con cuidado.

📊 Probabilidad: **Alta** · 💥 Impacto: **Medio** · 🟠 **Alto**

🛡️ **Mitigación**:
- **Design system explícito**: cada tipo de campo (number, select, etc.) tiene un componente React único y reusable.
- **Storybook** del design system para probar todos los tipos antes de integrarlos.
- **User testing** en planta con operadores reales **antes** de pasar a Fase 2.
- **Limitar tipos soportados**: arrancar con 5-6 tipos esenciales, no 20.

🚨 **Alerta temprana**: feedback negativo de operadores en piloto de Fase 1. Tasa alta de errores de captura.

---

#### R-P3 — Trazabilidad/recosteo nadie los usa

🎯 **Descripción**: Se construye el motor completo de trazabilidad y recosteo. Tenants no los usan porque no entienden el valor o no tienen disciplina contable.

📊 Probabilidad: **Media** · 💥 Impacto: **Medio** · 🟡 **Medio**

🛡️ **Mitigación**:
- **Onboarding incluye capacitación** específica de trazabilidad y cierre de mes.
- **Recordatorios automáticos** (cron `recostingReminders`).
- **Vistas y dashboards prominentes** que muestren el valor (variance reports, trazabilidad visual).
- **Default sensato**: si el tenant no captura overhead real, sistema usa el estimado — no se rompe, solo es menos preciso.

🚨 **Alerta temprana**: tenants con 0 cierres de mes después de 3 meses operando. Lotes existen pero nadie consulta trazabilidad.

---

### 8.8 Matriz consolidada de riesgos

| ID | Riesgo | Prob | Impacto | Calificación |
|---|---|:---:|:---:|:---:|
| **R-T1** | Refactor `productionService` rompe lógica existente | M | A | 🟠 Alto |
| **R-T2** | Migrations fallan a medio camino | M | A | 🟠 Alto |
| **R-T3** | Backfill incorrecto de enum → catálogo | B | M | 🟢 Bajo |
| **R-T4** | JSONB sin validación → datos sucios | A | M | 🟠 Alto |
| **R-T5** | Performance: recosteo lento al cierre | M | M | 🟡 Medio |
| **R-T6** | FEFO falla si compras no captura lotes | A | A | 🔴 Crítico |
| **R-T7** | Equipo de 2 (bus factor) | M | A | 🟠 Alto |
| **R-C1** | No conseguir tenants reales | A | A | 🔴 Crítico |
| **R-C2** | Tenant abandona durante onboarding | M | A | 🟠 Alto |
| **R-C3** | Tenants piden features fuera de MVP | A | M | 🟠 Alto |
| **R-C4** | Pricing inadecuado | M | M | 🟡 Medio |
| **R-R1** | Cambios en NOMs | B | M | 🟢 Bajo |
| **R-R2** | COFEPRIS audita y encuentra hueco | B | A | 🟡 Medio |
| **R-R3** | Demanda por recall mal manejado | B | A | 🟡 Medio |
| **R-R4** | LFPDPPP (privacidad) | B | M | 🟢 Bajo |
| **R-O1** | Tenant configura mal los catálogos | A | M | 🟠 Alto |
| **R-O2** | Operador no entiende UI schema-driven | M | M | 🟡 Medio |
| **R-O3** | Cron de expiración mal configurado | B | A | 🟡 Medio |
| **R-O4** | Disponibilidad / uptime | M | A | 🟠 Alto |
| **R-O5** | Backups no probados | M | A | 🟠 Alto |
| **R-F1** | Costos infraestructura > ingresos | M | M | 🟡 Medio |
| **R-F2** | Soporte técnico no escala | A | M | 🟠 Alto |
| **R-F3** | Cash flow de desarrollo | B | A | 🟡 Medio |
| **R-P1** | Sobre-abstracción en Fase 0 | A | A | 🔴 Crítico |
| **R-P2** | Schema-driven UI difícil de usar | A | M | 🟠 Alto |
| **R-P3** | Trazabilidad/recosteo nadie los usa | M | M | 🟡 Medio |

---

### 8.9 Top 5 riesgos a vigilar de cerca

De los 26 riesgos identificados, **estos 5 merecen atención semanal** durante el proyecto:

| # | Riesgo | Por qué priorizarlo |
|---|---|---|
| 1 | **R-P1 — Sobre-abstracción en Fase 0** | Causa más común de muerte de proyectos SaaS. Difícil de detectar desde adentro. |
| 2 | **R-C1 — No conseguir tenants reales** | Sin tenants, todo lo demás es inútil. Validación comercial debe correr en paralelo con Fase 0. |
| 3 | **R-T6 — FEFO falla por lotes no capturados** | Crítico para alimentos. Compliance NOM-251 se pierde silenciosamente. |
| 4 | **R-T1 — Refactor `productionService`** | El archivo más complejo del proyecto. Golden master tests son la única red de seguridad. |
| 5 | **R-O4 — Disponibilidad / uptime** | Una caída durante un turno destruye la confianza del tenant. Recuperar reputación es 10× más caro que prevenir. |

---

### 8.10 Capacidades transversales del MVP

Estas capacidades **no son riesgos** sino requisitos transversales del SaaS que necesitan diseño explícito en el MVP. Surgieron de la revisión arquitectónica (categoría 5 de hallazgos).

#### 8.10.1 RBAC — matriz de permisos para nuevas operaciones

Los permisos nuevos del SaaS v2, agrupados por dominio:

| Permiso | Quién típicamente | Acción |
|---|---|---|
| `process_config:read` | Cualquier usuario del tenant | Ver flags y catálogos |
| `process_config:update` | Admin del tenant | Modificar flags globales |
| `process_config:cost_method:update` | Admin del tenant | Cambiar método de costeo (afecta retroactivo) |
| `tenant_catalogs:create` | Admin / Configurador | Crear unidades, calidades, tipos de almacén, etc. |
| `tenant_catalogs:update` | Admin / Configurador | Editar catálogos |
| `tenant_catalogs:delete` | Admin | Soft-delete catálogos (con validación de uso) |
| `product_kinds:edit_schema` | Admin | Modificar `attribute_schema`/`capture_schema` (cambios pueden requerir confirmación) |
| `recipes:create` | Admin / Maestro de producción | Crear receta |
| `recipes:update_versioned` | Admin / Supervisor con permiso | Crear nueva versión de receta |
| `lots:create` | Almacenista | Capturar lote al recibir |
| `lots:quarantine` | Supervisor / Calidad | Mover lote a cuarentena |
| `lots:recall` | Admin con permiso | Iniciar workflow de recall |
| `lots:override_consumption` | Supervisor | Override de FEFO con razón |
| `production:override_allergen_quarantine` | Supervisor / Calidad senior | Liberar lote en cuarentena por alérgeno |
| `overhead:capture` | Contabilidad | Capturar gastos indirectos |
| `overhead:close_period` | Contabilidad senior / Admin | Cerrar período mensual |
| `overhead:reopen_period` | Admin | Reabrir período cerrado (con razón) |
| `traceability:read` | Cualquier usuario relevante | Ver trazabilidad de un lote |
| `traceability:export_audit_pack` | Admin / Calidad | Exportar paquete para COFEPRIS |

Estos permisos se siembran al crear el tenant con asignación default a roles típicos. El admin del tenant puede recombinarlos.

#### 8.10.2 Timezones — manejo por tenant

Cada tenant tiene una zona horaria configurada en `tenants.timezone` (existente). Implicaciones:

- **Crones diarios** (expiración, alertas, recordatorios de cierre) corren **por tenant** según su TZ, no en UTC global.
  - Implementación: cron único que corre cada hora UTC, evalúa qué tenants están en su "hora objetivo" (ej. 06:00 local) y ejecuta para esos.
- **Caducidades** (`expiry_date`) son **fechas** (DATE, no TIMESTAMPTZ) — un lote caduca al inicio del día en TZ del tenant.
- **Períodos contables** (`tenant_overhead_periods.period_start/end`) son fechas locales del tenant. Cierre de "abril 2026" significa abril en TZ del tenant.
- **Audit logs y timestamps técnicos** se almacenan en UTC (`TIMESTAMPTZ`). La UI los convierte a TZ del tenant.

#### 8.10.3 Concurrencia en captura — locking optimista

Múltiples operadores pueden capturar paquetes simultáneamente del mismo turno o consumir el mismo lote de MP. Estrategia:

- **`product_lots.quantity_remaining` y `raw_material_lots.quantity_remaining`** usan **locking optimista** vía columna `version` (entero auto-incremental):
  ```sql
  UPDATE product_lots
  SET quantity_remaining = quantity_remaining - :consumed,
      version = version + 1
  WHERE id = :id AND version = :expected_version;
  ```
  Si afecta 0 filas → conflict → retry hasta N veces antes de error al usuario.
- **`shift_progress` inserts** son atómicos por naturaleza (sin contención).
- **Reordenamiento de cola de órdenes** usa transacciones con `SELECT ... FOR UPDATE`.

Agregar columna `version INTEGER DEFAULT 1` a `product_lots`, `raw_material_lots`, `production_orders`.

#### 8.10.4 Multi-moneda

Cada tenant opera en una moneda base configurada en `tenants.base_currency` (existente, MXN para tenants mexicanos). Implicaciones:

- **Costos de MP/embalaje/PT** se almacenan en la moneda base del tenant.
- **Compras en moneda distinta**: se convierten al tipo de cambio del día (módulo `exchange-rates` existente) al confirmar el receipt. El costo del lote queda en moneda base.
- **Tipos de cambio históricos** se preservan — un recosteo de marzo usa tasas de marzo, no del día del recosteo.
- **MVP solo soporta una moneda base por tenant**. Multi-moneda en ventas (factura en USD para cliente, costo interno en MXN) ya está cubierto por el módulo de invoicing existente.

#### 8.10.5 Notificaciones — sistema de entrega

El SaaS genera muchas notificaciones (alertas de expiración, recordatorios de cierre, alertas de variance, alertas de cuarentena). Estrategia:

- **Canal default**: email (módulo `email` existente del ERP).
- **Tabla nueva `tenant_notification_preferences`**:
  ```
  tenant_id, notification_type, channel ('email'|'in_app'|'both'),
  recipient_user_ids[], is_enabled
  ```
- **Tabla nueva `notifications`** (in-app inbox):
  ```
  id, tenant_id, user_id, type, severity, title, body, action_url,
  is_read, created_at
  ```
- **Tipos de notificación MVP**:
  - `lot_expiring_soon` — N días antes de caducidad
  - `lot_expired` — al expirar
  - `lot_quarantined` — alérgeno o COA pendiente
  - `month_close_reminder` — día 5 del mes siguiente
  - `variance_alert` — variación > umbral
  - `low_stock_reorder_point` — ya existe en módulo inventory_levels

#### 8.10.6 Auditoría de cambios a catálogos

Aprovechando el módulo `audit_logs` existente, todo cambio a tablas `tenant_*` y a `recipes` se registra automáticamente vía middleware:

- Acción (`create`/`update`/`delete`)
- Tabla y registro afectado
- Usuario, IP, user-agent
- Valor anterior y nuevo (JSONB diff)

**No requiere tablas nuevas** — usa la infraestructura ya implementada.

#### 8.10.7 Soft-delete con validación de uso

Cualquier registro de catálogo (`tenant_units`, `tenant_quality_grades`, `tenant_warehouse_types`, etc.) que se intente desactivar (`is_active=false`):

1. Sistema verifica si está siendo **usado activamente** (en recetas vigentes, lotes activos, órdenes abiertas, etc.).
2. Si está en uso: error con lista de referencias y opciones:
   - "No puede desactivarse: usado en 3 recetas activas. Reemplaza o desactiva las recetas primero."
3. Si no está en uso pero hay histórico: warning + confirmación.
4. Soft-delete jamás borra; mantiene auditoría y permite consultar histórico.

### 8.11 Ritual de revisión de riesgos

Para que esta sección sea **viva** y no un anexo olvidado:

- **Mensualmente**: revisar la matriz 8.8 y actualizar probabilidades/impactos según realidad observada.
- **Por PR mayor**: identificar si introduce nuevos riesgos o mitiga existentes.
- **Por cierre de fase**: documentar qué riesgos se materializaron, cuáles no, qué nuevos emergieron.
- **Por incidente**: agregar a la matriz si era un riesgo no identificado.

---

## 9. Cierre del documento

### 9.1 Resumen ejecutivo

Este documento describe la **conversión del ERP actual (vertical de plástico) a un SaaS multi-tenant comercial** que soporta procesos productivos completamente distintos. Los puntos clave:

**Diseño:**
- **Process Template** configurable por tenant (12+ catálogos)
- **Captura schema-driven** (formularios dinámicos según producto)
- **Lotes y trazabilidad** obligatorios para alimentos (NOM-251)
- **Costeo híbrido** con recosteo mensual y variance reports
- **Modo PYME** para mercado masivo

**Alcance del refactor:**
- 1 módulo refactorizado (production) — **sin compat layer**, refactor agresivo con golden master tests
- 5 módulos nuevos (process-config, recipes, lots, allergens, overhead-costing)
- 21 módulos intactos (sales, compras, financieros, fiscal — todo el resto del ERP)
- ~47 migrations totales (38 principales + 9 cleanup al final)
- 100,000+ líneas de código existente sin tocar
- Repo v1 preservado en backup separado — código viejo no se mantiene en este repo

**Verticales objetivo:**
1. Palomitas → 2. Recicladora → 3. Frituras → 4. Pastelería → 5. PYME casera

**Camino**: Híbrido (C) — extraer motor genérico que ya existe, construir capa de configuración encima. Refactor del módulo de producción es agresivo (no preserva v1 en el mismo repo).

**Validación**: el modelo cubre **100% de los 5 perfiles** sin código custom (solo 3 ajustes aditivos pequeños).

**Riesgos críticos** a vigilar: sobre-abstracción en Fase 0, conseguir tenants reales, refactor del productionService, FEFO con lotes mal capturados, uptime.

### 9.2 Próximos pasos

1. **Revisar y aprobar este documento** completo (este paso).
2. **Identificar 2 tenants candidatos por vertical** (8 totales) — conversaciones comerciales.
3. **Crear el primer PR**: tests de caracterización (golden master) del `productionService` + migración 081 (`tenant_process_config`). Es el commit cero del refactor.
4. **Establecer ritual semanal** de revisión de progreso y riesgos (§8.11).
5. **Mantener este documento actualizado** a medida que aprendamos del desarrollo y de los tenants.

**Cambios mayores aplicados en la última revisión (post-revisión arquitectónica):**

- ✅ Compat layer v1/v2 **eliminado** (repo v1 está respaldado en otro lugar). Sin `process_engine_version`, sin `*_v1.js`, sin triggers de sincronización.
- ✅ Cleanup migrations 118-126 documentadas para eliminar columnas/tablas obsoletas al final.
- ✅ Política de schema evolution con confirmación de cambios destructivos.
- ✅ Versionado parcial de `tenant_process_config` (solo flags de costeo) vía tabla satélite `tenant_cost_config_history`.
- ✅ Fórmula explícita de prorrateo en tiempo real (extrapolación lineal + piso del estimado).
- ✅ Capacidades transversales documentadas (§8.10): RBAC, timezones, concurrencia, multi-moneda, notificaciones, auditoría de catálogos, soft-delete con validación.
- ✅ Mapeo enum→catálogo de seed (§2.6.4) para que los backfills sean reproducibles.
- ✅ Riesgos R-T1 y R-T3 rebajados gracias a la eliminación del compat layer.

### 9.3 Documentos futuros

Cuando este `00-design.md` crezca demasiado, se dividirá en:

- `00-overview.md` — secciones 1, 7, 8, 9 (alto nivel)
- `01-data-model.md` — secciones 2, 3
- `02-traceability.md` — sección 4
- `03-migration-map.md` — sección 5
- `04-vertical-config-guides.md` — sección 6 (con guías de configuración detalladas por vertical)

Pero hasta que cruce las ~50 páginas, queda como un solo archivo navegable.

---

**Fin del documento de diseño SaaS v2.**
