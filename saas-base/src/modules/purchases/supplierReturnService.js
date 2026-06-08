'use strict'

/**
 * SaaS v2 — Devoluciones a proveedor (Fase 1).
 *
 * Flujo:
 *   1. createReturn → borrador (encabezado + líneas). No mueve inventario.
 *   2. confirmReturn → SALE el inventario (movement_type='purchase_return', por
 *      lote y a costo de lote) + decrementa el lote. credit_status='pending'
 *      (la resolución fiscal — nota de crédito / cancelación / sustitución — es Fase 2).
 *   3. cancelReturn → borrador: solo marca cancelada. Confirmada: REVIERTE el
 *      inventario (re-entra el stock + re-incrementa el lote).
 *
 * Decisión Fase 1: NO se muta CXP automáticamente — la devolución registra el valor
 * como "crédito pendiente" contra el proveedor (credit_status='pending'). El efecto
 * fiscal/CXP real ocurre en Fase 2 cuando llega el CFDI de egreso / cancelación.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const { recordMovement } = require('../inventory/inventoryService')
const documentSeriesService = require('../document-series/documentSeriesService')

function badReq(msg) { const e = new Error(msg); e.status = 400; return e }
function notFound(msg) { const e = new Error(msg); e.status = 404; return e }

// ─── Folio DEV-YYYYMM-XXXX ───────────────────────────────────────────────────
async function nextReturnNumber(client, tenantId) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'supplier_return', opts: {},
  }).catch(() => null)
  if (result?.docNumber) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `DEV-${ym}-`
  const { rows } = await client.query(
    `SELECT return_number FROM supplier_returns
      WHERE tenant_id = $1 AND return_number LIKE $2
      ORDER BY return_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.return_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

// ─── Catálogo de motivos ─────────────────────────────────────────────────────
async function listReasons({ tenantId, includeInactive = false }) {
  const { rows } = await query(
    `SELECT id, code, name, sort_order, is_active
       FROM tenant_return_reasons
      WHERE tenant_id = $1 ${includeInactive ? '' : 'AND is_active = true'}
      ORDER BY sort_order, name`,
    [tenantId]
  )
  return rows
}

async function createReason({ tenantId, code, name, sortOrder = 0 }) {
  if (!name) throw badReq('El nombre del motivo es requerido.')
  // Slug del code dedup (mismo patrón que categorías de gasto).
  const base = (code || name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'motivo'
  let finalCode = base
  for (let i = 2; i < 50; i++) {
    const { rows } = await query(
      `SELECT 1 FROM tenant_return_reasons WHERE tenant_id = $1 AND code = $2`,
      [tenantId, finalCode]
    )
    if (rows.length === 0) break
    finalCode = `${base}_${i}`
  }
  const { rows } = await query(
    `INSERT INTO tenant_return_reasons (tenant_id, code, name, sort_order)
     VALUES ($1,$2,$3,$4) RETURNING id, code, name, sort_order, is_active`,
    [tenantId, finalCode, name, sortOrder]
  )
  return rows[0]
}

async function updateReason({ tenantId, reasonId, name, sortOrder, isActive }) {
  const { rows } = await query(
    `UPDATE tenant_return_reasons
        SET name = COALESCE($1, name),
            sort_order = COALESCE($2, sort_order),
            is_active = COALESCE($3, is_active)
      WHERE id = $4 AND tenant_id = $5
      RETURNING id, code, name, sort_order, is_active`,
    [name ?? null, sortOrder ?? null, isActive ?? null, reasonId, tenantId]
  )
  if (!rows[0]) throw notFound('Motivo no encontrado.')
  return rows[0]
}

// ─── Lotes devolvibles (para el selector del front) ──────────────────────────
// Lotes de MP con saldo > 0, opcionalmente filtrados por material/almacén/proveedor
// (vía la recepción que originó el lote). Incluye el almacén y el costo del lote.
async function listReturnableLots({ tenantId, rawMaterialId, warehouseId, partnerId }) {
  const params = [tenantId]
  const filters = []
  if (rawMaterialId) { params.push(rawMaterialId); filters.push(`lot.raw_material_id = $${params.length}`) }
  if (warehouseId)   { params.push(warehouseId);   filters.push(`lot.warehouse_id = $${params.length}`) }
  if (partnerId)     { params.push(partnerId);     filters.push(`sr.partner_id = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  const { rows } = await query(
    `SELECT lot.id, lot.lot_number, lot.raw_material_id, lot.warehouse_id,
            lot.quantity_remaining, lot.unit_cost, lot.expiry_date, lot.status,
            rm.name AS material_name, rm.unit AS material_unit,
            w.name AS warehouse_name
       FROM raw_material_lots lot
       JOIN raw_materials rm ON rm.id = lot.raw_material_id
       JOIN warehouses w     ON w.id = lot.warehouse_id
       LEFT JOIN supplier_receipts sr ON sr.id = lot.supplier_receipt_id
      WHERE lot.tenant_id = $1 AND lot.quantity_remaining > 0
        AND lot.status IN ('active','quarantined','expired') ${where}
      ORDER BY lot.expiry_date NULLS LAST, lot.lot_number`,
    params
  )
  return rows
}

// ─── Lectura ─────────────────────────────────────────────────────────────────
async function listReturns({ tenantId, status, partnerId, from, to, page = 1, limit = 50 }) {
  const params = [tenantId]
  const filters = []
  if (status)    { params.push(status);    filters.push(`r.status = $${params.length}`) }
  if (partnerId) { params.push(partnerId); filters.push(`r.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`r.return_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`r.return_date <= $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  const offset = (page - 1) * limit
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT r.id, r.return_number, r.partner_id, bp.name AS partner_name,
            r.status, r.return_date, r.total_mxn,
            r.fiscal_resolution, r.credit_status,
            rr.name AS reason_name,
            r.created_at
       FROM supplier_returns r
       JOIN business_partners bp ON bp.id = r.partner_id
       LEFT JOIN tenant_return_reasons rr ON rr.id = r.reason_id
      WHERE r.tenant_id = $1 ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  return rows
}

async function getReturn({ tenantId, returnId }) {
  const { rows } = await query(
    `SELECT r.*, bp.name AS partner_name, rr.name AS reason_name
       FROM supplier_returns r
       JOIN business_partners bp ON bp.id = r.partner_id
       LEFT JOIN tenant_return_reasons rr ON rr.id = r.reason_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [returnId, tenantId]
  )
  if (!rows[0]) return null
  const { rows: lines } = await query(
    `SELECT l.*, l.subtotal,
            CASE WHEN l.item_type = 'raw_material'
                 THEN (SELECT name FROM raw_materials WHERE id = l.item_id)
                 ELSE (SELECT name FROM products WHERE id = l.item_id) END AS item_name,
            lot.lot_number, w.name AS warehouse_name
       FROM supplier_return_lines l
       LEFT JOIN raw_material_lots lot ON lot.id = l.raw_material_lot_id
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.return_id = $1
      ORDER BY l.created_at`,
    [returnId]
  )
  return { ...rows[0], lines }
}

// ─── Crear borrador ──────────────────────────────────────────────────────────
async function createReturn({
  tenantId, partnerId, reasonId, sourceReceiptId, supplierInvoiceId,
  returnDate, notes, lines, userId, ipAddress, userAgent,
}) {
  if (!partnerId) throw badReq('El proveedor es requerido.')
  if (!Array.isArray(lines) || lines.length === 0) throw badReq('Agrega al menos una línea a devolver.')

  const newId = await withTransaction(async (client) => {
    // Validar proveedor del tenant.
    const { rows: bp } = await client.query(
      `SELECT id FROM business_partners WHERE id = $1 AND tenant_id = $2`,
      [partnerId, tenantId]
    )
    if (!bp[0]) throw badReq('El proveedor no pertenece a esta empresa.')

    const returnNumber = await nextReturnNumber(client, tenantId)

    // Normalizar/validar líneas (resolver costo y validar lote).
    const normalized = []
    for (const ln of lines) {
      const qty = parseFloat(ln.quantity)
      if (!qty || qty <= 0) throw badReq('Cada línea requiere una cantidad mayor a cero.')
      if (!ln.itemType || !ln.itemId) throw badReq('Cada línea requiere artículo (item_type + item_id).')
      if (!ln.warehouseId) throw badReq('Cada línea requiere almacén.')

      let unitCost = ln.unitCost != null && ln.unitCost !== '' ? parseFloat(ln.unitCost) : null
      let rawMaterialLotId = ln.rawMaterialLotId || null

      if (rawMaterialLotId) {
        const { rows: lot } = await client.query(
          `SELECT id, raw_material_id, warehouse_id, quantity_remaining, unit_cost
             FROM raw_material_lots WHERE id = $1 AND tenant_id = $2`,
          [rawMaterialLotId, tenantId]
        )
        if (!lot[0]) throw badReq('El lote indicado no existe.')
        if (ln.itemType === 'raw_material' && lot[0].raw_material_id !== ln.itemId) {
          throw badReq('El lote no corresponde al material de la línea.')
        }
        if (parseFloat(lot[0].quantity_remaining) + 1e-6 < qty) {
          throw badReq(`No hay suficiente en el lote (disponible ${lot[0].quantity_remaining}).`)
        }
        if (unitCost == null) unitCost = parseFloat(lot[0].unit_cost || 0)
      }

      if (unitCost == null) {
        // Sin lote: tomar el costo promedio del stock del almacén.
        const { rows: st } = await client.query(
          `SELECT avg_cost FROM inventory_stock
            WHERE tenant_id = $1 AND warehouse_id = $2 AND item_type = $3 AND item_id = $4
              AND status = 'available' LIMIT 1`,
          [tenantId, ln.warehouseId, ln.itemType, ln.itemId]
        )
        unitCost = parseFloat(st[0]?.avg_cost || 0)
      }

      normalized.push({
        itemType: ln.itemType, itemId: ln.itemId, warehouseId: ln.warehouseId,
        rawMaterialLotId, quantity: qty, unit: ln.unit || 'kg', unitCost,
        sourceReceiptLineId: ln.sourceReceiptLineId || null,
      })
    }
    const total = normalized.reduce((s, l) => s + Math.round(l.quantity * l.unitCost * 100) / 100, 0)

    const { rows: hdr } = await client.query(
      `INSERT INTO supplier_returns
         (tenant_id, return_number, partner_id, reason_id, source_receipt_id,
          supplier_invoice_id, status, return_date, notes, total_mxn, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',COALESCE($7,CURRENT_DATE),$8,$9,$10)
       RETURNING *`,
      [tenantId, returnNumber, partnerId, reasonId || null, sourceReceiptId || null,
       supplierInvoiceId || null, returnDate || null, notes || null, total.toFixed(2), userId]
    )
    const ret = hdr[0]

    for (const l of normalized) {
      await client.query(
        `INSERT INTO supplier_return_lines
           (return_id, tenant_id, item_type, item_id, warehouse_id, raw_material_lot_id,
            quantity, unit, unit_cost, source_receipt_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [ret.id, tenantId, l.itemType, l.itemId, l.warehouseId, l.rawMaterialLotId,
         l.quantity.toFixed(4), l.unit, l.unitCost.toFixed(6), l.sourceReceiptLineId]
      )
    }

    await audit({
      tenantId, userId, action: 'supplier_return.created', resource: 'supplier_returns',
      resourceId: ret.id, payload: { returnNumber, partnerId, lines: normalized.length, total },
      ipAddress, userAgent,
    })
    return ret.id
  })
  // getReturn usa el pool global → llamarlo FUERA de la transacción (ya commiteada).
  return getReturn({ tenantId, returnId: newId })
}

// ─── Confirmar (mueve inventario) ────────────────────────────────────────────
async function confirmReturn({ tenantId, returnId, userId, ipAddress, userAgent }) {
  await withTransaction(async (client) => {
    const { rows: hdr } = await client.query(
      `SELECT * FROM supplier_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [returnId, tenantId]
    )
    const ret = hdr[0]
    if (!ret) throw notFound('Devolución no encontrada.')
    if (ret.status !== 'draft') throw badReq('Solo se puede confirmar una devolución en borrador.')

    const { rows: lines } = await client.query(
      `SELECT * FROM supplier_return_lines WHERE return_id = $1`, [returnId]
    )
    if (lines.length === 0) throw badReq('La devolución no tiene líneas.')

    for (const l of lines) {
      const qty = parseFloat(l.quantity)
      // Salida de inventario (kardex). validateStock=true: no devuelvas lo que no tienes.
      await recordMovement(client, {
        tenantId, warehouseId: l.warehouse_id, itemType: l.item_type, itemId: l.item_id,
        movementType: 'purchase_return', quantity: -qty, unit: l.unit,
        unitCost: parseFloat(l.unit_cost || 0), statusTo: 'available',
        referenceType: 'supplier_return', referenceId: returnId,
        notes: `Devolución ${ret.return_number}`, createdBy: userId,
        validateStock: true, rawMaterialLotId: l.raw_material_lot_id || null,
      })

      // Decrementar el lote (si aplica).
      if (l.raw_material_lot_id) {
        const { rows: upd } = await client.query(
          `UPDATE raw_material_lots
              SET quantity_remaining = quantity_remaining - $1,
                  status = CASE WHEN quantity_remaining - $1 <= 0 THEN 'depleted' ELSE status END
            WHERE id = $2 AND tenant_id = $3 AND quantity_remaining + 1e-6 >= $1
            RETURNING id`,
          [qty.toFixed(4), l.raw_material_lot_id, tenantId]
        )
        if (!upd[0]) throw badReq('El lote ya no tiene suficiente cantidad para devolver.')
      }
    }

    await client.query(
      `UPDATE supplier_returns SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [returnId]
    )

    await audit({
      tenantId, userId, action: 'supplier_return.confirmed', resource: 'supplier_returns',
      resourceId: returnId, payload: { returnNumber: ret.return_number, total: ret.total_mxn },
      ipAddress, userAgent,
    })
  })
  return getReturn({ tenantId, returnId })
}

// ─── Cancelar (revierte si estaba confirmada) ────────────────────────────────
async function cancelReturn({ tenantId, returnId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: hdr } = await client.query(
      `SELECT * FROM supplier_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [returnId, tenantId]
    )
    const ret = hdr[0]
    if (!ret) throw notFound('Devolución no encontrada.')
    if (ret.status === 'cancelled') throw badReq('La devolución ya está cancelada.')

    if (ret.status === 'confirmed') {
      // Revertir inventario: re-entra el stock y re-incrementa el lote.
      const { rows: lines } = await client.query(
        `SELECT * FROM supplier_return_lines WHERE return_id = $1`, [returnId]
      )
      for (const l of lines) {
        const qty = parseFloat(l.quantity)
        await recordMovement(client, {
          tenantId, warehouseId: l.warehouse_id, itemType: l.item_type, itemId: l.item_id,
          movementType: 'adjustment_in', quantity: qty, unit: l.unit,
          unitCost: parseFloat(l.unit_cost || 0), statusTo: 'available',
          referenceType: 'supplier_return', referenceId: returnId,
          notes: `Reversa de devolución ${ret.return_number}`, createdBy: userId,
          rawMaterialLotId: l.raw_material_lot_id || null,
        })
        if (l.raw_material_lot_id) {
          await client.query(
            `UPDATE raw_material_lots
                SET quantity_remaining = LEAST(quantity_received, quantity_remaining + $1),
                    status = CASE WHEN status = 'depleted' THEN 'active' ELSE status END
              WHERE id = $2 AND tenant_id = $3`,
            [qty.toFixed(4), l.raw_material_lot_id, tenantId]
          )
        }
      }
    }

    const { rows: done } = await client.query(
      `UPDATE supplier_returns SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [returnId]
    )
    await audit({
      tenantId, userId, action: 'supplier_return.cancelled', resource: 'supplier_returns',
      resourceId: returnId, payload: { returnNumber: ret.return_number, wasConfirmed: ret.status === 'confirmed' },
      ipAddress, userAgent,
    })
    return done[0]
  })
}

module.exports = {
  listReasons, createReason, updateReason,
  listReturnableLots,
  listReturns, getReturn, createReturn, confirmReturn, cancelReturn,
}
