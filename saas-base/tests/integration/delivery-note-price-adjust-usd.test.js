'use strict'

/**
 * Fix 2026-06-09 — corrección de precio de remisión en USD.
 *
 * Bug: adjustDeliveryNotePrices actualizaba unit_price pero NO original_unit_price.
 * Al facturar, revalueLines lee original_unit_price (USD por unidad base) × TC ×
 * pack_factor → ignoraba la corrección y re-aplicaba el TC al precio viejo.
 *
 * Fix: para líneas en USD, la corrección también actualiza original_unit_price
 * (= nuevoPrecioUSD / pack_factor) en la remisión Y en el pedido espejado. Para
 * líneas MXN, original_unit_price queda intacto (NULL).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { adjustDeliveryNotePrices } = require('../../src/modules/sales/deliveryNoteService')
const { pool, query, withBypass } = require('../../src/db')

let tenantId, userId, partnerId, client, sess
let n = 0
const doc = (p) => `${p}-${Date.now() % 100000}-${n++}`

beforeAll(async () => {
  const info = await createTenant({ label: 'remusd', planSlug: 'owner' })
  tenantId = info.tenant.id
  sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  userId = sess.user.id
  client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente USD') RETURNING id`,
    [tenantId]))
  partnerId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

async function makeNote({ productId, unitPrice, originalUnitPrice, packFactor = 1, currency = 'USD', tc = 17 }) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, exchange_rate_value, subtotal_mxn, tax_mxn, total_mxn)
     VALUES ($1,'sale',$2,$3,'issued',$4,$5,0,0,0) RETURNING id`,
    [tenantId, doc('REM'), partnerId, currency, currency === 'USD' ? tc : null]))
  const noteId = dn[0].id
  const { rows: l } = await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit, unit_price,
        currency, discount_pct, line_number, original_unit_price, original_currency, pack_factor)
     VALUES ($1,$2,$3,$3,'paquete',$4,$5,0,1,$6,$7,$8) RETURNING id`,
    [noteId, productId, 10, unitPrice, currency,
     originalUnitPrice, currency === 'USD' ? 'USD' : null, packFactor]))
  return { noteId, lineId: l[0].id }
}

async function lineState(lineId) {
  const { rows } = await withBypass(() => query(
    `SELECT unit_price, original_unit_price, original_currency FROM delivery_note_lines WHERE id = $1`, [lineId]))
  return rows[0]
}

describe('corrección de precio de remisión en USD actualiza original_unit_price', () => {
  test('USD pack_factor=1: corregir a $12 USD deja original_unit_price=12 (no ignora la corrección)', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: 'Esquinero USD' })
    const { noteId, lineId } = await makeNote({ productId: p.id, unitPrice: 10, originalUnitPrice: 10, packFactor: 1 })

    await adjustDeliveryNotePrices({
      tenantId, noteId, userId,
      lines: [{ lineId, unitPrice: 12 }],
      reason: 'Ajuste de precio acordado con el cliente',
    })

    const s = await lineState(lineId)
    expect(parseFloat(s.unit_price)).toBe(12)
    expect(parseFloat(s.original_unit_price)).toBe(12) // ← antes quedaba en 10 → factura ignoraba la corrección
  })

  test('USD pack_factor=3 (rollo): corregir a $36/rollo deja original_unit_price=12/millar', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: 'Rollo USD' })
    const { noteId, lineId } = await makeNote({ productId: p.id, unitPrice: 30, originalUnitPrice: 10, packFactor: 3 })

    await adjustDeliveryNotePrices({
      tenantId, noteId, userId,
      lines: [{ lineId, unitPrice: 36 }],
      reason: 'Ajuste de precio del rollo',
    })

    const s = await lineState(lineId)
    expect(parseFloat(s.unit_price)).toBe(36)
    expect(parseFloat(s.original_unit_price)).toBeCloseTo(12, 4) // 36 / 3
  })

  test('MXN: la corrección NO toca original_unit_price (queda NULL)', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: 'Esquinero MXN' })
    const { noteId, lineId } = await makeNote({ productId: p.id, unitPrice: 100, originalUnitPrice: null, currency: 'MXN' })

    await adjustDeliveryNotePrices({
      tenantId, noteId, userId,
      lines: [{ lineId, unitPrice: 120 }],
      reason: 'Ajuste de precio en pesos',
    })

    const s = await lineState(lineId)
    expect(parseFloat(s.unit_price)).toBe(120)
    expect(s.original_unit_price).toBeNull()
  })
})
