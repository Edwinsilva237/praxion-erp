#!/usr/bin/env node
'use strict'

/**
 * Marca a un usuario como super-admin de la plataforma (is_platform_admin=TRUE).
 *
 * Uso:
 *   node scripts/set-platform-admin.js <email>
 *   node scripts/set-platform-admin.js <email> --tenant=<slug>   (opcional)
 *   node scripts/set-platform-admin.js <email> --revoke          (quitar marca)
 *
 * Si hay varios usuarios con el mismo email (cross-tenant), pide --tenant.
 */

const { query, pool } = require('../src/db')

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || args[0].startsWith('-')) {
    console.error('Uso: node scripts/set-platform-admin.js <email> [--tenant=<slug>] [--revoke]')
    process.exit(1)
  }

  const email     = args[0].toLowerCase().trim()
  const tenantArg = args.find(a => a.startsWith('--tenant='))?.split('=')[1] || null
  const revoke    = args.includes('--revoke')
  const flag      = !revoke

  const params = [email]
  let whereTenant = ''
  if (tenantArg) {
    params.push(tenantArg.toLowerCase())
    whereTenant = ` AND t.slug = $${params.length}`
  }

  const { rows: users } = await query(
    `SELECT u.id, u.email, u.is_platform_admin, t.slug AS tenant_slug, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1${whereTenant}`,
    params
  )

  if (!users.length) {
    console.error(`✗ No se encontró ningún usuario con email "${email}"${tenantArg ? ` en tenant "${tenantArg}"` : ''}.`)
    process.exit(1)
  }

  if (users.length > 1) {
    console.error(`✗ Hay ${users.length} usuarios con ese email en distintos tenants. Especifica con --tenant=<slug>:`)
    for (const u of users) console.error(`   - ${u.email} en ${u.tenant_slug} (${u.tenant_name})`)
    process.exit(1)
  }

  const u = users[0]
  await query(`UPDATE users SET is_platform_admin = $1, updated_at = NOW() WHERE id = $2`, [flag, u.id])

  console.log(`✓ Usuario ${u.email} (tenant: ${u.tenant_slug}) ahora tiene is_platform_admin = ${flag}.`)
  console.log(`  Cierra sesión y vuelve a entrar para que el flag se refresque en el frontend.`)

  await pool.end()
}

main().catch(err => {
  console.error('✗ Error:', err.message)
  pool.end().finally(() => process.exit(1))
})
