'use strict'

/**
 * Editar contactos de un cliente (PATCH /business-partners/:id).
 *
 * Bug: updatePartner no recibía `contacts` → editar contactos de un socio no
 * guardaba nada (solo createPartner los insertaba). Ahora se sincronizan
 * (delete+insert) cuando el form los manda, y NO se borran cuando no.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('PATCH /business-partners/:id — contactos al editar', () => {
  let client, partnerId

  beforeAll(async () => {
    const info = await createTenant({ label: 'pcontacts', planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })

    const created = await client.post('/api/business-partners', {
      name: 'Cliente Contactos', type: 'customer', rfc: 'XAXX010101000',
      tax_name: 'CLIENTE CONTACTOS', is_active: true,
    }).expect(201)
    partnerId = created.body.id
  })

  const getContacts = async () => {
    const res = await client.get(`/api/business-partners/${partnerId}`).expect(200)
    return res.body.contacts || []
  }

  test('Al editar con contacts, se GUARDAN (antes se ignoraban)', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, {
      contacts: [
        { name: 'Juan Pérez', email: 'juan@cliente.mx', phone: '5551234567', isPrimary: true },
        { name: 'Ana Gómez',  position: 'Compras', email: 'ana@cliente.mx' },
      ],
    }).expect(200)

    const contacts = await getContacts()
    expect(contacts).toHaveLength(2)
    const juan = contacts.find(c => c.name === 'Juan Pérez')
    expect(juan).toBeTruthy()
    expect(juan.email).toBe('juan@cliente.mx')
    expect(juan.is_primary).toBe(true)
  })

  test('Volver a editar REEMPLAZA la lista (delete+insert)', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, {
      contacts: [{ name: 'Solo Uno', email: 'uno@cliente.mx', isPrimary: true }],
    }).expect(200)

    const contacts = await getContacts()
    expect(contacts).toHaveLength(1)
    expect(contacts[0].name).toBe('Solo Uno')
  })

  test('Editar SIN mandar contacts NO borra los existentes', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, {
      notes: 'cambio sin tocar contactos',
    }).expect(200)

    const contacts = await getContacts()
    expect(contacts).toHaveLength(1)
    expect(contacts[0].name).toBe('Solo Uno')
  })

  test('contacts:[] vacío SÍ borra todos (el form mandó lista vacía a propósito)', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, { contacts: [] }).expect(200)
    expect(await getContacts()).toHaveLength(0)
  })

  test('Solo un contacto primario aunque manden varios', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, {
      contacts: [
        { name: 'A', isPrimary: true },
        { name: 'B', isPrimary: true },
      ],
    }).expect(200)

    const contacts = await getContacts()
    expect(contacts.filter(c => c.is_primary)).toHaveLength(1)
  })
})
