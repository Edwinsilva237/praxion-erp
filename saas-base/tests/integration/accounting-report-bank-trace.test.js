'use strict'

/**
 * Reporte Contable — rastro de conciliación bancaria por documento.
 *
 * Pedido del usuario (2026-08-07): que cada CFDI del Excel diga cuándo se
 * cobró/pagó, a qué banco (o con qué tarjeta), qué complemento lo ampara, si
 * está cancelado y por cuál se sustituye, y si tiene notas de crédito — para
 * poder cuadrar contra el estado de cuenta del banco sin salir de la hoja.
 *
 * Se arma un escenario con las dos direcciones y se LEE el .xlsx generado.
 */

const ExcelJS = require('exceljs')
const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { generateAccountingWorkbook } = require('../../src/modules/reports/accountingReport')

const FROM = '2025-11-01'
const TO   = '2025-12-01'

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

/** Lee una hoja como array de objetos {encabezado: valor}. */
function sheetRows(ws) {
  const headers = []
  ws.getRow(1).eachCell((c, i) => { headers[i] = String(c.value || '') })
  const out = []
  ws.eachRow((row, i) => {
    if (i === 1) return
    const o = {}
    row.eachCell((c, j) => { o[headers[j]] = c.value })
    out.push(o)
  })
  return out
}

beforeAll(async () => {
  const info = await createTenant({ label: 'cont-banco', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: cli } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1,'Cliente Banco','CLIENTE BANCO SA','XAXX010101000','customer',true) RETURNING id`,
      [tenantId])
    const { rows: prov } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1,'Prov Banco','PROV BANCO SA','XEXX010101000','supplier',true) RETURNING id`,
      [tenantId])
    const { rows: ba } = await query(
      `INSERT INTO bank_accounts (tenant_id, bank_name, alias, account_number, active)
       VALUES ($1,'BBVA','Cuenta principal','1234567890',true) RETURNING id`, [tenantId])
    const { rows: cc } = await query(
      `INSERT INTO credit_cards (tenant_id, alias, bank_name, last_four, statement_day, payment_day)
       VALUES ($1,'Tarjeta operativa','Banorte','4321',5,20) RETURNING id`, [tenantId])

    // ── VENTA PPD: cobrada por transferencia a BBVA + REP timbrado + NC ──────
    const inv = async (num, method, total, tax, status = 'stamped', cancelledAt = null, reason = null) => {
      const { rows } = await query(
        `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                               subtotal, tax_transferred, total, total_mxn, payment_method, status,
                               issue_date, stamp_date, cancellation_date, cancellation_reason, notes)
         VALUES ($1,'issued','I',$2,$3,$4,$5,$6,$7,$7,$8,$9,'2025-11-03','2025-11-03 12:00'::timestamptz,
                 $10,$11,'[facturapi_id:test]') RETURNING id, cfdi_uuid`,
        [tenantId, num, randomUUID(), cli[0].id, total - tax, tax, total, method, status, cancelledAt, reason])
      const { rows: ar } = await query(
        `INSERT INTO accounts_receivable (tenant_id, partner_id, document_type, document_id,
                                          document_number, amount_total, issue_date)
         VALUES ($1,$2,'invoice',$3,$4,$5,'2025-11-03') RETURNING id`,
        [tenantId, cli[0].id, rows[0].id, num, total])
      return { id: rows[0].id, uuid: rows[0].cfdi_uuid, arId: ar[0].id }
    }

    const ppd = await inv('V-PPD-1', 'PPD', 11600, 1600)
    await query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, reference,
                                payment_date, bank_account_id)
       VALUES ($1,$2,5000,'transfer','SPEI-778899','2025-11-20',$3)`,
      [tenantId, ppd.arId, ba[0].id])
    await query(
      `INSERT INTO payment_complements (tenant_id, invoice_id, facturapi_id, cfdi_uuid,
                                        payment_date, payment_form, amount, status)
       VALUES ($1,$2,'fa_t',$3,'2025-11-20','03',5000,'stamped')`,
      [tenantId, ppd.id, randomUUID()])
    const { rows: nc } = await query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                             subtotal, tax_transferred, total, total_mxn, status, issue_date,
                             stamp_date, related_invoice_id, notes)
       VALUES ($1,'issued','E','NC-V-PPD-1',$2,$3,1000,160,1160,1160,'stamped','2025-11-25',
               '2025-11-25 12:00'::timestamptz,$4,'[facturapi_id:test]') RETURNING id`,
      [tenantId, randomUUID(), cli[0].id, ppd.id])

    // ── VENTA PPD cobrada SIN complemento → debe gritar "FALTA REP" ─────────
    const sinRep = await inv('V-PPD-2', 'PPD', 5800, 800)
    await query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, reference,
                                payment_date, bank_account_id)
       VALUES ($1,$2,5800,'transfer','SPEI-000111','2025-11-22',$3)`,
      [tenantId, sinRep.arId, ba[0].id])

    // ── VENTA PUE cancelada y sustituida ───────────────────────────────────
    const vieja = await inv('V-PUE-VIEJA', 'PUE', 2320, 320, 'cancelled', '2025-11-10 12:00', '01')
    const nueva = await inv('V-PUE-NUEVA', 'PUE', 2320, 320)
    await query(
      `INSERT INTO audit_logs (tenant_id, action, resource, resource_id, payload, created_at)
       VALUES ($1,'invoice.cancelled_sat','invoices',$2,$3::jsonb,'2025-11-10 12:00'::timestamptz)`,
      [tenantId, vieja.id, JSON.stringify({ motive: '01', substitution: nueva.uuid })])

    // ── COMPRA PPD pagada con TARJETA DE CRÉDITO, con REP recibido ──────────
    const { rows: cxp } = await query(
      `INSERT INTO supplier_invoices (tenant_id, invoice_number, type, partner_id, uuid_sat,
                                      rfc_emisor, subtotal, tax, total, total_mxn, balance,
                                      invoice_date, metodo_pago_sat, status)
       VALUES ($1,'FP-777','invoice',$2,$3,'XEXX010101000',10000,1600,11600,11600,6600,
               '2025-11-05','PPD','partial') RETURNING id`,
      [tenantId, prov[0].id, randomUUID()])
    const { rows: sp } = await query(
      `INSERT INTO supplier_payments (tenant_id, partner_id, payment_date, method, reference,
                                      amount, amount_mxn, credit_card_id)
       VALUES ($1,$2,'2025-11-18','credit_card','TDC-5566',5000,5000,$3) RETURNING id`,
      [tenantId, prov[0].id, cc[0].id])
    await query(
      `INSERT INTO supplier_payment_applications (supplier_payment_id, supplier_invoice_id, amount_applied)
       VALUES ($1,$2,5000)`, [sp[0].id, cxp[0].id])
    await query(
      `INSERT INTO supplier_payment_complements (tenant_id, partner_id, cfdi_uuid, serie, folio,
                                                 payment_date, amount, supplier_payment_id, match_status)
       VALUES ($1,$2,$3,'REP','120','2025-11-18',5000,$4,'matched')`,
      [tenantId, prov[0].id, randomUUID(), sp[0].id])

    // ── COMPRA pagada en EFECTIVO ──────────────────────────────────────────
    const { rows: cxp2 } = await query(
      `INSERT INTO supplier_invoices (tenant_id, invoice_number, type, partner_id, uuid_sat,
                                      rfc_emisor, subtotal, tax, total, total_mxn, balance,
                                      invoice_date, metodo_pago_sat, status)
       VALUES ($1,'FP-778','invoice',$2,$3,'XEXX010101000',1000,160,1160,1160,0,
               '2025-11-07','PUE','paid') RETURNING id`,
      [tenantId, prov[0].id, randomUUID()])
    const { rows: sp2 } = await query(
      `INSERT INTO supplier_payments (tenant_id, partner_id, payment_date, method, reference,
                                      amount, amount_mxn)
       VALUES ($1,$2,'2025-11-08','cash','CAJA-12',1160,1160) RETURNING id`,
      [tenantId, prov[0].id])
    await query(
      `INSERT INTO supplier_payment_applications (supplier_payment_id, supplier_invoice_id, amount_applied)
       VALUES ($1,$2,1160)`, [sp2[0].id, cxp2[0].id])

    return { tenantId }
  })
})

async function book() {
  const buffer = await generateAccountingWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test Banco', fiscalOnly: true })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  return wb
}

test('cada factura emitida trae fecha de cobro, banco y complemento', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Ventas (Facturas)'))
  const r = rows.find(x => x['Folio interno'] === 'V-PPD-1')

  expect(r['Fecha(s) de cobro']).toBe('2025-11-20')
  expect(r['Banco / cuenta']).toBe('BBVA (Cuenta principal)')
  expect(r['Forma de cobro']).toBe('Transferencia')
  expect(r['Referencia cobro']).toBe('SPEI-778899')
  expect(r['Cobrado']).toBeCloseTo(5000, 2)
  expect(r['Estado REP']).toBe('Timbrado')
  expect(r['Fecha(s) REP']).toBe('2025-11-20')
  expect(String(r['UUID REP'])).toHaveLength(36)
})

test('una PUE dice que no aplica REP y una PPD cobrada sin complemento lo grita', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Ventas (Facturas)'))

  expect(rows.find(x => x['Folio interno'] === 'V-PUE-NUEVA')['Estado REP']).toBe('No aplica (PUE)')
  expect(rows.find(x => x['Folio interno'] === 'V-PPD-2')['Estado REP']).toBe('FALTA REP')
})

test('la factura cancelada dice el motivo y por cuál se sustituye', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Ventas (Facturas)'))
  const r = rows.find(x => x['Folio interno'] === 'V-PUE-VIEJA')

  expect(r['Motivo cancel.']).toBe('01 con relacion')
  expect(r['Sustituida por']).toBe('V-PUE-NUEVA')
  expect(String(r['UUID sustituta'])).toHaveLength(36)
})

test('la factura con nota de crédito la lista con folio, UUID e importe', async () => {
  const wb = await book()
  const r = sheetRows(wb.getWorksheet('Ventas (Facturas)'))
    .find(x => x['Folio interno'] === 'V-PPD-1')

  expect(r['NC aplicadas']).toBe('NC-V-PPD-1')
  expect(String(r['UUID de las NC'])).toHaveLength(36)
  expect(r['Total NC']).toBeCloseTo(1160, 2)
})

test('en compras se distingue tarjeta de crédito de efectivo, con su REP', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Compras (CFDI recibidos)'))

  const tdc = rows.find(x => x['Folio interno'] === 'FP-777')
  expect(tdc['Forma de pago']).toBe('Tarjeta de credito')
  expect(tdc['Banco / tarjeta']).toBe('Banorte ****4321 (Tarjeta operativa)')
  expect(tdc['Fecha(s) de pago']).toBe('2025-11-18')
  expect(tdc['Pagado']).toBeCloseTo(5000, 2)
  expect(tdc['Estado REP']).toBe('Recibido')
  expect(tdc['Folio REP']).toBe('REP-120')

  const efe = rows.find(x => x['Folio interno'] === 'FP-778')
  expect(efe['Forma de pago']).toBe('Efectivo')
  expect(efe['Banco / tarjeta']).toBe('Caja / efectivo')
  expect(efe['Estado REP']).toBe('No aplica (PUE)')
})

test('la hoja de pagos dice a qué factura se aplicó cada salida de dinero', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Pagos a proveedores'))
  const r = rows.find(x => x['Referencia'] === 'TDC-5566')

  expect(r['Método']).toBe('Tarjeta de credito')
  expect(r['Banco / tarjeta']).toBe('Banorte ****4321 (Tarjeta operativa)')
  expect(r['Aplicado a']).toBe('FP-777')
  expect(String(r['UUID facturas'])).toHaveLength(36)
  expect(r['REP recibido']).toBe('REP-120')
})

test('la hoja de cobros lleva el UUID de la factura cobrada', async () => {
  const wb = await book()
  const rows = sheetRows(wb.getWorksheet('Cobros recibidos'))
  const r = rows.find(x => x['Referencia'] === 'SPEI-778899')

  expect(r['Documento']).toBe('V-PPD-1')
  expect(String(r['UUID factura'])).toHaveLength(36)
  expect(r['Banco']).toBe('BBVA')
})
