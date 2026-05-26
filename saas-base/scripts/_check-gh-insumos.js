'use strict'
const { query, pool } = require('../src/db')

;(async () => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.slug, t.name, t.plan, t.is_active, t.is_sandbox,
              t.suspended_reason,
              s.status AS sub_status,
              p.slug AS sub_plan_slug, p.name AS sub_plan_name,
              p.price_mxn_cents, p.max_users, p.max_invoices_per_month,
              s.trial_end, s.current_period_end, s.stripe_subscription_id
         FROM tenants t
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE t.slug = 'gh-insumos'`
    )
    console.log(JSON.stringify(rows[0], null, 2))
  } finally {
    await pool.end()
  }
})()
