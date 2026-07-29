'use strict'

/**
 * Cierre de mes — recrear tras cancelar/aplicar NO debe chocar el folio.
 *
 * Bug (reportado 2026-06-30): el folio del cierre de mes es fijo CONT-YYYYMM-CM
 * y la validación "un cierre por mes" solo bloquea los ACTIVOS (in_capture/
 * reconciling). Un cierre CANCELADO o APLICADO deja el folio ocupado → el
 * siguiente intento del mismo mes violaba el UNIQUE ic_number_tenant (23505),
 * que el front mostraba como un genérico "Internal server error".
 *
 * Fix: el folio usa sufijo incremental (CM-2, CM-3…) cuando el base ya existe.
 * La regla "un cierre ACTIVO por mes" se sigue garantizando por el chequeo de
 * status (cubierto en otra prueba).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const countService = require('../../src/modules/inventory/inventoryCountService')

let tenantId, userId

// El folio del cierre se arma con el mes de HOY (`nextCountNumber` usa
// `new Date()`), NO con `countDate`. Por eso el mes esperado se DERIVA aquí en
// vez de escribirse fijo: antes decía 'CONT-202606-CM' y empezó a fallar solo
// el 1-jul-2026, cuando el folio pasó a ser de julio aunque el conteo siguiera
// fechado el 30-jun. Lo que esta prueba verifica es el folio INCREMENTAL
// (CM-2, CM-3) al recrear, no de qué mes es el folio.
// ⚠️ Que un cierre de JUNIO capturado en JULIO reciba folio de julio es una
// decisión de negocio pendiente de revisar con el usuario (lo normal es cerrar
// el mes ya empezado el siguiente), no algo que esta prueba deba fijar.
const YYYYMM = new Date().toISOString().slice(0, 7).replace('-', '')
const CM_BASE = `CONT-${YYYYMM}-CM`

describe('Cierre de mes — folio único al recrear', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'cmrefolio', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId   = t.user.id
    const wh = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'MP', 'raw_material', true) RETURNING id`, [tenantId]))
    const { rows: rm } = await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id, name, is_active)
       VALUES ($1, 'RM refolio', true) RETURNING id`, [tenantId]))
    await withBypass(() => query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost)
       VALUES ($1, $2, 'raw_material', $3, 'available', 10, 'kg', 3)`,
      [tenantId, wh.rows[0].id, rm[0].id]))
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('cancelar un cierre y recrear otro el mismo mes funciona (folio CM-2)', async () => {
    const c1 = await countService.createCount({
      tenantId, countType: 'month_close', userId, countDate: '2026-06-30',
    })
    expect(c1.count_number).toBe(CM_BASE)

    await countService.cancelCount({ tenantId, countId: c1.id, reason: 'prueba', userId })

    // Antes del fix: esto lanzaba 23505 → 500. Ahora obtiene folio incremental.
    const c2 = await countService.createCount({
      tenantId, countType: 'month_close', userId, countDate: '2026-06-30',
    })
    expect(c2.count_number).toBe(`${CM_BASE}-2`)
    expect(c2.status).toBe('in_capture')

    // Un tercero (tras cancelar el segundo) sigue incrementando.
    await countService.cancelCount({ tenantId, countId: c2.id, reason: 'prueba', userId })
    const c3 = await countService.createCount({
      tenantId, countType: 'month_close', userId, countDate: '2026-06-30',
    })
    expect(c3.count_number).toBe(`${CM_BASE}-3`)
  })

  test('sigue bloqueando un SEGUNDO cierre ACTIVO en el mismo mes', async () => {
    // c3 quedó activo del test anterior. Crear otro debe dar 409, no folio nuevo.
    await expect(countService.createCount({
      tenantId, countType: 'month_close', userId, countDate: '2026-06-30',
    })).rejects.toMatchObject({ status: 409 })
  })
})
