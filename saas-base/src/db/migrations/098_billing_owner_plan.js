'use strict'

/**
 * Plan "owner" — interno, sin pago, sin límites.
 *
 * Asignado a tenants que son cuentas del propio dueño del SaaS (GH Insumos
 * y similares). Características:
 *   - max_users = NULL (ilimitado)
 *   - max_invoices_per_month = NULL (ilimitado)
 *   - stripe_price_id = NULL → NUNCA aparece en checkout (no comprable)
 *   - active = TRUE pero sort_order alto → no aparece primero en listados
 *
 * El frontend filtra los planes "no comprables" del catálogo público, pero
 * sí puede mostrar "Plan actual: Owner" en la pantalla de suscripción.
 */

const up = `
  INSERT INTO plans (slug, name, description, price_mxn_cents, max_users, max_invoices_per_month, active, sort_order)
  VALUES ('owner', 'Owner', 'Cuenta interna del dueño — sin límites, sin cobro.', 0, NULL, NULL, TRUE, 99)
  ON CONFLICT (slug) DO NOTHING;
`

const down = `
  DELETE FROM plans WHERE slug = 'owner';
`

module.exports = { up, down }
