'use strict'

/**
 * SaaS v2 §5h — Service de alertas operativas (tenant_alerts).
 *
 * API:
 *   dispatchAlert(client, alert)
 *     → Persiste en tenant_alerts + audit_log + console.log con prefijo [ALERT].
 *       Dedupe: si ya existe una alerta pending/acknowledged del mismo
 *       (tenant_id, type, source_type, source_id), no inserta nueva — retorna
 *       la existente. Esto evita ruido cuando el cron corre múltiples veces
 *       sobre el mismo lote.
 *
 *       Hook centralizado: a futuro, aquí se invocará el publisher SMTP/Slack
 *       según `tenant_process_config.alert_webhook_url` (columna por agregar).
 *
 *   listAlerts({ tenantId, status, type, limit, offset })
 *   acknowledgeAlert({ tenantId, alertId, userId })
 *   resolveAlert({ tenantId, alertId, userId })
 *
 * Las acciones de ack/resolve respetan que el status anterior sea coherente
 * (no se puede ack lo ya resolved, etc.).
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

const VALID_SEVERITIES = ['info', 'warning', 'critical']

function createError(status, message) {
  const err = new Error(message); err.status = status; return err
}

/**
 * Inserta o reusa una alerta. Idempotente por (tenant_id, type, source_type, source_id)
 * mientras esté pending/acknowledged. Resolved no bloquea — si la condición
 * vuelve a ocurrir, se crea una alerta nueva.
 *
 * Puede recibir un `client` (transaccional) o usar pool.
 */
async function dispatchAlert(clientOrNull, {
  tenantId, type, severity = 'warning',
  title, body = null, payload = null,
  sourceType = null, sourceId = null,
  userId = null,
}) {
  if (!tenantId || !type || !title) {
    throw new Error('dispatchAlert: tenantId, type y title son requeridos.')
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`severity inválida: ${severity}`)
  }

  const q = (text, params) => (clientOrNull ? clientOrNull.query(text, params) : query(text, params))

  // Dedupe: ¿hay ya una alerta pending/acknowledged del mismo origen?
  if (sourceType && sourceId) {
    const { rows: existing } = await q(
      `SELECT id, status FROM tenant_alerts
       WHERE tenant_id = $1 AND type = $2
         AND source_type = $3 AND source_id = $4
         AND status IN ('pending','acknowledged')
       LIMIT 1`,
      [tenantId, type, sourceType, sourceId]
    )
    if (existing[0]) {
      // Solo log info — no consideramos esto un error.
      console.log(`[ALERT][dedupe] ${type} ya existe (id=${existing[0].id}, status=${existing[0].status})`)
      return { id: existing[0].id, deduped: true }
    }
  }

  const { rows: ins } = await q(
    `INSERT INTO tenant_alerts (tenant_id, type, severity, title, body, payload, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tenantId, type, severity, title, body, payload ? JSON.stringify(payload) : null, sourceType, sourceId]
  )
  const alert = ins[0]

  // Side-effects: audit + console. Las side-effects no participan en la
  // transacción principal — son best-effort.
  try {
    await audit({
      tenantId, userId,
      action: `alert.${type}`,
      resource: 'tenant_alerts',
      resourceId: alert.id,
      payload: { severity, title, sourceType, sourceId, payload },
    })
  } catch (auditErr) {
    console.warn('[alertService] audit failed:', auditErr.message)
  }
  console.log(`[ALERT][${severity}][${type}] ${title} (tenant=${tenantId}, alert=${alert.id})`)

  return { ...alert, deduped: false }
}

async function listAlerts({ tenantId, status = null, type = null, limit = 100, offset = 0 }) {
  const params = [tenantId]
  let where = `WHERE tenant_id = $1`
  if (status) { params.push(status); where += ` AND status = $${params.length}` }
  if (type) { params.push(type); where += ` AND type = $${params.length}` }
  params.push(parseInt(limit), parseInt(offset))
  const { rows } = await query(
    `SELECT id, type, severity, status, title, body, payload, source_type, source_id,
            created_at, acknowledged_at, acknowledged_by, resolved_at, resolved_by
     FROM tenant_alerts
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows
}

async function acknowledgeAlert({ tenantId, alertId, userId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM tenant_alerts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [alertId, tenantId]
    )
    if (!rows[0]) throw createError(404, 'Alerta no encontrada.')
    if (rows[0].status === 'resolved') {
      throw createError(400, 'No se puede reconocer una alerta ya resuelta.')
    }
    if (rows[0].status === 'acknowledged') return rows[0]

    const { rows: upd } = await client.query(
      `UPDATE tenant_alerts
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $1
       WHERE id = $2 RETURNING *`,
      [userId, alertId]
    )
    return upd[0]
  })
}

async function resolveAlert({ tenantId, alertId, userId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status FROM tenant_alerts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [alertId, tenantId]
    )
    if (!rows[0]) throw createError(404, 'Alerta no encontrada.')
    if (rows[0].status === 'resolved') return rows[0]

    const { rows: upd } = await client.query(
      `UPDATE tenant_alerts
       SET status = 'resolved', resolved_at = NOW(), resolved_by = $1
       WHERE id = $2 RETURNING *`,
      [userId, alertId]
    )
    return upd[0]
  })
}

module.exports = {
  dispatchAlert,
  listAlerts,
  acknowledgeAlert,
  resolveAlert,
}
