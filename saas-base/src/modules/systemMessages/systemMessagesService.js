'use strict'

// Mensajes del sistema (cross-tenant): banners de aviso + ventanas de
// mantenimiento programadas. Los crea el super-admin; se muestran a todos
// los tenants en el AppShell.

const { query, withBypass } = require('../../db')

const KINDS      = ['announcement', 'maintenance']
const SEVERITIES = ['info', 'success', 'warning', 'critical']

function throwHttp(status, message, code) {
  const err = new Error(message)
  err.status = status
  if (code) err.code = code
  throw err
}

/**
 * Lista todos los mensajes del sistema. Por default solo los no cancelados;
 * pasa `includeCancelled=true` para mostrarlos también (historial).
 */
async function list({ includeCancelled = false } = {}) {
  const where = includeCancelled ? '1=1' : 'cancelled_at IS NULL'
  const { rows } = await withBypass(() => query(
    `SELECT * FROM system_messages
      WHERE ${where}
      ORDER BY
        CASE WHEN cancelled_at IS NULL THEN 0 ELSE 1 END,
        starts_at DESC NULLS LAST,
        created_at DESC`
  ))
  return rows
}

/**
 * Mensajes vigentes ahora — esto consume el banner de los tenants.
 * Aún no soporta targeting por tenant; se muestran a todos.
 */
async function listActive() {
  const { rows } = await withBypass(() => query(
    `SELECT id, kind, title, message, severity,
            starts_at, ends_at,
            maintenance_at, duration_minutes,
            updated_at
       FROM system_messages
      WHERE cancelled_at IS NULL
        AND NOW() BETWEEN starts_at AND ends_at
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 0
          WHEN 'warning'  THEN 1
          WHEN 'success'  THEN 2
          ELSE 3
        END,
        starts_at DESC`
  ))
  return rows
}

async function getOne(id) {
  const { rows } = await withBypass(() => query(
    `SELECT * FROM system_messages WHERE id = $1`, [id]
  ))
  return rows[0] || null
}

async function create(input, createdBy) {
  const v = normalize(input)

  const { rows } = await withBypass(() => query(
    `INSERT INTO system_messages
       (kind, title, message, severity,
        starts_at, ends_at, maintenance_at, duration_minutes,
        notify_email, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [v.kind, v.title, v.message, v.severity,
     v.starts_at, v.ends_at, v.maintenance_at, v.duration_minutes,
     v.notify_email, createdBy]
  ))
  return rows[0]
}

const EDITABLE = [
  'title', 'message', 'severity', 'starts_at', 'ends_at',
  'maintenance_at', 'duration_minutes', 'notify_email',
]

async function update(id, patch) {
  const current = await getOne(id)
  if (!current) throwHttp(404, 'Mensaje no encontrado.')
  if (current.cancelled_at) throwHttp(400, 'El mensaje está cancelado, no se puede editar.')

  // No permitimos cambiar kind — destruiría las invariantes del CHECK.
  if (patch.kind && patch.kind !== current.kind) {
    throwHttp(400, 'No se puede cambiar el tipo (kind) de un mensaje. Crea uno nuevo.')
  }

  // Reusamos la normalización pasando lo nuevo + lo viejo como fallback.
  const merged = normalize({ ...current, ...patch, kind: current.kind })

  const sets = []
  const params = []
  for (const k of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      params.push(merged[k])
      sets.push(`${k} = $${params.length}`)
    }
  }
  if (!sets.length) return current

  params.push(id)
  await withBypass(() => query(
    `UPDATE system_messages SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  ))
  return getOne(id)
}

async function cancel(id, { reason = null, userId = null } = {}) {
  const current = await getOne(id)
  if (!current) throwHttp(404, 'Mensaje no encontrado.')
  if (current.cancelled_at) return current

  await withBypass(() => query(
    `UPDATE system_messages
        SET cancelled_at = NOW(),
            cancelled_reason = $2
      WHERE id = $1`,
    [id, reason]
  ))
  return getOne(id)
}

// ─── Helpers de notificación (los usan los jobs pg-boss) ──────────────

/**
 * Devuelve mensajes con notify_email=TRUE que aún no se han notificado y
 * cuya ventana de visibilidad ya empezó o empieza pronto.
 */
async function findPendingNotifications() {
  const { rows } = await withBypass(() => query(
    `SELECT *
       FROM system_messages
      WHERE cancelled_at IS NULL
        AND notify_email = TRUE
        AND notified_at IS NULL
        AND starts_at <= NOW() + INTERVAL '1 hour'`
  ))
  return rows
}

async function markNotified(id) {
  await withBypass(() => query(
    `UPDATE system_messages SET notified_at = NOW() WHERE id = $1`, [id]
  ))
}

/**
 * Devuelve mantenimientos cuya fecha está entre 23 y 26 horas en el futuro
 * y aún no se les ha mandado recordatorio. La ventana 23-26 da margen para
 * que el job que corre cada hora alcance a procesarlos.
 */
async function findPendingReminders() {
  const { rows } = await withBypass(() => query(
    `SELECT *
       FROM system_messages
      WHERE cancelled_at IS NULL
        AND kind = 'maintenance'
        AND reminder_sent_at IS NULL
        AND maintenance_at BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '26 hours'`
  ))
  return rows
}

async function markReminderSent(id) {
  await withBypass(() => query(
    `UPDATE system_messages SET reminder_sent_at = NOW() WHERE id = $1`, [id]
  ))
}

async function markAdminReminded(id) {
  await withBypass(() => query(
    `UPDATE system_messages SET admin_reminded_at = NOW() WHERE id = $1`, [id]
  ))
}

// ─── Validación / normalización ───────────────────────────────────────

function normalize(input) {
  const kind = input.kind
  if (!KINDS.includes(kind)) throwHttp(400, `kind inválido (${kind})`)

  const title = String(input.title || '').trim()
  if (!title || title.length > 200) throwHttp(400, 'title requerido (máx 200).')

  const message = String(input.message || '').trim()
  if (!message) throwHttp(400, 'message requerido.')

  const severity = input.severity || 'info'
  if (!SEVERITIES.includes(severity)) throwHttp(400, `severity inválido (${severity})`)

  const starts_at = parseDate(input.starts_at, 'starts_at')
  const ends_at   = parseDate(input.ends_at,   'ends_at')
  if (ends_at <= starts_at) throwHttp(400, 'ends_at debe ser posterior a starts_at.')

  let maintenance_at = null
  let duration_minutes = null
  if (kind === 'maintenance') {
    maintenance_at = parseDate(input.maintenance_at, 'maintenance_at')
    duration_minutes = parseInt(input.duration_minutes, 10)
    if (!Number.isFinite(duration_minutes) || duration_minutes <= 0) {
      throwHttp(400, 'duration_minutes debe ser un entero positivo.')
    }
  }

  return {
    kind, title, message, severity,
    starts_at, ends_at, maintenance_at, duration_minutes,
    notify_email: !!input.notify_email,
  }
}

function parseDate(v, field) {
  if (!v) throwHttp(400, `${field} requerido.`)
  const d = v instanceof Date ? v : new Date(v)
  if (isNaN(d.getTime())) throwHttp(400, `${field} no es una fecha válida.`)
  return d
}

module.exports = {
  KINDS, SEVERITIES,
  list, listActive, getOne, create, update, cancel,
  findPendingNotifications, markNotified,
  findPendingReminders, markReminderSent, markAdminReminded,
}
