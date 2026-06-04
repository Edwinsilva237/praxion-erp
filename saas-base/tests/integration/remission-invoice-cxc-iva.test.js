'use strict'

/**
 * Mig 192 — backfill de CXC de facturas de UNA remisión que quedaron SIN IVA.
 *
 * El AR de una remisión nace sin IVA (las remisiones no son fiscales: total = subtotal).
 * Al facturar UNA remisión (full-coverage), el código migraba el AR a 'invoice' pero
 * conservaba el monto sin IVA → Cuentas por cobrar / pagos recibidos mostraban menos.
 * El backfill pone amount_total = invoice.total_mxn (con IVA) SOLO para facturas de una
 * remisión (invoices.delivery_note_id NOT NULL). Aquí corremos el SQL real de la migración.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const mig192 = require('../../src/db/migrations/192_backfill_remission_invoice_cxc_iva')

let tenantId, userId, partnerId

async function arAmount(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_total FROM accounts_receivable WHERE id = $1`, [arId]))
  return parseFloat(rows[0].amount_total)
}

async function makeDeliveryNote(doc) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status, currency, total_mxn)
     VALUES ($1,'sale',$2,$3,'invoiced','MXN',100) RETURNING id`,
    [tenantId, doc, partnerId]))
  return rows[0].id
}

async function makeInvoiceWithAr({ doc, deliveryNoteId, invTotalMxn, arAmt }) {
  const { rows: inv } = await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id, total_mxn)
     VALUES ($1,'issued',$2,$3,'draft',$4,$5) RETURNING id`,
    [tenantId, doc, partnerId, deliveryNoteId, invTotalMxn]))
  const { rows: ar } = await withBypass(() => query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number,
        currency, exchange_rate, amount_total, issue_date, created_by)
     VALUES ($1,$2,'invoice',$3,$4,'MXN',1,$5,CURRENT_DATE,$6) RETURNING id`,
    [tenantId, partnerId, inv[0].id, doc, arAmt, userId]))
  return ar[0].id
}

describe('Mig 192 — CXC de factura de remisión incluye IVA', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'cxciva', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1,'customer','Cliente IVA') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('corrige el AR sin IVA de una factura de UNA remisión (100 → 116)', async () => {
    const dn = await makeDeliveryNote('REM-IVA-1')
    const arId = await makeInvoiceWithAr({ doc: 'F-IVA-1', deliveryNoteId: dn, invTotalMxn: 116, arAmt: 100 })
    expect(await arAmount(arId)).toBe(100)        // antes: sin IVA
    await withBypass(() => query(mig192.up))
    expect(await arAmount(arId)).toBe(116)        // después: con IVA (= total_mxn de la factura)
  })

  test('NO toca facturas directas/consolidadas (delivery_note_id NULL), aunque difieran', async () => {
    const arId = await makeInvoiceWithAr({ doc: 'F-DIR-1', deliveryNoteId: null, invTotalMxn: 116, arAmt: 100 })
    await withBypass(() => query(mig192.up))
    expect(await arAmount(arId)).toBe(100)        // intacto: el backfill solo aplica a facturas de UNA remisión
  })

  test('es idempotente: un AR ya correcto no cambia', async () => {
    const dn = await makeDeliveryNote('REM-IVA-2')
    const arId = await makeInvoiceWithAr({ doc: 'F-IVA-2', deliveryNoteId: dn, invTotalMxn: 232, arAmt: 232 })
    await withBypass(() => query(mig192.up))
    expect(await arAmount(arId)).toBe(232)
  })
})
