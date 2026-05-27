'use strict'

/**
 * Verifica que el cableado de applyCodeFormat en productService / partnerService
 * / rawMaterialService respete los modos auto / suggested / manual y consuma
 * el seq cuando corresponda. Antes del wiring, codeFormatService.consumeNext
 * estaba definido pero nadie lo llamaba — los códigos se quedaban pegados en
 * el preview hasta que un admin pasaba a la pantalla de Nomenclatura y los
 * actualizaba a mano.
 */

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

describe('applyCodeFormat — cableado en creates (149)', () => {
  let tenant, session

  beforeAll(async () => {
    tenant = await createTenant({ label: 'apply-fmt' })
    session = await loginAs({
      slug:     tenant.tenant.slug,
      email:    tenant.email,
      password: tenant.password,
    })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  // Helpers ───────────────────────────────────────────────────────────────────

  const auth = (req) => req
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Tenant-Slug', tenant.tenant.slug)

  async function configFormat(entity, body) {
    await auth(request(app).put(`/api/code-formats/${entity}`)).send(body).expect(200)
  }

  async function getNextSeq(entity) {
    return withBypass(async () => {
      const { rows } = await query(
        'SELECT next_seq FROM tenant_code_formats WHERE tenant_id=$1 AND entity_type=$2',
        [tenant.tenant.id, entity]
      )
      return rows[0]?.next_seq
    })
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  describe('createProduct', () => {
    test('mode=auto sobrescribe sku recibido y avanza next_seq', async () => {
      await configFormat('product', { pattern: 'PRD-{seq}', padding: 3, nextSeq: 50, mode: 'auto' })

      const res = await auth(request(app).post('/api/products')).send({
        sku:  'IGNORED-XYZ',
        name: 'Producto auto 1',
        type: 'resale',
        isProduced: false,
      }).expect(201)

      expect(res.body.sku).toBe('PRD-050')
      expect(await getNextSeq('product')).toBe(51)
    })

    test('mode=auto en 2 creaciones consecutivas genera SKUs únicos', async () => {
      const a = await auth(request(app).post('/api/products')).send({
        sku: 'X', name: 'A', type: 'resale', isProduced: false,
      }).expect(201)
      const b = await auth(request(app).post('/api/products')).send({
        sku: 'Y', name: 'B', type: 'resale', isProduced: false,
      }).expect(201)

      expect(a.body.sku).toBe('PRD-051')
      expect(b.body.sku).toBe('PRD-052')
      expect(a.body.sku).not.toBe(b.body.sku)
    })
  })

  // ─── Business partners ─────────────────────────────────────────────────────

  describe('createPartner', () => {
    test('customer mode=auto consume secuencia CLI', async () => {
      await configFormat('customer', { pattern: 'CLI-{seq}', padding: 4, nextSeq: 100, mode: 'auto' })

      const res = await auth(request(app).post('/api/business-partners')).send({
        type: 'customer', name: 'ACME Corp', personType: 'moral',
      }).expect(201)

      expect(res.body.internal_code).toBe('CLI-0100')
      expect(await getNextSeq('customer')).toBe(101)
    })

    test('supplier consume secuencia distinta (PROV) — no comparte seq con customer', async () => {
      await configFormat('supplier', { pattern: 'PROV-{seq}', padding: 4, nextSeq: 7, mode: 'auto' })

      const res = await auth(request(app).post('/api/business-partners')).send({
        type: 'supplier', name: 'Test Proveedor', personType: 'moral',
      }).expect(201)

      expect(res.body.internal_code).toBe('PROV-0007')
      expect(await getNextSeq('supplier')).toBe(8)
      // customer no avanzó
      expect(await getNextSeq('customer')).toBe(101)
    })

    test('type=both usa nomenclatura de customer (por convención del form)', async () => {
      const seqBefore = await getNextSeq('customer')

      const res = await auth(request(app).post('/api/business-partners')).send({
        type: 'both', name: 'Cliente y proveedor', personType: 'moral',
      }).expect(201)

      expect(res.body.internal_code).toBe(`CLI-${String(seqBefore).padStart(4, '0')}`)
      expect(await getNextSeq('customer')).toBe(seqBefore + 1)
    })

    test('mode=suggested + code matching consume seq', async () => {
      await configFormat('customer', { pattern: 'CLI-{seq}', padding: 4, nextSeq: 200, mode: 'suggested' })

      const res = await auth(request(app).post('/api/business-partners')).send({
        type: 'customer', name: 'Aceptó sugerencia', personType: 'moral',
        internalCode: 'CLI-0200',
      }).expect(201)

      expect(res.body.internal_code).toBe('CLI-0200')
      expect(await getNextSeq('customer')).toBe(201)
    })

    test('mode=suggested + code custom NO consume seq', async () => {
      await configFormat('customer', { pattern: 'CLI-{seq}', padding: 4, nextSeq: 300, mode: 'suggested' })

      const res = await auth(request(app).post('/api/business-partners')).send({
        type: 'customer', name: 'Code custom', personType: 'moral',
        internalCode: 'MIO-001',
      }).expect(201)

      expect(res.body.internal_code).toBe('MIO-001')
      expect(await getNextSeq('customer')).toBe(300)
    })
  })

  // ─── Raw materials por subtipo ─────────────────────────────────────────────

  describe('createRawMaterial', () => {
    test('itemKind=raw_material consume seq MP', async () => {
      await configFormat('raw_material', { pattern: 'MP-{seq}', padding: 3, nextSeq: 10, mode: 'auto' })

      const res = await auth(request(app).post('/api/raw-materials')).send({
        name: 'PE virgen', itemKind: 'raw_material', resinType: 'PE',
      }).expect(201)

      expect(res.body.code).toBe('MP-010')
      expect(await getNextSeq('raw_material')).toBe(11)
    })

    test('itemKind=packaging consume seq EMB independiente', async () => {
      await configFormat('packaging', { pattern: 'EMB-{seq}', padding: 3, nextSeq: 5, mode: 'auto' })

      const res = await auth(request(app).post('/api/raw-materials')).send({
        name: 'Bolsa transparente 30x40', itemKind: 'packaging',
      }).expect(201)

      expect(res.body.code).toBe('EMB-005')
      expect(await getNextSeq('packaging')).toBe(6)
      // MP no avanzó
      expect(await getNextSeq('raw_material')).toBe(11)
    })

    test('itemKind=additive consume seq ADI independiente', async () => {
      await configFormat('additive', { pattern: 'ADI-{seq}', padding: 3, nextSeq: 1, mode: 'auto' })

      const res = await auth(request(app).post('/api/raw-materials')).send({
        name: 'Colorante rojo', itemKind: 'additive',
      }).expect(201)

      expect(res.body.code).toBe('ADI-001')
      expect(await getNextSeq('additive')).toBe(2)
    })

    test('mode=manual no toca el código capturado a mano', async () => {
      // Cambiamos packaging a manual y verificamos que un code custom queda intacto.
      await configFormat('packaging', { pattern: 'EMB-{seq}', padding: 3, nextSeq: 99, mode: 'manual' })

      const res = await auth(request(app).post('/api/raw-materials')).send({
        name: 'Embalaje custom', itemKind: 'packaging', code: 'CUSTOM-Z9',
      }).expect(201)

      expect(res.body.code).toBe('CUSTOM-Z9')
      expect(await getNextSeq('packaging')).toBe(99)
    })
  })
})
