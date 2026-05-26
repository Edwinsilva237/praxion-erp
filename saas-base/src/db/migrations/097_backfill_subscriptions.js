'use strict'

/**
 * Backfill: crea una suscripción trial para cada tenant existente que
 * todavía no tenga una. Los tenants nuevos las obtienen vía
 * tenantService.provisionTenant (a partir de sesión 17).
 *
 * Idempotente — ON CONFLICT DO NOTHING. Si quieres rehacer el trial de un
 * tenant específico, bórralo manualmente de subscriptions y vuelve a correr.
 */

const up = `
  INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end, trial_end)
  SELECT
    t.id,
    (SELECT id FROM plans WHERE slug = 'free' LIMIT 1),
    'trialing',
    NOW(),
    NOW() + INTERVAL '14 days',
    NOW() + INTERVAL '14 days'
  FROM tenants t
  WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);
`

// No tiene rollback útil: si bajas la migración 096 se borra todo.
const down = `-- noop`

module.exports = { up, down }
