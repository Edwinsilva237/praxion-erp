'use strict'

const bcrypt = require('bcrypt')
const { query, withTransaction } = require('../../db')
const config = require('../../config')
const { audit } = require('../../utils/audit')
const { enqueueEmail } = require('../../queues/emailQueue')
const { assertCanCreateUser } = require('../billing/enforcement')
const { invitationEmail } = require('../email/templates')
const logger = require('../../config/logger')

async function listUsers({ tenantId, page = 1, limit = 20, search }) {
  const offset = (page - 1) * limit
  const params = [tenantId, limit, offset]
  let searchClause = ''

  if (search) {
    params.push(`%${search}%`)
    searchClause = `AND (u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`
  }

  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
            u.primary_role_id,
            COALESCE(
              json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.name IS NOT NULL), '[]'
            ) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r       ON r.id = ur.role_id
     WHERE u.tenant_id = $1 ${searchClause}
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT $2 OFFSET $3`,
    params
  )

  const { rows: countRows } = await query(`SELECT COUNT(*) FROM users WHERE tenant_id = $1`, [tenantId])
  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getUserById({ userId, tenantId }) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
            u.primary_role_id,
            COALESCE(
              json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r       ON r.id = ur.role_id
     WHERE u.id = $1 AND u.tenant_id = $2
     GROUP BY u.id`,
    [userId, tenantId]
  )
  if (rows.length === 0) return null
  return rows[0]
}

async function inviteUser({ tenantId, tenantName, email, fullName, roleIds = [], invitedBy, invitedByName, ipAddress, userAgent }) {
  // Bloquear si excede max_users del plan. Tira 402 si bloqueado.
  await assertCanCreateUser(tenantId)

  const tempPassword = generateTempPassword()
  const passwordHash = await bcrypt.hash(tempPassword, config.bcrypt.rounds)

  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (tenant_id, email, full_name) VALUES ($1, $2, $3)
       RETURNING id, email, full_name, is_active, created_at`,
      [tenantId, email.toLowerCase().trim(), fullName.trim()]
    )
    const newUser = rows[0]

    await client.query(
      `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
      [newUser.id, passwordHash]
    )

    // El usuario debe tener una membresía explícita en su home tenant.
    // Los users creados por el backfill de la migración 145 ya la tienen;
    // los nuevos la reciben aquí. Default 'admin' porque inviteUser se usa
    // para crear usuarios del tenant (no invitados externos).
    await client.query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role, invited_by)
       VALUES ($1, $2, 'admin', $3)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [newUser.id, tenantId, invitedBy]
    )

    let rolesToAssign = roleIds
    if (rolesToAssign.length === 0) {
      const { rows: memberRole } = await client.query(
        `SELECT id FROM roles WHERE name = 'member' AND tenant_id IS NULL`
      )
      if (memberRole.length > 0) rolesToAssign = [memberRole[0].id]
    }

    for (const roleId of rolesToAssign) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [newUser.id, roleId, invitedBy]
      )
    }

    return newUser
  })

  // Branding del tenant para personalizar el correo.
  const { rows: trows } = await query(
    `SELECT brand_color_primary FROM tenants WHERE id = $1`, [tenantId]
  )
  const brandColor = trows[0]?.brand_color_primary || null

  // Enviar email de invitación. Si falla (SMTP mal configurado, rechazo del
  // proveedor, etc.) NO tiramos —el usuario ya fue creado— pero SÍ lo reportamos
  // al caller (emailSent=false) para que el admin lo sepa y comparta las
  // credenciales a mano. Antes se tragaba en silencio y el invitado quedaba sin
  // poder entrar sin que nadie se enterara.
  let emailSent = true
  let emailError = null
  try {
    await enqueueEmail({
      to:      user.email,
      subject: `Invitación a ${tenantName}`,
      html:    invitationEmail({
        fullName:      user.full_name,
        email:         user.email,
        tempPassword,
        tenantName,
        invitedByName: invitedByName || 'Un administrador',
        brandColor,
      }),
    })
  } catch (err) {
    emailSent = false
    emailError = err.message
    logger.warn('Invitation email failed', { userId: user.id, error: err.message })
  }

  await audit({
    tenantId,
    userId: invitedBy,
    action: 'user.invited',
    resource: 'users',
    resourceId: user.id,
    payload: { email: user.email, fullName: user.full_name, emailSent },
    ipAddress,
    userAgent,
  })

  // tempPassword se devuelve para que el caller pueda mostrarla SOLO si el correo
  // falló (recuperación manual). El route decide no exponerla cuando emailSent.
  return { user, emailSent, emailError, tempPassword }
}

async function updateUser({ userId, tenantId, fullName, isActive, requesterId, ipAddress, userAgent }) {
  // Reactivar (inactivo→activo) consume un asiento del plan → validar el límite,
  // pero SOLO en esa transición (si ya está activo, no se re-cuenta). Tira 402 si
  // el plan está lleno. Aplica venga del botón "Reactivar" o del checkbox del modal.
  if (isActive === true) {
    const { rows: cur } = await query(
      `SELECT is_active FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId]
    )
    if (cur.length && cur[0].is_active === false) {
      await assertCanCreateUser(tenantId)
    }
  }

  const { rows } = await query(
    `UPDATE users
     SET full_name = COALESCE($1, full_name),
         is_active = COALESCE($2, is_active)
     WHERE id = $3 AND tenant_id = $4
     RETURNING id, email, full_name, is_active`,
    [fullName || null, isActive !== undefined ? isActive : null, userId, tenantId]
  )
  if (rows.length === 0) return null

  await audit({
    tenantId, userId: requesterId, action: 'user.updated',
    resource: 'users', resourceId: userId,
    payload: { fullName, isActive }, ipAddress, userAgent,
  })

  return rows[0]
}

async function deactivateUser({ userId, tenantId, requesterId, ipAddress, userAgent }) {
  if (userId === requesterId) throw createError(400, 'You cannot deactivate your own account.')

  const { rows } = await query(
    `UPDATE users SET is_active = false WHERE id = $1 AND tenant_id = $2 RETURNING id, email`,
    [userId, tenantId]
  )
  if (rows.length === 0) return null

  await audit({
    tenantId, userId: requesterId, action: 'user.deactivated',
    resource: 'users', resourceId: userId,
    payload: { email: rows[0].email }, ipAddress, userAgent,
  })

  return rows[0]
}

/**
 * Reenvía la invitación a un usuario que aún NO ha iniciado sesión. La
 * contraseña temporal original se guardó hasheada (irrecuperable), así que se
 * genera una NUEVA y se actualizan las credenciales. Por eso se bloquea si el
 * usuario ya entró (sería resetearle su contraseña sin querer). Devuelve
 * `emailSent` + la nueva temporal para recuperación manual si el correo falla.
 */
async function resendInvitation({ userId, tenantId, tenantName, invitedByName, requesterId, ipAddress, userAgent }) {
  const { rows } = await query(
    `SELECT id, email, full_name, last_login_at FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Usuario no encontrado.')
  const user = rows[0]
  if (user.last_login_at) {
    throw createError(400, 'Este usuario ya inició sesión. Reenviar invitación es solo para quien aún no ha entrado.')
  }

  const tempPassword = generateTempPassword()
  const passwordHash = await bcrypt.hash(tempPassword, config.bcrypt.rounds)
  await query(`UPDATE user_credentials SET password_hash = $1 WHERE user_id = $2`, [passwordHash, user.id])

  const { rows: trows } = await query(`SELECT brand_color_primary FROM tenants WHERE id = $1`, [tenantId])
  const brandColor = trows[0]?.brand_color_primary || null

  let emailSent = true
  let emailError = null
  try {
    await enqueueEmail({
      to:      user.email,
      subject: `Invitación a ${tenantName}`,
      html:    invitationEmail({
        fullName:      user.full_name,
        email:         user.email,
        tempPassword,
        tenantName,
        invitedByName: invitedByName || 'Un administrador',
        brandColor,
      }),
    })
  } catch (err) {
    emailSent = false
    emailError = err.message
    logger.warn('Resend invitation email failed', { userId: user.id, error: err.message })
  }

  await audit({
    tenantId, userId: requesterId, action: 'user.invitation_resent',
    resource: 'users', resourceId: user.id,
    payload: { email: user.email, emailSent }, ipAddress, userAgent,
  })

  return { user, emailSent, emailError, tempPassword }
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefghjkmnpqrstwxyz23456789!@#$'
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { listUsers, getUserById, inviteUser, resendInvitation, updateUser, deactivateUser }
