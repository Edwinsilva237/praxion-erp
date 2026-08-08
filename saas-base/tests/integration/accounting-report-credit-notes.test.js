'use strict'

/**
 * Reporte contable — hoja de Notas de crédito.
 *
 * Regresión (2026-08-07): las NC emitidas viven en `invoices` con cfdi_type='E'
 * (creditNoteService las timbra ahí), pero el reporte y el paquete contable
 * seguían leyendo la tabla LEGACY `credit_notes` → la hoja salía vacía y el ZIP
 * no llevaba los XML de las NC. Esta prueba fija el modelo actual y comprueba
 * que las filas legacy se sigan sumando sin duplicar por UUID.
 */

const ExcelJS = require('exceljs')
const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { generateAccountingWorkbook } = require('../../src/modules/reports/accountingReport')

const FROM = '2025-05-01'
const TO   = '2025-06-01'

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'cont-nc', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: bp } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1, 'Cliente NC', 'CLIENTE NC SA', 'XAXX010101000', 'customer', true) RETURNING id`,
      [tenantId])
    const partnerId = bp[0].id

    const { rows: inv } = await query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                             subtotal, tax_transferred, total, total_mxn, status, issue_date, stamp_date, notes)
       VALUES ($1, 'issued', 'I', 'F-NC-BASE', $2, $3, 1000, 160, 1160, 1160, 'stamped',
               '2025-05-02', '2025-05-02 12:00'::timestamptz, '[facturapi_id:test]') RETURNING id`,
      [tenantId, randomUUID(), partnerId])

    // NC del modelo ACTUAL (invoices cfdi_type='E'), ligada a su factura.
    const ncUuid = randomUUID()
    await query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                             subtotal, tax_transferred, total, total_mxn, status, issue_date,
                             stamp_date, related_invoice_id, notes)
       VALUES ($1, 'issued', 'E', 'NC-F-NC-BASE-01', $2, $3, 200, 32, 232, 232, 'stamped',
               '2025-05-10', '2025-05-10 12:00'::timestamptz, $4, '[facturapi_id:test]')`,
      [tenantId, ncUuid, partnerId, inv[0].id])

    // NC LEGACY que nadie migró: debe seguir apareciendo.
    await query(
      `INSERT INTO credit_notes (tenant_id, type, document_number, cfdi_uuid, partner_id,
                                 reason, amount, tax_amount, total, issue_date, status)
       VALUES ($1, 'issued', 'NC-LEGACY-1', $2, $3, 'discount', 100, 16, 116, '2025-05-15', 'stamped')`,
      [tenantId, randomUUID(), partnerId])

    return { tenantId, ncUuid }
  })
})

test('la hoja de Notas de crédito trae las del modelo actual y las legacy', async () => {
  const buffer = await generateAccountingWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test NC', fiscalOnly: true })

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.getWorksheet('Notas de crédito')
  expect(ws).toBeTruthy()

  const folios = []
  ws.eachRow((row, i) => { if (i > 1) folios.push(row.getCell(1).value) })
  expect(folios).toContain('NC-F-NC-BASE-01')
  expect(folios).toContain('NC-LEGACY-1')
  expect(folios).toHaveLength(2)

  // La NC del modelo actual conserva la liga a su factura origen.
  let ligada = null
  ws.eachRow((row, i) => { if (i > 1 && row.getCell(1).value === 'NC-F-NC-BASE-01') ligada = row })
  expect(ligada.getCell(11).value).toBe('F-NC-BASE')   // columna "Factura original"
})

test('el resumen descuenta las notas de crédito timbradas del periodo', async () => {
  const buffer = await generateAccountingWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test NC', fiscalOnly: true })

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const rs = wb.getWorksheet('Resumen')

  let total = null
  rs.eachRow(row => {
    if (row.getCell(1).value === 'Total notas de crédito') total = row.getCell(2).value
  })
  expect(total).toBeCloseTo(232 + 116, 2)
})
