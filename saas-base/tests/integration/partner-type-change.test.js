'use strict'

/**
 * Cambiar el TIPO de un socio al editar (PATCH /business-partners/:id).
 *
 * Bug: updatePartner no recibía ni escribía `type` → un socio creado como
 * 'customer' no podía cambiarse a 'both' (ni a 'supplier'). El form mandaba el
 * nuevo tipo pero el backend lo ignoraba y el socio quedaba pegado en su tipo
 * viejo, así que no aparecía en los selectores de compras (OC/CXP/precios prov).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('PATCH /business-partners/:id — cambiar tipo', () => {
  let client, partnerId

  beforeAll(async () => {
    const info = await createTenant({ label: 'ptype', planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })

    const created = await client.post('/api/business-partners', {
      name: 'Cliente Que Sera Ambos', type: 'customer', rfc: 'XAXX010101000',
      tax_name: 'CLIENTE QUE SERA AMBOS', is_active: true,
    }).expect(201)
    partnerId = created.body.id
  })

  const getType = async () => {
    const res = await client.get(`/api/business-partners/${partnerId}`).expect(200)
    return res.body.type
  }

  test('cliente → ambos: el cambio SE GUARDA (antes se ignoraba)', async () => {
    expect(await getType()).toBe('customer')
    await client.patch(`/api/business-partners/${partnerId}`, { type: 'both' }).expect(200)
    expect(await getType()).toBe('both')
  })

  test('ahora aparece en el filtro de proveedores (role=supplier incluye both)', async () => {
    const res = await client.get('/api/business-partners?role=supplier').expect(200)
    const list = res.body.data || res.body
    expect(list.find(p => p.id === partnerId)).toBeTruthy()
  })

  test('sigue apareciendo como cliente (role=customer incluye both)', async () => {
    const res = await client.get('/api/business-partners?role=customer').expect(200)
    const list = res.body.data || res.body
    expect(list.find(p => p.id === partnerId)).toBeTruthy()
  })

  test('type inválido → 400', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, { type: 'amigo' }).expect(400)
    expect(await getType()).toBe('both')  // no cambió
  })

  test('editar SIN mandar type NO cambia el tipo', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, { notes: 'cambio sin tocar tipo' }).expect(200)
    expect(await getType()).toBe('both')
  })

  test('ambos → proveedor: también se puede acotar', async () => {
    await client.patch(`/api/business-partners/${partnerId}`, { type: 'supplier' }).expect(200)
    expect(await getType()).toBe('supplier')
  })
})
