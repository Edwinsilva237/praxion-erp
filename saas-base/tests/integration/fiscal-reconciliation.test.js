'use strict'

/**
 * Cuadre fiscal del periodo: universo de CFDI + incidencias que impiden cerrar.
 *
 * El reporte solo LEE, así que el escenario se siembra por SQL — una situación
 * de cada incidencia dentro del periodo, más los casos "sanos" que NO deben
 * aparecer (factura PUE cobrada, NC con factura ligada, remisión ya facturada).
 *
 * Periodo fijo en el pasado a propósito: el corte lo define el parámetro, no la
 * fecha de hoy, así la prueba no se convierte en bomba de tiempo.
 */

const { randomUUID } = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getFiscalReconciliation } = require('../../src/modules/reports/fiscalReconciliation')
const { generateFiscalReconciliationWorkbook } = require('../../src/modules/reports/fiscalReconciliationExcel')

const FROM = '2025-03-01'
const TO   = '2025-04-01'

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'cuadre', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const partner = async (name, rfc, type) => {
      const { rows } = await query(
        `INSERT INTO business_partners (tenant_id, name, tax_name, rfc, type, is_active)
         VALUES ($1, $2, $2, $3, $4, true) RETURNING id`, [tenantId, name, rfc, type])
      return rows[0].id
    }
    const clienteId    = await partner('Cliente Cuadre', 'XAXX010101000', 'customer')
    const provId       = await partner('Prov Cuadre',    'XEXX010101000', 'supplier')
    const provSinRfcId = await partner('Prov Sin RFC',   null,            'supplier')

    // Factura emitida: crea la factura + su CXC y devuelve ambos ids.
    const issue = async ({ number, uuid, stamp, method = 'PUE', total = 1160, tax = 160, cfdiType = 'I',
                           status = 'stamped', cancelledAt = null, related = null }) => {
      const { rows } = await query(
        `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, cfdi_uuid, partner_id,
                               subtotal, tax_transferred, total, total_mxn, payment_method, status,
                               issue_date, stamp_date, cancellation_date, related_invoice_id, notes)
         VALUES ($1, 'issued', $2, $3, $4, $5, $6, $7, $8, $8, $9, $10,
                 $11::timestamptz::date, $11::timestamptz, $12, $13, '[facturapi_id:test]')
         RETURNING id`,
        [tenantId, cfdiType, number, uuid, clienteId, total - tax, tax, total, method, status,
         stamp, cancelledAt, related])
      const invoiceId = rows[0].id
      const { rows: ar } = await query(
        `INSERT INTO accounts_receivable (tenant_id, partner_id, document_type, document_id,
                                          document_number, amount_total, issue_date)
         VALUES ($1, $2, 'invoice', $3, $4, $5, $6::timestamptz::date) RETURNING id`,
        [tenantId, clienteId, invoiceId, number, total, stamp])
      return { invoiceId, arId: ar[0].id }
    }

    const pay = (arId, amount, date, method = 'transfer') => query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, reference, payment_date)
       VALUES ($1, $2, $3, $4, 'TRX-CUADRE', $5)`, [tenantId, arId, amount, method, date])

    // ── Emitidos ───────────────────────────────────────────────────────────
    // 1. PPD cobrada en el periodo SIN complemento → incidencia.
    const ppd = await issue({ number: 'F-PPD-1', uuid: randomUUID(), stamp: '2025-03-05 12:00', method: 'PPD' })
    await pay(ppd.arId, 500, '2025-03-20')

    // 2. PPD cobrada CON complemento por el mismo monto → sana.
    const ppdOk = await issue({ number: 'F-PPD-2', uuid: randomUUID(), stamp: '2025-03-06 12:00', method: 'PPD' })
    await pay(ppdOk.arId, 400, '2025-03-21')
    await query(
      `INSERT INTO payment_complements (tenant_id, invoice_id, facturapi_id, cfdi_uuid, payment_date,
                                        payment_form, amount, status)
       VALUES ($1, $2, 'fa_test', $3, '2025-03-21', '03', 400, 'stamped')`,
      [tenantId, ppdOk.invoiceId, randomUUID()])

    // 3. PUE cobrada → no exige REP, no debe aparecer.
    const pue = await issue({ number: 'F-PUE-1', uuid: randomUUID(), stamp: '2025-03-07 12:00' })
    await pay(pue.arId, 1160, '2025-03-22')

    // 4. NC sin factura relacionada → incidencia. Y una NC ligada → sana.
    await issue({ number: 'NC-SUELTA', uuid: randomUUID(), stamp: '2025-03-10 12:00',
                  cfdiType: 'E', total: 232, tax: 32 })
    await issue({ number: 'NC-LIGADA', uuid: randomUUID(), stamp: '2025-03-11 12:00',
                  cfdiType: 'E', total: 116, tax: 16, related: pue.invoiceId })

    // 5. Timbrada ANTES del periodo y cancelada DENTRO, con un cobro vivo →
    //    dos incidencias sobre el mismo documento.
    const vieja = await issue({ number: 'F-VIEJA', uuid: randomUUID(), stamp: '2025-01-15 12:00',
                               status: 'cancelled', cancelledAt: '2025-03-25 12:00' })
    await pay(vieja.arId, 300, '2025-02-10')

    // ── Recibidos ──────────────────────────────────────────────────────────
    const supplierInvoice = async ({ number, uuid, date, type = 'invoice', metodo = null,
                                     total = 2320, tax = 320, partnerId = provId }) => {
      const { rows } = await query(
        `INSERT INTO supplier_invoices (tenant_id, invoice_number, type, partner_id, uuid_sat,
                                        subtotal, tax, total, total_mxn, balance, invoice_date,
                                        metodo_pago_sat, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9, $10, 'pending') RETURNING id`,
        [tenantId, number, type, partnerId, uuid, total - tax, tax, total, date, metodo])
      return rows[0].id
    }

    // 6. Factura PPD de proveedor pagada en el periodo sin REP → IVA en riesgo.
    const cxpPpd = await supplierInvoice({ number: 'FP-PPD-1', uuid: randomUUID(),
                                           date: '2025-03-08', metodo: 'PPD' })
    const { rows: sp } = await query(
      `INSERT INTO supplier_payments (tenant_id, partner_id, payment_date, method, reference,
                                      amount, amount_mxn)
       VALUES ($1, $2, '2025-03-18', 'transfer', 'SPEI-CUADRE', 1160, 1160) RETURNING id`,
      [tenantId, provId])
    await query(
      `INSERT INTO supplier_payment_applications (supplier_payment_id, supplier_invoice_id, amount_applied)
       VALUES ($1, $2, 1160)`, [sp[0].id, cxpPpd])

    // 7. CxP sin CFDI (remisión del proveedor) → no deducible.
    await supplierInvoice({ number: 'REM-PROV-1', uuid: null, date: '2025-03-12',
                            type: 'remission', total: 500, tax: 0 })

    // 8. CFDI recibido de un proveedor sin RFC capturado.
    await supplierInvoice({ number: 'FP-SIN-RFC', uuid: randomUUID(), date: '2025-03-14',
                            partnerId: provSinRfcId, total: 116, tax: 16 })

    return { tenantId, clienteId, provId }
  })
})

test('el universo del periodo cuenta los CFDI de los dos lados', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })

  // Emitidos vigentes del periodo: F-PPD-1, F-PPD-2, F-PUE-1 (F-VIEJA se timbró
  // en enero, no entra al universo de marzo).
  expect(data.universe.issued.invoices).toBe(3)
  expect(data.universe.issued.credit_notes).toBe(2)
  expect(data.universe.issued.complements).toBe(1)

  // Recibidos: solo los que tienen UUID (la remisión no es CFDI).
  expect(data.universe.received.invoices).toBe(2)
  expect(data.universe.received.complements).toBe(0)
})

test('detecta cobros del periodo sin complemento de pago y deja pasar los que sí lo tienen', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const g = data.groups.find(x => x.key === 'ar_rep_missing')

  expect(g).toBeTruthy()
  expect(g.severity).toBe('danger')
  const docs = g.rows.map(r => r.doc)
  expect(docs).toContain('F-PPD-1')
  expect(docs).not.toContain('F-PPD-2')  // complemento por el monto exacto
  expect(docs).not.toContain('F-PUE-1')  // PUE no exige REP
})

test('detecta la NC sin factura origen, pero no la que sí está ligada', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const g = data.groups.find(x => x.key === 'nc_sin_factura')

  expect(g.rows.map(r => r.doc)).toEqual(['NC-SUELTA'])
})

test('avisa de la cancelación que pega a un mes ya declarado y de sus cobros vivos', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })

  const prev = data.groups.find(x => x.key === 'cancel_periodo_anterior')
  expect(prev.rows.map(r => r.doc)).toEqual(['F-VIEJA'])
  expect(prev.rows[0].detail).toContain('2025-01-15')

  const cobros = data.groups.find(x => x.key === 'cancelada_con_cobros')
  expect(cobros.rows.map(r => r.doc)).toEqual(['F-VIEJA'])
  expect(cobros.rows[0].amount).toBeCloseTo(300, 2)
})

test('el pago a proveedor sin REP marca el IVA que aún no es acreditable', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const g = data.groups.find(x => x.key === 'ap_rep_missing')

  expect(g.rows).toHaveLength(1)
  expect(g.rows[0].doc).toBe('SPEI-CUADRE')
  // 1160 pagados sobre una factura con IVA de 320/2320 → 160 de IVA en riesgo.
  expect(data.iva.en_riesgo).toBeCloseTo(160, 2)
  expect(data.iva.neto_en_firme).toBeCloseTo(data.iva.neto + 160, 2)
})

test('detecta CxP sin CFDI y CFDI recibidos sin RFC del emisor', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })

  expect(data.groups.find(x => x.key === 'cxp_sin_cfdi').rows.map(r => r.doc))
    .toEqual(['REM-PROV-1'])
  expect(data.groups.find(x => x.key === 'proveedor_sin_rfc').rows.map(r => r.doc))
    .toEqual(['FP-SIN-RFC'])
})

test('cada incidencia trae su explicación fiscal y su acción, y el Excel se genera', async () => {
  const data = await getFiscalReconciliation({ tenantId: ctx.tenantId, from: FROM, to: TO })

  expect(data.issues.total).toBe(data.groups.reduce((n, g) => n + g.count, 0))
  expect(data.issues.danger).toBeGreaterThan(0)
  for (const g of data.groups) {
    expect(typeof g.meaning).toBe('string')
    expect(g.meaning.length).toBeGreaterThan(20)
    expect(typeof g.action).toBe('string')
  }

  const buffer = await generateFiscalReconciliationWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test Cuadre' })
  expect(buffer.byteLength).toBeGreaterThan(5000)
})

test('un periodo sin documentos no inventa incidencias', async () => {
  const vacio = await getFiscalReconciliation({
    tenantId: ctx.tenantId, from: '2024-01-01', to: '2024-02-01' })

  expect(vacio.issues.total).toBe(0)
  expect(vacio.groups).toEqual([])
  expect(vacio.universe.issued.invoices).toBe(0)
})
