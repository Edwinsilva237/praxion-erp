'use strict'

/**
 * Reemplazar capturista en turno ACTIVO (POST /shifts/:id/replace-member).
 *
 * Verifica:
 *  - El saliente queda con left_at y pierde el handover; el entrante entra activo
 *    con el mismo rol y hereda el handover.
 *  - production_shifts.operator_id se reapunta al nuevo (si el saliente lo ocupaba).
 *  - userCanActOnShift: el nuevo puede capturar, el anterior ya no.
 *  - Rechaza mismo usuario, usuario ajeno, y turno ya validado.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { openShift, createRawMaterial, createProduct, createOrder } = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

describe('POST /shifts/:id/replace-member — reemplazar capturista en turno activo', () => {
  let client, tenantId, sess, shift, captRoleId, userB

  beforeAll(async () => {
    const info = await createTenant({ label: uniq('replace'), planSlug: 'owner' })
    sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    tenantId = info.tenant.id

    // Rol capturista (reusa el del seed o lo crea).
    captRoleId = await withBypass(async () => {
      const { rows } = await query(
        `SELECT id FROM tenant_shift_roles WHERE tenant_id=$1 AND code='capturista' AND is_active=true LIMIT 1`,
        [tenantId]
      )
      if (rows[0]) return rows[0].id
      const ins = await query(
        `INSERT INTO tenant_shift_roles (tenant_id, code, name, can_capture, is_required, is_unique_per_shift, is_active)
         VALUES ($1,'capturista','Capturista',true,true,true,true) RETURNING id`,
        [tenantId]
      )
      return ins.rows[0].id
    })

    // Segundo usuario del tenant (el nuevo capturista).
    userB = await withBypass(async () => {
      const { rows } = await query(
        `INSERT INTO users (tenant_id, email, full_name, is_active)
         VALUES ($1, $2, 'Capturista Nuevo', true) RETURNING id, full_name`,
        [tenantId, `${uniq('nuevo')}@test.local`]
      )
      return rows[0]
    })

    // Turno activo con el owner como capturista (operator_id + miembro = flujo real).
    shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })
    await withBypass(() => query(
      `INSERT INTO production_shift_members (shift_id, user_id, role_id, is_handover_responsible)
       VALUES ($1, $2, $3, true)`,
      [shift.id, sess.user.id, captRoleId]
    ))

    // scheduled_shift ligado (la cuadrícula lee operator_name de aquí). Necesita una orden.
    const rm = await createRawMaterial(client, { name: uniq('MP') })
    const product = await createProduct(client, { sku: uniq('SKU') })
    const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 5 })
    await withBypass(() => query(
      `INSERT INTO scheduled_shifts
         (tenant_id, production_order_id, shift_number, scheduled_date, scheduled_start,
          operator_id, supervisor_id, line_id, status, shift_id)
       VALUES ($1, $2, '1', CURRENT_DATE, '08:00', $3, $3, 1, 'active', $4)`,
      [tenantId, order.id, sess.user.id, shift.id]
    ))
  })

  async function activeMemberId(userId) {
    const res = await client.get(`/api/production/shifts/${shift.id}/members`).expect(200)
    return res.body.find(m => m.user_id === userId && m.left_at === null)?.id
  }

  test('Reemplaza al capturista: saliente con left_at, entrante activo con el rol y handover heredado', async () => {
    const memberId = await activeMemberId(sess.user.id)
    const res = await client.post(`/api/production/shifts/${shift.id}/replace-member`, {
      memberId, newUserId: userB.id,
    }).expect(200)
    expect(res.body.incoming.userId).toBe(userB.id)
    expect(res.body.outgoing.userId).toBe(sess.user.id)

    const { rows } = await withBypass(() => query(
      `SELECT user_id, role_id, left_at, is_handover_responsible
         FROM production_shift_members WHERE shift_id=$1`, [shift.id]
    ))
    const out = rows.find(r => r.user_id === sess.user.id)
    const inc = rows.find(r => r.user_id === userB.id)
    expect(out.left_at).not.toBeNull()
    expect(out.is_handover_responsible).toBe(false)
    expect(inc.left_at).toBeNull()
    expect(inc.role_id).toBe(captRoleId)
    expect(inc.is_handover_responsible).toBe(true)
  })

  test('operator_id del turno se reapunta al nuevo capturista', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT operator_id FROM production_shifts WHERE id=$1`, [shift.id]
    ))
    expect(rows[0].operator_id).toBe(userB.id)
  })

  test('scheduled_shifts.operator_id (fuente de la cuadrícula) también se reapunta', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT operator_id, supervisor_id FROM scheduled_shifts WHERE shift_id=$1`, [shift.id]
    ))
    expect(rows[0].operator_id).toBe(userB.id)
    expect(rows[0].supervisor_id).toBe(userB.id)
  })

  test('La cuadrícula muestra el operador de RUNTIME aunque el plan tenga el viejo (caso reemplazo pre-fix)', async () => {
    // Simula el estado previo al espejo: el plan apunta al saliente, el runtime al nuevo.
    await withBypass(() => query(
      `UPDATE scheduled_shifts SET operator_id=$1 WHERE shift_id=$2`, [sess.user.id, shift.id]
    ))
    const res = await client.get('/api/production/scheduled-shifts').expect(200)
    const row = res.body.find(r => r.shift_id === shift.id)
    expect(row).toBeTruthy()
    // operator_name debe reflejar al de runtime (userB = 'Capturista Nuevo'), no al del plan.
    expect(row.operator_name).toBe('Capturista Nuevo')
  })

  test('El nuevo puede capturar y el anterior ya no (userCanActOnShift)', async () => {
    const { userCanActOnShift } = require('../../src/modules/production/shiftAuthService')
    expect(await userCanActOnShift({ shiftId: shift.id, userId: userB.id, capability: 'capture' })).toBe(true)
    expect(await userCanActOnShift({ shiftId: shift.id, userId: sess.user.id, capability: 'capture' })).toBe(false)
  })

  test('Rechaza reemplazar por el mismo usuario', async () => {
    const memberId = await activeMemberId(userB.id)
    const res = await client.post(`/api/production/shifts/${shift.id}/replace-member`, {
      memberId, newUserId: userB.id,
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza usuario ajeno al tenant', async () => {
    const memberId = await activeMemberId(userB.id)
    const res = await client.post(`/api/production/shifts/${shift.id}/replace-member`, {
      memberId, newUserId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza en turno ya validado (no runtime)', async () => {
    const memberId = await activeMemberId(userB.id)
    await withBypass(() => query(`UPDATE production_shifts SET status='reviewed' WHERE id=$1`, [shift.id]))
    const res = await client.post(`/api/production/shifts/${shift.id}/replace-member`, {
      memberId, newUserId: sess.user.id,
    })
    expect(res.status).toBe(400)
  })
})
