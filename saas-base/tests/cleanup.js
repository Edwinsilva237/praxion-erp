'use strict'

// Limpieza manual de cualquier tenant test_* residual.
// Usar con: npm run test:clean

const { query, pool } = require('../src/db')

;(async () => {
  const r = await query(`DELETE FROM tenants WHERE slug LIKE 'test-%' RETURNING slug`)
  console.log(`Tenants eliminados: ${r.rows.length}`)
  for (const t of r.rows) console.log('  -', t.slug)
  await pool.end()
})().catch(err => { console.error(err); process.exit(1) })
