'use strict'

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, withTransaction } = require('../../src/db')
const documentSeriesService = require('../../src/modules/document-series/documentSeriesService')

describe('Series generalizadas (148) — todos los documentos', () => {
  let tenant
  let session

  beforeAll(async () => {
    tenant = await createTenant({ label: 'docser' })
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

  test('GET /document-series/meta devuelve entity_types y agrupación', async () => {
    const res = await request(app)
      .get('/api/document-series/meta')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .expect(200)

    expect(res.body.entityTypes).toContain('sales_order')
    expect(res.body.entityTypes).toContain('purchase_order')
    expect(res.body.entityTypes).toContain('inventory_adjustment')
    expect(res.body.groups.ventas).toContain('sales_order')
    expect(res.body.groups.compras).toContain('purchase_order')
    expect(res.body.labels.sales_order).toMatch(/pedidos/i)
  })

  describe('Series para no-facturas (sin fiscal_profile)', () => {
    test('Crear serie para sales_order sin fiscalProfileId', async () => {
      const res = await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({
          entityType: 'sales_order',
          serie:      'A',
          folioNext:  100,
          isDefault:  true,
        })
        .expect(201)

      expect(res.body.entity_type).toBe('sales_order')
      expect(res.body.serie).toBe('A')
      expect(res.body.folio_next).toBe(100)
      expect(res.body.fiscal_profile_id).toBeNull()
    })

    test('Bloquea pasar fiscalProfileId a entity no-fiscal', async () => {
      const res = await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({
          entityType: 'purchase_order',
          fiscalProfileId: '00000000-0000-0000-0000-000000000000',
          serie: 'B',
          folioNext: 1,
        })
        .expect(400)

      expect(res.body.error).toMatch(/no usa perfil fiscal/i)
    })

    test('Bloquea pasar cfdiType a entity no-fiscal', async () => {
      const res = await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({
          entityType: 'quotation',
          cfdiType: 'I',
          serie: 'Q',
          folioNext: 1,
        })
        .expect(400)

      expect(res.body.error).toMatch(/no usa cfdi_type/i)
    })

    test('Bloquea crear serie de invoice sin fiscalProfileId', async () => {
      const res = await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({
          entityType: 'invoice',
          serie: 'X',
          folioNext: 1,
        })
        .expect(400)

      expect(res.body.error).toMatch(/requieren un perfil fiscal/i)
    })
  })

  describe('Filtros y listado por entity_type', () => {
    beforeAll(async () => {
      // Crear varias series de tipos distintos
      const create = (entityType, serie, isDefault = false) => request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ entityType, serie, folioNext: 1, isDefault })

      await create('purchase_order',       'OC', true)
      await create('quotation',             'COT', true)
      await create('inventory_adjustment',  'AJ',  true)
      await create('delivery_note',         'REM', true)
    })

    test('GET filtrando por entityType=sales_order solo trae esos', async () => {
      const res = await request(app)
        .get('/api/document-series?entityType=sales_order')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      expect(res.body.length).toBeGreaterThanOrEqual(1)
      for (const s of res.body) {
        expect(s.entity_type).toBe('sales_order')
      }
    })

    test('GET sin filtro trae todas las series del tenant', async () => {
      const res = await request(app)
        .get('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      const types = new Set(res.body.map(s => s.entity_type))
      expect(types.has('sales_order')).toBe(true)
      expect(types.has('purchase_order')).toBe(true)
      expect(types.has('quotation')).toBe(true)
    })
  })

  describe('Consumo de folio para no-facturas', () => {
    test('generateDocumentNumber para sales_order usa la serie default', async () => {
      const result = await withTransaction(client =>
        documentSeriesService.generateDocumentNumber({
          client, tenantId: tenant.tenant.id, entityType: 'sales_order',
        })
      )
      expect(result).toBeTruthy()
      expect(result.serie).toBe('A')
      expect(result.docNumber).toMatch(/^A-\d{4}$/)
    })

    test('Si no hay serie configurada, devuelve null (caller usa legacy)', async () => {
      const result = await withTransaction(client =>
        documentSeriesService.generateDocumentNumber({
          client, tenantId: tenant.tenant.id, entityType: 'supplier_receipt',
        })
      )
      // Para supplier_receipt no creamos serie en este test
      expect(result).toBeNull()
    })

    test('Concurrencia: 8 emisiones paralelas obtienen folios únicos', async () => {
      // Crear serie dedicada
      const created = await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ entityType: 'supplier_receipt', serie: 'RP', folioNext: 1, isDefault: true })
        .expect(201)
      const seriesId = created.body.id

      const consume = () => withTransaction(client =>
        documentSeriesService.consumeNextFolio({ client, seriesId })
      )

      const folios = await Promise.all(Array.from({ length: 8 }, consume))
      const nums = folios.map(f => f.folio).sort((a, b) => a - b)
      expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    test('Default único por (tenant, entity_type): crear otra default desmarca la anterior', async () => {
      // Crear segunda serie para purchase_order como default
      await request(app)
        .post('/api/document-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ entityType: 'purchase_order', serie: 'OCNEW', folioNext: 1, isDefault: true })
        .expect(201)

      const list = await request(app)
        .get('/api/document-series?entityType=purchase_order')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)

      const defaults = list.body.filter(s => s.is_default)
      expect(defaults).toHaveLength(1)
      expect(defaults[0].serie).toBe('OCNEW')
    })
  })
})
