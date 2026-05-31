'use strict'

/**
 * Overhead — default_expected_basis_divisor (mig 181).
 *
 * Verifica que el "turnos/horas/kg esperados al mes" configurado por ítem se
 * copie al expected_basis_divisor del período generado, para que el estimado
 * intra-mes se reparta (en vez de cargar el monto completo por turno).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Overhead: default_expected_basis_divisor → período del mes', () => {
  let client
  let itemId

  beforeAll(async () => {
    const tenantInfo = await createTenant({ label: 'ovhdiv', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea ítem con default_expected_basis_divisor y persiste', async () => {
    const res = await client.post('/api/overhead/items', {
      code: 'renta_div', name: 'Renta test',
      allocation_base: 'shifts', capture_frequency: 'monthly',
      default_estimated_amount: 6000,
      default_expected_basis_divisor: 60,
    }).expect(201)
    expect(parseFloat(res.body.default_expected_basis_divisor)).toBe(60)
    itemId = res.body.id
  })

  test('ensure-current copia el divisor del ítem al período generado', async () => {
    const res = await client.post('/api/overhead/periods/ensure-current', { year: 2030, month: 6 }).expect(201)
    const period = res.body.rows.find(r => parseFloat(r.estimated_amount) === 6000)
    expect(period).toBeTruthy()
    expect(parseFloat(period.expected_basis_divisor)).toBe(60)
  })

  test('Editar el monto/divisor del ítem propaga a los períodos NO finalizados', async () => {
    await client.patch(`/api/overhead/items/${itemId}`, {
      default_estimated_amount: 9000,
      default_expected_basis_divisor: 90,
    }).expect(200)
    const res = await client.get('/api/overhead/periods?year=2030&month=6&itemId=' + itemId).expect(200)
    const period = res.body.find(p => p.overhead_item_id === itemId)
    expect(period).toBeTruthy()
    expect(parseFloat(period.estimated_amount)).toBe(9000)        // propagado
    expect(parseFloat(period.expected_basis_divisor)).toBe(90)    // propagado
  })

  test('Rechaza divisor <= 0', async () => {
    const res = await client.post('/api/overhead/items', {
      code: 'bad_div', name: 'Bad', allocation_base: 'shifts',
      default_estimated_amount: 100, default_expected_basis_divisor: 0,
    })
    expect(res.status).toBe(400)
  })

  test('Acepta ítem sin divisor (null) — comportamiento previo', async () => {
    const res = await client.post('/api/overhead/items', {
      code: 'sin_div', name: 'Sin divisor', allocation_base: 'shifts',
      default_estimated_amount: 500,
    }).expect(201)
    expect(res.body.default_expected_basis_divisor).toBeNull()
  })
})
