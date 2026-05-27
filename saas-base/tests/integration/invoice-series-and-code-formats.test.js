'use strict'

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const invoiceSeriesService = require('../../src/modules/invoice-series/invoiceSeriesService')
const codeFormatService    = require('../../src/modules/code-formats/codeFormatService')

describe('Series de facturación y nomenclatura de códigos (147)', () => {
  let tenant
  let session
  let fiscalProfileId

  beforeAll(async () => {
    tenant = await createTenant({ label: 'series' })
    session = await loginAs({
      slug:     tenant.tenant.slug,
      email:    tenant.email,
      password: tenant.password,
    })

    // Crear perfil fiscal mínimo (necesario para tener fiscalProfileId)
    const res = await request(app)
      .post('/api/fiscal-profiles')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-Tenant-Slug', tenant.tenant.slug)
      .send({
        rfc:        'XAXX010101000',
        taxName:    'PUBLICO EN GENERAL',
        taxRegime:  '601',
        zipCode:    '01000',
        serie:      'A',
      })
      .expect(201)
    fiscalProfileId = res.body.id
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  // ───────────────────────── Series de folios ─────────────────────────────

  describe('Series de folios', () => {
    test('Al crear el perfil fiscal se generó automáticamente la serie default', async () => {
      // El service de fiscal-profiles ahora crea la serie default sola.
      const res = await request(app)
        .get('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      expect(res.body).toHaveLength(1)
      expect(res.body[0].serie).toBe('A')
      expect(res.body[0].is_default).toBe(true)
      expect(res.body[0].folio_next).toBe(1)
    })

    test('Editar folio_next: pasar de 1 a 1000 para migrar desde sistema viejo', async () => {
      const list = await request(app)
        .get('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
      const seriesA = list.body.find(s => s.serie === 'A')

      const res = await request(app)
        .patch(`/api/invoice-series/${seriesA.id}`)
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ folioNext: 1000 })
        .expect(200)

      expect(res.body.folio_next).toBe(1000)
    })

    test('No permite serie duplicada en el mismo perfil', async () => {
      const res = await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'A', folioNext: 1 })
        .expect(409)

      expect(res.body.error).toMatch(/ya existe/i)
    })

    test('Valida formato de serie (solo alfanuméricos)', async () => {
      const res = await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'A B!', folioNext: 1 })
        .expect(400)

      expect(res.body.error).toMatch(/serie debe tener/i)
    })

    test('Validar folio inicial >= 1', async () => {
      const res = await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'BAD', folioNext: 0 })
        .expect(400)

      expect(res.body.error).toMatch(/folio inicial/i)
    })

    test('Toggle isDefault desmarca la anterior', async () => {
      const res1 = await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'B', folioNext: 1, isDefault: true })
        .expect(201)

      const list = await request(app)
        .get('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      const seriesA = list.body.find(s => s.serie === 'A')
      const seriesB = list.body.find(s => s.serie === 'B')
      expect(seriesA.is_default).toBe(false)
      expect(seriesB.is_default).toBe(true)
    })

    test('consumeNextFolio es atómico bajo concurrencia (10 emisiones paralelas)', async () => {
      // Crear una serie dedicada para no chocar con los tests previos
      const created = await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'CONC', folioNext: 1 })
        .expect(201)
      const seriesId = created.body.id

      const { withTransaction } = require('../../src/db')

      const consume = () => withTransaction(client =>
        invoiceSeriesService.consumeNextFolio({ client, seriesId })
      )

      const folios = await Promise.all(Array.from({ length: 10 }, consume))
      const numbers = folios.map(f => f.folio).sort((a, b) => a - b)
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    })

    test('Resolver series elige default + cfdiType > default genérico', async () => {
      // Crear una serie default para 'E' (notas de crédito)
      await request(app)
        .post('/api/invoice-series')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ fiscalProfileId, serie: 'NC', folioNext: 1, cfdiType: 'E', isDefault: true })
        .expect(201)

      const { withTransaction } = require('../../src/db')

      // Resolver con cfdiType='E' debe devolver 'NC', no la default genérica
      const resolved = await withTransaction(client =>
        invoiceSeriesService.resolveSeriesForEmission({
          client, tenantId: tenant.tenant.id, fiscalProfileId, cfdiType: 'E',
        })
      )
      expect(resolved.serie).toBe('NC')

      // Sin cfdiType debe caer al default genérico (B, marcada arriba)
      const resolvedGeneric = await withTransaction(client =>
        invoiceSeriesService.resolveSeriesForEmission({
          client, tenantId: tenant.tenant.id, fiscalProfileId,
        })
      )
      expect(resolvedGeneric.serie).toBe('B')
    })
  })

  // ────────────────────── Nomenclatura de códigos ─────────────────────────

  describe('Nomenclatura de códigos', () => {
    test('Sin formato configurado, previewNext devuelve mode=manual', async () => {
      const res = await request(app)
        .get('/api/code-formats/preview-next/product')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      expect(res.body.mode).toBe('manual')
      expect(res.body.code).toBeNull()
    })

    test('PUT /code-formats/:entity crea formato', async () => {
      const res = await request(app)
        .put('/api/code-formats/customer')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ pattern: 'CLI-{seq}', padding: 4, nextSeq: 42, mode: 'suggested' })
        .expect(200)

      expect(res.body.pattern).toBe('CLI-{seq}')
      expect(res.body.next_seq).toBe(42)
      expect(res.body.mode).toBe('suggested')
    })

    test('Rechaza patrón sin {seq}', async () => {
      const res = await request(app)
        .put('/api/code-formats/customer')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ pattern: 'CLI-NOSEQ', padding: 4, nextSeq: 1, mode: 'suggested' })
        .expect(400)

      expect(res.body.error).toMatch(/\{seq\}/i)
    })

    test('Rechaza variables no soportadas', async () => {
      const res = await request(app)
        .put('/api/code-formats/customer')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ pattern: 'CLI-{año}-{seq}', padding: 4, nextSeq: 1, mode: 'suggested' })
        .expect(400)

      expect(res.body.error).toMatch(/no soportada/i)
    })

    test('previewNext devuelve el código resuelto con padding', async () => {
      const res = await request(app)
        .get('/api/code-formats/preview-next/customer')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .expect(200)

      expect(res.body.code).toBe('CLI-0042')
      expect(res.body.mode).toBe('suggested')
    })

    test('consumeNext es atómico (5 capturas paralelas)', async () => {
      await request(app)
        .put('/api/code-formats/product')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ pattern: 'PRD-{seq}', padding: 3, nextSeq: 1, mode: 'auto' })
        .expect(200)

      const { withTransaction } = require('../../src/db')
      const consume = () => withTransaction(client =>
        codeFormatService.consumeNext({ client, tenantId: tenant.tenant.id, entityType: 'product' })
      )

      const results = await Promise.all(Array.from({ length: 5 }, consume))
      const codes = results.map(r => r.code).sort()
      expect(codes).toEqual(['PRD-001', 'PRD-002', 'PRD-003', 'PRD-004', 'PRD-005'])
    })

    test('Modo manual no consume seq', async () => {
      await request(app)
        .put('/api/code-formats/supplier')
        .set('Authorization', `Bearer ${session.token}`)
        .set('X-Tenant-Slug', tenant.tenant.slug)
        .send({ pattern: 'PROV-{seq}', padding: 4, nextSeq: 1, mode: 'manual' })
        .expect(200)

      const { withTransaction } = require('../../src/db')
      const result = await withTransaction(client =>
        codeFormatService.consumeNext({ client, tenantId: tenant.tenant.id, entityType: 'supplier' })
      )
      expect(result).toBeNull()
    })
  })
})
