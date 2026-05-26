'use strict'
const { query, pool } = require('../src/db')

;(async () => {
  try {
    const tbl = await query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%migrat%' OR table_name='knex_migrations') ORDER BY table_name"
    )
    console.log('Tablas de migrations:', tbl.rows.map((r) => r.table_name).join(', ') || '(ninguna)')

    const a = await query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_platform_admin') AS x"
    )
    const b = await query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='modules') AS x"
    )
    const c = await query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='suspended_reason') AS x"
    )
    console.log('users.is_platform_admin:', a.rows[0].x)
    console.log('tenants.modules:        ', b.rows[0].x)
    console.log('tenants.suspended_reason:', c.rows[0].x)

    const users = await query(
      "SELECT u.email, u.is_platform_admin, t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id ORDER BY t.slug, u.email"
    )
    console.log('\nUsuarios (email | tenant | platform_admin):')
    users.rows.forEach((u) =>
      console.log(` - ${u.email} | ${u.slug} | ${u.is_platform_admin}`)
    )
  } catch (e) {
    console.error('ERR', e.message)
  } finally {
    await pool.end()
  }
})()
