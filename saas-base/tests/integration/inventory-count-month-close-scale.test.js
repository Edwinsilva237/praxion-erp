'use strict'

/**
 * Cierre de mes (month_close) a ESCALA — regresión del "Internal server error".
 *
 * Bug original (2026-06-30): createCount insertaba TODAS las líneas del snapshot
 * en UNA sola query con 7 bind-params por línea. Postgres/node-postgres limita un
 * statement a 65535 parámetros (Int16) → a partir de ~9362 líneas el contador se
 * desborda y el servidor rechaza el mensaje de protocolo con 08P01
 * ("el mensaje de «bind» tiene N formatos de parámetro pero 0 parámetros"), que
 * el front ve como un genérico "Internal server error".
 *
 * Un cierre de mes abarca TODOS los almacenes × TODOS los items con stock o nivel,
 * así que es el conteo más grande y el único que cruzaba el tope en producción.
 *
 * Fix: insertar las líneas en CHUNKS de 1000 (7000 params, holgado bajo 65535).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const countService = require('../../src/modules/inventory/inventoryCountService')

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('Cierre de mes a escala (> tope de bind-params)', () => {
  test('createCount month_close con 10000 líneas no revienta el límite de parámetros', async () => {
    const t = await createTenant({ label: 'mcscale', planSlug: 'owner' })
    const tenantId = t.tenant.id
    const userId   = t.user.id

    const wh = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'MP escala', 'raw_material', true) RETURNING id`,
      [tenantId]
    ))
    const whId = wh.rows[0].id

    // 10000 materias primas con stock disponible en el almacén → 10000 líneas,
    // muy por encima del tope de ~9362 que desbordaba la query única.
    const N = 10000
    await withBypass(async () => {
      await query(
        `INSERT INTO raw_materials (tenant_id, name, is_active)
         SELECT $1, 'RM escala '||g, true FROM generate_series(1,$2) g`,
        [tenantId, N]
      )
      await query(
        `INSERT INTO inventory_stock
           (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost)
         SELECT $1, $2, 'raw_material', rm.id, 'available', 10, 'kg', 3
         FROM raw_materials rm WHERE rm.tenant_id = $1`,
        [tenantId, whId]
      )
    })

    const res = await countService.createCount({
      tenantId, countType: 'month_close', userId, countDate: '2026-06-30',
    })

    expect(res.count_number).toBe('CONT-202606-CM')
    expect(res.lines.length).toBe(N)
    expect(parseInt(res.total_lines)).toBe(N)
  }, 120000)
})
