'use strict'

/**
 * Producto de 2ª calidad por defecto (mig 221): createProduct/updateProduct lo
 * persisten; getProduct y list lo devuelven. NULL/'' lo limpian.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')
const productService = require('../../src/modules/products/productService')

let tenantId, userId

async function newProduct(sku, extra = {}) {
  return productService.createProduct({
    tenantId, sku, name: `Prod ${sku}`, isProduced: true,
    saleUnit: 'pieza', satUnitCode: 'H87', userId, ...extra,
  })
}

describe('products.second_quality_product_id (mig 221)', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'sqdef', planSlug: 'owner' })
    tenantId = t.tenant.id; userId = t.user.id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('createProduct persiste second_quality_product_id y getProduct lo devuelve', async () => {
    const secondQ = await newProduct('SQ-2A')                       // el SKU "Comercial"
    const first   = await newProduct('SQ-1A', { secondQualityProductId: secondQ.id })
    const detail  = await productService.getProduct({ tenantId, productId: first.id })
    expect(detail.second_quality_product_id).toBe(secondQ.id)
  })

  test('updateProduct fija y limpia el default', async () => {
    const secondQ = await newProduct('SQ-2B')
    const first   = await newProduct('SQ-1B')
    expect((await productService.getProduct({ tenantId, productId: first.id })).second_quality_product_id).toBeNull()

    await productService.updateProduct({ tenantId, productId: first.id, secondQualityProductId: secondQ.id, userId })
    expect((await productService.getProduct({ tenantId, productId: first.id })).second_quality_product_id).toBe(secondQ.id)

    await productService.updateProduct({ tenantId, productId: first.id, secondQualityProductId: '', userId })
    expect((await productService.getProduct({ tenantId, productId: first.id })).second_quality_product_id).toBeNull()
  })

  test('list incluye second_quality_product_id', async () => {
    const secondQ = await newProduct('SQ-2C')
    await newProduct('SQ-1C', { secondQualityProductId: secondQ.id })
    const { data } = await productService.listProducts({ tenantId, search: 'SQ-1C', page: 1, limit: 50 })
    const row = data.find(p => p.sku === 'SQ-1C')
    expect(row).toBeTruthy()
    expect(row.second_quality_product_id).toBe(secondQ.id)
  })
})
