'use strict'
const { query, pool } = require('../src/db')

;(async () => {
  try {
    const r = await query(
      `SELECT t.slug, t.name, u.id, u.email, u.full_name,
              u.is_active, u.is_platform_admin,
              ARRAY(SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id) AS roles
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug IN ('gh-insumos', 'sandbox')
        ORDER BY t.slug, u.created_at`
    )
    console.log(JSON.stringify(r.rows, null, 2))
  } finally { await pool.end() }
})()
