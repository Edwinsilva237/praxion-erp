# Entradas para agregar al final de DECISIONS.md
# Sesión del 2026-05-11

---

## 2026-05-11 — Revert de inventario en modo permisivo

**Decisión:** En `revertInventoryMovements`, usar `GREATEST(0, ...)` para evitar
que el stock baje de 0 al revertir movimientos. Si la operación habría dejado
negativo, se trunca a 0 y se emite un warning visible para el supervisor.

**Razón:** Coherente con Escenario B (flujo permisivo) ya aprobado. El sistema
puede operar sin que el almacén raw_material tenga MP cargada; las correcciones
del supervisor no deben fallar por inconsistencias del WIP.

**Alternativas descartadas:**
- A: Mantener el error de BD con mensaje amigable — bloquea al supervisor.
- C: Híbrida con permiso especial + checkbox de confirmación — sobre-engineering.

**Impacto:**
- Correcciones del supervisor siempre se completan.
- Trazabilidad preservada en `shift_corrections` y `inventory_movements`.
- Cuando haya MP real cargada, el fix queda silencioso.

---

## 2026-05-11 — Persistencia de orden activa en production_shifts

**Decisión:** El campo `production_shifts.production_order_id` se persiste
explícitamente vía `PATCH /production/shifts/:id/active-order` cuando el
operador selecciona una orden de la cola. Antes se derivaba implícitamente
del último paquete capturado.

**Razón:** Validaciones como cambio de fórmula y reportes necesitan saber
qué orden trabaja el turno antes de que existan paquetes. El modelo implícito
fallaba en esos casos.

**Alternativas descartadas:**
- A: Quick fix en validación de `changeOrderFormula` mirando `shift_progress`
  además de `production_shifts`. Tapa síntoma, no causa.
- C: Forzar selección de orden al iniciar turno. Bloquea casos válidos
  (mantenimiento, limpieza, multi-orden).

**Impacto:**
- Nuevo endpoint con permiso `production:create`.
- Frontend (`ProduccionCaptura.jsx`) llama al endpoint en el `onSelect` de card de orden.
- Transición `released → in_progress` ocurre como punto único dentro de este endpoint.

---

## 2026-05-11 — Separación visual de órdenes "Cumplidas"

**Decisión:** Las órdenes en status `fulfilled` (al 100% sin cerrar) salen de
la tab "Cola activa" y aparecen en una tab propia "Cumplidas" con badge
contador rojo. El cierre sigue siendo manual.

**Razón:** Mejorar la visibilidad para que el supervisor identifique sin
ambigüedad qué órdenes requieren acción de cierre. Mantener el cierre manual
porque una orden al 100% puede aún recibir excedentes o requerir re-trabajo.

**Alternativas descartadas:**
- B: Cierre automático al 100% — pierde flexibilidad de excedente/devoluciones.
- C: Mantener todas mezcladas — confunde al supervisor.

**Impacto:**
- Backend `getOrdersQueue` excluye `fulfilled` del listado de cola activa.
- Frontend agrega tab "Cumplidas" con query separado y badge rojo dinámico.
- Sin migración. El estado `fulfilled` ya existía en BD.
