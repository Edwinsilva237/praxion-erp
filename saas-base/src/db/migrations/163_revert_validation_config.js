'use strict'

/**
 * Mig 163 — configuración por tenant para revertir validación de turnos +
 * permiso production:revert_validation.
 *
 * Contexto (sesión 2026-05-29):
 *  Una vez que un turno pasa a status='reviewed' (supervisor validó) no hay
 *  manera de reabrirlo. reopenShift solo opera en pending_handover y dentro
 *  de 30 min. Si surge un imprevisto después de validar (operario reportó
 *  merma olvidada, paquete capturado por error, etc.), el turno queda
 *  congelado y los registros de inventario incorrectos.
 *
 *  Este refactor introduce un flujo controlado de "revertir validación":
 *  el supervisor con permiso reversa los inventory_movements del turno y
 *  el shift vuelve a status='active' para corregir.
 *
 *  Configurable por tenant — distintos verticales tienen distintas tolerancias:
 *
 *   - allow_revert_validation:           apagar para tenants con compliance estricto.
 *   - revert_validation_window_hours:    null = sin límite. Defaults sugeridos por
 *                                        industria: 24h (alimentos), 72h (palomitas),
 *                                        null (recicladora).
 *   - block_revert_if_order_fulfilled:   si la orden ya cerró (fulfilled/completed)
 *                                        la reversión podría descuadrar inventario
 *                                        ya facturado.
 *   - block_revert_if_period_closed:     si el periodo de overhead cerró y se aplicó
 *                                        al turno, reabrirlo invalida ese cierre.
 *   - require_revert_dual_approval:      reversa requiere firma supervisor + admin
 *                                        para plantas con compliance reforzado.
 *
 *  Defaults conservadores: permitido, 72h, bloquear si fulfilled, bloquear si
 *  periodo cerrado, sin dual approval. Cada tenant ajusta en
 *  Configuración → Procesos → Flags del proceso.
 */

const up = `
  -- ─── Flags en tenant_process_config ────────────────────────────────────────
  ALTER TABLE tenant_process_config
    ADD COLUMN allow_revert_validation         BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN revert_validation_window_hours  INTEGER NULL DEFAULT 72,
    ADD COLUMN block_revert_if_order_fulfilled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN block_revert_if_period_closed   BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN require_revert_dual_approval    BOOLEAN NOT NULL DEFAULT false;

  ALTER TABLE tenant_process_config
    ADD CONSTRAINT tpc_revert_window_positive
      CHECK (revert_validation_window_hours IS NULL OR revert_validation_window_hours BETWEEN 1 AND 8760);

  COMMENT ON COLUMN tenant_process_config.allow_revert_validation IS
    'true: el supervisor puede revertir un turno reviewed. false: turnos validados son inmutables.';
  COMMENT ON COLUMN tenant_process_config.revert_validation_window_hours IS
    'Horas desde la validación dentro de las cuales se permite revertir. NULL = sin límite. Default 72.';
  COMMENT ON COLUMN tenant_process_config.block_revert_if_order_fulfilled IS
    'true: bloquea reversión si la orden está fulfilled o completed.';
  COMMENT ON COLUMN tenant_process_config.block_revert_if_period_closed IS
    'true: bloquea reversión si el periodo contable del turno ya cerró (overhead aplicado).';
  COMMENT ON COLUMN tenant_process_config.require_revert_dual_approval IS
    'true: requiere firma de un aprobador secundario (admin) además del supervisor.';

  -- ─── Permiso production:revert_validation ──────────────────────────────────
  INSERT INTO permissions (resource, action, description) VALUES
    ('production', 'revert_validation',
     'Revertir la validación de un turno reviewed (reverse de inventario, vuelve a active para corregir)')
  ON CONFLICT (resource, action) DO NOTHING;

  -- Amarrar a super_admin global
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'production'
     AND p.action   = 'revert_validation'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'production' AND action = 'revert_validation'
   );
  DELETE FROM permissions
   WHERE resource = 'production' AND action = 'revert_validation';

  ALTER TABLE tenant_process_config DROP CONSTRAINT IF EXISTS tpc_revert_window_positive;
  ALTER TABLE tenant_process_config
    DROP COLUMN IF EXISTS require_revert_dual_approval,
    DROP COLUMN IF EXISTS block_revert_if_period_closed,
    DROP COLUMN IF EXISTS block_revert_if_order_fulfilled,
    DROP COLUMN IF EXISTS revert_validation_window_hours,
    DROP COLUMN IF EXISTS allow_revert_validation;
`

module.exports = { up, down }
