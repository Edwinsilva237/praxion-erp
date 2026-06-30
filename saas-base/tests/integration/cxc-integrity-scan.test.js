'use strict'

/**
 * Escáner de integridad de CXC (getCxcIntegrity): detecta DOBLE COBRO — una
 * remisión con cuenta por cobrar de remisión ACTIVA que ADEMÁS ya está facturada.
 * En un sistema sano debe ser CERO (la CXC de remisión se cancela o no se crea al
 * facturar). Sirve para auditar que el bug de doble conteo del dashboard NUNCA
 * tocó los saldos reales del cliente.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getCxcIntegrity } = require('../../src/modules/reports/salesReport')

let tenantId, userId, partnerId, dnId, arId

describe('getCxcIntegrity — doble cobro en CXC', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'cxcint', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId = t.user.id
    partnerId = (await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id,type,name) VALUES ($1,'customer','Cli') RETURNING id`, [tenantId]))).rows[0].id

    // Remisión + CXC de remisión ACTIVA + factura consolidada ligada → doble cobro.
    dnId = (await withBypass(() => query(
      `INSERT INTO delivery_notes (tenant_id,type,document_number,partner_id,status,currency,total_mxn,subtotal_mxn,delivered_at,issue_date)
       VALUES ($1,'sale','REM-X',$2,'delivered','MXN',1160,1000,NOW(),CURRENT_DATE) RETURNING id`, [tenantId, partnerId]))).rows[0].id
    arId = (await withBypass(() => query(
      `INSERT INTO accounts_receivable (tenant_id,partner_id,document_type,document_id,document_number,currency,exchange_rate,amount_total,amount_paid,issue_date,status,created_by)
       VALUES ($1,$2,'remission',$3,'REM-X','MXN',1,1160,0,CURRENT_DATE,'pending',$4) RETURNING id`, [tenantId, partnerId, dnId, userId]))).rows[0].id
    const inv = (await withBypass(() => query(
      `INSERT INTO invoices (tenant_id,type,cfdi_type,document_number,partner_id,status,stamp_date,subtotal,tax_transferred,total,total_mxn,delivery_note_id)
       VALUES ($1,'issued','I','F-X',$2,'stamped',NOW(),1000,160,1160,1160,NULL) RETURNING id`, [tenantId, partnerId]))).rows[0].id
    await withBypass(() => query(`INSERT INTO invoice_remissions (invoice_id,delivery_note_id) VALUES ($1,$2)`, [inv, dnId]))
    await withBypass(() => query(
      `INSERT INTO accounts_receivable (tenant_id,partner_id,document_type,document_id,document_number,currency,exchange_rate,amount_total,amount_paid,issue_date,status,created_by)
       VALUES ($1,$2,'invoice',$3,'F-X','MXN',1,1160,0,CURRENT_DATE,'pending',$4)`, [tenantId, partnerId, inv, userId]))
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('detecta la remisión cobrada doble', async () => {
    const r = await getCxcIntegrity({ tenantId })
    expect(r.doubleCountedCount).toBe(1)
    expect(r.doubleCountedSaldo).toBeCloseTo(1160, 2)
    expect(r.doubleCounted[0]).toMatchObject({ remision: 'REM-X', factura: 'F-X', cxc_status: 'pending' })
    expect(r.invoicesWithoutAr).toBe(0)
  })

  test('tras cancelar la CXC de remisión (como hace la consolidación) → limpio', async () => {
    await withBypass(() => query(`UPDATE accounts_receivable SET status='cancelled' WHERE id=$1`, [arId]))
    const r = await getCxcIntegrity({ tenantId })
    expect(r.doubleCountedCount).toBe(0)
    expect(r.doubleCountedSaldo).toBeCloseTo(0, 2)
  })
})
