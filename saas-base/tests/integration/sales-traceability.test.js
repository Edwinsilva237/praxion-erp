'use strict'

/**
 * Reporte de trazabilidad de ventas — expediente pedido → remisión → factura →
 * devolución/NC → cancelación/sustitución → cobros → complementos de pago.
 *
 * El reporte solo LEE, así que el escenario se siembra por SQL. Se arma una
 * cadena completa, una factura cancelada y sustituida (la liga vive en la
 * bitácora de la cancelación), una remisión sin facturar y una factura limpia
 * que el filtro "solo lo que hay que revisar" debe esconder.
 *
 * Periodo fijo en el pasado: el corte lo define el parámetro, no la fecha de
 * hoy, así la prueba no se vuelve bomba de tiempo.
 */

const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getSalesTraceability } = require('../../src/modules/reports/salesTraceability')
const { generateSalesTraceabilityWorkbook } = require('../../src/modules/reports/salesTraceabilityExcel')

const FROM = '2025-09-01'
const TO   = '2025-10-01'

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'trzventas', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: bp } = await query(
      `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
       VALUES ($1, 'Cliente Trazas', 'CLIENTE TRAZAS SA', 'XAXX010101000', 'customer', true)
       RETURNING id`, [tenantId])
    const partnerId = bp[0].id

    const issue = async ({ number, uuid, stamp, method = 'PUE', total = 11600, tax = 1600,
                           cfdiType = 'I', status = 'stamped', cancelledAt = null,
                           cancelReason = null, related = null, deliveryNoteId = null }) => {
      const { rows } = await query(
        `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                               subtotal, tax_transferred, total, total_mxn, payment_method, status,
                               issue_date, stamp_date, cancellation_date, cancellation_reason,
                               related_invoice_id, delivery_note_id, notes)
         VALUES ($1,'issued',$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11::timestamptz::date,$11::timestamptz,
                 $12,$13,$14,$15,'[facturapi_id:test]')
         RETURNING id`,
        [tenantId, cfdiType, number, uuid, partnerId, total - tax, tax, total, method, status,
         stamp, cancelledAt, cancelReason, related, deliveryNoteId])
      const id = rows[0].id
      const { rows: ar } = await query(
        `INSERT INTO accounts_receivable (tenant_id, partner_id, document_type, document_id,
                                          document_number, amount_total, amount_paid, issue_date, status)
         VALUES ($1,$2,'invoice',$3,$4,$5,0,$6::timestamptz::date,'pending') RETURNING id`,
        [tenantId, partnerId, id, number, total, stamp])
      return { id, arId: ar[0].id }
    }

    const pay = async (arId, amount, date, method = 'transfer') => {
      await query(
        `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, reference, payment_date)
         VALUES ($1,$2,$3,$4,'SPEI-TRZ',$5)`, [tenantId, arId, amount, method, date])
      await query(
        `UPDATE accounts_receivable SET amount_paid = amount_paid + $1,
                status = (CASE WHEN amount_total - (amount_paid + $1) <= 0.005
                               THEN 'paid' ELSE 'partial' END)::ar_status
          WHERE id = $2`, [amount, arId])
    }

    // ── Expediente completo: pedido → remisión → factura PPD → cobro → REP,
    //    más devolución del cliente resuelta con nota de crédito.
    const { rows: so } = await query(
      `INSERT INTO sales_orders (tenant_id, order_number, partner_id, status, created_by)
       VALUES ($1, 'PED-TRZ-1', $2, 'invoiced', $3) RETURNING id`,
      [tenantId, partnerId, info.user.id])
    const { rows: dn } = await query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, sales_order_id,
                                   subtotal_mxn, tax_mxn, total_mxn, status, issue_date, delivered_at)
       VALUES ($1, 'sale', 'REM-TRZ-1', $2, $3, 10000, 1600, 11600, 'invoiced', '2025-09-02',
               '2025-09-03 10:00'::timestamptz) RETURNING id`,
      [tenantId, partnerId, so[0].id])

    const uuidPpd = randomUUID()
    const ppd = await issue({ number: 'F-TRZ-1', uuid: uuidPpd, stamp: '2025-09-05 12:00',
                              method: 'PPD', total: 11600, tax: 1600 })
    await query(`INSERT INTO invoice_remissions (invoice_id, delivery_note_id) VALUES ($1,$2)`,
      [ppd.id, dn[0].id])
    await pay(ppd.arId, 5000, '2025-09-20')
    await query(
      `INSERT INTO payment_complements (tenant_id, invoice_id, facturapi_id, cfdi_uuid, payment_date,
                                        payment_form, amount, status)
       VALUES ($1,$2,'fa_trz',$3,'2025-09-20','03',5000,'stamped')`,
      [tenantId, ppd.id, randomUUID()])

    // Devolución del cliente sobre esa factura + su nota de crédito.
    const { rows: ret } = await query(
      `INSERT INTO sales_returns (tenant_id, return_number, partner_id, source_delivery_note_id,
                                  source_invoice_id, status, return_date, total_mxn, credit_status,
                                  confirmed_at)
       VALUES ($1,'DEVV-TRZ-1',$2,$3,$4,'confirmed','2025-09-22',2320,'resolved',
               '2025-09-22 12:00'::timestamptz) RETURNING id`,
      [tenantId, partnerId, dn[0].id, ppd.id])
    const nc = await issue({ number: 'NC-TRZ-1', uuid: randomUUID(), stamp: '2025-09-23 12:00',
                             cfdiType: 'E', total: 2320, tax: 320, related: ppd.id })
    await query(`UPDATE sales_returns SET credit_note_invoice_id = $1 WHERE id = $2`, [nc.id, ret[0].id])

    // ── Factura cancelada con motivo 01 y sustituida por otra ──────────────
    const uuidNueva = randomUUID()
    const vieja = await issue({ number: 'F-TRZ-VIEJA', uuid: randomUUID(), stamp: '2025-09-08 12:00',
                                status: 'cancelled', cancelledAt: '2025-09-09 12:00', cancelReason: '01' })
    const nueva = await issue({ number: 'F-TRZ-NUEVA', uuid: uuidNueva, stamp: '2025-09-09 13:00' })
    await pay(nueva.arId, 11600, '2025-09-10')
    await query(
      `INSERT INTO audit_logs (tenant_id, action, resource, resource_id, payload, created_at)
       VALUES ($1,'invoice.cancelled_sat','invoices',$2,$3::jsonb,'2025-09-09 12:00'::timestamptz)`,
      [tenantId, vieja.id, JSON.stringify({ motive: '01', substitution: uuidNueva })])

    // ── Factura limpia (PUE cobrada, sin novedades) → la esconde el filtro ──
    const limpia = await issue({ number: 'F-TRZ-LIMPIA', uuid: randomUUID(), stamp: '2025-09-12 12:00' })
    await pay(limpia.arId, 11600, '2025-09-12')

    // ── Remisión del periodo sin facturar ─────────────────────────────────
    await query(
      `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id,
                                   subtotal_mxn, tax_mxn, total_mxn, status, issue_date)
       VALUES ($1,'sale','REM-TRZ-SINFAC',$2, 4000, 640, 4640, 'delivered', '2025-09-25')`,
      [tenantId, partnerId])

    return { tenantId, partnerId, uuidPpd, uuidNueva }
  })
})

test('el expediente reconstruye pedido, remisión, factura, cobro, complemento, devolución y NC', async () => {
  const data = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const chain = data.chains.find(c => c.invoice.number === 'F-TRZ-1')

  expect(chain).toBeTruthy()
  expect(chain.partner.rfc).toBe('XAXX010101000')
  expect(chain.orders).toEqual(['PED-TRZ-1'])
  expect(chain.remissions).toEqual(['REM-TRZ-1'])

  const types = chain.events.map(e => e.type)
  for (const t of ['order', 'remission', 'invoice', 'payment', 'rep', 'sales_return', 'credit_note']) {
    expect(types).toContain(t)
  }

  // Postgres normaliza los uuid a minúsculas → comparar sin distinguir caja.
  const invoiceEvt = chain.events.find(e => e.type === 'invoice')
  expect(invoiceEvt.uuid.toUpperCase()).toBe(ctx.uuidPpd.toUpperCase())
  expect(chain.events.find(e => e.type === 'credit_note').doc).toBe('NC-TRZ-1')
  expect(chain.events.find(e => e.type === 'sales_return').doc).toBe('DEVV-TRZ-1')
  expect(chain.flags.has_nc).toBe(true)
  expect(chain.flags.has_return).toBe(true)

  // PPD con cobro de 5000 y complemento por 5000 → semáforo en verde.
  expect(chain.flags.rep_status).toBe('ok')
})

test('marca el complemento faltante cuando la PPD se cobró sin timbrarlo', async () => {
  // Segundo cobro sin complemento → el semáforo pasa a "no cuadra".
  await withBypass(async () => {
    const { rows } = await query(
      `SELECT ar.id FROM accounts_receivable ar
        JOIN invoices i ON i.id = ar.document_id
       WHERE ar.tenant_id = $1 AND i.document_number = 'F-TRZ-1'`, [ctx.tenantId])
    await query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, reference, payment_date)
       VALUES ($1,$2,3000,'transfer','SPEI-TRZ-2','2025-09-28')`, [ctx.tenantId, rows[0].id])
  })

  const data = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const chain = data.chains.find(c => c.invoice.number === 'F-TRZ-1')

  expect(chain.flags.rep_status).toBe('mismatch')
  expect(data.summary.rep_missing).toBe(1)
  // El IVA trasladado de esa factura es lo que queda expuesto.
  expect(data.summary.iva_pending_rep_mxn).toBeCloseTo(1600, 2)
})

test('la cancelación con motivo 01 muestra la factura sustituta en los dos sentidos', async () => {
  const data = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })

  const vieja = data.chains.find(c => c.invoice.number === 'F-TRZ-VIEJA')
  expect(vieja.flags.cancelled).toBe(true)
  const sub = vieja.events.find(e => e.type === 'substituted')
  expect(sub.doc).toBe('F-TRZ-NUEVA')
  expect(sub.detail).toContain('CON relación')

  const nueva = data.chains.find(c => c.invoice.number === 'F-TRZ-NUEVA')
  expect(nueva.events.find(e => e.type === 'substitutes').doc).toBe('F-TRZ-VIEJA')
})

test('el filtro esconde los expedientes limpios sin alterar los totales', async () => {
  const todos = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const soloIssues = await getSalesTraceability({
    tenantId: ctx.tenantId, from: FROM, to: TO, onlyIssues: true })

  expect(todos.chains.map(c => c.invoice.number)).toContain('F-TRZ-LIMPIA')
  expect(soloIssues.chains.map(c => c.invoice.number)).not.toContain('F-TRZ-LIMPIA')
  expect(soloIssues.summary).toEqual(todos.summary)
  expect(soloIssues.filtered).toBe(true)
})

test('las remisiones sin factura aparecen aparte y el filtro por cliente responde', async () => {
  const data = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const pendientes = data.pending_remissions.map(r => r.document_number)
  expect(pendientes).toContain('REM-TRZ-SINFAC')
  expect(pendientes).not.toContain('REM-TRZ-1')   // ya está facturada

  const otro = await getSalesTraceability({
    tenantId: ctx.tenantId, from: FROM, to: TO, partnerId: randomUUID() })
  expect(otro.chains).toHaveLength(0)
  expect(otro.pending_remissions).toHaveLength(0)
})

test('las notas de crédito no abren expediente propio y el Excel se genera', async () => {
  const data = await getSalesTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  expect(data.chains.map(c => c.invoice.number)).not.toContain('NC-TRZ-1')

  // Facturado neto = vigentes (11600 + 11600 + 11600) menos la NC (2320).
  expect(data.summary.net_invoiced_mxn).toBeCloseTo(11600 * 3 - 2320, 2)
  expect(data.summary.cancelled).toBe(1)

  const buffer = await generateSalesTraceabilityWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test Ventas' })
  expect(buffer.byteLength).toBeGreaterThan(5000)
})
