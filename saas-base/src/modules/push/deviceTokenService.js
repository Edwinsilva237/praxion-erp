'use strict'

/**
 * CRUD de tokens de dispositivo (FCM) — tabla device_tokens (mig 191).
 *
 * El registro es UPSERT por `token`: el token de FCM es global por instalación,
 * así que reclamar un token ya existente para otro usuario solo sobrescribe
 * user_id/tenant_id (ver comentario de la migración). Esto hace el registro
 * idempotente y auto-sana un unregister perdido.
 */

const { query } = require('../../db')

/**
 * Registra (o reclama) un token para el (tenant, user) dado.
 * @returns la fila resultante.
 */
async function registerToken(tenantId, userId, { token, platform = 'android', deviceInfo = null }) {
  if (!tenantId || !userId) throw new Error('registerToken: tenantId y userId requeridos.')
  if (!token || typeof token !== 'string') throw new Error('registerToken: token requerido.')
  if (!['android', 'ios', 'web'].includes(platform)) {
    throw new Error(`registerToken: platform inválida: ${platform}`)
  }

  const { rows } = await query(
    `INSERT INTO device_tokens (tenant_id, user_id, token, platform, device_info)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO UPDATE
       SET tenant_id    = EXCLUDED.tenant_id,
           user_id      = EXCLUDED.user_id,
           platform     = EXCLUDED.platform,
           device_info  = EXCLUDED.device_info,
           last_seen_at = now()
     RETURNING *`,
    [tenantId, userId, token, platform, deviceInfo]
  )
  return rows[0]
}

/**
 * Borra un token (al cerrar sesión). Solo borra si pertenece al (tenant, user)
 * que lo pide — evita que un usuario borre el token de otro.
 * @returns true si borró algo.
 */
async function unregisterToken(tenantId, userId, token) {
  if (!token) return false
  const { rowCount } = await query(
    `DELETE FROM device_tokens WHERE token = $1 AND tenant_id = $2 AND user_id = $3`,
    [token, tenantId, userId]
  )
  return rowCount > 0
}

/**
 * Lista los dispositivos registrados de un usuario en un tenant (futuro: UI
 * "sesiones activas"). No expone el token completo.
 */
async function listUserDevices(tenantId, userId) {
  const { rows } = await query(
    `SELECT id, platform, device_info, last_seen_at, created_at
       FROM device_tokens
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY last_seen_at DESC`,
    [tenantId, userId]
  )
  return rows
}

module.exports = { registerToken, unregisterToken, listUserDevices }
