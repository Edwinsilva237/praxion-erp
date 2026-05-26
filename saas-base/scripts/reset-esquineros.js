'use strict'
// Resetea el tenant esquineros-piloto eliminando en orden correcto (FK constraints).
require('dotenv').config()
const { pool, query, withBypass } = require('../src/db')

const SLUG = 'esquineros-piloto'

async function reset() {
  const r = await withBypass(() => query('SELECT id FROM tenants WHERE slug = $1', [SLUG]))
  if (!r.rows[0]) { console.log(`Tenant '${SLUG}' not found — nothing to reset`); return }
  const tid = r.rows[0].id
  console.log('Resetting tenant:', SLUG, `(${tid})`)

  // Borrar en orden para respetar FKs
  const steps = [
    ['shift_handovers',       'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['shift_mp_loads',        'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['shift_scrap',           'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['shift_progress',        'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['shift_cost_snapshot',   'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['shift_incidents',       'shift_id IN (SELECT id FROM production_shifts WHERE tenant_id = $1)'],
    ['inventory_movements',   'tenant_id = $1'],
    ['inventory_stock',       'tenant_id = $1'],
    ['production_shifts',     'tenant_id = $1'],
    ['production_orders',     'tenant_id = $1'],
    ['raw_materials',         'tenant_id = $1'],
    ['tenants',               'id = $1'],
  ]

  for (const [table, condition] of steps) {
    try {
      const res = await withBypass(() => query(`DELETE FROM ${table} WHERE ${condition}`, [tid]))
      if (res.rowCount > 0) console.log(`  Deleted ${res.rowCount} rows from ${table}`)
    } catch (e) {
      console.warn(`  WARN: ${table}: ${e.message}`)
    }
  }
  console.log('Reset complete')
}

reset().then(() => pool.end()).catch(e => { console.error('FATAL:', e.message); pool.end() })
