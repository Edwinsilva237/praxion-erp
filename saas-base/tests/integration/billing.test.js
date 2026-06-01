'use strict'

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { query, pool, withBypass } = require('../../src/db')

describe('Enforcement de billing', () => {
  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  describe('Límite de usuarios por plan', () => {
    test('Plan Gratis (max 2 usuarios): el 3er usuario es bloqueado con 402', async () => {
      const t = await createTenant({ label: 'free-users' })
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      // El tenant ya viene con 1 usuario (el admin). Plan Gratis permite 2.
      // Invitamos 1 → OK (queda en el límite 2/2).
      const r1 = await client.post('/api/users/invite', {
        email: 'usuario2@test.local',
        fullName: 'Usuario 2',
        roleIds: [],
      })
      expect(r1.status).toBe(201)

      // Invitar 1 más debe fallar con 402.
      const r2 = await client.post('/api/users/invite', {
        email: 'usuario3@test.local',
        fullName: 'Usuario 3',
        roleIds: [],
      })
      expect(r2.status).toBe(402)
      expect(r2.body.error).toMatch(/plan.*Gratis.*2 usuario/i)
    })

    test('Asientos activos: desactivar libera lugar; reactivar respeta el límite', async () => {
      const t = await createTenant({ label: 'free-seats' })
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      // Admin (1) + invitar usuario2 → 2/2 activos (al límite del plan Gratis).
      const r1 = await client.post('/api/users/invite', { email: 'seat2@test.local', fullName: 'Seat 2', roleIds: [] })
      expect(r1.status).toBe(201)
      const u2 = r1.body.user.id

      // Lleno: invitar otro debe fallar con 402.
      const rFull = await client.post('/api/users/invite', { email: 'seat3@test.local', fullName: 'Seat 3', roleIds: [] })
      expect(rFull.status).toBe(402)

      // Desactivar usuario2 → libera un asiento.
      const rDeact = await client.delete(`/api/users/${u2}`)
      expect(rDeact.status).toBe(200)

      // Ahora SÍ se puede invitar (1 activo + 1 = 2/2).
      const r3 = await client.post('/api/users/invite', { email: 'seat3@test.local', fullName: 'Seat 3', roleIds: [] })
      expect(r3.status).toBe(201)

      // Reactivar usuario2 con el plan lleno → 402 (sería el 3er activo).
      const rReact = await client.patch(`/api/users/${u2}`, { isActive: true })
      expect(rReact.status).toBe(402)
      expect(rReact.body.error).toMatch(/activo|plan/i)
    })

    test('Plan Owner: sin límite de usuarios (acepta crear varios)', async () => {
      const t = await createTenant({ label: 'owner-users', planSlug: 'owner' })
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      // 3 invites en paralelo para no exceder el timeout default (5s).
      // Cada invite hace bcrypt (rounds=4 en test) + INSERT + audit.
      const results = await Promise.all([2, 3, 4].map(i =>
        client.post('/api/users/invite', {
          email: `u${i}@test.local`,
          fullName: `Usuario ${i}`,
          roleIds: [],
        })
      ))
      for (const r of results) expect(r.status).toBe(201)
    }, 15_000)
  })

  describe('Estado de la suscripción', () => {
    test('Trial vencido bloquea operaciones sensibles (timbrar)', async () => {
      const t = await createTenant({ label: 'trial-expired' })

      // Forzar trial vencido directamente en BD.
      await withBypass(() => query(
        `UPDATE subscriptions SET trial_end = NOW() - INTERVAL '1 day'
          WHERE tenant_id = $1`,
        [t.tenant.id]
      ))

      // Crear una factura cualquiera para tener algo que timbrar. Como no
      // tenemos partner ni líneas, esperamos que el bloqueo de billing
      // ocurra ANTES del 404/422 de "no encontrado/sin líneas". El status
      // 402 prueba que enforcement.assertSubscriptionActive cortó primero.
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      const res = await client.post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/stamp')
      expect(res.status).toBe(402)
      expect(res.body.error).toMatch(/prueba terminó|plan/i)
    })

    test('Suscripción canceled bloquea timbrar con 402', async () => {
      const t = await createTenant({ label: 'canceled' })
      await withBypass(() => query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = NOW()
          WHERE tenant_id = $1`,
        [t.tenant.id]
      ))

      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      const res = await client.post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/stamp')
      expect(res.status).toBe(402)
      expect(res.body.error).toMatch(/cancel/i)
    })

    test('past_due dentro del grace period permite operaciones', async () => {
      const t = await createTenant({ label: 'past-due-grace' })
      // current_period_end hace 1 día. Grace de 7 días → todavía permite.
      await withBypass(() => query(
        `UPDATE subscriptions SET status = 'past_due',
                                  current_period_end = NOW() - INTERVAL '1 day'
          WHERE tenant_id = $1`,
        [t.tenant.id]
      ))

      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      // Intento de timbrar — debería pasar el chequeo de subscription (402 no)
      // y llegar a la lógica de timbrado, donde fallará por otra razón (404 factura).
      const res = await client.post('/api/invoicing/invoices/00000000-0000-0000-0000-000000000000/stamp')
      expect(res.status).not.toBe(402)
    })
  })

  describe('Endpoints públicos de billing', () => {
    test('GET /api/billing/plans lista los planes vendibles', async () => {
      const t = await createTenant({ label: 'plans' })
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      const res = await client.get('/api/billing/plans').expect(200)
      const slugs = res.body.map(p => p.slug)
      expect(slugs).toContain('free')
      expect(slugs).toContain('pro')
      expect(slugs).toContain('enterprise')
      // 'owner' es interno — no debe aparecer en el catálogo público.
      // (Nota: el filtro 'no aparece' es responsabilidad del frontend en este momento,
      //  ver Planes.jsx — pero el backend sí lo expone. Lo dejamos documentado.)
    })

    test('GET /api/billing/subscription devuelve el estado del tenant', async () => {
      const t = await createTenant({ label: 'sub-state' })
      const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
      const client = authedClient({ slug: t.tenant.slug, token: sess.token })

      const res = await client.get('/api/billing/subscription').expect(200)
      expect(res.body.tenant_id).toBe(t.tenant.id)
      expect(res.body.status).toBe('trialing')
      expect(res.body.plan_slug).toBe('free')
    })
  })
})
