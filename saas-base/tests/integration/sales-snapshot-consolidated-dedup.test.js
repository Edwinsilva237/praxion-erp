'use strict'

/**
 * Tarjeta "Ventas del mes" del dashboard (financialSnapshot.getSalesSnapshot):
 * regresión del DOBLE CONTEO de remisiones consolidadas.
 *
 * Bug (reportado 2026-06-30): el total mensual sumaba facturas timbradas
 * (invoiced) + remisiones no facturadas (uninvoiced), deduplicando SOLO por
 * inv.delivery_note_id. Pero una factura CONSOLIDADA (varias remisiones en una)
 * deja delivery_note_id en NULL y guarda la liga en invoice_remissions (mig 190).
 * Resultado: cada remisión consolidada se contaba DOS veces — en "invoiced" vía
 * su factura y otra vez en "uninvoiced" → el total del dashboard salía inflado.
 *
 * Fix: el cálculo de "uninvoiced" excluye también las remisiones ligadas a una
 * factura timbrada vía invoice_remissions.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getFinancialSnapshot } = require('../../src/modules/reports/financialSnapshot')

let tenantId, partnerId

describe('Ventas del mes — no doble-cuenta remisiones consolidadas', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'snapconsol', planSlug: 'owner' })
    tenantId = t.tenant.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1, 'customer', 'Cliente snapshot') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  const mkDN = async (num, total) => (await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, total_mxn, subtotal_mxn, status, delivered_at, issue_date)
     VALUES ($1,'sale',$2,$3,$4,$4,'delivered',NOW(),CURRENT_DATE) RETURNING id`,
    [tenantId, num, partnerId, total]))).rows[0].id

  const mkINV = async (num, total, dnId) => (await withBypass(() => query(
    `INSERT INTO invoices
       (tenant_id, type, cfdi_type, document_number, partner_id, status, stamp_date,
        subtotal, tax_transferred, total, total_mxn, delivery_note_id)
     VALUES ($1,'issued','I',$2,$3,'stamped',NOW(),$4,0,$4,$4,$5) RETURNING id`,
    [tenantId, num, partnerId, total, dnId || null]))).rows[0].id

  test('consolidada NO se cuenta como facturada + sin factura a la vez', async () => {
    // Consolidada: dos remisiones (1000 + 2000) en una factura de 3000 con
    // delivery_note_id NULL; liga vía invoice_remissions.
    const dnA = await mkDN('R-A', 1000)
    const dnB = await mkDN('R-B', 2000)
    const invC = await mkINV('F-CONS', 3000, null)
    await withBypass(() => query(
      `INSERT INTO invoice_remissions (invoice_id, delivery_note_id) VALUES ($1,$2),($1,$3)`,
      [invC, dnA, dnB]))

    // Individual: remisión de 700 facturada con liga directa.
    const dnI = await mkDN('R-IND', 700)
    await mkINV('F-IND', 700, dnI)

    // Genuinamente sin factura: 500.
    await mkDN('R-SIN', 500)

    const snap = await getFinancialSnapshot({ tenantId })

    // Facturado = 3000 (consolidada) + 700 (individual) = 3700.
    expect(snap.sales.invoiced).toBeCloseTo(3700, 2)
    // Sin factura = SOLO la remisión genuinamente sin facturar (500), UNA sola.
    expect(snap.sales.uninvoiced).toBeCloseTo(500, 2)
    expect(snap.sales.count_uninvoiced).toBe(1)
    // Total sin doble conteo = 4200 (antes del fix: 7200).
    expect(snap.sales.total).toBeCloseTo(4200, 2)
  })
})
