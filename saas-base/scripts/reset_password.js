#!/usr/bin/env node
'use strict'

/**
 * Resetea la contraseña de un usuario por correo electrónico.
 * El hash se guarda en la tabla `user_credentials` (no en `users`).
 *
 * USO (desde la raíz del backend `saas-base/`):
 *   node scripts/reset_password.js <email> <nuevaPassword>
 *
 * Ejemplos:
 *   node scripts/reset_password.js edwinsilva237@gmail.com Test1234
 *   node scripts/reset_password.js admin@demo.com Admin123
 *
 * Listar usuarios disponibles primero:
 *   node scripts/reset_password.js --list
 */

const bcrypt = require('bcrypt')
const { query, withTransaction } = require('../src/db')
const config = require('../src/config')

async function listUsers() {
  const { rows } = await query(
    `SELECT u.email, u.full_name, u.is_active, t.slug AS tenant,
            (uc.user_id IS NOT NULL) AS has_password
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN user_credentials uc ON uc.user_id = u.id
     ORDER BY u.created_at`
  )
  if (!rows.length) {
    console.log('No hay usuarios en la base de datos.')
    process.exit(0)
  }
  console.log('Usuarios registrados:')
  console.log('---')
  for (const u of rows) {
    const active = u.is_active ? '✓' : '✗'
    const pwd    = u.has_password ? '🔑' : '⚠'
    console.log(`  ${active} ${pwd}  ${u.email.padEnd(35)}  ${(u.full_name || '(sin nombre)').padEnd(22)}  tenant: ${u.tenant || '?'}`)
  }
  console.log('---')
  console.log(`Total: ${rows.length} usuarios.   ✓=activo  ✗=inactivo  🔑=tiene password  ⚠=sin password`)
  process.exit(0)
}

async function resetPassword(email, newPassword) {
  if (!email || !newPassword) {
    console.error('❌ Faltan argumentos. Uso:')
    console.error('   node scripts/reset_password.js <email> <nuevaPassword>')
    console.error('   node scripts/reset_password.js --list')
    process.exit(1)
  }

  if (newPassword.length < 6) {
    console.error('❌ La contraseña debe tener al menos 6 caracteres.')
    process.exit(1)
  }

  // Verificar que el usuario exista
  const { rows } = await query(
    `SELECT id, email, full_name, is_active FROM users WHERE LOWER(email) = LOWER($1)`,
    [email]
  )

  if (!rows.length) {
    console.error(`❌ No existe ningún usuario con email "${email}".`)
    console.error('   Ejecuta "node scripts/reset_password.js --list" para ver los disponibles.')
    process.exit(1)
  }

  const user = rows[0]
  if (!user.is_active) {
    console.warn(`⚠ El usuario "${user.email}" está inactivo. Se reseteará la contraseña, pero no podrá iniciar sesión hasta reactivarlo.`)
  }

  // Generar hash con la misma config que usa el sistema
  const rounds = config.bcrypt?.rounds || 12
  const hash = await bcrypt.hash(newPassword, rounds)

  // UPSERT en user_credentials (puede no existir credenciales aún para este usuario)
  await withTransaction(async (client) => {
    // Verificar si ya tiene credenciales
    const { rows: existing } = await client.query(
      `SELECT id FROM user_credentials WHERE user_id = $1`,
      [user.id]
    )

    if (existing.length) {
      await client.query(
        `UPDATE user_credentials SET password_hash = $1, updated_at = NOW()
         WHERE user_id = $2`,
        [hash, user.id]
      )
    } else {
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
        [user.id, hash]
      )
    }

    // Revocar todos los refresh tokens activos — forzar re-login en otros dispositivos
    await client.query(
      `UPDATE refresh_tokens SET is_revoked = true
       WHERE user_id = $1 AND is_revoked = false`,
      [user.id]
    )
  })

  console.log('---')
  console.log(`✓ Contraseña actualizada exitosamente para: ${user.full_name || user.email}`)
  console.log(`  Email:    ${user.email}`)
  console.log(`  Password: ${newPassword}`)
  console.log('---')
  console.log('Ahora puedes iniciar sesión con esas credenciales.')
  console.log('Las sesiones activas en otros dispositivos quedaron revocadas (refresh tokens).')
  process.exit(0)
}

const args = process.argv.slice(2)

if (args.includes('--list') || args[0] === '-l') {
  listUsers().catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
} else {
  resetPassword(args[0], args[1]).catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
