'use strict'

/**
 * CLI para resetear los datos transaccionales de un tenant sandbox.
 * La lógica vive en src/modules/platformAdmin/sandboxResetService.js — este
 * archivo solo es el wrapper para correrlo desde terminal.
 *
 * Uso:
 *   npm run reset:sandbox                       (default slug: 'sandbox')
 *   SANDBOX_SLUG=otro npm run reset:sandbox
 *   KEEP_INVENTORY=1 npm run reset:sandbox
 *   FORCE=1 npm run reset:sandbox               (omite la confirmación)
 */

require('dotenv').config()
const readline = require('readline')
const { query, pool, withBypass } = require('./index')
const logger = require('../config/logger')
const svc = require('../modules/platformAdmin/sandboxResetService')

const SLUG           = process.env.SANDBOX_SLUG || 'sandbox'
const KEEP_INVENTORY = process.env.KEEP_INVENTORY === '1'
const FORCE          = process.env.FORCE === '1'

async function confirm(promptText) {
  if (FORCE) return true
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(promptText, (ans) => {
      rl.close()
      resolve(['y', 'yes', 'sí', 'si', 's'].includes(ans.trim().toLowerCase()))
    })
  })
}

;(async () => {
  try {
    // Resolver tenant por slug. withBypass para saltar RLS (necesario porque
    // este script no tiene sesión de tenant).
    const tenant = await withBypass(async () => {
      const { rows } = await query(
        `SELECT id, slug, name, is_sandbox FROM tenants WHERE slug = $1`, [SLUG]
      )
      return rows[0] || null
    })
    if (!tenant) {
      logger.error(`Tenant '${SLUG}' no existe. Corre 'npm run seed:sandbox' primero.`)
      process.exit(1)
    }

    // assertSandbox vuelve a validar — defensa en profundidad.
    await withBypass(() => svc.assertSandbox(tenant.id))

    // Preview
    const { counts, total } = await withBypass(() =>
      svc.previewCounts(tenant.id, { keepInventory: KEEP_INVENTORY })
    )

    logger.info(`\nTenant sandbox: ${tenant.name} (${tenant.id})`)
    if (counts.length === 0) {
      logger.info('  (no hay nada que borrar)')
      process.exit(0)
    }
    logger.info('Conteos antes del reset:')
    counts.forEach(c => logger.info(`  ${c.table.padEnd(32)} ${c.count}`))

    const ok = await confirm(
      `\nVas a BORRAR ${total} registros del tenant '${SLUG}'.\n` +
      `Catálogos (clientes, proveedores, productos, almacenes, bancos, usuarios) se preservan.\n` +
      `${KEEP_INVENTORY
        ? 'Inventario PRESERVADO (KEEP_INVENTORY=1).\n'
        : 'Inventario también se resetea (movimientos + saldos a 0).\n'}` +
      `¿Confirmas? [y/N]: `
    )
    if (!ok) { logger.info('Cancelado.'); process.exit(0) }

    const result = await withBypass(() =>
      svc.resetTenantData(tenant.id, { keepInventory: KEEP_INVENTORY })
    )

    logger.info('\nResultado:')
    result.deletedBy.forEach(d => logger.info(`  ✓ ${d.table.padEnd(32)} ${d.count} borrados`))
    logger.info(`\n✓ Reset completo: ${result.total} registros eliminados.\n`)
  } catch (err) {
    logger.error('Reset sandbox falló:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
  } finally {
    await pool.end()
  }
})()
