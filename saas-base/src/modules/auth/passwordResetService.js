'use strict'

const crypto = require('crypto')
const bcrypt = require('bcrypt')
const { query, withTransaction } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const { enqueueEmail } = require('../../queues/emailQueue')
const { passwordResetEmail } = require('../email/templates')
const { audit } = require('../../utils/audit')
const { validatePassword } = require('../../utils/passwordPolicy')

/**
 * Genera un token de reset y envía el email.
 * Siempre responde igual aunque el email no exista — evita user enumeration.
 */
async function forgotPassword({ email, tenantId, tenantSlug, ipAddress, userAgent }) {
  const { rows } = await query(
    `SELECT id, email, full_name FROM users
     WHERE email = $1 AND tenant_id = $2 AND is_active = true`,
    [email.toLowerCase().trim(), tenantId]
  )

  // Respuesta genérica — no revelamos si el email existe
  if (rows.length === 0) {
    logger.info('Password reset requested for unknown email', { email, tenantId })
    return
  }

  const user = rows[0]

  // Branding del tenant para personalizar el correo (header + botón).
  const { rows: trows } = await query(
    `SELECT name, display_name, brand_color_primary FROM tenants WHERE id = $1`,
    [tenantId]
  )
  const tenantName  = trows[0]?.display_name || trows[0]?.name || null
  const brandColor  = trows[0]?.brand_color_primary || null

  // Invalidar tokens anteriores del usuario
  await query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [user.id]
  )

  // Generar token seguro
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hora

  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  )

  // Enviar email
  try {
    await enqueueEmail({
      to:      user.email,
      subject: 'Restablecer contraseña',
      html:    passwordResetEmail({
        fullName:   user.full_name,
        resetToken: token,
        tenantSlug,
        tenantName,
        brandColor,
      }),
    })
    logger.info('Password reset email sent', { userId: user.id })
  } catch (err) {
    logger.error('Password reset email failed', { userId: user.id, error: err.message })
  }

  await audit({
    tenantId,
    userId:    user.id,
    action:    'auth.password_reset_requested',
    resource:  'auth',
    ipAddress,
    userAgent,
  })
}

/**
 * Valida el token y actualiza la contraseña.
 */
async function resetPassword({ token, newPassword, tenantId, ipAddress, userAgent }) {
  if (!token || !newPassword) {
    throw createError(400, 'token and newPassword are required.')
  }

  const check = validatePassword(newPassword)
  if (!check.valid) {
    throw createError(400, check.reason)
  }

  const tokenHash = hashToken(token)

  const { rows } = await query(
    `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at,
            u.email, u.is_active, u.tenant_id
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = $1`,
    [tokenHash]
  )

  if (rows.length === 0) {
    throw createError(400, 'Invalid or expired reset token.')
  }

  const record = rows[0]

  if (record.used_at) {
    throw createError(400, 'Reset token has already been used.')
  }

  if (new Date(record.expires_at) < new Date()) {
    throw createError(400, 'Reset token has expired.')
  }

  if (!record.is_active) {
    throw createError(400, 'Account is disabled.')
  }

  if (record.tenant_id !== tenantId) {
    throw createError(400, 'Invalid or expired reset token.')
  }

  const passwordHash = await bcrypt.hash(newPassword, config.bcrypt.rounds)

  await withTransaction(async (client) => {
    // Actualizar contraseña
    await client.query(
      `UPDATE user_credentials SET password_hash = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [passwordHash, record.user_id]
    )

    // Marcar token como usado
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
      [record.id]
    )

    // Revocar todos los refresh tokens activos — forzar re-login
    await client.query(
      `UPDATE refresh_tokens SET is_revoked = true
       WHERE user_id = $1 AND is_revoked = false`,
      [record.user_id]
    )
  })

  await audit({
    tenantId,
    userId:    record.user_id,
    action:    'auth.password_reset',
    resource:  'auth',
    payload:   { email: record.email },
    ipAddress,
    userAgent,
  })

  logger.info('Password reset successful', { userId: record.user_id })
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { forgotPassword, resetPassword }
