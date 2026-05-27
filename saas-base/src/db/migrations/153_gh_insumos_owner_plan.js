'use strict'

/**
 * Asigna el plan 'owner' (ilimitado, sin cobro, sin Stripe) a los dos
 * tenants de la operación del dueño del SaaS:
 *   - gh-insumos-prod
 *   - gh-insumos-sandbox
 *
 * Antes ambos arrancaron con plan 'free' (límite 2 users, 10 facturas/mes)
 * desde el bootstrap. Como gh-insumos es la operación real del dueño y el
 * sandbox es su réplica para pruebas, los dos deben quedar bajo el plan
 * interno 'owner' que:
 *   - bypassea assertSubscriptionActive (`enforcement.js:41`),
 *   - tiene max_users = NULL e max_invoices_per_month = NULL (ilimitado),
 *   - no tiene stripe_price_id → nunca aparece en checkout.
 *
 * También sincroniza `tenants.plan` (columna legacy paralela a
 * `subscriptions.plan_id`) para mantener consistencia con la pantalla de
 * SuperAdmin. El check constraint de `tenants.plan` ya acepta 'owner'
 * desde la mig 110.
 *
 * Idempotente: si los tenants no existen (BD test/dev limpia) los
 * UPDATE afectan 0 rows y la migración es no-op. Si ya están en plan
 * owner, los campos quedan igual (status='active', etc.).
 */

const up = `
  -- subscriptions: cambiar plan_id y forzar status='active' sin expiración
  UPDATE subscriptions s
     SET plan_id              = (SELECT id FROM plans WHERE slug = 'owner'),
         status               = 'active',
         current_period_start = NOW(),
         current_period_end   = NULL,
         trial_end            = NULL,
         cancel_at_period_end = FALSE,
         canceled_at          = NULL
   WHERE s.tenant_id IN (
     SELECT id FROM tenants
      WHERE slug IN ('gh-insumos-prod', 'gh-insumos-sandbox')
   );

  -- tenants.plan: columna legacy paralela. Sincronizar para que el badge
  -- en SuperAdmin y cualquier query que lea tenants.plan vean 'owner'.
  UPDATE tenants
     SET plan = 'owner'
   WHERE slug IN ('gh-insumos-prod', 'gh-insumos-sandbox');
`

const down = `
  -- Volver a free. No restauramos current_period_end/trial_end porque
  -- esos datos no se preservan — bajar de owner a free siempre fue una
  -- operación destructiva.
  UPDATE subscriptions s
     SET plan_id = (SELECT id FROM plans WHERE slug = 'free'),
         status  = 'active'
   WHERE s.tenant_id IN (
     SELECT id FROM tenants
      WHERE slug IN ('gh-insumos-prod', 'gh-insumos-sandbox')
   );

  UPDATE tenants
     SET plan = 'free'
   WHERE slug IN ('gh-insumos-prod', 'gh-insumos-sandbox');
`

module.exports = { up, down }
