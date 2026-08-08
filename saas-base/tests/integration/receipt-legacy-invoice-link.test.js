'use strict'

/**
 * Listado de recepciones — recepciones que YA tienen factura y salían como
 * "Sin factura".
 *
 * Causa (reportada 2026-08-07, reproducida en datos locales): la liga
 * recepción↔factura vive en `invoice_receipt_links` (N:N, mig 042) y las líneas
 * se marcan con `invoiced_by_invoice_id` (mig 202). Las facturas registradas
 * ANTES de eso solo dejaron rastro en la columna directa
 * `supplier_invoices.supplier_receipt_id`: el listado no las veía, así que la
 * recepción aparecía "Sin factura", el folio de la factura salía vacío y el
 * botón "Solicitar factura" dejaba pedirle al proveedor una factura ya recibida.
 *
 * Mismo patrón que la liga remisión↔factura consolidada (invoice_remissions).
 */

const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  listReceipts, getReceipt, getReceiptInvoiceRequestContext,
} = require('../../src/modules/purchases/supplierReceiptService')

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'rec-legacy', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: bp } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1,'Prov Legacy','PROV LEGACY SA','XEXX010101000','supplier',true) RETURNING id`,
      [tenantId])
    const partnerId = bp[0].id
    const { rows: rm } = await query(
      `INSERT INTO raw_materials (tenant_id, name, unit, is_active)
       VALUES ($1,'MP Legacy','kg',true) RETURNING id`, [tenantId])
    const { rows: w } = await query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1,'MP L','raw_material',true) RETURNING id`, [tenantId])

    const receipt = async (num) => {
      const { rows } = await query(
        `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id,
                                        received_date, status, created_by)
         VALUES ($1,$2,$3,$4,CURRENT_DATE,'confirmed',$5) RETURNING id`,
        [tenantId, num, partnerId, w[0].id, info.user.id])
      await query(
        `INSERT INTO supplier_receipt_lines (supplier_receipt_id, line_number, item_type, item_id,
                                             quantity_received, unit, unit_price, warehouse_id)
         VALUES ($1, 1, 'raw_material', $2, 100, 'kg', 10, $3)`,
        [rows[0].id, rm[0].id, w[0].id])
      return rows[0].id
    }
    const invoice = async (num, receiptIdLegacy) => {
      const { rows } = await query(
        `INSERT INTO supplier_invoices (tenant_id, invoice_number, type, partner_id, uuid_sat,
                                        supplier_receipt_id, subtotal, tax, total, total_mxn,
                                        balance, invoice_date, status)
         VALUES ($1,$2,'invoice',$3,$4,$5,1000,160,1160,1160,1160,CURRENT_DATE,'pending')
         RETURNING id`,
        [tenantId, num, partnerId, randomUUID(), receiptIdLegacy])
      return rows[0].id
    }

    // A) LEGACY: la factura solo apunta por la columna directa. Sin fila en
    //    invoice_receipt_links, sin líneas marcadas, sin invoiced_at.
    const legacyReceipt = await receipt('REC-LEGACY-1')
    const legacyInvoice = await invoice('F-LEGACY-1', legacyReceipt)

    // B) MODERNA: liga N:N + línea marcada + invoiced_at (lo que hace hoy el alta).
    const modernReceipt = await receipt('REC-MODERNA-1')
    const modernInvoice = await invoice('F-MODERNA-1', null)
    await query(
      `INSERT INTO invoice_receipt_links (tenant_id, supplier_invoice_id, supplier_receipt_id, amount_applied)
       VALUES ($1,$2,$3,1000)`, [tenantId, modernInvoice, modernReceipt])
    await query(
      `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = $1
        WHERE supplier_receipt_id = $2`, [modernInvoice, modernReceipt])
    await query(`UPDATE supplier_receipts SET invoiced_at = NOW() WHERE id = $1`, [modernReceipt])

    // C) SIN FACTURA de verdad: debe seguir marcándose como tal.
    const openReceipt = await receipt('REC-ABIERTA-1')

    return { tenantId, partnerId, legacyReceipt, legacyInvoice, modernReceipt, openReceipt }
  })
})

const find = (res, num) => res.data.find(r => r.receipt_number === num)

test('la recepción ligada por la columna vieja ya NO sale como "sin factura"', async () => {
  const res = await listReceipts({ tenantId: ctx.tenantId, limit: 50 })
  const legacy = find(res, 'REC-LEGACY-1')

  expect(legacy).toBeTruthy()
  expect(legacy.has_linked_invoice).toBe(true)
  // Y ahora sí muestra de qué factura se trata.
  expect(legacy.invoice_number).toBe('F-LEGACY-1')
  expect(legacy.invoice_type).toBe('invoice')
})

test('la recepción sin factura sigue marcándose como tal', async () => {
  const res = await listReceipts({ tenantId: ctx.tenantId, limit: 50 })
  const abierta = find(res, 'REC-ABIERTA-1')

  expect(abierta.has_linked_invoice).toBe(false)
  expect(abierta.invoice_number).toBeNull()
  expect(abierta.invoiced_at).toBeNull()
  expect(abierta.invoiced_line_count).toBe(0)
})

test('la recepción con liga moderna no cambió de comportamiento', async () => {
  const res = await listReceipts({ tenantId: ctx.tenantId, limit: 50 })
  const moderna = find(res, 'REC-MODERNA-1')

  expect(moderna.invoiced_at).not.toBeNull()
  expect(moderna.invoice_number).toBe('F-MODERNA-1')
  expect(moderna.invoiced_line_count).toBe(1)
  expect(moderna.has_linked_invoice).toBe(true)
})

test('el filtro "sin factura" ya no lista la ligada por la vía vieja', async () => {
  const pendientes = await listReceipts({ tenantId: ctx.tenantId, invoiceStatus: 'pending', limit: 50 })
  const folios = pendientes.data.map(r => r.receipt_number)

  expect(folios).toContain('REC-ABIERTA-1')
  expect(folios).not.toContain('REC-LEGACY-1')
  expect(folios).not.toContain('REC-MODERNA-1')

  const facturadas = await listReceipts({ tenantId: ctx.tenantId, invoiceStatus: 'invoiced', limit: 50 })
  const ff = facturadas.data.map(r => r.receipt_number)
  expect(ff).toContain('REC-LEGACY-1')
  expect(ff).toContain('REC-MODERNA-1')
  expect(ff).not.toContain('REC-ABIERTA-1')
})

test('el detalle expone la liga para esconder las acciones de facturación', async () => {
  const legacy = await getReceipt({ tenantId: ctx.tenantId, receiptId: ctx.legacyReceipt })
  const abierta = await getReceipt({ tenantId: ctx.tenantId, receiptId: ctx.openReceipt })

  expect(legacy.has_linked_invoice).toBe(true)
  expect(abierta.has_linked_invoice).toBe(false)
})

test('ya no se le puede pedir al proveedor una factura que ya mandó', async () => {
  await expect(
    getReceiptInvoiceRequestContext({ tenantId: ctx.tenantId, id: ctx.legacyReceipt })
  ).rejects.toMatchObject({ status: 409 })

  // La que sí está pendiente conserva el flujo.
  const ok = await getReceiptInvoiceRequestContext({ tenantId: ctx.tenantId, id: ctx.openReceipt })
  expect(ok).toBeTruthy()
})
