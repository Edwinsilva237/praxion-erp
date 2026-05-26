'use strict'
const { query, pool } = require('../src/db')

;(async () => {
  try {
    const before = await query(
      `SELECT slug, plan FROM tenants WHERE slug = 'gh-insumos'`
    )
    if (!before.rows.length) {
      console.error('Tenant gh-insumos no existe.')
      process.exit(1)
    }
    console.log('Antes:', before.rows[0])

    const r = await query(
      `UPDATE tenants SET plan = 'owner' WHERE slug = 'gh-insumos' RETURNING slug, plan`
    )
    console.log('Después:', r.rows[0])
    console.log('✓ Sincronizado.')
  } finally {
    await pool.end()
  }
})()
