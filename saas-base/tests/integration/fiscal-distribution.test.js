'use strict'

/**
 * Distribución de documentos fiscales (CSF + Opinión 32-D) a clientes.
 *
 * Mockeamos enqueueEmail para validar el flujo sin enviar correo real:
 *   - subir/consultar docs del tenant (attachments a nivel tenant)
 *   - preview de destinatarios (clientes activos con contactos con email)
 *   - envío: un correo por cliente + bitácora (fiscal_doc_sends/_recipients)
 *   - validaciones (sin docs, sin clientes)
 */

jest.mock('../../src/queues/emailQueue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ queued: true, jobId: 'x' }),
  emailQueue: null,
}))

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { enqueueEmail } = require('../../src/queues/emailQueue')

const PDF = Buffer.from('%PDF-1.4\n test doc fiscal\n%%EOF', 'utf8')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

async function createCustomer(client, { name, type = 'customer', emails = [] }) {
  const res = await client.post('/api/business-partners', {
    type, name,
    contacts: emails.map((email, i) => ({ name: `Contacto ${i + 1}`, email, isPrimary: i === 0 })),
  }).expect(201)
  return res.body
}

describe('Distribución de documentos fiscales a clientes', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'fiscaldist', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Clientes: A (2 correos), B (1 correo), C (sin correo), + un PROVEEDOR con correo.
    await createCustomer(client, { name: 'Cliente A', emails: ['a1@test.local', 'a2@test.local'] })
    await createCustomer(client, { name: 'Cliente B', emails: ['b1@test.local'] })
    await createCustomer(client, { name: 'Cliente C', emails: [] })
    await createCustomer(client, { name: 'Proveedor X', type: 'supplier', emails: ['prov@test.local'] })
  })

  beforeEach(() => enqueueEmail.mockClear())

  test('sin documentos cargados, enviar da 400', async () => {
    const res = await client.post('/api/fiscal-distribution/send', {}).expect(400)
    expect(res.body.error).toMatch(/documento fiscal/i)
  })

  test('sube la CSF y la consulta', async () => {
    await client.post('/api/fiscal-distribution/docs/csf')
      .attach('file', PDF, { filename: 'csf.pdf', contentType: 'application/pdf' })
      .expect(201)

    const res = await client.get('/api/fiscal-distribution/docs').expect(200)
    expect(res.body.csf).toBeTruthy()
    expect(res.body.csf.filename).toBe('csf.pdf')
    expect(res.body.opinion).toBeNull()
  })

  test('rechaza un archivo que no es PDF', async () => {
    await client.post('/api/fiscal-distribution/docs/csf')
      .attach('file', Buffer.from('hola'), { filename: 'x.txt', contentType: 'text/plain' })
      .expect(400)
  })

  test('preview cuenta clientes y correos, excluye proveedor y cliente sin email', async () => {
    const res = await client.post('/api/fiscal-distribution/preview', {}).expect(200)
    expect(res.body.clientCount).toBe(2)          // A y B (no proveedor)
    expect(res.body.recipientCount).toBe(3)       // a1, a2, b1
    const names = res.body.clientsWithoutEmail.map(c => c.name)
    expect(names).toContain('Cliente C')
    const clientNames = res.body.clients.map(c => c.name)
    expect(clientNames).not.toContain('Proveedor X')
  })

  test('envía: un correo por cliente + bitácora con destinatarios', async () => {
    const res = await client.post('/api/fiscal-distribution/send', {
      message: 'Adjuntamos nuestros documentos fiscales.',
    }).expect(200)

    expect(res.body.ok).toBe(true)
    expect(res.body.clientCount).toBe(2)
    expect(res.body.recipientCount).toBe(3)
    expect(res.body.failedCount).toBe(0)
    expect(res.body.status).toBe('completed')

    // Un enqueue por CLIENTE (no por correo).
    expect(enqueueEmail).toHaveBeenCalledTimes(2)
    const firstCall = enqueueEmail.mock.calls[0][0]
    expect(firstCall.tenantId).toBe(tenantInfo.tenant.id)
    expect(firstCall.attachments).toHaveLength(1)       // solo CSF cargada
    expect(Array.isArray(firstCall.to)).toBe(true)

    // Bitácora
    const hist = await client.get('/api/fiscal-distribution/sends').expect(200)
    expect(hist.body.length).toBe(1)
    expect(hist.body[0].recipient_count).toBe(3)

    const detail = await client.get(`/api/fiscal-distribution/sends/${hist.body[0].id}`).expect(200)
    expect(detail.body.recipients).toHaveLength(3)
    const emails = detail.body.recipients.map(r => r.email).sort()
    expect(emails).toEqual(['a1@test.local', 'a2@test.local', 'b1@test.local'])
    detail.body.recipients.forEach(r => expect(r.status).toBe('queued'))
  })

  test('enviar acotado a un cliente por partnerIds', async () => {
    const preview = await client.post('/api/fiscal-distribution/preview', {}).expect(200)
    const clienteB = preview.body.clients.find(c => c.name === 'Cliente B')

    const res = await client.post('/api/fiscal-distribution/send', {
      partnerIds: [clienteB.id],
    }).expect(200)
    expect(res.body.clientCount).toBe(1)
    expect(res.body.recipientCount).toBe(1)
    expect(enqueueEmail).toHaveBeenCalledTimes(1)
  })

  test('correos MANUALES combinados con clientes: asunto propio + bitácora con partner nulo', async () => {
    const res = await client.post('/api/fiscal-distribution/send', {
      subject: 'Mis documentos fiscales 2026',
      // 2 válidos únicos (dedupe + lowercase); 'malformado' se ignora.
      manualEmails: 'nuevo@ext.local, Otro@EXT.local, nuevo@ext.local, malformado',
    }).expect(200)

    expect(res.body.clientCount).toBe(2)          // A y B
    expect(res.body.manualCount).toBe(2)          // nuevo, otro
    expect(res.body.recipientCount).toBe(5)       // 3 de clientes + 2 manuales
    expect(res.body.failedCount).toBe(0)

    // enqueue: 2 clientes + 2 manuales = 4; todos con el asunto capturado.
    expect(enqueueEmail).toHaveBeenCalledTimes(4)
    enqueueEmail.mock.calls.forEach(([payload]) =>
      expect(payload.subject).toBe('Mis documentos fiscales 2026'))

    // Bitácora: los manuales van con partner_id null + partner_name '(Correo manual)'.
    const hist = await client.get('/api/fiscal-distribution/sends').expect(200)
    const mySend = hist.body.find(s => s.recipient_count === 5)
    expect(mySend).toBeTruthy()
    const detail = await client.get(`/api/fiscal-distribution/sends/${mySend.id}`).expect(200)
    const manualRecs = detail.body.recipients.filter(r => r.partner_id === null)
    expect(manualRecs.map(r => r.email).sort()).toEqual(['nuevo@ext.local', 'otro@ext.local'])
    manualRecs.forEach(r => expect(r.partner_name).toBe('(Correo manual)'))
  })

  test('SOLO manuales (partnerIds vacío) NO dispara a todos los clientes', async () => {
    const res = await client.post('/api/fiscal-distribution/send', {
      partnerIds: [],                      // selección vacía = ningún cliente
      manualEmails: ['solo@ext.local'],
    }).expect(200)
    expect(res.body.clientCount).toBe(0)
    expect(res.body.manualCount).toBe(1)
    expect(res.body.recipientCount).toBe(1)
    expect(enqueueEmail).toHaveBeenCalledTimes(1) // 1, NO los 3 correos de clientes
    expect(enqueueEmail.mock.calls[0][0].to).toBe('solo@ext.local')
  })

  test('sin clientes ni manuales válidos → 400', async () => {
    const res = await client.post('/api/fiscal-distribution/send', {
      partnerIds: [],
      manualEmails: 'noesuncorreo',
    }).expect(400)
    expect(res.body.error).toMatch(/destinatario|manual/i)
  })

  test('el asunto por default usa la RAZÓN SOCIAL del perfil fiscal, no el nombre comercial', async () => {
    // El tenant de prueba no tenía perfil fiscal → armamos uno con razón social.
    await withBypass(() => query(
      `INSERT INTO tenant_fiscal_profiles
         (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
       VALUES ($1, 'ABC010101AB1', $2, '601', '01000', true)`,
      [tenantInfo.tenant.id, 'RAZON SOCIAL PRUEBA SA DE CV']
    ))

    // Enviar SIN asunto → debe caer al default con la razón social.
    await client.post('/api/fiscal-distribution/send', {
      partnerIds: [],                       // solo un manual, para acotar
      manualEmails: 'destino@ext.local',
    }).expect(200)

    const subject = enqueueEmail.mock.calls[0][0].subject
    expect(subject).toBe('Documentos fiscales — RAZON SOCIAL PRUEBA SA DE CV')
  })
})
