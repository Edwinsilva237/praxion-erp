'use strict'

/**
 * Mig 216 — Reversa de pagos a proveedor (supplier_payments) + permiso dedicado.
 *
 * Espejo de la mig 205 (reversa de cobros de cliente). Hasta ahora un pago a
 * proveedor no se podía deshacer: si se aplicó al documento equivocado o se
 * quería re-aplicar de otra forma, no había salida desde la app.
 *
 *   supplier_payments.reversed_at / reversed_by / reversal_reason
 *     → marca un pago como reversado (NO se borra: queda para auditoría). Los
 *       saldos de CXP y el historial de pagos emitidos excluyen los reversados.
 *
 * Permiso nuevo `purchases:reverse_payment` (destructivo: revierte el saldo de
 * la CXP de las facturas que el pago liquidó). Mismo patrón que mig 205: crear
 * el permiso, amarrarlo a super_admin global y concederlo a los roles `admin`.
 *
 * ⚠️ Los usuarios admin/owner ya logueados deben RE-LOGUEAR (o refrescar
 * /auth/me) para que el nuevo permiso aparezca en su sesión.
 */

const up = `
  ALTER TABLE supplier_payments
    ADD COLUMN IF NOT EXISTS reversed_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

  CREATE INDEX IF NOT EXISTS idx_sp_reversed_at
    ON supplier_payments (tenant_id, reversed_at);

  INSERT INTO permissions (resource, action, description) VALUES
    ('purchases', 'reverse_payment',
     'Reversar un pago a proveedor: revierte el saldo de la CXP de las facturas que liquidó')
  ON CONFLICT (resource, action) DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'purchases'
     AND p.action = 'reverse_payment'
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'admin'
     AND p.resource = 'purchases'
     AND p.action = 'reverse_payment'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'purchases' AND action = 'reverse_payment'
   );
  DELETE FROM permissions
   WHERE resource = 'purchases' AND action = 'reverse_payment';

  DROP INDEX IF EXISTS idx_sp_reversed_at;
  ALTER TABLE supplier_payments
    DROP COLUMN IF EXISTS reversal_reason,
    DROP COLUMN IF EXISTS reversed_by,
    DROP COLUMN IF EXISTS reversed_at;
`

module.exports = { up, down }
