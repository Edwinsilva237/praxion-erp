'use strict'

/**
 * Tarjetas de crédito (mig 212): catálogo CRUD, asociación opcional al pagar un
 * gasto con tarjeta, y el escaneo de recordatorios de pago (scanDuePayments).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const cards = require('../../src/modules/credit-cards/service')
const supplierInvoiceService = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, supplierId, scanTenantId

beforeAll(async () => {
  const info = await createTenant({ label: 'cards', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Tarjeta') RETURNING id`,
    [tenantId]))
  supplierId = rows[0].id

  const scan = await createTenant({ label: 'cardscan', planSlug: 'owner' })
  scanTenantId = scan.tenant.id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('CRUD + validaciones', () => {
  let cardId

  test('create: da de alta una tarjeta con responsable', async () => {
    const c = await cards.create({
      tenantId, userId,
      body: { alias: 'BBVA Oro', bankName: 'BBVA', lastFour: '4321',
              statementDay: 5, paymentDay: 25, responsibleUserId: userId, creditLimit: 50000 },
    })
    cardId = c.id
    expect(c.alias).toBe('BBVA Oro')
    expect(c.statement_day).toBe(5)
    expect(c.payment_day).toBe(25)
    expect(c.reminder_lead_days).toBe(3)   // default
    expect(c.responsible_user_id).toBe(userId)
  })

  test('list: aparece y trae el nombre del responsable', async () => {
    const list = await cards.list({ tenantId })
    expect(list.find(c => c.id === cardId)).toBeTruthy()
    expect(list.find(c => c.id === cardId).responsible_full_name).toBeTruthy()
  })

  test('update: cambia el día de pago', async () => {
    const c = await cards.update({ tenantId, userId, id: cardId, body: { paymentDay: 18 } })
    expect(c.payment_day).toBe(18)
  })

  test('validación: día de corte fuera de rango → 400', async () => {
    await expect(cards.create({ tenantId, userId, body: { alias: 'X', statementDay: 40, paymentDay: 10 } }))
      .rejects.toMatchObject({ status: 400 })
  })

  test('validación: últimos 4 inválidos → 400', async () => {
    await expect(cards.create({ tenantId, userId, body: { alias: 'X', statementDay: 5, paymentDay: 10, lastFour: 'AB12' } }))
      .rejects.toMatchObject({ status: 400 })
  })

  test('remove: soft-delete (active=false), no aparece en la lista activa', async () => {
    await cards.remove({ tenantId, userId, id: cardId })
    const active = await cards.list({ tenantId })
    expect(active.find(c => c.id === cardId)).toBeFalsy()
    const all = await cards.list({ tenantId, includeInactive: true })
    expect(all.find(c => c.id === cardId)?.active).toBe(false)
  })
})

describe('payExpense asociado a tarjeta', () => {
  test('pagar un gasto con method=credit_card guarda credit_card_id', async () => {
    const card = await cards.create({
      tenantId, userId, body: { alias: 'Amex', statementDay: 1, paymentDay: 20 },
    })
    const exp = await supplierInvoiceService.registerInvoice({
      tenantId, supplierId, documentNumber: 'CARD-PAY-1',
      uuidSat: 'c1000001-0000-0000-0000-000000000001',
      subtotal: 100, tax: 16, total: 116,
      invoiceDate: '2026-06-10', currency: 'MXN',
      isExpense: true, expenseCategoryId: null, userId,
    })
    await supplierInvoiceService.payExpense({
      tenantId, id: exp.id, method: 'credit_card', creditCardId: card.id, userId,
    })
    const { rows } = await withBypass(() => query(
      `SELECT method, credit_card_id FROM supplier_payments
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenantId]))
    expect(rows[0].method).toBe('credit_card')
    expect(rows[0].credit_card_id).toBe(card.id)
  })

  test('creditCardId inexistente → 400', async () => {
    const exp = await supplierInvoiceService.registerInvoice({
      tenantId, supplierId, documentNumber: 'CARD-PAY-2',
      uuidSat: 'c1000002-0000-0000-0000-000000000002',
      subtotal: 50, tax: 8, total: 58, invoiceDate: '2026-06-10', currency: 'MXN',
      isExpense: true, expenseCategoryId: null, userId,
    })
    await expect(supplierInvoiceService.payExpense({
      tenantId, id: exp.id, method: 'credit_card',
      creditCardId: '00000000-0000-0000-0000-000000000000', userId,
    })).rejects.toMatchObject({ status: 400 })
  })
})

describe('nextOccurrence (cálculo de fecha de pago)', () => {
  test('día futuro este mes', () => {
    const r = cards.nextOccurrence(25, '2026-06-10')
    expect(r.date.toISOString().slice(0, 10)).toBe('2026-06-25')
    expect(r.daysUntil).toBe(15)
    expect(r.cycle).toBe('2026-06')
  })
  test('día ya pasado → mes siguiente', () => {
    const r = cards.nextOccurrence(5, '2026-06-10')
    expect(r.date.toISOString().slice(0, 10)).toBe('2026-07-05')
    expect(r.cycle).toBe('2026-07')
  })
  test('clamp a fin de mes (31 en febrero)', () => {
    const r = cards.nextOccurrence(31, '2026-02-01')
    expect(r.date.toISOString().slice(0, 10)).toBe('2026-02-28')
  })
})

describe('scanDuePayments — recordatorios', () => {
  test('dispara alerta solo para tarjetas dentro de la ventana; dedup por ciclo', async () => {
    // A: vence en 2 días (lead 3) → dispara.  B: vence en 18 días (lead 1) → no.
    const cardA = await cards.create({ tenantId: scanTenantId, userId, body: { alias: 'Vence pronto', statementDay: 1, paymentDay: 12, reminderLeadDays: 3 } })
    await cards.create({ tenantId: scanTenantId, userId, body: { alias: 'Vence lejos',  statementDay: 1, paymentDay: 28, reminderLeadDays: 1 } })

    const fired = await cards.scanDuePayments({ tenantId: scanTenantId, today: '2026-06-10' })
    expect(fired).toBe(1)

    const { rows } = await withBypass(() => query(
      `SELECT type, severity, source_id, payload FROM tenant_alerts
        WHERE tenant_id = $1 AND type = 'credit_card_payment_due'`, [scanTenantId]))
    expect(rows.length).toBe(1)
    expect(rows[0].source_id).toBe(cardA.id)
    expect(rows[0].payload.cycle).toBe('2026-06')

    // Segunda corrida el mismo ciclo → dedup, 0 nuevas.
    const again = await cards.scanDuePayments({ tenantId: scanTenantId, today: '2026-06-10' })
    expect(again).toBe(0)
  })
})
