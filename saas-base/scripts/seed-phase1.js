'use strict'

require('dotenv').config()
const { withTransaction, query, pool } = require('../src/db')
const logger = require('../src/config/logger')

async function seedPhase1() {
  const { rows: tenants } = await query(
    `SELECT id, slug FROM tenants WHERE slug = 'demo'`
  )

  if (tenants.length === 0) {
    logger.warn('Tenant demo no encontrado. Ejecuta primero: node scripts/create-test-tenant.js')
    return
  }

  const tenantId = tenants[0].id
  logger.info(`Seeding Fase 1 para tenant: demo (${tenantId})`)

  await withTransaction(async (client) => {

    // ─── Almacenes base ────────────────────────────────────────────────────
    logger.info('Creando almacenes...')

    const warehouses = [
      { name: 'MP Virgen PP',    type: 'raw_material',     resin_type: 'PP' },
      { name: 'MP Virgen PE',    type: 'raw_material',     resin_type: 'PE' },
      { name: 'Regrind PP',      type: 'regrind',          resin_type: 'PP' },
      { name: 'Regrind PE',      type: 'regrind',          resin_type: 'PE' },
      { name: 'WIP Producción',  type: 'wip',              resin_type: null },
      { name: 'PT Esquineros',   type: 'finished_product',  resin_type: null },
      { name: 'PT Reventa',      type: 'resale',           resin_type: null },
    ]

    const warehouseIds = {}
    for (const wh of warehouses) {
      const { rows } = await client.query(
        `INSERT INTO warehouses (tenant_id, name, type, resin_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name) DO UPDATE SET type = EXCLUDED.type
         RETURNING id, name`,
        [tenantId, wh.name, wh.type, wh.resin_type]
      )
      warehouseIds[rows[0].name] = rows[0].id
      logger.debug(`  Almacén: ${rows[0].name}`)
    }

    // ─── Materias primas ───────────────────────────────────────────────────
    logger.info('Creando materias primas...')

    const rawMaterials = [
      {
        name: 'Polipropileno virgen PP',
        resin_type: 'PP',
        material_type: 'virgin',
        max_regrind_pct: 30,
        cost_per_kg: 28.50,
      },
      {
        name: 'Polietileno virgen PE',
        resin_type: 'PE',
        material_type: 'virgin',
        max_regrind_pct: 25,
        cost_per_kg: 26.00,
      },
      {
        name: 'Regrind PP recuperado',
        resin_type: 'PP',
        material_type: 'regrind',
        max_regrind_pct: 100,
        cost_per_kg: 0,
      },
      {
        name: 'Regrind PE recuperado',
        resin_type: 'PE',
        material_type: 'regrind',
        max_regrind_pct: 100,
        cost_per_kg: 0,
      },
    ]

    const rmIds = {}
    for (const rm of rawMaterials) {
      const { rows } = await client.query(
        `INSERT INTO raw_materials
           (tenant_id, name, resin_type, material_type, max_regrind_pct, cost_per_kg)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, name) DO UPDATE SET cost_per_kg = EXCLUDED.cost_per_kg
         RETURNING id, name`,
        [tenantId, rm.name, rm.resin_type, rm.material_type, rm.max_regrind_pct, rm.cost_per_kg]
      )
      rmIds[rows[0].name] = rows[0].id
      logger.debug(`  MP: ${rows[0].name}`)
    }

    // ─── Productos de ejemplo ──────────────────────────────────────────────
    logger.info('Creando productos de ejemplo...')

    const products = [
      {
        sku: 'ESQ-PP-120-50-3',
        name: 'Esquinero PP 120×50×3mm',
        type: 'corner_protector',
        resin_type: 'PP',
        length_mm: 1200,
        width_mm: 50,
        thickness_mm: 3,
      },
      {
        sku: 'ESQ-PP-100-50-3',
        name: 'Esquinero PP 100×50×3mm',
        type: 'corner_protector',
        resin_type: 'PP',
        length_mm: 1000,
        width_mm: 50,
        thickness_mm: 3,
      },
      {
        sku: 'ESQ-PE-120-50-3',
        name: 'Esquinero PE 120×50×3mm',
        type: 'corner_protector',
        resin_type: 'PE',
        length_mm: 1200,
        width_mm: 50,
        thickness_mm: 3,
      },
      {
        sku: 'FLEJE-PET-16',
        name: 'Fleje PET 16mm',
        type: 'resale',
        resin_type: null,
        length_mm: null,
        width_mm: null,
        thickness_mm: null,
      },
    ]

    for (const prod of products) {
      const { rows } = await client.query(
        `INSERT INTO products
           (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, sku) DO NOTHING
         RETURNING id, sku`,
        [tenantId, prod.sku, prod.name, prod.type, prod.resin_type,
         prod.length_mm, prod.width_mm, prod.thickness_mm]
      )

      if (rows.length > 0 && prod.type === 'corner_protector') {
        // Crear spec de calidad inicial con valores default
        await client.query(
          `INSERT INTO product_quality_specs
             (product_id, grams_per_linear_meter, tolerance_pct, units_per_package)
           VALUES ($1, 180.00, 5.00, 50)
           ON CONFLICT DO NOTHING`,
          [rows[0].id]
        )
        logger.debug(`  Producto: ${rows[0].sku} con spec de calidad`)
      } else if (rows.length > 0) {
        logger.debug(`  Producto: ${rows[0].sku} (reventa)`)
      }
    }

    logger.info('Seed Fase 1 completado.')
    logger.info(`  Almacenes creados: ${warehouses.length}`)
    logger.info(`  Materias primas:   ${rawMaterials.length}`)
    logger.info(`  Productos:         ${products.length}`)
  })
}

seedPhase1()
  .then(() => pool.end())
  .catch((err) => {
    logger.error('Seed Fase 1 falló:', err.message)
    pool.end()
    process.exit(1)
  })
