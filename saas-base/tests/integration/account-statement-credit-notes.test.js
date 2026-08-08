'use strict'

/**
 * Estado de cuenta de clientes — efecto de una nota de crédito en el saldo.
 *
 * Contexto (2026-08-07): al corregir el reporte contable se sospechó que el
 * estado de cuenta también estaba "ciego" a las NC del modelo actual (viven en
 * `invoices` con cfdi_type='E'), porque `getApplicableCreditNotes` lee la tabla
 * LEGACY `credit_notes`.
 *
 * No lo está, y esta prueba fija POR QUÉ: la NC del modelo actual ya bajó el
 * saldo cobrable de la factura vía `accounts_receivable.amount_credited`
 * (amount_pending = total − pagado − acreditado, mig 081). Listarla ADEMÁS como
 * "saldo a favor" descontaría el crédito dos veces y haría ver al cliente
 * debiendo menos de lo que debe.
 *
 * O sea: el bucket "saldo a favor" es solo para las NC legacy que no tocaban el
 * AR. Si alguien vuelve a "arreglar" esto sumando las NC modernas, esta prueba
 * truena.
 */

const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getAccountStatement, getPartnerStatement } = require('../../src/modules/reports/accountStatementReport')

const TOTAL = 11600
const NC     = 2320

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'edocta-nc', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: bp } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1,'Cliente EdoCta','CLIENTE EDOCTA SA','XAXX010101000','customer',true)
       RETURNING id`, [tenantId])
    const partnerId = bp[0].id

    const { rows: inv } = await query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                             subtotal, tax_transferred, total, total_mxn, payment_method, status,
                             issue_date, stamp_date, notes)
       VALUES ($1,'issued','I','F-EDO-1',$2,$3,10000,1600,$4,$4,'PUE','stamped',
               CURRENT_DATE, NOW(), '[facturapi_id:test]') RETURNING id`,
      [tenantId, randomUUID(), partnerId, TOTAL])

    // AR de la factura, con vencimiento a futuro para que caiga en 'current'.
    await query(
      `INSERT INTO accounts_receivable (tenant_id, partner_id, document_type, document_id,
                                        document_number, amount_total, issue_date, due_date, status)
       VALUES ($1,$2,'invoice',$3,'F-EDO-1',$4, CURRENT_DATE, CURRENT_DATE + 30, 'pending')`,
      [tenantId, partnerId, inv[0].id, TOTAL])

    // Nota de crédito del modelo ACTUAL + su efecto en el AR, tal como lo hace
    // creditNoteService: no toca amount_total, acumula en amount_credited.
    await query(
      `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                             subtotal, tax_transferred, total, total_mxn, status, issue_date,
                             stamp_date, related_invoice_id, notes)
       VALUES ($1,'issued','E','NC-F-EDO-1-01',$2,$3,2000,320,$4,$4,'stamped',
               CURRENT_DATE, NOW(), $5, '[facturapi_id:test]')`,
      [tenantId, randomUUID(), partnerId, NC, inv[0].id])
    await query(
      `UPDATE accounts_receivable SET amount_credited = $1, status = 'partial'::ar_status
        WHERE tenant_id = $2 AND document_type = 'invoice' AND document_id = $3`,
      [NC, tenantId, inv[0].id])

    return { tenantId, partnerId }
  })
})

test('la nota de crédito baja el saldo de la factura una sola vez', async () => {
  const data = await getAccountStatement({ tenantId: ctx.tenantId, direction: 'in' })

  const doc = data.documents.find(d => d.document_number === 'F-EDO-1')
  expect(doc).toBeTruthy()
  expect(doc.amount_pending).toBeCloseTo(TOTAL - NC, 2)

  expect(data.summary.total_pending_amount).toBeCloseTo(TOTAL - NC, 2)
  expect(data.summary.net_balance).toBeCloseTo(TOTAL - NC, 2)
})

test('la NC del modelo actual NO se suma además como saldo a favor (sería doble descuento)', async () => {
  const data = await getAccountStatement({ tenantId: ctx.tenantId, direction: 'in' })

  // El bucket "saldo a favor" es solo para NC legacy que no tocaban el AR.
  expect(data.summary.credit_notes_available.count).toBe(0)
  expect(data.summary.credit_notes_available.amount).toBeCloseTo(0, 2)
  // Si se listara, el neto caería a 6960 y el cliente parecería deber de menos.
  expect(data.summary.net_balance).not.toBeCloseTo(TOTAL - NC * 2, 2)
})

test('el estado de cuenta del cliente (PDF/correo) cuadra con el general', async () => {
  const uno = await getPartnerStatement({
    tenantId: ctx.tenantId, direction: 'in', partnerId: ctx.partnerId })

  expect(uno.summary.net_balance).toBeCloseTo(TOTAL - NC, 2)
  expect(uno.credit_notes).toHaveLength(0)
})

test('la factura dice CUÁL nota de crédito la rebajó', async () => {
  const data = await getAccountStatement({ tenantId: ctx.tenantId, direction: 'in' })
  const doc = data.documents.find(d => d.document_number === 'F-EDO-1')

  expect(doc.amount_credited).toBeCloseTo(NC, 2)
  expect(doc.credits.map(c => c.document_number)).toEqual(['NC-F-EDO-1-01'])
  expect(doc.credits[0].total).toBeCloseTo(NC, 2)
  expect(doc.credits[0].cfdi_uuid).toBeTruthy()

  // El renglón informativo cierra la aritmética: total − pagado − NC = pendiente.
  expect(data.summary.credits_applied.amount).toBeCloseTo(NC, 2)
  expect(data.summary.credits_applied.count).toBe(1)
  expect(doc.amount_total - doc.amount_paid - doc.amount_credited)
    .toBeCloseTo(doc.amount_pending, 2)

  // Y NO se descuenta otra vez del neto.
  expect(data.summary.net_balance).toBeCloseTo(TOTAL - NC, 2)
})

test('el PDF del estado de cuenta se genera con el renglón de la nota de crédito', async () => {
  const { generateAccountStatementPdf } = require('../../src/modules/reports/accountStatementPdf')
  const buffer = await generateAccountStatementPdf({
    tenantId: ctx.tenantId, direction: 'in', mode: 'partner', partnerId: ctx.partnerId })

  expect(Buffer.isBuffer(buffer)).toBe(true)
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
  expect(buffer.length).toBeGreaterThan(2000)
})

test('en cuentas por pagar no hay crédito aplicado (la columna no existe en CxP)', async () => {
  const cxp = await getAccountStatement({ tenantId: ctx.tenantId, direction: 'out' })
  expect(cxp.summary.credits_applied.amount).toBeCloseTo(0, 2)
  for (const d of cxp.documents) expect(d.amount_credited).toBeCloseTo(0, 2)
})
