'use strict'

/**
 * Mig 205 — Reversa de cobros de cliente (ar_payments) + permiso dedicado.
 *
 * Hasta ahora un cobro aplicado a una CXC no se podía deshacer: si se aplicaba
 * al documento equivocado, la única salida era tocar la BD a mano. Esta mig
 * habilita la reversa desde la app:
 *
 *   ar_payments.reversed_at / reversed_by / reversal_reason
 *     → marca un cobro como reversado (NO se borra: queda para auditoría). Los
 *       saldos (amount_paid) y el historial de cobros excluyen los reversados.
 *
 *   ar_payments.payment_complement_id → payment_complements(id)
 *     → link determinista cobro ↔ complemento timbrado (CFDI tipo P). Se llena
 *       de aquí en adelante desde registerPayment; para el histórico (cobros
 *       previos a esta mig) la reversa hace match por (factura, monto). ON DELETE
 *       SET NULL para no romper si el complemento se borra.
 *
 * Permiso nuevo `financials:reverse_payment` (destructivo: revierte saldo y, si
 * el cobro timbró complemento, lo cancela ante el SAT con motivo '02'). Mismo
 * patrón que mig 200: crear el permiso, amarrarlo a super_admin global y
 * concederlo a los roles `admin` (sistema + por-tenant).
 *
 * ⚠️ Los usuarios admin/owner ya logueados deben RE-LOGUEAR (o refrescar
 * /auth/me) para que el nuevo permiso aparezca en su sesión.
 */

const up = `
  ALTER TABLE ar_payments
    ADD COLUMN IF NOT EXISTS reversed_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reversal_reason       TEXT,
    ADD COLUMN IF NOT EXISTS payment_complement_id UUID REFERENCES payment_complements(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_arp_reversed_at
    ON ar_payments (tenant_id, reversed_at);

  -- 1. Permiso dedicado (destructivo).
  INSERT INTO permissions (resource, action, description) VALUES
    ('financials', 'reverse_payment',
     'Reversar un cobro aplicado: revierte el saldo CXC y cancela el complemento de pago ante el SAT si lo hubo')
  ON CONFLICT (resource, action) DO NOTHING;

  -- 2. Amarrar a super_admin global (dueño del tenant).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'super_admin'
     AND r.tenant_id IS NULL
     AND p.resource = 'financials'
     AND p.action = 'reverse_payment'
   ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- 3. Conceder a todos los roles 'admin' (sistema + por-tenant).
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r
    CROSS JOIN permissions p
   WHERE r.name = 'admin'
     AND p.resource = 'financials'
     AND p.action = 'reverse_payment'
   ON CONFLICT (role_id, permission_id) DO NOTHING;
`

const down = `
  DELETE FROM role_permissions
   WHERE permission_id IN (
     SELECT id FROM permissions
      WHERE resource = 'financials' AND action = 'reverse_payment'
   );
  DELETE FROM permissions
   WHERE resource = 'financials' AND action = 'reverse_payment';

  DROP INDEX IF EXISTS idx_arp_reversed_at;
  ALTER TABLE ar_payments
    DROP COLUMN IF EXISTS payment_complement_id,
    DROP COLUMN IF EXISTS reversal_reason,
    DROP COLUMN IF EXISTS reversed_by,
    DROP COLUMN IF EXISTS reversed_at;
`

module.exports = { up, down }
