'use strict'

/**
 * Módulo Comunicados: envío de avisos (texto + adjuntos) a clientes, proveedores
 * y correos manuales. Fase 2: el fan-out corre en 2º plano (pg-boss); en tests
 * pg-boss no arranca → distribute cae a envío SÍNCRONO inline, que usa
 * sendEmail directamente. Mockeamos sendEmail para validar el flujo sin enviar.
 */

jest.mock('../../src/modules/email/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'test-msg' }),
  verifyConnection: jest.fn().mockResolvedValue(true),
}))

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')
const { sendEmail } = require('../../src/modules/email/emailService')

const PDF = Buffer.from('%PDF-1.4\n aviso adjunto\n%%EOF', 'utf8')

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

async function createPartner(client, { name, type = 'customer', emails = [] }) {
  const res = await client.post('/api/business-partners', {
    type, name,
    contacts: emails.map((email, i) => ({ name: `Contacto ${i + 1}`, email, isPrimary: i === 0 })),
  }).expect(201)
  return res.body
}

describe('Comunicados a clientes/proveedores', () => {
  let client, tenantInfo, clienteA, clienteB, proveedorP

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'comunicados', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    clienteA   = await createPartner(client, { name: 'Cliente A', emails: ['a1@test.local', 'a2@test.local'] })
    clienteB   = await createPartner(client, { name: 'Cliente B', emails: ['b1@test.local'] })
    await createPartner(client, { name: 'Cliente C', emails: [] })          // sin correo
    proveedorP = await createPartner(client, { name: 'Proveedor P', type: 'supplier', emails: ['p1@test.local'] })
  })

  beforeEach(() => sendEmail.mockClear())

  test('recipients lista clientes y proveedores con correo, separa los sin correo', async () => {
    const res = await client.get('/api/communications/recipients').expect(200)
    expect(res.body.clients.map(c => c.name).sort()).toEqual(['Cliente A', 'Cliente B'])
    expect(res.body.suppliers.map(s => s.name)).toEqual(['Proveedor P'])
    expect(res.body.clientsWithoutEmail.map(c => c.name)).toContain('Cliente C')
  })

  test('enviar sin asunto → 400', async () => {
    const res = await client.post('/api/communications/send')
      .field('message', 'hola').expect(400)
    expect(res.body.error).toMatch(/asunto/i)
  })

  test('enviar sin destinatarios → 400', async () => {
    const res = await client.post('/api/communications/send')
      .field('subject', 'Aviso').expect(400)
    expect(res.body.error).toMatch(/destinatario/i)
  })

  test('envía a clientes + proveedores + manual con adjunto; dedupe + bitácora branded', async () => {
    const res = await client.post('/api/communications/send')
      .field('subject', 'Ajuste de precios julio')
      .field('message', 'Estimados, les informamos el ajuste de precios vigente.')
      .field('category', 'precios')
      .field('clientIds', JSON.stringify([clienteA.id, clienteB.id]))
      .field('supplierIds', JSON.stringify([proveedorP.id]))
      .field('manualEmails', 'a1@test.local, nuevo@ext.local')   // a1 duplica a Cliente A
      .attach('files', PDF, { filename: 'lista-precios.pdf', contentType: 'application/pdf' })
      .expect(201)

    expect(res.body.ok).toBe(true)
    expect(res.body.clientCount).toBe(2)
    expect(res.body.supplierCount).toBe(1)
    expect(res.body.manualCount).toBe(1)         // solo 'nuevo@' — a1 ya iba en Cliente A (dedupe)
    expect(res.body.recipientCount).toBe(5)      // A(2) + B(1) + P(1) + manual(1)
    expect(res.body.attachmentCount).toBe(1)
    expect(res.body.failedCount).toBe(0)
    expect(res.body.status).toBe('completed')

    // sendEmail: A, B, P (1 c/u a sus contactos) + 1 manual = 4 correos.
    expect(sendEmail).toHaveBeenCalledTimes(4)
    const first = sendEmail.mock.calls[0][0]
    expect(first.subject).toBe('Ajuste de precios julio')
    expect(first.html).toContain('Powered by')              // branded (pie Praxion)
    expect(first.attachments.some(a => a.filename === 'lista-precios.pdf')).toBe(true)

    // Bitácora: 5 destinatarios, tipos correctos, adjunto persistido.
    const hist = await client.get('/api/communications/sends').expect(200)
    const mine = hist.body.find(s => s.subject === 'Ajuste de precios julio')
    expect(mine.recipient_count).toBe(5)
    expect(mine.attachment_count).toBe(1)

    const detail = await client.get(`/api/communications/sends/${mine.id}`).expect(200)
    expect(detail.body.recipients).toHaveLength(5)
    const byType = detail.body.recipients.reduce((m, r) => (m[r.partner_type] = (m[r.partner_type] || 0) + 1, m), {})
    expect(byType).toEqual({ customer: 3, supplier: 1, manual: 1 }) // A(2)+B(1) customer, P supplier, nuevo manual
    // a1 aparece UNA sola vez (dedupe global).
    expect(detail.body.recipients.filter(r => r.email === 'a1@test.local')).toHaveLength(1)
    expect(detail.body.attachments).toHaveLength(1)

    // El adjunto se puede descargar.
    const att = detail.body.attachments[0]
    await client.get(`/api/communications/sends/${mine.id}/attachments/${att.id}/download`).expect(200)
  })

  test('solo a proveedores (sin clientes) funciona', async () => {
    const res = await client.post('/api/communications/send')
      .field('subject', 'Cierre por vacaciones')
      .field('supplierIds', JSON.stringify([proveedorP.id]))
      .expect(201)
    expect(res.body.clientCount).toBe(0)
    expect(res.body.supplierCount).toBe(1)
    expect(res.body.recipientCount).toBe(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  test('rechaza un adjunto de tipo no permitido (ejecutable)', async () => {
    const res = await client.post('/api/communications/send')
      .field('subject', 'x')
      .field('manualEmails', 'x@ext.local')
      .attach('files', Buffer.from('MZ'), { filename: 'virus.exe', contentType: 'application/x-msdownload' })
      .expect(400)
    expect(res.body.error).toMatch(/no permitido/i)
  })

  test('filtra el historial por categoría', async () => {
    const all = await client.get('/api/communications/sends').expect(200)
    expect(all.body.length).toBeGreaterThanOrEqual(2)
    const precios = await client.get('/api/communications/sends?category=precios').expect(200)
    expect(precios.body.length).toBeGreaterThanOrEqual(1)
    expect(precios.body.every(s => s.category === 'precios')).toBe(true)
  })

  // ── Plantillas ─────────────────────────────────────────────────────────────
  test('CRUD de plantillas', async () => {
    const created = await client.post('/api/communications/templates')
      .send({ name: 'Cierre anual', subject: 'Cerramos por fin de año', message: 'Estimados…', category: 'Vacaciones' })
      .expect(201)
    expect(created.body.id).toBeTruthy()

    const list = await client.get('/api/communications/templates').expect(200)
    expect(list.body.find(t => t.id === created.body.id)?.subject).toBe('Cerramos por fin de año')

    const upd = await client.put(`/api/communications/templates/${created.body.id}`)
      .send({ name: 'Cierre anual', subject: 'Cerramos del 20 al 5', message: 'Estimados…', category: 'Vacaciones' })
      .expect(200)
    expect(upd.body.subject).toBe('Cerramos del 20 al 5')

    await client.delete(`/api/communications/templates/${created.body.id}`).expect(200)
    const after = await client.get('/api/communications/templates').expect(200)
    expect(after.body.find(t => t.id === created.body.id)).toBeUndefined()
  })

  test('crear plantilla sin nombre → 400', async () => {
    const res = await client.post('/api/communications/templates').send({ subject: 'x' }).expect(400)
    expect(res.body.error).toMatch(/nombre/i)
  })

  // ── Categorías configurables ─────────────────────────────────────────────────
  test('CRUD de categorías + rechazo de duplicado', async () => {
    const c1 = await client.post('/api/communications/categories').send({ name: 'Promociones' }).expect(201)
    expect(c1.body.name).toBe('Promociones')

    // Duplicado (case-insensitive) → 409.
    await client.post('/api/communications/categories').send({ name: 'promociones' }).expect(409)

    const upd = await client.put(`/api/communications/categories/${c1.body.id}`)
      .send({ name: 'Promos', isActive: false }).expect(200)
    expect(upd.body.name).toBe('Promos')
    expect(upd.body.is_active).toBe(false)

    // activeOnly excluye la inactiva.
    const active = await client.get('/api/communications/categories?activeOnly=true').expect(200)
    expect(active.body.find(c => c.id === c1.body.id)).toBeUndefined()

    await client.delete(`/api/communications/categories/${c1.body.id}`).expect(200)
  })
})
