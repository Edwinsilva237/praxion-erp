'use strict'

/**
 * Estado 'fulfilled' y cierre explícito de órdenes.
 *
 * Nuevo flujo:
 *   draft → released → in_progress → fulfilled → completed
 *
 * - in_progress: orden en producción, abajo del 100% target
 * - fulfilled:   orden al 100%+, pero esperando cierre explícito del supervisor.
 *                Sigue abierta a capturas y correcciones.
 * - completed:   cerrada por el supervisor. INMUTABLE.
 *
 * Columnas nuevas:
 *   - closed_by_user_id: quién cerró la orden
 *   - close_reason:      razón al cerrar (obligatoria si se cierra incompleta)
 *   - close_was_partial: TRUE si se cerró antes de llegar al 100%
 *
 * Backfill:
 *   - Órdenes en 'completed': mantienen el estado (ya están cerradas).
 *   - Ninguna queda en 'fulfilled' automáticamente — el supervisor decide.
 */
const up = `
  ALTER TYPE production_order_status ADD VALUE IF NOT EXISTS 'fulfilled' BEFORE 'completed';

  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS closed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS close_reason       TEXT,
    ADD COLUMN IF NOT EXISTS close_was_partial  BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN production_orders.closed_by_user_id IS
    'Usuario que cerró la orden (supervisor o admin).';
  COMMENT ON COLUMN production_orders.close_reason      IS
    'Razón del cierre. Obligatoria si close_was_partial = true.';
  COMMENT ON COLUMN production_orders.close_was_partial IS
    'TRUE si la orden se cerró sin llegar al 100% del target.';
`

const down = `
  -- Nota: PostgreSQL no permite eliminar valores de ENUM fácilmente.
  -- Si se necesita revertir, hay que recrear el tipo. Para simplificar el
  -- down, solo se eliminan las columnas. El valor 'fulfilled' queda en el ENUM.
  ALTER TABLE production_orders
    DROP COLUMN IF EXISTS closed_by_user_id,
    DROP COLUMN IF EXISTS close_reason,
    DROP COLUMN IF EXISTS close_was_partial;
`

module.exports = { up, down }
