'use strict'

const { query, withTransaction } = require('../../db')
const { recordMovement } = require('./inventoryService')
const documentSeriesService = require('../document-series/documentSeriesService')
const storage = require('../../utils/storage')
const logger = require('../../config/logger')

/**
 * Vales de salida (consumo interno a áreas) — mig 245/246.
 *
 * El almacenista libera material a un área (producción, empaque, mantenimiento,
 * oficinas...) SIN venta de por medio. Espejo de los ajustes de inventario:
 * la cabecera vive en consumption_vouchers y las líneas en inventory_movements
 * (reference_type='consumption_voucher', movement_type='internal_consumption').
 *
 * El costo unitario NO viene del cliente: se toma del costo promedio vigente
 * (inventory_stock.avg_cost) al momento del vale — snapshot para valorizar el
 * consumo por área aunque el costo cambie después.
 */

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// ─── Áreas de consumo ─────────────────────────────────────────────────────────

async function listAreas({ tenantId, includeInactive = false }) {
  const { rows } = await query(
    `SELECT id, name, is_active, sort_order
       FROM tenant_consumption_areas
      WHERE tenant_id = $1 ${includeInactive ? '' : 'AND is_active = true'}
      ORDER BY sort_order, name`,
    [tenantId]
  )
  return rows
}

async function createArea({ tenantId, name }) {
  if (!name || !name.trim()) throw createError(400, 'name (nombre del área) es requerido.')
  try {
    const { rows } = await query(
      `INSERT INTO tenant_consumption_areas (tenant_id, name)
       VALUES ($1, $2) RETURNING id, name, is_active, sort_order`,
      [tenantId, name.trim()]
    )
    return rows[0]
  } catch (err) {
    if (err.code === '23505') throw createError(409, 'Ya existe un área con ese nombre.')
    throw err
  }
}

async function updateArea({ tenantId, areaId, name, isActive, sortOrder }) {
  const sets = []
  const params = [areaId, tenantId]
  if (name !== undefined) {
    if (!String(name).trim()) throw createError(400, 'El nombre no puede quedar vacío.')
    params.push(String(name).trim()); sets.push(`name = $${params.length}`)
  }
  if (isActive !== undefined)  { params.push(!!isActive); sets.push(`is_active = $${params.length}`) }
  if (sortOrder !== undefined) { params.push(parseInt(sortOrder, 10) || 0); sets.push(`sort_order = $${params.length}`) }
  if (!sets.length) throw createError(400, 'Nada que actualizar.')

  try {
    const { rows } = await query(
      `UPDATE tenant_consumption_areas SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, is_active, sort_order`,
      params
    )
    if (!rows.length) throw createError(404, 'Área no encontrada.')
    return rows[0]
  } catch (err) {
    if (err.code === '23505') throw createError(409, 'Ya existe un área con ese nombre.')
    throw err
  }
}

// ─── Folio ────────────────────────────────────────────────────────────────────

async function nextVoucherNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'consumption_voucher', opts,
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `VAL-${ym}-`
  const { rows } = await client.query(
    `SELECT voucher_number FROM consumption_vouchers
     WHERE tenant_id = $1 AND voucher_number LIKE $2
     ORDER BY voucher_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.voucher_number
  const seq  = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

// ─── Crear vale ───────────────────────────────────────────────────────────────

// Firma en pantalla (opcional): data URL PNG del pad de firma. Tope 2MB
// decodificados — una firma real pesa unos cuantos KB.
const SIGNATURE_PREFIX = 'data:image/png;base64,'
function decodeSignature(signatureDataUrl) {
  if (!signatureDataUrl) return null
  if (typeof signatureDataUrl !== 'string' || !signatureDataUrl.startsWith(SIGNATURE_PREFIX)) {
    throw createError(400, 'La firma debe ser un PNG (data URL).')
  }
  const buf = Buffer.from(signatureDataUrl.slice(SIGNATURE_PREFIX.length), 'base64')
  if (!buf.length) throw createError(400, 'La firma llegó vacía.')
  if (buf.length > 2 * 1024 * 1024) throw createError(400, 'La firma excede 2MB.')
  return buf
}

async function createVoucher({
  tenantId, warehouseId, areaId, receivedBy, notes, lines = [], signatureDataUrl, userId,
}) {
  const signatureBuf = decodeSignature(signatureDataUrl)   // valida ANTES de tocar la BD
  if (!warehouseId) throw createError(400, 'warehouseId es requerido.')
  if (!areaId)      throw createError(400, 'areaId (área destino) es requerido.')
  if (!receivedBy || !receivedBy.trim()) {
    throw createError(400, 'receivedBy (quién recibe el material) es requerido.')
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw createError(400, 'Se requiere al menos una línea.')
  }
  lines.forEach((ln, idx) => {
    if (!ln.itemType || !['raw_material', 'product'].includes(ln.itemType)) {
      throw createError(400, `Línea ${idx + 1}: itemType inválido (raw_material o product).`)
    }
    if (!ln.itemId) throw createError(400, `Línea ${idx + 1}: itemId es requerido.`)
    const q = parseFloat(ln.quantity)
    if (isNaN(q) || q <= 0) throw createError(400, `Línea ${idx + 1}: quantity debe ser un número positivo.`)
  })

  return withTransaction(async (client) => {
    const { rows: whRows } = await client.query(
      `SELECT id, type FROM warehouses WHERE id=$1 AND tenant_id=$2 AND is_active=true`,
      [warehouseId, tenantId]
    )
    if (!whRows[0]) throw createError(404, 'Almacén no encontrado o inactivo.')
    if (whRows[0].type === 'wip') {
      throw createError(409, 'Los almacenes WIP son de solo lectura. Solo los hooks de producción pueden moverlos.')
    }

    const { rows: areaRows } = await client.query(
      `SELECT id, name, is_active FROM tenant_consumption_areas WHERE id=$1 AND tenant_id=$2`,
      [areaId, tenantId]
    )
    if (!areaRows[0]) throw createError(404, 'Área no encontrada.')
    if (!areaRows[0].is_active) throw createError(409, 'El área está desactivada.')

    const voucherNumber = await nextVoucherNumber(client, tenantId)
    const { rows: hdrRows } = await client.query(
      `INSERT INTO consumption_vouchers
         (tenant_id, voucher_number, warehouse_id, area_id, received_by, notes,
          total_lines, total_value, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 'active', $7)
       RETURNING *`,
      [tenantId, voucherNumber, warehouseId, areaId,
       receivedBy.trim(), (notes || '').trim() || null, userId]
    )
    const header = hdrRows[0]

    let totalValue = 0
    for (const ln of lines) {
      const qty = parseFloat(ln.quantity)

      // Snapshot del costo promedio vigente en ese almacén (disponible).
      const { rows: st } = await client.query(
        `SELECT avg_cost, unit FROM inventory_stock
          WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type=$3 AND item_id=$4 AND status='available'`,
        [tenantId, warehouseId, ln.itemType, ln.itemId]
      )
      const unitCost = parseFloat(st[0]?.avg_cost || 0)
      const unit     = ln.unit || st[0]?.unit || (ln.itemType === 'raw_material' ? 'kg' : 'pza')

      await recordMovement(client, {
        tenantId,
        warehouseId,
        itemType:      ln.itemType,
        itemId:        ln.itemId,
        movementType:  'internal_consumption',
        quantity:      -qty,
        unit,
        unitCost,
        statusTo:      'available',
        referenceType: 'consumption_voucher',
        referenceId:   header.id,
        notes:         (ln.notes || '').trim() || `Salida a ${areaRows[0].name} — recibe ${receivedBy.trim()}`,
        createdBy:     userId,
        validateStock: true,
      })

      totalValue += qty * unitCost
    }

    await client.query(
      `UPDATE consumption_vouchers SET total_lines = $1, total_value = $2 WHERE id = $3`,
      [lines.length, totalValue.toFixed(2), header.id]
    )

    const { rows: finalRows } = await client.query(
      `SELECT * FROM consumption_vouchers WHERE id = $1`, [header.id]
    )
    return finalRows[0]
  }).then(async (voucher) => {
    // Firma: se sube DESPUÉS del commit (el vale ya existe). Best-effort — si el
    // storage falla, el vale queda sin firma y se avisa al caller; el material
    // ya salió y eso es lo que no puede perderse.
    if (!signatureBuf) return voucher
    try {
      const key = `vouchers/${tenantId}/${voucher.id}-firma.png`
      await storage.put(key, signatureBuf, { contentType: 'image/png' })
      await query(
        `UPDATE consumption_vouchers SET receiver_signature_path = $1
          WHERE id = $2 AND tenant_id = $3`,
        [key, voucher.id, tenantId]
      )
      return { ...voucher, receiver_signature_path: key }
    } catch (err) {
      logger.warn('vales: no se pudo guardar la firma', { voucherId: voucher.id, error: err.message })
      return { ...voucher, signature_error: 'El vale se guardó, pero la firma no pudo almacenarse.' }
    }
  })
}

/** PNG de la firma del receptor (si el vale la tiene). */
async function getSignatureFile({ tenantId, voucherId }) {
  const { rows } = await query(
    `SELECT receiver_signature_path FROM consumption_vouchers
      WHERE id = $1 AND tenant_id = $2`,
    [voucherId, tenantId]
  )
  if (!rows.length || !rows[0].receiver_signature_path) return null
  return {
    storagePath: rows[0].receiver_signature_path,
    mimetype: 'image/png',
  }
}

// ─── Cancelar (reingresa el material) ─────────────────────────────────────────

async function cancelVoucher({ tenantId, voucherId, reason, userId }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'reason (razón de la cancelación) es obligatorio.')
  }

  return withTransaction(async (client) => {
    const { rows: vRows } = await client.query(
      `SELECT * FROM consumption_vouchers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [voucherId, tenantId]
    )
    if (!vRows.length) throw createError(404, 'Vale no encontrado.')
    const voucher = vRows[0]
    if (voucher.status === 'cancelled') throw createError(409, 'Este vale ya está cancelado.')

    const { rows: origMovs } = await client.query(
      `SELECT * FROM inventory_movements
       WHERE reference_type = 'consumption_voucher' AND reference_id = $1
       ORDER BY created_at ASC`,
      [voucherId]
    )
    if (!origMovs.length) throw createError(409, 'No se encontraron movimientos para revertir.')

    for (const m of origMovs) {
      await recordMovement(client, {
        tenantId,
        warehouseId:   m.warehouse_id,
        itemType:      m.item_type,
        itemId:        m.item_id,
        movementType:  'internal_consumption',
        quantity:      -parseFloat(m.quantity),   // el original es negativo → reingreso positivo
        unit:          m.unit,
        unitCost:      parseFloat(m.unit_cost || 0),
        statusTo:      m.status_to || 'available',
        referenceType: 'consumption_voucher_reversal',
        referenceId:   voucherId,
        notes:         `Reversión por cancelación: ${String(reason).trim()}`,
        createdBy:     userId,
      })
    }

    await client.query(
      `UPDATE consumption_vouchers
       SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1, cancellation_reason=$2
       WHERE id=$3`,
      [userId, String(reason).trim(), voucherId]
    )

    const { rows: final } = await client.query(
      `SELECT * FROM consumption_vouchers WHERE id=$1`, [voucherId]
    )
    return final[0]
  })
}

// ─── Consultas ────────────────────────────────────────────────────────────────

async function listVouchers({
  tenantId, warehouseId, areaId, status, dateFrom, dateTo, search,
  page = 1, limit = 25,
}) {
  const conds = ['cv.tenant_id = $1']
  const params = [tenantId]
  const add = (clause, value) => { params.push(value); conds.push(clause.replace('?', `$${params.length}`)) }

  if (warehouseId) add('cv.warehouse_id = ?', warehouseId)
  if (areaId)      add('cv.area_id = ?', areaId)
  if (status)      add('cv.status = ?', status)
  if (dateFrom)    add('cv.voucher_date >= ?', dateFrom)
  if (dateTo)      add('cv.voucher_date <= ?', dateTo)
  if (search) {
    params.push(`%${search}%`)
    conds.push(`(cv.voucher_number ILIKE $${params.length} OR cv.received_by ILIKE $${params.length})`)
  }

  const offset = (page - 1) * limit
  const sql = `
    SELECT cv.*, w.name AS warehouse_name, a.name AS area_name,
           u.full_name AS created_by_name, cb.full_name AS cancelled_by_name
      FROM consumption_vouchers cv
      JOIN warehouses w ON w.id = cv.warehouse_id
      JOIN tenant_consumption_areas a ON a.id = cv.area_id
      LEFT JOIN users u  ON u.id  = cv.created_by
      LEFT JOIN users cb ON cb.id = cv.cancelled_by
     WHERE ${conds.join(' AND ')}
     ORDER BY cv.created_at DESC
     LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}
  `
  const countSql = `SELECT COUNT(*) AS total FROM consumption_vouchers cv WHERE ${conds.join(' AND ')}`
  const [listRes, countRes] = await Promise.all([query(sql, params), query(countSql, params)])
  return { data: listRes.rows, total: parseInt(countRes.rows[0].total, 10), page, limit }
}

async function getVoucher({ tenantId, voucherId }) {
  const { rows } = await query(
    `SELECT cv.*, w.name AS warehouse_name, a.name AS area_name,
            u.full_name AS created_by_name, cb.full_name AS cancelled_by_name
       FROM consumption_vouchers cv
       JOIN warehouses w ON w.id = cv.warehouse_id
       JOIN tenant_consumption_areas a ON a.id = cv.area_id
       LEFT JOIN users u  ON u.id  = cv.created_by
       LEFT JOIN users cb ON cb.id = cv.cancelled_by
      WHERE cv.id = $1 AND cv.tenant_id = $2`,
    [voucherId, tenantId]
  )
  if (!rows.length) return null
  const voucher = rows[0]

  const { rows: lines } = await query(
    `SELECT m.id, m.item_type, m.item_id, m.quantity, m.unit, m.unit_cost, m.notes,
            COALESCE(rm.name, p.name) AS item_name,
            CASE m.item_type WHEN 'product' THEN p.sku ELSE NULL END AS item_sku
       FROM inventory_movements m
       LEFT JOIN raw_materials rm ON rm.id = m.item_id AND m.item_type = 'raw_material'
       LEFT JOIN products p       ON p.id  = m.item_id AND m.item_type = 'product'
      WHERE m.reference_type = 'consumption_voucher' AND m.reference_id = $1
        AND m.tenant_id = $2
      ORDER BY m.created_at ASC`,
    [voucherId, tenantId]
  )
  return { ...voucher, lines }
}

/** Consumo valorizado por área en un rango de fechas (solo vales activos). */
async function consumptionByArea({ tenantId, dateFrom, dateTo }) {
  const conds = [`cv.tenant_id = $1`, `cv.status = 'active'`]
  const params = [tenantId]
  if (dateFrom) { params.push(dateFrom); conds.push(`cv.voucher_date >= $${params.length}`) }
  if (dateTo)   { params.push(dateTo);   conds.push(`cv.voucher_date <= $${params.length}`) }

  const { rows } = await query(
    `SELECT a.id AS area_id, a.name AS area_name,
            COUNT(*)::int AS vouchers, SUM(cv.total_value)::numeric AS total_value
       FROM consumption_vouchers cv
       JOIN tenant_consumption_areas a ON a.id = cv.area_id
      WHERE ${conds.join(' AND ')}
      GROUP BY a.id, a.name
      ORDER BY total_value DESC NULLS LAST`,
    params
  )
  return rows
}

module.exports = {
  listAreas, createArea, updateArea,
  createVoucher, cancelVoucher, listVouchers, getVoucher, consumptionByArea,
  getSignatureFile,
}
