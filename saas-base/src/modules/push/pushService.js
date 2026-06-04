'use strict'

/**
 * Núcleo de notificaciones push (Firebase Cloud Messaging).
 *
 * Diseño defensivo (igual que emailService/storage):
 *  - Si Firebase NO está configurado (faltan las 3 env), TODO queda en no-op:
 *    no se carga `firebase-admin`, no se manda nada, no se lanza error. Así los
 *    tests corren sin Firebase y el arranque nunca se rompe.
 *  - `firebase-admin` se carga LAZY (require dentro de getMessaging) — si el
 *    paquete no está instalado pero tampoco hay credenciales, da igual.
 *  - Ningún método lanza: los callers son best-effort (push es un side-effect).
 *
 * API:
 *   sendToUsers(tenantId, userIds, { title, body, data }) → { sent, skipped, pruned }
 *   notify(tenantId, { audience, title, body, data })     → idem (resuelve audiencia)
 */

const config = require('../../config')
const logger = require('../../config/logger')
const { query } = require('../../db')
const { resolveRecipients } = require('./audienceService')

// Códigos de error de FCM que significan "este token ya no sirve" → podar.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
])

const FCM_MULTICAST_MAX = 500 // límite de sendEachForMulticast

let messaging = null
let initFailed = false

/**
 * Devuelve la instancia de messaging, o null si push está deshabilitado o si
 * la inicialización falló (credenciales corruptas). Nunca lanza.
 */
function getMessaging() {
  if (messaging) return messaging
  if (initFailed) return null
  if (!config.firebase.enabled) return null

  try {
    // Lazy require: solo se intenta cuando hay credenciales.
    const admin = require('firebase-admin')
    const app = admin.apps && admin.apps.length
      ? admin.app()
      : admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   config.firebase.projectId,
          clientEmail: config.firebase.clientEmail,
          privateKey:  config.firebase.privateKey,
        }),
      })
    messaging = admin.messaging(app)
    return messaging
  } catch (err) {
    initFailed = true
    logger.error('[push] No se pudo inicializar firebase-admin — push deshabilitado.', { error: err.message })
    return null
  }
}

/** ¿Está el push operativo? (para health checks / endpoints informativos) */
function isEnabled() {
  return !!getMessaging()
}

// FCM exige que todos los valores de `data` sean strings.
function stringifyData(data) {
  const out = {}
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Manda una notificación a todos los dispositivos de un conjunto de usuarios.
 * No lanza. Si push está deshabilitado o no hay tokens, devuelve { skipped:true }.
 */
async function sendToUsers(tenantId, userIds, { title, body, data = {} } = {}) {
  const m = getMessaging()
  if (!m) return { sent: 0, skipped: true }

  const ids = [...new Set((userIds || []).filter(Boolean))]
  if (ids.length === 0) return { sent: 0, skipped: true }

  try {
    const { rows } = await query(
      `SELECT token FROM device_tokens WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId, ids]
    )
    const tokens = rows.map((r) => r.token)
    if (tokens.length === 0) return { sent: 0, skipped: true }

    const payloadData = stringifyData(data)
    let sent = 0
    const deadTokens = []

    for (const batch of chunk(tokens, FCM_MULTICAST_MAX)) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await m.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data: payloadData,
        android: { priority: 'high' },
      })
      sent += resp.successCount
      resp.responses.forEach((r, i) => {
        if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) {
          deadTokens.push(batch[i])
        }
      })
    }

    // Poda de tokens muertos (best-effort).
    if (deadTokens.length) {
      try {
        await query(`DELETE FROM device_tokens WHERE token = ANY($1::text[])`, [deadTokens])
      } catch (pruneErr) {
        logger.warn('[push] no se pudieron podar tokens muertos', { error: pruneErr.message })
      }
    }

    logger.info('[push] enviado', { tenantId, users: ids.length, tokens: tokens.length, sent, pruned: deadTokens.length })
    return { sent, skipped: false, pruned: deadTokens.length }
  } catch (err) {
    logger.error('[push] error enviando notificación', { tenantId, error: err.message })
    return { sent: 0, skipped: false, error: err.message }
  }
}

/**
 * Resuelve una o varias audiencias (ver audienceService), las une, descuenta a
 * `excludeUserIds` (típicamente el usuario que ejecutó la acción — no debe
 * recibir el push de su propio acto) y manda el push. No lanza.
 *
 * Acepta `audience` (una spec) o `audiences` (array de specs que se UNEN). Esto
 * permite dirigir un evento a "todos los de facturación + el dueño del pedido"
 * sin que pushService conozca la lógica de cada módulo.
 */
async function notify(tenantId, { audience, audiences, excludeUserIds = [], title, body, data = {} } = {}) {
  const m = getMessaging()
  if (!m) return { sent: 0, skipped: true }
  try {
    const userIds = await resolveRecipients(tenantId, { audience, audiences, excludeUserIds })
    if (!userIds.length) return { sent: 0, skipped: true }
    return await sendToUsers(tenantId, userIds, { title, body, data })
  } catch (err) {
    logger.error('[push] error resolviendo audiencia', { tenantId, error: err.message })
    return { sent: 0, skipped: false, error: err.message }
  }
}

module.exports = { sendToUsers, notify, isEnabled }
