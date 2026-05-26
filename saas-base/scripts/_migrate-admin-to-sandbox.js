'use strict'

/**
 * Migra al usuario administracion@ghinsumos.com de gh-insumos a sandbox:
 *   - Crea un nuevo registro en users (sandbox) con el MISMO password_hash
 *     y is_platform_admin=true.
 *   - Asigna rol super_admin (cross-tenant).
 *   - Desactiva el usuario original en gh-insumos (is_active=false).
 *
 * Reversible: para revertir, solo activa el de gh-insumos y desactiva el de
 * sandbox. Ningún dato se borra.
 */

const { query, pool, withTransaction, withBypass } = require('../src/db')

const ADMIN_EMAIL = 'administracion@ghinsumos.com'

;(async () => {
  try {
    const result = await withBypass(() => withTransaction(async (client) => {
      // 1. Buscar usuario actual en gh-insumos.
      const { rows: src } = await client.query(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.is_platform_admin,
                uc.password_hash, t.slug AS tenant_slug
           FROM users u
           JOIN tenants t ON t.id = u.tenant_id
           LEFT JOIN user_credentials uc ON uc.user_id = u.id
          WHERE LOWER(u.email) = LOWER($1) AND t.slug = 'gh-insumos'`,
        [ADMIN_EMAIL]
      )
      if (!src.length) {
        throw new Error(`Usuario ${ADMIN_EMAIL} no existe en gh-insumos.`)
      }
      const source = src[0]
      console.log(`Usuario origen encontrado en gh-insumos: ${source.id}`)

      // 2. Verificar que NO existe ya en sandbox.
      const { rows: exists } = await client.query(
        `SELECT u.id FROM users u
           JOIN tenants t ON t.id = u.tenant_id
          WHERE LOWER(u.email) = LOWER($1) AND t.slug = 'sandbox'`,
        [ADMIN_EMAIL]
      )
      if (exists.length) {
        throw new Error(`Ya existe un usuario con email ${ADMIN_EMAIL} en sandbox (id: ${exists[0].id}). Aborto.`)
      }

      // 3. Obtener tenant sandbox.
      const { rows: sb } = await client.query(
        `SELECT id FROM tenants WHERE slug = 'sandbox'`
      )
      if (!sb.length) throw new Error('Tenant sandbox no existe.')
      const sandboxId = sb[0].id

      // 4. Crear usuario en sandbox con mismo email + nombre + flags.
      const { rows: newUserRows } = await client.query(
        `INSERT INTO users (tenant_id, email, full_name, is_active, is_platform_admin)
         VALUES ($1, $2, $3, TRUE, TRUE)
         RETURNING id`,
        [sandboxId, source.email, source.full_name]
      )
      const newUserId = newUserRows[0].id
      console.log(`✓ Nuevo usuario creado en sandbox: ${newUserId}`)

      // 5. Copiar password_hash.
      if (source.password_hash) {
        await client.query(
          `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
          [newUserId, source.password_hash]
        )
        console.log('✓ Password copiado')
      } else {
        console.warn('⚠ El usuario origen no tiene password_hash — el nuevo no podrá hacer login con password')
      }

      // 6. Asignar rol super_admin (sistema, tenant_id IS NULL).
      const { rows: roleRows } = await client.query(
        `SELECT id FROM roles WHERE name = 'super_admin' AND tenant_id IS NULL`
      )
      if (!roleRows.length) throw new Error('Rol super_admin no existe en el sistema.')
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [newUserId, roleRows[0].id]
      )
      console.log('✓ Rol super_admin asignado')

      // 7. Desactivar usuario origen en gh-insumos (NO borrar).
      await client.query(
        `UPDATE users SET is_active = FALSE WHERE id = $1`,
        [source.id]
      )
      console.log('✓ Usuario en gh-insumos desactivado')

      // 8. Revocar refresh tokens del usuario viejo (lo fuerza a re-login).
      await client.query(
        `UPDATE refresh_tokens SET is_revoked = TRUE
          WHERE user_id = $1 AND is_revoked = FALSE`,
        [source.id]
      )

      return { sourceId: source.id, newUserId, sandboxId }
    }))

    console.log('\n✅ Migración completada.\n')
    console.log('Resumen:')
    console.log(`  - Usuario original (gh-insumos): ${result.sourceId} → DESACTIVADO`)
    console.log(`  - Usuario nuevo (sandbox):       ${result.newUserId} → ACTIVO + platform_admin`)
    console.log(`  - Tenant sandbox:                ${result.sandboxId}`)
    console.log('\nPara entrar:')
    console.log(`  1. Cierra sesión actual.`)
    console.log(`  2. Login con: ${ADMIN_EMAIL}`)
    console.log(`  3. Misma password que tenías.`)
    console.log(`  4. login-discover te lleva directo a sandbox (solo existe en sandbox ahora).`)
    console.log(`\nPara entrar a gh-insumos: usa el botón "Impersonar este tenant" en el panel super admin.`)
  } catch (err) {
    console.error('❌ Falló:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
  } finally {
    await pool.end()
  }
})()
