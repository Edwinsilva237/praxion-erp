'use strict'

/**
 * Fix 2026-06-09 — corrección de precio de remisión para productos cotizados en USD.
 *
 * MODELO (getSuggestedPrice): un producto en USD dentro de un documento en MXN guarda
 *   original_unit_price = precio USD,
 *   unit_price          = original_unit_price × applied_exchange_rate  (en pesos),
 *   original_currency   = 'USD'.
 * La facturación re-deriva el precio MXN desde original_unit_price × TC del día.
 *
 * Bug: adjustDeliveryNotePrices solo tocaba unit_price (pesos) → la factura ignoraba
 * la corrección. Fix: el usuario captura el precio EN USD; el backend guarda
 * original_unit_price=USD y recomputa unit_price = USD × TC de la línea. Líneas MXN
 * (sin original_currency) siguen capturándose en pesos.
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

// Crea una remisión en MXN con una línea cotizada en USD (o en MXN si isUsd=false).
async function makeNote({ productId, originalUnitPrice, rate = 17.4453, isUsd = true, qty = 36 }) {
  const unitPrice = isUsd ? +(originalUnitPrice * rate).toFixed(4) : originalUnitPrice
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, exchange_rate_value, subtotal_mxn, tax_mxn, total_mxn)
     VALUES ($1,'sale',$2,$3,'issued','MXN',$4,0,0,0) RETURNING id`,
    [tenantId, doc('REM'), partnerId, rate]))
  const noteId = dn[0].id
  const { rows: l } = await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit, unit_price,
        currency, discount_pct, line_number, original_unit_price, original_currency, applied_exchange_rate, pack_factor)
     VALUES ($1,$2,$3,$3,'millar',$4,'MXN',0,1,$5,$6,$7,1) RETURNING id`,
    [noteId, productId, qty, unitPrice,
     isUsd ? originalUnitPrice : null, isUsd ? 'USD' : null, isUsd ? rate : null]))
  return { noteId, lineId: l[0].id, unitPrice, rate }
}

async function lineState(lineId) {
  const { rows } = await withBypass(() => query(
    `SELECT unit_price, original_unit_price, original_currency FROM delivery_note_lines WHERE id = $1`, [lineId]))
  return rows[0]
}

describe('corrección de precio de remisión en USD captura dólares y recomputa pesos', () => {
  test('línea USD: corregir a $5.50 USD → original=5.50 y unit_price = 5.50 × TC (pesos)', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: '51 C3 1P TT' })
    const rate = 17.4453
    const { noteId, lineId } = await makeNote({ productId: p.id, originalUnitPrice: 5.20, rate })
    // sanity: arranca en 5.20 USD → 90.7156 pesos
    expect(parseFloat((await lineState(lineId)).unit_price)).toBeCloseTo(90.7156, 2)

    // El usuario captura el precio EN USD (5.50), no en pesos.
    await adjustDeliveryNotePrices({
      tenantId, noteId, userId,
      lines: [{ lineId, unitPrice: 5.50 }],
      reason: 'Precio en dólares acordado con el cliente',
    })

    const s = await lineState(lineId)
    expect(parseFloat(s.original_unit_price)).toBeCloseTo(5.50, 4)          // USD capturado
    expect(parseFloat(s.unit_price)).toBeCloseTo(5.50 * rate, 2)           // pesos = USD × TC
    expect(s.original_currency).toBe('USD')
  })

  test('línea USD: el total de la remisión se recalcula en pesos con el nuevo USD', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: 'Esquinero USD' })
    const rate = 17.4453
    const { noteId, lineId } = await makeNote({ productId: p.id, originalUnitPrice: 5.20, rate, qty: 36 })
    await adjustDeliveryNotePrices({
      tenantId, noteId, userId, lines: [{ lineId, unitPrice: 5.50 }], reason: 'Ajuste USD',
    })
    const { rows: nt } = await withBypass(() => query(
      `SELECT total_mxn FROM delivery_notes WHERE id = $1`, [noteId]))
    expect(parseFloat(nt[0].total_mxn)).toBeCloseTo(36 * 5.50 * rate, 1)   // pesos
  })

  test('línea MXN (sin original_currency): se captura en pesos y NO toca original_unit_price', async () => {
    const p = await createProduct(client, { sku: doc('P'), name: 'Esquinero MXN' })
    const { noteId, lineId } = await makeNote({ productId: p.id, originalUnitPrice: 100, isUsd: false })

    await adjustDeliveryNotePrices({
      tenantId, noteId, userId, lines: [{ lineId, unitPrice: 120 }], reason: 'Ajuste en pesos',
    })

    const s = await lineState(lineId)
    expect(parseFloat(s.unit_price)).toBe(120)
    expect(s.original_unit_price).toBeNull()
  })
})
