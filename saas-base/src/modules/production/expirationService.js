'use strict'

/**
 * SaaS v2 §5h — Service de expiración de lotes.
 *
 * Dos operaciones:
 *
 *   markExpiredLots({ tenantId? })
 *     → Por cada raw_material_lot / product_lot con expiry_date <= NOW() y
 *       status = 'active', actualiza status a 'expired'. Genera alerta
 *       lot_expired por cada lote afectado.
 *
 *   getExpiringLots({ tenantId, daysAhead? })
 *     → Devuelve los lotes que vencen en N días (default tomado de
 *       tenant_process_config.expiry_alert_days). NO modifica nada — es
 *       consulta pura. Si se especifica `dispatch=true`, también genera
 *       alertas lot_expiring (con dedupe).
 *
 * markExpiredLots puede correr scoped a un tenant (modo cron por tenant)
 * o sin scope (modo cron global por toda la BD).
 *
 * Referencia: §4.9.2 del design.
 */

const { query, withTransaction } = require('../../db')
const { dispatchAlert } = require('../alerts/alertService')

/**
 * Marca como expirados los lotes vencidos. Devuelve { rmLots, ptLots } con
 * arrays de IDs afectados.
 */
async function markExpiredLots({ tenantId = null } = {}) {
  return withTransaction(async (client) => {
    const params = []
    let where = `WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date <= NOW()::date`
    if (tenantId) {
      params.push(tenantId)
      where += ` AND tenant_id = $1`
    }

    const { rows: rmExpired } = await client.query(
      `UPDATE raw_material_lots SET status = 'expired'
       ${where}
       RETURNING id, tenant_id, lot_number, expiry_date, raw_material_id`,
      params
    )
    const { rows: ptExpired } = await client.query(
      `UPDATE product_lots SET status = 'expired'
       ${where}
       RETURNING id, tenant_id, lot_number, expiry_date, product_id`,
      params
    )

    // Generar alertas. dispatchAlert hace dedupe.
    for (const rm of rmExpired) {
      await dispatchAlert(client, {
        tenantId: rm.tenant_id,
        type: 'lot_expired',
        severity: 'critical',
        title: `Lote MP caducado: ${rm.lot_number}`,
        body: `El lote ${rm.lot_number} venció el ${rm.expiry_date.toISOString().slice(0, 10)}. Pasó a status='expired'.`,
        payload: {
          lot_number: rm.lot_number,
          expiry_date: rm.expiry_date,
          raw_material_id: rm.raw_material_id,
        },
        sourceType: 'raw_material_lot',
        sourceId: rm.id,
      })
    }
    for (const pt of ptExpired) {
      await dispatchAlert(client, {
        tenantId: pt.tenant_id,
        type: 'lot_expired',
        severity: 'critical',
        title: `Lote PT caducado: ${pt.lot_number}`,
        body: `El lote ${pt.lot_number} venció el ${pt.expiry_date.toISOString().slice(0, 10)}. Pasó a status='expired'.`,
        payload: {
          lot_number: pt.lot_number,
          expiry_date: pt.expiry_date,
          product_id: pt.product_id,
        },
        sourceType: 'product_lot',
        sourceId: pt.id,
      })
    }

    return {
      rmLotsExpired: rmExpired.length,
      ptLotsExpired: ptExpired.length,
      rmIds: rmExpired.map(r => r.id),
      ptIds: ptExpired.map(r => r.id),
    }
  })
}

/**
 * Devuelve lotes que vencen en los próximos N días (sin modificarlos).
 * Si daysAhead no se pasa, usa tenant_process_config.expiry_alert_days.
 * Si tampoco está, usa 30 días default.
 *
 * @param {object} opts
 * @param {boolean} [opts.dispatch=false]  Si true, genera alertas lot_expiring
 *   por cada lote (dedupe vía alertService).
 */
async function getExpiringLots({ tenantId, daysAhead = null, dispatch = false }) {
  if (!tenantId) throw new Error('tenantId requerido.')

  let days = daysAhead
  if (days == null) {
    const { rows: cfg } = await query(
      `SELECT expiry_alert_days FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    days = cfg[0]?.expiry_alert_days || 30
  }

  const { rows: rmRows } = await query(
    `SELECT rml.id, rml.lot_number, rml.expiry_date, rml.raw_material_id,
            rml.quantity_remaining, rm.name AS raw_material_name
     FROM raw_material_lots rml
     JOIN raw_materials rm ON rm.id = rml.raw_material_id
     WHERE rml.tenant_id = $1 AND rml.status = 'active'
       AND rml.expiry_date IS NOT NULL
       AND rml.expiry_date > NOW()::date
       AND rml.expiry_date <= (NOW()::date + ($2 || ' days')::interval)
     ORDER BY rml.expiry_date ASC`,
    [tenantId, String(days)]
  )

  // Per-product override: usa products.expiry_alert_days si está configurado,
  // sino cae al umbral global `days`. §7.7 (Pastelería — vida útil muy corta).
  const { rows: ptRows } = await query(
    `SELECT pl.id, pl.lot_number, pl.expiry_date, pl.product_id,
            pl.quantity_remaining, p.name AS product_name,
            COALESCE(p.expiry_alert_days, $2) AS effective_alert_days
     FROM product_lots pl
     JOIN products p ON p.id = pl.product_id
     WHERE pl.tenant_id = $1 AND pl.status = 'active'
       AND pl.expiry_date IS NOT NULL
       AND pl.expiry_date > NOW()::date
       AND pl.expiry_date <= (NOW()::date + (COALESCE(p.expiry_alert_days, $2) || ' days')::interval)
     ORDER BY pl.expiry_date ASC`,
    [tenantId, String(days)]
  )

  if (dispatch) {
    for (const rm of rmRows) {
      await dispatchAlert(null, {
        tenantId,
        type: 'lot_expiring',
        severity: 'warning',
        title: `Lote MP por vencer: ${rm.lot_number}`,
        body: `${rm.raw_material_name} — vence el ${rm.expiry_date.toISOString().slice(0, 10)}. Quedan ${rm.quantity_remaining}.`,
        payload: { lot_number: rm.lot_number, expiry_date: rm.expiry_date, quantity_remaining: rm.quantity_remaining },
        sourceType: 'raw_material_lot',
        sourceId: rm.id,
      })
    }
    for (const pt of ptRows) {
      await dispatchAlert(null, {
        tenantId,
        type: 'lot_expiring',
        severity: 'warning',
        title: `Lote PT por vencer: ${pt.lot_number}`,
        body: `${pt.product_name} — vence el ${pt.expiry_date.toISOString().slice(0, 10)}. Quedan ${pt.quantity_remaining}.`,
        payload: { lot_number: pt.lot_number, expiry_date: pt.expiry_date, quantity_remaining: pt.quantity_remaining },
        sourceType: 'product_lot',
        sourceId: pt.id,
      })
    }
  }

  return {
    daysAhead: parseInt(days),
    rawMaterialLots: rmRows,
    productLots: ptRows,
  }
}

module.exports = {
  markExpiredLots,
  getExpiringLots,
}
