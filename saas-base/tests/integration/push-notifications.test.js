'use strict'

/**
 * Push notifications — device_tokens, audienceService, pushService (no-op sin
 * Firebase) y los endpoints /api/push/*.
 *
 * En test NO hay credenciales Firebase (tests/setup.js las vacía) → pushService
 * queda en no-op: sendToUsers/notify devuelven { skipped:true } sin lanzar ni
 * cargar firebase-admin. Eso es justo lo que verificamos aquí.
 */

const { query } = require('../../src/db')
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const deviceTokens   = require('../../src/modules/push/deviceTokenService')
const audienceService = require('../../src/modules/push/audienceService')
const pushService     = require('../../src/modules/push/pushService')

describe('Push notifications', () => {
  let A, B, adminClient

  beforeAll(async () => {
    A = await createTenant({ label: 'pusha' })
    B = await createTenant({ label: 'pushb' })
    const la = await loginAs({ slug: A.tenant.slug, email: A.email, password: A.password })
    adminClient = authedClient({ slug: A.tenant.slug, token: la.token })
  })

  afterAll(async () => {
    await cleanupTestTenants()
  })

  async function countToken(token) {
    const { rows } = await query(`SELECT tenant_id, user_id FROM device_tokens WHERE token = $1`, [token])
    return rows
  }

  describe('deviceTokenService', () => {
    test('registerToken inserta una fila para el (tenant,user)', async () => {
      const token = 'tok-register-1'
      const row = await deviceTokens.registerToken(A.tenant.id, A.user.id, { token, platform: 'android' })
      expect(row.token).toBe(token)
      expect(row.user_id).toBe(A.user.id)
      const rows = await countToken(token)
      expect(rows).toHaveLength(1)
    })

    test('re-registrar el MISMO token bajo otro user/tenant lo reclama (UNIQUE token)', async () => {
      const token = 'tok-reclaim'
      await deviceTokens.registerToken(A.tenant.id, A.user.id, { token, platform: 'android' })
      await deviceTokens.registerToken(B.tenant.id, B.user.id, { token, platform: 'android' })
      const rows = await countToken(token)
      expect(rows).toHaveLength(1)                 // sigue siendo UNA sola fila
      expect(rows[0].user_id).toBe(B.user.id)      // ahora pertenece a B
      expect(rows[0].tenant_id).toBe(B.tenant.id)
    })

    test('unregisterToken solo borra la fila del (tenant,user) que la pide', async () => {
      const token = 'tok-unregister'
      await deviceTokens.registerToken(A.tenant.id, A.user.id, { token, platform: 'android' })
      // Otro usuario/tenant NO puede borrarlo.
      const notMine = await deviceTokens.unregisterToken(B.tenant.id, B.user.id, token)
      expect(notMine).toBe(false)
      expect(await countToken(token)).toHaveLength(1)
      // El dueño sí.
      const mine = await deviceTokens.unregisterToken(A.tenant.id, A.user.id, token)
      expect(mine).toBe(true)
      expect(await countToken(token)).toHaveLength(0)
    })
  })

  describe('audienceService.resolveAudience', () => {
    test("'all' incluye al admin del tenant", async () => {
      const ids = await audienceService.resolveAudience(A.tenant.id, 'all')
      expect(ids).toContain(A.user.id)
    })

    test("{ permission } resuelve por reverse-RBAC (admin tiene alerts:read)", async () => {
      const ids = await audienceService.resolveAudience(A.tenant.id, { permission: ['alerts', 'read'] })
      expect(ids).toContain(A.user.id)
    })

    test('{ permission } inexistente devuelve vacío', async () => {
      const ids = await audienceService.resolveAudience(A.tenant.id, { permission: ['nope', 'read'] })
      expect(ids).toEqual([])
    })

    test('{ membershipRoles } filtra por rol de membresía (admin es owner)', async () => {
      const ids = await audienceService.resolveAudience(A.tenant.id, { membershipRoles: ['owner', 'admin'] })
      expect(ids).toContain(A.user.id)
    })

    test('{ userIds } passthrough con dedupe', async () => {
      const ids = await audienceService.resolveAudience(A.tenant.id, { userIds: [A.user.id, A.user.id] })
      expect(ids).toEqual([A.user.id])
    })
  })

  describe('pushService no-op sin Firebase', () => {
    test('isEnabled() es false en test', () => {
      expect(pushService.isEnabled()).toBe(false)
    })

    test('sendToUsers no lanza y devuelve skipped', async () => {
      const res = await pushService.sendToUsers(A.tenant.id, [A.user.id], { title: 'x', body: 'y' })
      expect(res.skipped).toBe(true)
    })

    test('notify no lanza y devuelve skipped', async () => {
      const res = await pushService.notify(A.tenant.id, { audience: 'all', title: 'x' })
      expect(res.skipped).toBe(true)
    })
  })

  describe('endpoints /api/push', () => {
    test('POST /register guarda el token (201)', async () => {
      const res = await adminClient.post('/api/push/register', { token: 'tok-route', platform: 'android' })
      expect(res.status).toBe(201)
      expect(res.body.id).toBeDefined()
      const rows = await countToken('tok-route')
      expect(rows).toHaveLength(1)
      expect(rows[0].user_id).toBe(A.user.id)
    })

    test('POST /register sin token → 400', async () => {
      const res = await adminClient.post('/api/push/register', { platform: 'android' })
      expect(res.status).toBe(400)
    })

    test('POST /unregister borra el token (removed:true)', async () => {
      const res = await adminClient.post('/api/push/unregister', { token: 'tok-route' })
      expect(res.status).toBe(200)
      expect(res.body.removed).toBe(true)
      expect(await countToken('tok-route')).toHaveLength(0)
    })

    test('POST /broadcast con permiso push:broadcast → 200 skipped (sin Firebase)', async () => {
      const res = await adminClient.post('/api/push/broadcast', { title: 'Aviso', body: 'Hola' })
      expect(res.status).toBe(200)
      expect(res.body.skipped).toBe(true)
    })

    test('POST /broadcast sin title → 400', async () => {
      const res = await adminClient.post('/api/push/broadcast', { body: 'sin titulo' })
      expect(res.status).toBe(400)
    })
  })
})
