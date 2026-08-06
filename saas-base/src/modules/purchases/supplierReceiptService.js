'use strict'

const path = require('path')
const { query, withTransaction } = require('../../db')
const { audit }          = require('../../utils/audit')
const storage            = require('../../utils/storage')
const { recordMovement } = require('../inventory/inventoryService')
const pushEvents = require('../push/pushEvents')
const { generate: generateLotNumber } = require('../production/lotNumberGenerator')
const documentSeriesService = require('../document-series/documentSeriesService')
const supplierPriceService = require('./supplierPriceService')
const { buildOrderBy } = require('../../utils/sortOrder')

const RECEIPT_SORT_COLUMNS = {
  folio:     'sr.receipt_number',
  fecha:     'sr.created_at',
  proveedor: 'bp.name',
  estatus:   'sr.status',
}

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
  search, warehouseId, hasEvidence, invoiceStatus, from, to, sortBy, sortDir, page = 1, limit = 50,
}) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  const orderBy = buildOrderBy({ sortBy, sortDir, columns: RECEIPT_SORT_COLUMNS, defaultKey: 'fecha', tiebreaker: 'sr.id DESC' })

  if (status)          { params.push(status);          filters.push(`sr.status = $${params.length}`) }
  if (partnerId)       { params.push(partnerId);       filters.push(`sr.partner_id = $${params.length}`) }
  if (purchaseOrderId) { params.push(purchaseOrderId); filters.push(`sr.purchase_order_id = $${params.length}`) }
  if (warehouseId)     { params.push(warehouseId);     filters.push(`sr.warehouse_id = $${params.length}`) }
  if (from)            { params.push(from);            filters.push(`sr.received_date >= $${params.length}`) }
  if (to)              { params.push(to);              filters.push(`sr.received_date <= $${params.length}`) }
  if (hasEvidence === 'yes')  filters.push(`sr.evidence_path IS NOT NULL`)
  if (hasEvidence === 'no')   filters.push(`sr.evidence_path IS NULL`)
  // Estado de facturación. `invoiced_at` (lo setea registerInvoice/remisión SOLO
  // cuando TODAS las líneas quedan cubiertas) es la verdad para "totalmente
  // facturada". El estado PARCIAL (algunas líneas con factura REAL, otras no) se
  // deriva por línea: invoiced_at sigue NULL pero existe ≥1 línea facturada.
  const REAL_INVOICED_LINE = `EXISTS (
    SELECT 1 FROM supplier_receipt_lines srl2
      JOIN supplier_invoices ci2 ON ci2.id = srl2.invoiced_by_invoice_id
     WHERE srl2.supplier_receipt_id = sr.id
       AND ci2.status <> 'cancelled' AND ci2.type = 'invoice')`
  // Las reposiciones de devolución no esperan factura (la vigente es la
  // original) → no cuentan como "sin factura".
  if (invoiceStatus === 'pending')  filters.push(`sr.invoiced_at IS NULL AND sr.replacement_return_id IS NULL AND NOT ${REAL_INVOICED_LINE}`)
  if (invoiceStatus === 'partial')  filters.push(`sr.status = 'confirmed' AND sr.invoiced_at IS NULL AND ${REAL_INVOICED_LINE}`)
  if (invoiceStatus === 'invoiced') filters.push(`sr.invoiced_at IS NOT NULL`)
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
            sr.confirmed_at, sr.invoiced_at,
            -- Folio de la factura de proveedor ligada (la más reciente NO cancelada).
            -- La liga N:N vive en invoice_receipt_links; el folio es invoice_number.
            (SELECT si.invoice_number
               FROM invoice_receipt_links irl
               JOIN supplier_invoices si
                 ON si.id = irl.supplier_invoice_id AND si.status <> 'cancelled'
              WHERE irl.supplier_receipt_id = sr.id
              ORDER BY si.created_at DESC LIMIT 1) AS invoice_number,
            -- Tipo del documento ligado: 'remission' = CXP sin factura (Fase 2),
            -- 'invoice' = factura fiscal. Para distinguir el chip en la lista.
            (SELECT si.type
               FROM invoice_receipt_links irl
               JOIN supplier_invoices si
                 ON si.id = irl.supplier_invoice_id AND si.status <> 'cancelled'
              WHERE irl.supplier_receipt_id = sr.id
              ORDER BY si.created_at DESC LIMIT 1) AS invoice_type,
            CASE WHEN sr.evidence_path IS NOT NULL THEN sr.evidence_filename ELSE NULL END AS evidence_filename,
            po.order_number  AS purchase_order_number,
            sr.replacement_return_id,
            rret.return_number AS replacement_return_number,
            bp.name          AS partner_name,
            w.name           AS warehouse_name,
            u.full_name      AS created_by_name,
            cb.full_name     AS confirmed_by_name,
            COUNT(srl.id)    AS line_count,
            -- Líneas cubiertas por una factura REAL y activa (type='invoice'):
            -- si 0 < esto < line_count y la recepción NO está totalmente facturada
            -- (invoiced_at NULL) → estado "parcialmente facturado" (chip ámbar).
            COUNT(srl.id) FILTER (
              WHERE srl.invoiced_by_invoice_id IS NOT NULL
                AND cil.status <> 'cancelled' AND cil.type = 'invoice'
            ) AS invoiced_line_count,
            COALESCE(SUM(srl.subtotal), 0) AS total_mxn
     FROM supplier_receipts sr
     LEFT JOIN purchase_orders    po  ON po.id  = sr.purchase_order_id
     LEFT JOIN supplier_returns   rret ON rret.id = sr.replacement_return_id
     LEFT JOIN business_partners  bp  ON bp.id  = sr.partner_id
     LEFT JOIN warehouses         w   ON w.id   = sr.warehouse_id
     LEFT JOIN users              u   ON u.id   = sr.created_by
     LEFT JOIN users              cb  ON cb.id  = sr.confirmed_by
     LEFT JOIN supplier_receipt_lines srl ON srl.supplier_receipt_id = sr.id
     LEFT JOIN supplier_invoices    cil ON cil.id = srl.invoiced_by_invoice_id
     WHERE sr.tenant_id = $1 ${where}
     GROUP BY sr.id, po.id, rret.id, bp.id, w.id, u.id, cb.id
     ORDER BY ${orderBy}
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

  // Los COUNT de PG llegan como string (bigint) → a número para el chip "3/5".
  const data = rows.map(r => ({
    ...r,
    line_count: parseInt(r.line_count, 10),
    invoiced_line_count: parseInt(r.invoiced_line_count, 10),
  }))
  return { data, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getReceipt({ tenantId, receiptId }) {
  const { rows } = await query(
    `SELECT sr.*,
            po.order_number  AS purchase_order_number,
            -- Reposición: devolución ligada + su traza de origen (auditoría).
            rret.return_number AS replacement_return_number,
            rret.total_mxn     AS replacement_return_total,
            rrr.name           AS replacement_return_reason,
            rorig.invoice_number AS replacement_source_invoice_number,
            bp.name AS partner_name, bp.rfc,
            w.name  AS warehouse_name,
            -- Cobertura por MONTO: subtotal total de la recepción vs lo ya cubierto por
            -- facturas REALES activas (permite ver el saldo cuando 2+ facturas dividen
            -- el mismo material). remaining = receipt_subtotal - invoiced_amount.
            COALESCE((SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                       WHERE srl.supplier_receipt_id = sr.id), 0)::numeric AS receipt_subtotal,
            COALESCE((SELECT SUM(irl.amount_applied) FROM invoice_receipt_links irl
                        JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
                       WHERE irl.supplier_receipt_id = sr.id
                         AND si.status <> 'cancelled' AND si.type = 'invoice'), 0)::numeric AS invoiced_amount,
            u.full_name  AS created_by_name,
            cb.full_name AS confirmed_by_name
     FROM supplier_receipts sr
     LEFT JOIN purchase_orders    po ON po.id  = sr.purchase_order_id
     LEFT JOIN supplier_returns   rret ON rret.id = sr.replacement_return_id
     LEFT JOIN tenant_return_reasons rrr ON rrr.id = rret.reason_id
     LEFT JOIN supplier_invoices  rorig ON rorig.id = rret.supplier_invoice_id
     LEFT JOIN business_partners  bp ON bp.id  = sr.partner_id
     LEFT JOIN warehouses         w  ON w.id   = sr.warehouse_id
     LEFT JOIN users              u  ON u.id   = sr.created_by
     LEFT JOIN users              cb ON cb.id  = sr.confirmed_by
     WHERE sr.id = $1 AND sr.tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (rows.length === 0) return null

  // Reposición: recepciones/lotes ORIGINALES de la devolución (cadena de
  // auditoría: esta recepción → DEV → lo devuelto y de dónde venía).
  let replacementOrigin = null
  if (rows[0].replacement_return_id) {
    const { rows: origin } = await query(
      `SELECT l.id, l.quantity, l.unit, l.unit_cost,
              CASE WHEN l.item_type = 'raw_material'
                   THEN (SELECT name FROM raw_materials WHERE id = l.item_id)
                   ELSE (SELECT name FROM products WHERE id = l.item_id) END AS item_name,
              lot.lot_number AS original_lot,
              srcr.receipt_number AS source_receipt_number
         FROM supplier_return_lines l
         LEFT JOIN raw_material_lots lot ON lot.id = l.raw_material_lot_id
         LEFT JOIN supplier_receipt_lines srcl ON srcl.id = l.source_receipt_line_id
         LEFT JOIN supplier_receipts srcr ON srcr.id = srcl.supplier_receipt_id
        WHERE l.return_id = $1
        ORDER BY l.created_at`,
      [rows[0].replacement_return_id]
    )
    replacementOrigin = origin
  }

  const { rows: lines } = await query(
    `SELECT srl.*,
            COALESCE(rm.name, pt.name)       AS item_name,
            COALESCE(rm.unit, pt.sale_unit)  AS item_unit,
            pol.quantity   AS ordered_qty,
            pol.unit_price AS ordered_price,
            w.name         AS warehouse_name,
            rl.lot_number       AS lot_number,
            rl.manufacturer_lot AS manufacturer_lot,
            rl.expiry_date      AS lot_expiry_date,
            -- Estado de facturación de la línea (mig 202). Una línea está realmente
            -- facturada solo si su factura ligada es REAL (type='invoice') y activa.
            -- Si está NULL, cancelada, o es una remisión-CXP, la línea sigue
            -- PENDIENTE (re-facturable) → invoice_pending = true.
            ci.status         AS invoiced_status,
            ci.type           AS invoiced_type,
            ci.invoice_number AS invoiced_number,
            (srl.invoiced_by_invoice_id IS NULL
              OR ci.status = 'cancelled'
              OR ci.type = 'remission') AS invoice_pending
     FROM supplier_receipt_lines srl
     LEFT JOIN purchase_order_lines pol ON pol.id  = srl.purchase_order_line_id
     LEFT JOIN raw_materials        rm  ON rm.id   = srl.item_id AND srl.item_type = 'raw_material'
     LEFT JOIN products             pt  ON pt.id   = srl.item_id AND srl.item_type = 'product'
     LEFT JOIN warehouses           w   ON w.id    = srl.warehouse_id
     LEFT JOIN raw_material_lots    rl  ON rl.supplier_receipt_line_id = srl.id
     LEFT JOIN supplier_invoices    ci  ON ci.id   = srl.invoiced_by_invoice_id
     WHERE srl.supplier_receipt_id = $1
     ORDER BY srl.line_number`,
    [receiptId]
  )

  return { ...rows[0], lines, replacement_origin: replacementOrigin }
}

// Inserta las líneas de una recepción y, si el tenant usa lotes, crea un
// raw_material_lot por cada línea de MP. Compartido por createReceipt y
// updateReceipt (al editar un borrador se borran las líneas/lotes viejos y se
// re-insertan con esto, para no divergir la lógica).
async function insertReceiptLinesAndLots(client, {
  tenantId, receiptId, warehouseId, resolvedPartnerId, receivedDate, cfg, lines, userId,
}) {
  let lineNumber = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const qtyReceived = Math.round(parseFloat(line.quantityReceived) * 10000) / 10000
    // La tabla exige quantity_received > 0 (constraint srl_qty_positive). Saltamos
    // líneas en 0 / negativo / NaN en vez de reventar con 500 — pasaba al editar una
    // recepción que ya tenía una línea recibida en 0 (dato viejo previo a la restricción).
    if (!(qtyReceived > 0)) continue
    lineNumber++
    const { rows: lineRows } = await client.query(
      `INSERT INTO supplier_receipt_lines
         (supplier_receipt_id, purchase_order_line_id, item_type, item_id,
          description, quantity_received, unit, unit_price,
          warehouse_id, is_generic, generic_category, line_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [receiptId,
       line.purchaseOrderLineId || null,
       line.itemType || null, line.itemId || null,
       line.description || null,
       qtyReceived,
       line.unit || 'kg', line.unitPrice || 0,
       line.warehouseId || warehouseId,
       line.isGeneric || false, line.genericCategory || null,
       lineNumber, line.notes || null]
    )
    const lineId = lineRows[0].id

    // SaaS v2 §4.3.1: crear raw_material_lot si aplica.
    //   - Solo para items tipo raw_material (no genéricos / servicios).
    //   - Solo si el tenant tiene uses_lots=true.
    //   - lot_number lo da el usuario (line.lotNumber) o se autogenera.
    //   - expiry_date solo si uses_expiry=true.
    if (cfg.uses_lots && line.itemType === 'raw_material' && line.itemId && !line.isGeneric) {
      const qty = qtyReceived
      if (qty > 0) {
        // Auto-generar lot_number si no vino del cliente.
        let lotNumber = (line.lotNumber || '').trim()
        if (!lotNumber) {
          const { rows: rmRows } = await client.query(
            `SELECT code FROM raw_materials WHERE id = $1`, [line.itemId]
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
            sku:  rmRows[0]?.code || 'MP',
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
           resolvedPartnerId || null, receiptId, lineId,
           line.warehouseId || warehouseId,
           qty,
           parseFloat(line.unitPrice || 0),
           parseFloat(line.unitPrice || 0) * qty,
           userId]
        )
      }
    }
  }
}

// Bloquea editar/cancelar un borrador si algún lote ya fue consumido. Los lotes
// de la recepción se crean YA en borrador y FEFO/FIFO los puede consumir aunque
// la recepción no se haya confirmado; si quantity_remaining < quantity_received
// el lote ya alimentó producción → deshacer corrompería inventario.
async function assertReceiptLotsUntouched(client, tenantId, receiptId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS consumed
       FROM raw_material_lots
      WHERE tenant_id = $1 AND supplier_receipt_id = $2
        AND quantity_remaining < quantity_received - 0.0001`,
    [tenantId, receiptId]
  )
  if (rows[0].consumed > 0) {
    throw createError(409, 'No se puede editar/cancelar: ya se consumió material de los lotes de esta recepción.')
  }
}

// ─── Candado de almacén contra la OC (2026-08-01) ────────────────────────────
// La OC define el almacén destino por renglón desde que se captura; recibir en
// otro almacén descuadraba el inventario (entradas repartidas entre bodegas por
// descuido). Regla: cada línea ligada a un renglón de OC debe entrar al almacén
// de ese renglón. `warehouseOverride:true` (la ruta ya validó el permiso
// warehouses:update) permite la excepción consciente y queda auditada.
async function assertWarehouseMatchesOC(client, {
  tenantId, purchaseOrderId, headerWarehouseId, lines, warehouseOverride,
}) {
  const { rows: polRows } = await client.query(
    `SELECT pol.id, pol.warehouse_id, w.name AS warehouse_name
       FROM purchase_order_lines pol
       LEFT JOIN warehouses w ON w.id = pol.warehouse_id
      WHERE pol.purchase_order_id = $1`,
    [purchaseOrderId]
  )
  const byId = new Map(polRows.map(l => [l.id, l]))
  const mismatches = []
  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue
    const ocLine = byId.get(line.purchaseOrderLineId)
    if (!ocLine || !ocLine.warehouse_id) continue  // línea genérica sin almacén en la OC
    const effective = line.warehouseId || headerWarehouseId
    if (effective !== ocLine.warehouse_id) mismatches.push(ocLine)
  }
  if (mismatches.length === 0) return { warehouseOverridden: false }
  if (warehouseOverride) {
    return {
      warehouseOverridden: true,
      ocWarehouses: [...new Set(mismatches.map(m => m.warehouse_name).filter(Boolean))],
    }
  }
  const names = [...new Set(mismatches.map(m => m.warehouse_name).filter(Boolean))]
  throw createError(409,
    `La OC destina esta mercancía al almacén "${names.join('" / "') || 'definido en la OC'}" y la recepción intenta entrar a otro. ` +
    'Recibe en el almacén que indica la OC; si de verdad debe entrar a otra bodega, un usuario con permiso de administrar almacenes puede cambiarlo, o recibe conforme a la OC y haz un traspaso.')
}

async function createReceipt({
  tenantId, purchaseOrderId, replacementReturnId, partnerId, genericSupplier,
  warehouseId, receivedDate, documentType, documentNumber, warehouseOverride,
  lines = [], notes, userId, ipAddress, userAgent,
}) {
  const receipt = await withTransaction(async (client) => {
    if (!warehouseId) throw createError(400, 'warehouseId es requerido.')
    if (lines.length === 0) throw createError(400, 'Se requiere al menos una linea.')
    if (purchaseOrderId && replacementReturnId) {
      throw createError(400, 'Una recepción es contra una OC o contra una devolución (reposición), no ambas.')
    }

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
    let ocWarehouseCheck = null

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
      ocWarehouseCheck = await assertWarehouseMatchesOC(client, {
        tenantId, purchaseOrderId, headerWarehouseId: warehouseId,
        lines, warehouseOverride: warehouseOverride === true,
      })
    }

    // Reposición en especie (mig 240): la recepción se registra CONTRA una
    // devolución confirmada que espera reposición. El proveedor es el de la
    // devolución; la recepción NO espera factura (la vigente es la original).
    if (replacementReturnId) {
      const { rows: ret } = await client.query(
        `SELECT id, return_number, partner_id, status, replacement_expected, replacement_completed_at
           FROM supplier_returns WHERE id = $1 AND tenant_id = $2`,
        [replacementReturnId, tenantId]
      )
      if (!ret[0]) throw createError(404, 'Devolución no encontrada.')
      if (ret[0].status !== 'confirmed') {
        throw createError(400, 'Solo se puede recibir la reposición de una devolución CONFIRMADA.')
      }
      if (!ret[0].replacement_expected) {
        throw createError(400, `La devolución ${ret[0].return_number} no está marcada como "espera reposición".`)
      }
      if (ret[0].replacement_completed_at) {
        throw createError(409, `La reposición de ${ret[0].return_number} ya fue recibida por completo.`)
      }
      resolvedPartnerId = ret[0].partner_id
    }

    const receiptNumber = await nextReceiptNumber(client, tenantId)

    const { rows } = await client.query(
      `INSERT INTO supplier_receipts
         (tenant_id, receipt_number, purchase_order_id, replacement_return_id,
          partner_id, generic_supplier,
          warehouse_id, received_date, document_type, document_number, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [tenantId, receiptNumber, purchaseOrderId || null, replacementReturnId || null,
       resolvedPartnerId || null, resolvedGenericSupplier || null,
       warehouseId,
       receivedDate || new Date().toISOString().split('T')[0],
       documentType || null, documentNumber || null,
       notes || null, userId]
    )
    const receipt = rows[0]

    await insertReceiptLinesAndLots(client, {
      tenantId, receiptId: receipt.id, warehouseId, resolvedPartnerId,
      receivedDate, cfg, lines, userId,
    })

    await audit({
      tenantId, userId, action: 'supplier_receipt.created',
      resource: 'supplier_receipts', resourceId: receipt.id,
      payload: { receiptNumber, purchaseOrderId, partnerId: resolvedPartnerId,
                 ...(ocWarehouseCheck?.warehouseOverridden
                   ? { warehouseOverridden: true, ocWarehouses: ocWarehouseCheck.ocWarehouses } : {}) },
      ipAddress, userAgent,
    })

    return receipt
  })

  return receipt
}

// Edita una recepción EN BORRADOR: reemplaza por completo sus líneas (y lotes)
// y los campos del encabezado editables. La OC y el proveedor NO cambian (si la
// OC está mal, cancela y crea otra). No toca recepciones confirmadas/canceladas.
async function updateReceipt({
  tenantId, receiptId, warehouseId, receivedDate,
  documentType, documentNumber, warehouseOverride, lines = [], notes,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    const { rows: rRows } = await client.query(
      `SELECT * FROM supplier_receipts WHERE id = $1 AND tenant_id = $2`,
      [receiptId, tenantId]
    )
    if (rRows.length === 0) throw createError(404, 'Recepción no encontrada.')
    const receipt = rRows[0]
    if (receipt.status !== 'draft') throw createError(409, 'Solo se puede editar una recepción en borrador.')
    if (!warehouseId) throw createError(400, 'warehouseId es requerido.')
    if (lines.length === 0) throw createError(400, 'Se requiere al menos una línea.')

    let ocWarehouseCheck = null
    if (receipt.purchase_order_id) {
      ocWarehouseCheck = await assertWarehouseMatchesOC(client, {
        tenantId, purchaseOrderId: receipt.purchase_order_id,
        headerWarehouseId: warehouseId, lines,
        warehouseOverride: warehouseOverride === true,
      })
    }

    // No editar si algún lote del borrador ya se consumió.
    await assertReceiptLotsUntouched(client, tenantId, receiptId)

    const { rows: cfgRows } = await client.query(
      `SELECT uses_lots, uses_expiry, lot_number_pattern
       FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    const cfg = cfgRows[0] || { uses_lots: false, uses_expiry: false, lot_number_pattern: null }

    const newDate = receivedDate || receipt.received_date

    // Reemplazo total de líneas + lotes del borrador (no movieron inventario).
    // Los lotes referencian a las líneas (FK) → borrar lotes primero.
    await client.query(
      `DELETE FROM raw_material_lots WHERE tenant_id = $1 AND supplier_receipt_id = $2`,
      [tenantId, receiptId]
    )
    await client.query(
      `DELETE FROM supplier_receipt_lines WHERE supplier_receipt_id = $1`,
      [receiptId]
    )

    await client.query(
      `UPDATE supplier_receipts
         SET warehouse_id = $1, received_date = $2,
             document_type = $3, document_number = $4, notes = $5
       WHERE id = $6 AND tenant_id = $7`,
      [warehouseId, newDate, documentType || null, documentNumber || null,
       notes || null, receiptId, tenantId]
    )

    await insertReceiptLinesAndLots(client, {
      tenantId, receiptId, warehouseId,
      resolvedPartnerId: receipt.partner_id,
      receivedDate: newDate, cfg, lines, userId,
    })

    await audit({
      tenantId, userId, action: 'supplier_receipt.updated',
      resource: 'supplier_receipts', resourceId: receiptId,
      payload: { receiptNumber: receipt.receipt_number, linesCount: lines.length,
                 ...(ocWarehouseCheck?.warehouseOverridden
                   ? { warehouseOverridden: true, ocWarehouses: ocWarehouseCheck.ocWarehouses } : {}) },
      ipAddress, userAgent,
    })

    const { rows } = await client.query(
      `SELECT * FROM supplier_receipts WHERE id = $1`, [receiptId]
    )
    return rows[0]
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

/**
 * Quita la evidencia de una recepción (cuando se subió en el documento
 * equivocado). Borra el archivo de R2 y limpia los 3 campos. Idempotente: si no
 * había evidencia, devuelve removed:false sin error.
 */
async function deleteEvidence({ tenantId, receiptId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `SELECT id, evidence_path FROM supplier_receipts WHERE id = $1 AND tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (rows.length === 0) throw createError(404, 'Recepción no encontrada.')
  if (!rows[0].evidence_path) return { removed: false }

  await storage.remove(rows[0].evidence_path)
  await query(
    `UPDATE supplier_receipts
        SET evidence_path = NULL, evidence_filename = NULL, evidence_mimetype = NULL
      WHERE id = $1 AND tenant_id = $2`,
    [receiptId, tenantId]
  )
  await audit({
    tenantId, userId, action: 'supplier_receipt.evidence_removed',
    resource: 'supplier_receipts', resourceId: receiptId, payload: {},
    ipAddress, userAgent,
  })
  return { removed: true }
}

async function confirmReceipt({ tenantId, receiptId, userId, ipAddress, userAgent }) {
  const result = await withTransaction(async (client) => {
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

      // En una REPOSICIÓN el costo capturado es el histórico de la compra
      // original (para no distorsionar inventario) — NO es un precio de mercado
      // nuevo, así que no debe pisar el precio vigente del proveedor.
      if (line.unit_price > 0 && line.item_type === 'raw_material' && receipt.partner_id
          && !receipt.replacement_return_id) {
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
    // (Reposiciones excluidas: entran al costo original, no a precio nuevo.)
    if (receipt.partner_id && !receipt.replacement_return_id) {
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

    // Reposición en especie: abonar lo recibido a la cobertura de la devolución
    // y, si quedó cubierta por completo, resolverla como 'replacement'.
    if (receipt.replacement_return_id) {
      await applyReplacementCoverage(client, {
        tenantId, returnId: receipt.replacement_return_id,
        receipt, lines, userId,
      })
    }

    await audit({
      tenantId, userId, action: 'supplier_receipt.confirmed',
      resource: 'supplier_receipts', resourceId: receiptId,
      payload: { receiptNumber: receipt.receipt_number, linesCount: lines.length,
                 replacementReturnId: receipt.replacement_return_id || undefined },
      ipAddress, userAgent,
    })

    return rows[0]
  })

  // Push best-effort post-commit: recepción validada → compras + dueño de la OC.
  pushEvents.receiptConfirmed(tenantId, { receiptId, actorUserId: userId })

  return result
}

async function cancelReceipt({ tenantId, receiptId, reason, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: rRows } = await client.query(
      `SELECT id, receipt_number, status FROM supplier_receipts
       WHERE id = $1 AND tenant_id = $2`,
      [receiptId, tenantId]
    )
    if (rRows.length === 0) throw createError(404, 'Recepción no encontrada.')
    if (rRows[0].status !== 'draft') throw createError(409, 'Solo se puede cancelar una recepción en borrador.')

    // No cancelar si algún lote del borrador ya se consumió.
    await assertReceiptLotsUntouched(client, tenantId, receiptId)

    // Borrar los lotes creados en borrador: no movieron inventario, pero SÍ
    // cuentan como stock disponible (FEFO/FIFO). Si no se borran, el material
    // cancelado seguiría apareciendo como existencia.
    await client.query(
      `DELETE FROM raw_material_lots WHERE tenant_id = $1 AND supplier_receipt_id = $2`,
      [tenantId, receiptId]
    )

    const { rows } = await client.query(
      `UPDATE supplier_receipts SET status = 'cancelled'
       WHERE id = $1 AND tenant_id = $2 RETURNING id, receipt_number`,
      [receiptId, tenantId]
    )

    await audit({
      tenantId, userId, action: 'supplier_receipt.cancelled',
      resource: 'supplier_receipts', resourceId: receiptId,
      payload: { reason }, ipAddress, userAgent,
    })

    return rows[0]
  })
}

/**
 * Reposición en especie (mig 240): al confirmar una recepción ligada a una
 * devolución, abona lo recibido a quantity_replaced de las líneas de la
 * devolución (emparejadas por artículo, en orden, topadas a su pendiente).
 * Si todas las líneas quedan cubiertas → la devolución se resuelve como
 * 'replacement' (sin tocar CxP: la factura vigente sigue siendo la original).
 */
async function applyReplacementCoverage(client, { tenantId, returnId, receipt, lines, userId }) {
  const { rows: retRows } = await client.query(
    `SELECT id, return_number, credit_status, replacement_completed_at
       FROM supplier_returns WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [returnId, tenantId]
  )
  const ret = retRows[0]
  if (!ret) throw createError(404, 'La devolución de esta reposición ya no existe.')

  const { rows: retLines } = await client.query(
    `SELECT id, item_type, item_id, quantity, quantity_replaced
       FROM supplier_return_lines WHERE return_id = $1
       ORDER BY created_at`,
    [returnId]
  )

  // Distribuir lo recibido entre las líneas de la devolución del mismo artículo.
  for (const line of lines) {
    if (!line.item_id || !line.item_type) continue
    let remaining = parseFloat(line.quantity_received)
    for (const rl of retLines) {
      if (remaining <= 1e-6) break
      if (rl.item_type !== line.item_type || rl.item_id !== line.item_id) continue
      const pending = parseFloat(rl.quantity) - parseFloat(rl.quantity_replaced)
      if (pending <= 1e-6) continue
      const applied = Math.min(remaining, pending)
      rl.quantity_replaced = (parseFloat(rl.quantity_replaced) + applied).toFixed(4)
      remaining -= applied
      await client.query(
        `UPDATE supplier_return_lines SET quantity_replaced = quantity_replaced + $1
          WHERE id = $2`,
        [applied.toFixed(4), rl.id]
      )
    }
  }

  const fullyCovered = retLines.every(rl =>
    parseFloat(rl.quantity_replaced) >= parseFloat(rl.quantity) - 1e-4)

  if (fullyCovered && !ret.replacement_completed_at) {
    // Si la devolución seguía con crédito pendiente, la reposición ES la
    // resolución (no hay NC/cancelación: la CxP original no cambia). Si ya
    // tenía otra resolución fiscal registrada, solo se marca la cobertura.
    await client.query(
      `UPDATE supplier_returns
          SET replacement_completed_at = NOW(),
              fiscal_resolution = CASE WHEN credit_status = 'pending'
                                       THEN 'replacement'::supplier_return_fiscal_resolution
                                       ELSE fiscal_resolution END,
              credit_status = CASE WHEN credit_status = 'pending'
                                   THEN 'resolved' ELSE credit_status END
        WHERE id = $1`,
      [returnId]
    )
    await audit({
      tenantId, userId, action: 'supplier_return.replacement_completed',
      resource: 'supplier_returns', resourceId: returnId,
      payload: { returnNumber: ret.return_number, receiptNumber: receipt.receipt_number },
    })
  }
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

  // No revivir una OC cerrada manualmente ('closed', "dar por completa") ni una
  // cancelada: una recepción confirmada tardía no debe reabrir el ciclo. Solo se
  // recalcula el estatus mientras la OC sigue en su flujo de recepción.
  await client.query(
    `UPDATE purchase_orders SET status = $1
       WHERE id = $2 AND tenant_id = $3
         AND status NOT IN ('closed', 'cancelled')`,
    [newStatus, purchaseOrderId, tenantId]
  )
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Pide por correo al proveedor la factura de una recepción confirmada sin
 * CFDI. Espejo de requestExpenseInvoice (Gastos): reusa el mismo template y
 * marca supplier_receipts.invoice_requested_at (mig 244).
 */
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Query base compartida por el envío y el contexto del modal (elegir correo). */
async function fetchReceiptForInvoiceRequest({ tenantId, id }) {
  const { rows } = await query(
    `SELECT sr.id, sr.status, sr.partner_id, sr.receipt_number, sr.received_date,
            sr.replacement_return_id, sr.invoice_requested_at,
            po.order_number AS purchase_order_number,
            po.subtotal_mxn AS po_subtotal, po.tax_mxn AS po_tax,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            t.name AS tenant_name, t.brand_color_primary, t.notification_email,
            COALESCE((SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                       WHERE srl.supplier_receipt_id = sr.id), 0)::numeric AS receipt_subtotal,
            -- ¿Ya hay factura REAL activa ligada? (parcial también cuenta como "ya llegó algo")
            EXISTS (SELECT 1 FROM invoice_receipt_links irl
                      JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
                     WHERE irl.supplier_receipt_id = sr.id
                       AND si.status <> 'cancelled' AND si.type = 'invoice'
                       AND si.uuid_sat IS NOT NULL) AS has_real_invoice
       FROM supplier_receipts sr
       LEFT JOIN purchase_orders   po ON po.id = sr.purchase_order_id
       LEFT JOIN business_partners bp ON bp.id = sr.partner_id
       LEFT JOIN tenants           t  ON t.id  = sr.tenant_id
      WHERE sr.id = $1 AND sr.tenant_id = $2`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Recepción no encontrada.')
  const rec = rows[0]
  if (rec.status !== 'confirmed') throw createError(409, 'La recepción debe estar confirmada para solicitar su factura.')
  if (rec.replacement_return_id) throw createError(409, 'Las reposiciones de devolución no se facturan (la factura vigente es la original).')
  if (rec.has_real_invoice) throw createError(409, 'Esta recepción ya tiene factura ligada.')
  if (!rec.partner_id) throw createError(400, 'La recepción no tiene un proveedor del catálogo a quien solicitarle la factura.')

  const { rows: contacts } = await query(
    `SELECT name, email, is_primary FROM business_partner_contacts
      WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [rec.partner_id]
  )

  // Total con IVA: aplicamos a las líneas recibidas la tasa efectiva de la OC
  // (cubre recepciones parciales). Sin OC — o con OC en $0 — usamos 16%.
  const subtotal = parseFloat(rec.receipt_subtotal || 0)
  const poSubtotal = parseFloat(rec.po_subtotal || 0)
  const taxRate = poSubtotal > 0 ? parseFloat(rec.po_tax || 0) / poSubtotal : 0.16
  const totalWithTax = Math.round(subtotal * (1 + taxRate) * 100) / 100

  return { rec, contacts, totalWithTax }
}

/**
 * Contexto para el modal de "Solicitar factura": correos candidatos del
 * proveedor, dirección del buzón de facturas y el resumen que llevará el correo.
 */
async function getReceiptInvoiceRequestContext({ tenantId, id }) {
  const { getInboxAddress } = require('../inbound/inboundEmailService')
  const { rec, contacts, totalWithTax } = await fetchReceiptForInvoiceRequest({ tenantId, id })

  let inbox = null
  try {
    const info = await getInboxAddress(tenantId)
    if (info.token && info.active) inbox = info.address
  } catch { /* sin buzón: el correo usará reply-to del remitente */ }

  return {
    contacts,
    inboxAddress: inbox,
    receipt: {
      receipt_number: rec.receipt_number,
      purchase_order_number: rec.purchase_order_number,
      received_date: rec.received_date,
      total_with_tax: totalWithTax,
      partner_name: rec.partner_tax_name || rec.partner_name || '',
      invoice_requested_at: rec.invoice_requested_at,
    },
  }
}

async function requestReceiptInvoice({ tenantId, id, toEmails, userId, ipAddress, userAgent }) {
  const { enqueueEmail } = require('../../queues/emailQueue')
  const { expenseInvoiceRequestEmail } = require('../email/templates/sales')
  const { getInboxAddress } = require('../inbound/inboundEmailService')

  const { rec, contacts, totalWithTax } = await fetchReceiptForInvoiceRequest({ tenantId, id })

  // Destinatarios: los que eligió el usuario en el modal, o (fallback) todos
  // los contactos con correo del proveedor.
  let recipients
  if (Array.isArray(toEmails) && toEmails.length) {
    recipients = [...new Set(toEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean))]
    const bad = recipients.filter(e => !EMAIL_RX.test(e))
    if (bad.length) throw createError(400, `Correo(s) inválido(s): ${bad.join(', ')}`)
  } else {
    recipients = contacts.map(c => c.email).filter(Boolean)
    if (!recipients.length) {
      throw createError(400, 'El proveedor no tiene contactos con correo. Captura uno en Socios para poder solicitar la factura.')
    }
  }

  let senderEmail = rec.notification_email || null
  if (!senderEmail && userId) {
    const { rows: u } = await query(`SELECT email FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId])
    senderEmail = u[0]?.email || null
  }
  if (senderEmail && recipients.includes(senderEmail)) senderEmail = null

  // Reply-To: el buzón de facturas del tenant (si está activo), para que el
  // XML/PDF que responda el proveedor entre solo al sistema. Si no hay buzón,
  // cae al correo del remitente como antes.
  let inboxAddress = null
  try {
    const info = await getInboxAddress(tenantId)
    if (info.token && info.active) inboxAddress = info.address
  } catch { /* tenant sin buzón */ }

  const tenantName = rec.tenant_name || 'Emisor'
  const concept = `Mercancía recibida — recepción ${rec.receipt_number}`
  const html = expenseInvoiceRequestEmail({
    tenantName, brandColor: rec.brand_color_primary || null,
    supplierName: rec.partner_tax_name || rec.partner_name || '',
    concept,
    orderNumber: rec.purchase_order_number || null,
    folio: rec.receipt_number,
    total: totalWithTax, currency: 'MXN',
    totalLabel: 'Total (IVA incluido)',
    expenseDate: rec.received_date,
    dateLabel: 'Fecha de recepción',
    replyNote: inboxAddress
      ? `Por favor respondan a este correo adjuntando el XML y el PDF del comprobante — su respuesta llegará directo a nuestro buzón de facturas (${inboxAddress}). ¡Gracias!`
      : 'Pueden responder a este correo con el XML y el PDF del comprobante. ¡Gracias!',
  })

  await enqueueEmail({
    tenantId, to: recipients,
    bcc: senderEmail || undefined,
    replyTo: inboxAddress || senderEmail || undefined,
    subject: `Solicitud de factura — ${tenantName}`,
    html, fromName: tenantName,
  })

  const { rows: upd } = await query(
    `UPDATE supplier_receipts SET invoice_requested_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 RETURNING invoice_requested_at`,
    [id, tenantId]
  )

  await audit({
    tenantId, userId,
    action: 'supplier_receipt.invoice_requested',
    resource: 'supplier_receipts', resourceId: id,
    payload: { recipients, receipt_number: rec.receipt_number },
    ipAddress, userAgent,
  })

  return { requested_at: upd[0].invoice_requested_at, sentTo: recipients }
}

module.exports = {
  listReceipts, getReceipt,
  createReceipt, updateReceipt, confirmReceipt, cancelReceipt,
  uploadEvidence, getEvidenceFile, deleteEvidence,
  requestReceiptInvoice, getReceiptInvoiceRequestContext,
}
