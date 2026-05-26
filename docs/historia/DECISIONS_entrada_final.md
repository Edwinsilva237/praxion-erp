## 2026-05-12 — Recepción explícita de turno entre operadores

**Decisión:** El cambio de turno entre operadores ya no se activa
automáticamente al cerrar el saliente. El operador entrante pasa por una
pantalla intermedia de "Recepción de turno" donde elige aceptar la línea
o recibirla con observaciones (texto libre obligatorio mínimo 20 caracteres).
La recepción se registra en una tabla nueva `shift_receptions`.

**Razón:**
- Trazabilidad real de cómo se entrega la línea entre turnos. Antes, si el
  operador entrante encontraba un problema heredado (MP mala, máquina
  descalibrada, scrap sin reportar), no había forma de registrarlo y se
  perdía la causa raíz al revisar.
- Cultura de calidad: obliga a cada operador a recibir conscientemente.
- Cierra naturalmente el bug que tenía el código viejo: `closeShift`
  intentaba activar al entrante con una query rota (filtraba por
  `handover_waiting_shift_id` en el lado equivocado), dejándolo atorado
  en `pending_handover`.

**Alternativas descartadas:**
- A: Lista predefinida de tipos de observación (MP mala, equipo falla, etc.).
  Descartada por velocidad de implementación; queda abierta para iteración
  futura si se ve que la búsqueda por categorías es necesaria para reportes.
- B: Supervisor puede forzar el inicio del turno entrante si el operador no
  aparece. Descartada para mantener la integridad: el supervisor puede
  reprogramar o usar otro operador, pero no firmar la recepción en nombre
  de alguien que no está.
- C: Activación automática del entrante al cerrar el saliente (status quo
  anterior). Descartada porque perdía trazabilidad y tenía el bug
  mencionado.

**Impacto:**
- **BD nueva**: tabla `shift_receptions` (migración 062). FK al saliente y al
  entrante, `accepted` boolean, `issue_description` text (obligatorio si no
  acepta, mínimo 20 chars enforceado por CHECK constraint), UNIQUE por
  `incoming_shift_id`.
- **Backend**: `closeShift` simplificado (sin activación automática). 2
  funciones nuevas: `getHandoverSummary` (resumen del saliente para mostrar
  al entrante) y `acceptHandover` (registro + activación).
- **Endpoints nuevos**: `GET /production/shifts/:id/handover-summary` y
  `POST /production/shifts/:id/accept-handover`.
- **Frontend**: componente `HandoverReceptionScreen` con pantalla de espera,
  resumen del turno saliente, modal de observaciones. Integrado en
  `ProduccionCaptura` por detección automática de `pending_handover`.
- **Nombre de tabla**: se llama `shift_receptions` (no `shift_handovers`)
  para no colisionar con la tabla preexistente del mismo módulo que
  almacena el reporte de balance al cierre del turno.
- **Acciones de auditoría nuevas**: `shift.handover_accepted` y
  `shift.handover_with_issues`.
