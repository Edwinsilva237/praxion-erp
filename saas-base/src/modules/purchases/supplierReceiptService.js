'use strict'

const path = require('path')
const { query, withTransaction } = require('../../db')
const { audit }          = require('../../utils/audit')
const storage            = require('../../utils/storage')
const { recordMovement } = require('../inventory/inventoryService')
const { generate: generateLotNumber } = require('../production/lotNumberGenerator')
const documentSeriesService = require('../document-series/documentSeriesService')
const supplierPriceService = require('./supplierPriceService')

async function nextReceiptNumber(client, tenantId, opts = {}) {
  const result = await documentSeriesService.generateDocumentNumber({
    client, tenantId, entityType: 'supplier_receipt', opts,
  })
  if (result) return result.docNumber

  const ym = new Date().toISOString().slice(0, 7).replace('-', '')
  const prefix = `REC-${ym}-`
  const { rows } = await client.query(
    `SELECT receipt_number FROM supplier_receipts
     WHERE tenant_id = $1 AND receipt_number LIKE $2
     ORDER BY receipt_number DESC LIMIT 1`,
    [tenantId, `${prefix}%`]
  )
  const last = rows[0]?.receipt_number
  const seq = last ? parseInt(last.split('-')[2], 10) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

async function listReceipts({
  tenantId, status, partnerId, purchaseOrderId,
  search, warehouseId, hasEvidence, from, to, page = 1, limit = 50,
}) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (status)          { params.push(status);          filters.push(`sr.status = $${params.length}`) }
  if (partnerId)       { params.push(partnerId);       filters.push(`sr.partner_id = $${params.length}`) }
  if (purchaseOrderId) { params.push(purchaseOrderId); filters.push(`sr.purchase_order_id = $${params.length}`) }
  if (warehouseId)     { params.push(warehouseId);     filters.push(`sr.warehouse_id = $${params.length}`) }
  if (from)            { params.push(from);            filters.push(`sr.received_date >= $${params.length}`) }
  if (to)              { params.push(to);              filters.push(`sr.received_date <= $${params.length}`) }
  if (hasEvidence === 'yes')  filters.push(`sr.evidence_path IS NOT NULL`)
  if (hasEvidence === 'no')   filters.push(`sr.evidence_path IS NULL`)
  if (search) {
    params.push(`%${search}%`)
    const sN = params.length
    filters.push(`(sr.receipt_number ILIKE $${sN} OR bp.name ILIKE $${sN} OR sr.document_number ILIKE $${sN})`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT sr.id, sr.receipt_number, sr.status, sr.received_date,
            sr.generic_supplier, sr.notes,
            sr.document_type, sr.document_number,
            sr.confirmed_at,
            CASE WHEN sr.evidence_path IS NOT NULL THEN sr.evidence_filename ELSE NULL END AS evidence_filename,
            po.order_number  AS purchase_order_number,
            bp.name          AS partner_name,
            w.name           AS warehouse_name,
            u.full_name      AS created_by_name,
            cb.full_name     AS confirmed_by_name,
            COUNT(srl.id)    AS line_count,
            COALESCE(SUM(srl.subtotal), 0) AS total_mxn
     FROM supplier_receipts sr
     LEFT JOIN purchase_orders    po  ON po.id  = sr.purchase_order_id
     LEFT JOIN business_partners  bp  ON bp.id  = sr.partner_id
     LEFT JOIN warehouses         w   ON w.id   = sr.warehouse_id
     LEFT JOIN users              u   ON u.id   = sr.created_by
     LEFT JOIN users              cb  ON cb.id  = sr.confirmed_by
     LEFT JOIN supplier_receipt_lines srl ON srl.supplier_receipt_id = sr.id
     WHERE sr.tenant_id = $1 ${where}
     GROUP BY sr.id, po.id, bp.id, w.id, u.id, cb.id
     ORDER BY sr.received_date DESC, sr.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(DISTINCT sr.id)
     FROM supplier_receipts sr
     LEFT JOIN business_partners bp ON bp.id = sr.partner_id
     WHERE sr.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getReceipt({ tenantId, receiptId }) {
  const { rows } = await query(
    `SELECT sr.*,
            po.order_number  AS purchase_order_number,
            bp.name AS partner_name, bp.rfc,
            w.name  AS warehouse_name,
            u.full_name  AS created_by_name,
            cb.full_name AS confirmed_by_name
     FROM supplier_receipts sr
     LEFT JOIN purchase_orders    po ON po.id  = sr.purchase_order_id
     LEFT JOIN business_partners  bp ON bp.id  = sr.partner_id
     LEFT JOIN warehouses         w  ON w.id   = sr.warehouse_id
     LEFT JOIN users              u  ON u.id   = sr.created_by
     LEFT JOIN users              cb ON cb.id  = sr.confirmed_by
     WHERE sr.id = $1 AND sr.tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (rows.length === 0) return null

  const { rows: lines } = await query(
    `SELECT srl.*,
            COALESCE(rm.name, pt.name)       AS item_name,
            COALESCE(rm.unit, pt.sale_unit)  AS item_unit,
            pol.quantity   AS ordered_qty,
            pol.unit_price AS ordered_price,
            w.name         AS warehouse_name
     FROM supplier_receipt_lines srl
     LEFT JOIN purchase_order_lines pol ON pol.id  = srl.purchase_order_line_id
     LEFT JOIN raw_materials        rm  ON rm.id   = srl.item_id AND srl.item_type = 'raw_material'
     LEFT JOIN products             pt  ON pt.id   = srl.item_id AND srl.item_type = 'product'
     LEFT JOIN warehouses           w   ON w.id    = srl.warehouse_id
     WHERE srl.supplier_receipt_id = $1
     ORDER BY srl.line_number`,
    [receiptId]
  )

  return { ...rows[0], lines }
}

async function createReceipt({
  tenantId, purchaseOrderId, partnerId, genericSupplier,
  warehouseId, receivedDate, documentType, documentNumber,
  lines = [], notes, userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    if (!warehouseId) throw createError(400, 'warehouseId es requerido.')
    if (lines.length === 0) throw createError(400, 'Se requiere al menos una linea.')

    // SaaS v2: si el tenant usa lotes, se creará un raw_material_lot por cada
    // línea de tipo raw_material. Se lee la config aquí para no hacer N queries.
    const { rows: cfgRows } = await client.query(
      `SELECT uses_lots, uses_expiry, lot_number_pattern
       FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    const cfg = cfgRows[0] || { uses_lots: false, uses_expiry: false, lot_number_pattern: null }

    let resolvedPartnerId = partnerId
    let resolvedGenericSupplier = genericSupplier

    if (purchaseOrderId) {
      const { rows: po } = await client.query(
        `SELECT partner_id, generic_supplier, is_generic
         FROM purchase_orders WHERE id = $1 AND tenant_id = $2`,
        [purchaseOrderId, tenantId]
      )
      if (po.length === 0) throw createError(404, 'OC no encontrada.')
      if (po[0].is_generic) {
        resolvedGenericSupplier = resolvedGenericSupplier || po[0].generic_supplier
      } else {
        resolvedPartnerId = resolvedPartnerId || po[0].partner_id
      }
    }

    const receiptNumber = await nextReceiptNumber(client, tenantId)

    const { rows } = await client.query(
      `INSERT INTO supplier_receipts
         (tenant_id, receipt_number, purchase_order_id, partner_id, generic_supplier,
          warehouse_id, received_date, document_type, document_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, receiptNumber, purchaseOrderId || null,
       resolvedPartnerId || null, resolvedGenericSupplier || null,
       warehouseId,
       receivedDate || new Date().toISOString().split('T')[0],
       documentType || null, documentNumber || null,
       notes || null, userId]
    )
    const receipt = rows[0]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const { rows: lineRows } = await client.query(
        `INSERT INTO supplier_receipt_lines
           (supplier_receipt_id, purchase_order_line_id, item_type, item_id,
            description, quantity_received, unit, unit_price,
            warehouse_id, is_generic, generic_category, line_number, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [receipt.id,
         line.purchaseOrderLineId || null,
         line.itemType || null, line.itemId || null,
         line.description || null,
         Math.round(parseFloat(line.quantityReceived) * 10000) / 10000,
         line.unit || 'kg', line.unitPrice || 0,
         line.warehouseId || warehouseId,
         line.isGeneric || false, line.genericCategory || null,
         i + 1, line.notes || null]
      )
      const lineId = lineRows[0].id

      // SaaS v2 §4.3.1: crear raw_material_lot si aplica.
      //   - Solo para items tipo raw_material (no genéricos / servicios).
      //   - Solo si el tenant tiene uses_lots=true.
      //   - lot_number lo da el usuario (line.lotNumber) o se autogenera.
      //   - expiry_date solo si uses_expiry=true.
      if (cfg.uses_lots && line.itemType === 'raw_material' && line.itemId && !line.isGeneric) {
        const qty = Math.round(parseFloat(line.quantityReceived) * 10000) / 10000
        if (qty > 0) {
          // Auto-generar lot_number si no vino del cliente.
          let lotNumber = (line.lotNumber || '').trim()
          if (!lotNumber) {
            const { rows: rmRows } = await client.query(
              `SELECT sku FROM raw_materials WHERE id = $1`, [line.itemId]
            )
            const pattern = cfg.lot_number_pattern || '{YYYY}{MM}{DD}-{SKU}-{SEQ}'
            // Secuencia diaria por MP (cuántos lotes ya hay hoy para esta MP)
            const { rows: seqRows } = await client.query(
              `SELECT COUNT(*)::int AS n FROM raw_material_lots
               WHERE raw_material_id = $1 AND DATE(received_at) = CURRENT_DATE`,
              [line.itemId]
            )
            lotNumber = generateLotNumber(pattern, {
              date: receivedDate || new Date(),
              sku:  rmRows[0]?.sku || 'MP',
              seq:  (seqRows[0]?.n || 0) + 1,
            })
          }

          await client.query(
            `INSERT INTO raw_material_lots
               (tenant_id, raw_material_id, lot_number, manufacturer_lot,
                manufacture_date, expiry_date, best_before_date, received_at,
                supplier_id, supplier_receipt_id, supplier_receipt_line_id,
                warehouse_id, quantity_received, quantity_remaining,
                unit_cost, total_cost, created_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12,$12,$13,$14,$15)
             ON CONFLICT (raw_material_id, lot_number) DO NOTHING`,
            [tenantId, line.itemId, lotNumber,
             line.manufacturerLot || null,
             line.manufactureDate || null,
             cfg.uses_expiry ? (line.expiryDate || null) : null,
             cfg.uses_expiry ? (line.bestBeforeDate || null) : null,
             resolvedPartnerId || null, receipt.id, lineId,
             line.warehouseId || warehouseId,
             qty,
             parseFloat(line.unitPrice || 0),
             parseFloat(line.unitPrice || 0) * qty,
             userId]
          )
        }
      }
    }

    await audit({
      tenantId, userId, action: 'supplier_receipt.created',
      resource: 'supplier_receipts', resourceId: receipt.id,
      payload: { receiptNumber, purchaseOrderId, partnerId: resolvedPartnerId },
      ipAddress, userAgent,
    })

    return receipt
  })
}

async function uploadEvidence({ tenantId, receiptId, buffer, originalname, mimetype, userId }) {
  // Verificar que la recepción existe y pertenece al tenant
  const { rows } = await query(
    `SELECT id, evidence_path FROM supplier_receipts WHERE id = $1 AND tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Recepción no encontrada.')

  // Si ya tenía evidencia anterior, borrar el objeto previo (best-effort).
  if (rows[0].evidence_path) {
    await storage.remove(rows[0].evidence_path)
  }

  // Usamos forward slash en el key — R2 lo respeta y en modo disco
  // storage.put resuelve con path.join al normalizar.
  const ext = path.extname(originalname || '.jpg') || '.jpg'
  const key = `receipts/${tenantId}/${receiptId}${ext}`
  await storage.put(key, buffer, { contentType: mimetype })

  await query(
    `UPDATE supplier_receipts
     SET evidence_path = $1, evidence_filename = $2, evidence_mimetype = $3
     WHERE id = $4 AND tenant_id = $5`,
    [key, originalname, mimetype, receiptId, tenantId]
  )

  return { evidencePath: key, evidenceFilename: originalname }
}

async function getEvidenceFile({ tenantId, receiptId }) {
  const { rows } = await query(
    `SELECT evidence_path, evidence_filename, evidence_mimetype
     FROM supplier_receipts WHERE id = $1 AND tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (rows.length === 0 || !rows[0].evidence_path) return null

  return {
    storagePath: rows[0].evidence_path,
    filename:    rows[0].evidence_filename,
    mimetype:    rows[0].evidence_mimetype || 'application/octet-stream',
  }
}

async function confirmReceipt({ tenantId, receiptId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: receiptRows } = await client.query(
      `SELECT * FROM supplier_receipts WHERE id = $1 AND tenant_id = $2 AND status = 'draft'`,
      [receiptId, tenantId]
    )
    if (receiptRows.length === 0) throw createError(404, 'Recepcion no encontrada o ya confirmada.')
    const receipt = receiptRows[0]

    const { rows: lines } = await client.query(
      `SELECT * FROM supplier_receipt_lines WHERE supplier_receipt_id = $1`,
      [receiptId]
    )
    if (lines.length === 0) throw createError(400, 'La recepcion no tiene lineas.')

    for (const line of lines) {
      if (!line.item_id || !line.item_type) continue

      await recordMovement(client, {
        tenantId,
        warehouseId:   line.warehouse_id,
        itemType:      line.item_type,
        itemId:        line.item_id,
        movementType:  'purchase_entry',
        quantity:      parseFloat(line.quantity_received),
        unit:          line.unit || 'kg',
        unitCost:      parseFloat(line.unit_price || 0),
        statusTo:      'available',
        referenceType: 'supplier_receipt',
        referenceId:   receiptId,
        notes:         `Recepción ${receipt.receipt_number}`,
        createdBy:     userId,
      })

      if (line.unit_price > 0 && line.item_type === 'raw_material' && receipt.partner_id) {
        try {
          await client.query('SAVEPOINT sp_supplier_materials')
          await client.query(
            `UPDATE supplier_materials SET unit_price = $1, updated_at = NOW()
             WHERE tenant_id = $2 AND business_partner_id = $3 AND raw_material_id = $4`,
            [line.unit_price, tenantId, receipt.partner_id, line.item_id]
          )
          await client.query('RELEASE SAVEPOINT sp_supplier_materials')
        } catch (_e) {
          await client.query('ROLLBACK TO SAVEPOINT sp_supplier_materials')
        }
      }
    }

    // Aprender el precio REAL recibido (source='receipt') → corrige el precio
    // aprendido de la OC con lo que de verdad llegó. La línea de la recepción ya
    // trae item_type/item_id/unit_price. Best-effort, dentro de la transacción.
    if (receipt.partner_id) {
      await supplierPriceService.learnFromLines(client, {
        tenantId, supplierId: receipt.partner_id,
        currency: receipt.currency || 'MXN', source: 'receipt', userId,
        lines: lines.map(l => ({
          itemType: l.item_type, itemId: l.item_id,
          unitPrice: l.unit_price, isGeneric: l.is_generic,
        })),
      })
    }

    const { rows } = await client.query(
      `UPDATE supplier_receipts
       SET status = 'confirmed', confirmed_by = $1, confirmed_at = NOW()
       WHERE id = $2 RETURNING *`,
      [userId, receiptId]
    )

    if (receipt.purchase_order_id) {
      await updatePurchaseOrderStatus(client, tenantId, receipt.purchase_order_id)
    }

    await audit({
      tenantId, userId, action: 'supplier_receipt.confirmed',
      resource: 'supplier_receipts', resourceId: receiptId,
      payload: { receiptNumber: receipt.receipt_number, linesCount: lines.length },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function cancelReceipt({ tenantId, receiptId, reason, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `UPDATE supplier_receipts SET status = 'cancelled'
     WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
     RETURNING id, receipt_number`,
    [receiptId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Recepcion no encontrada o no se puede cancelar.')

  await audit({
    tenantId, userId, action: 'supplier_receipt.cancelled',
    resource: 'supplier_receipts', resourceId: receiptId,
    payload: { reason }, ipAddress, userAgent,
  })

  return rows[0]
}

async function updatePurchaseOrderStatus(client, tenantId, purchaseOrderId) {
  const { rows: poTotals } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS total_ordered
     FROM purchase_order_lines WHERE purchase_order_id = $1`,
    [purchaseOrderId]
  )
  if (!poTotals.length || parseFloat(poTotals[0].total_ordered) === 0) return

  const { rows: recTotals } = await client.query(
    `SELECT COALESCE(SUM(srl.quantity_received), 0) AS total_received
     FROM supplier_receipt_lines srl
     JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
     WHERE sr.purchase_order_id = $1
       AND sr.tenant_id = $2
       AND sr.status = 'confirmed'`,
    [purchaseOrderId, tenantId]
  )

  const totalOrdered  = parseFloat(poTotals[0].total_ordered)
  const totalReceived = parseFloat(recTotals[0].total_received)
  const newStatus     = totalReceived >= totalOrdered ? 'received'
                      : totalReceived > 0             ? 'partially_received'
                      :                                 'sent'

  await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE id = $2 AND tenant_id = $3`,
    [newStatus, purchaseOrderId, tenantId]
  )
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listReceipts, getReceipt,
  createReceipt, confirmReceipt, cancelReceipt,
  uploadEvidence, getEvidenceFile,
}
