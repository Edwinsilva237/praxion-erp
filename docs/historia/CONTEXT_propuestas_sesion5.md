# Propuestas de actualización para CONTEXT.md — Sesión 5 (2026-05-13)

Las siguientes notas se proponen para agregar/actualizar en `CONTEXT.md`. La ubicación exacta de cada una depende de la estructura actual del archivo, pero se sugieren las secciones más probables.

---

## Sección sugerida: "Convenciones del módulo de Producción"

### Estado `pending_handover` tiene doble significado

El status `pending_handover` en `production_shifts` significa dos cosas distintas según `closed_at`:

- **`closed_at IS NULL`** → entrante esperando recibir la línea (operador que ya confirmó presencia pero aún no acepta el handover).
- **`closed_at IS NOT NULL`** → saliente cerrado, esperando validación del supervisor.

**Regla**: cualquier código que filtre por `status='pending_handover'` debe considerar el rol y agregar el filtro de `closed_at` correspondiente. No hacerlo lleva a bugs visuales o lógicos (ej: mostrar pantalla de recepción cuando debería ser resumen de cierre).

### Cálculo de MP consumida en un turno

La columna `production_shifts.mp_real_kg` **NO se mantiene actualizada** (deuda técnica registrada). Para cualquier vista que necesite mostrar MP consumida, calcular en vivo:

```sql
SELECT
  COALESCE((SELECT SUM(real_weight_kg) FROM shift_progress WHERE shift_id = $1), 0) AS mp_packages_kg,
  COALESCE((SELECT SUM(kg)             FROM shift_scrap    WHERE shift_id = $1), 0) AS mp_scrap_kg
```

MP total = paquetes + scrap. Incluye paquetes de segunda calidad (consumieron MP igual). Incluye todos los tipos de scrap.

### Convención "Resetear turnos"

Cuando el usuario solicite "resetear turnos", ejecutar procedimiento de borrado en cascada de turnos de hoy. Ver documentación completa en `HANDOFF.md` de sesión 5. Resumen:

1. Snapshot previo.
2. Confirmación del usuario.
3. Romper referencias en `scheduled_shifts`.
4. Borrar registros hijos (`shift_progress`, `shift_scrap`, `shift_incidents`, `shift_mp_loads`, `shift_corrections`, `shift_cost_snapshot`, `shift_handovers`, `shift_receptions`).
5. Borrar `production_shifts` de hoy.
6. Decidir destino de `scheduled_shifts` de hoy.
7. Verificación.

No revierte inventario por defecto. Solo aplica a `shift_date = CURRENT_DATE`. Usar `BEGIN ... COMMIT` para transacción atómica.

---

## Sección sugerida: "Endpoints críticos del módulo"

### Endpoints "huérfanos" protegidos

Los siguientes endpoints son consumidos por el frontend pero podrían parecer código no usado al inspeccionar el código aisladamente. **No eliminar**:

- `POST /orders/preview-stock` → función `previewStockForNewOrder`. Consumido por el formulario de creación de orden (`productionApi.previewStock`). Sin este endpoint, el formulario muestra banner "Route not found" al agregar fórmulas MP.
- `GET /orders/:id/stock-availability` → función `getOrderStockAvailability`. Consumido por vista de detalle de orden (`productionApi.getStockAvailability`). También usado **internamente** por `releaseOrder` para validar stock antes de liberar.

Ambos archivos (`routes.js` y `productionService.js`) tienen bloques de comentarios visibles `═════════════════════════════════` con instrucciones de "NO ELIMINAR" e historial de incidentes. Cada vez que se rompan, agregar línea al historial.

### Tablas con nombre similar pero propósitos distintos

- **`shift_handovers`** (preexistente, módulo de producción inicial): reporte de balance al cierre del turno (mp_received_kg, pt_produced_units, supervisor_notes, etc.). Una fila por turno validado.
- **`shift_receptions`** (sesión 4): recepción del operador entrante. Una fila por handover completado. Tiene constraint que obliga texto ≥ 20 caracteres si `accepted=false`.

No confundir.

---

## Sección sugerida: "Enums personalizados del módulo de Producción"

Los siguientes tipos enum requieren cast explícito (`'1'::shift_number`) en queries SQL directas:

- **`shift_number`**: `{1, 2, 3}` — solo 3 turnos sin migración del enum.
- **`shift_status`** (production_shifts.status): `{pending, active, pending_handover, reviewed, pending_management, closed}`. NO incluye `cancelled`.
- **`scheduled_shift_status`** (scheduled_shifts.status): `{scheduled, active, completed, cancelled}`.

---

## Sección sugerida: "Deuda técnica registrada"

Lista actualizada al cierre de sesión 5:

1. **`production_shifts.mp_real_kg` nunca se actualiza**. Cualquier reporte que use ese campo está mostrando 0 incorrectamente. Mitigación: las vistas de handover/closed-summary usan cálculo en vivo. Pendiente: encontrar todos los consumidores del campo y decidir si reparar el llenado o migrar todos a cálculo en vivo.

2. **`findstr` vs `Select-String` en Windows**: `findstr` falla con archivos UTF-8 con caracteres especiales. Usar `Select-String` en PowerShell para verificaciones de código.

3. **Multi-línea de producción**: BD soporta múltiples `line_id` pero frontend asume línea 1 por defecto. No se ha validado funcionalmente.

4. **Tests automatizados ausentes**: actualmente la única protección contra regresiones de endpoints es los bloques de comentarios anti-eliminación. Cuando exista una capa de testing, migrar las anotaciones a tests E2E que fallen si las rutas se eliminan o cambian de firma.

---

## Sección sugerida: "Patrones de fix recurrentes"

### Patrón "endpoint registrado pero parámetros ignorados"

Diferente al "endpoint ausente". Acá la ruta SÍ existe en `routes.js` pero **no extrae todos los campos del body** y los olvida. El frontend llama al endpoint, recibe 200, pero el comportamiento es incorrecto porque parte del input se perdió.

Ejemplo histórico (sesión 5): `POST /orders/:id/release` ignoraba `lowStockOverrideReason`. El frontend lo enviaba, la ruta no lo extraía, el service nunca lo recibía y por tanto bloqueaba el flujo con error de stock.

**Cómo detectar**: cuando un flujo "funciona a medias" o falla en un caso específico, revisar que la ruta extraiga TODOS los campos del body que el frontend envía. Verificar con `req.body` completo, no solo destructuring parcial.

**Cómo prevenir**: cuando el service tenga parámetros opcionales, documentar en `routes.js` cuáles se extraen. Idealmente, tests E2E que validen el flujo completo.
