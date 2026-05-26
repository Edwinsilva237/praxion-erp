'use strict'

/**
 * Servicio de reset de datos transaccionales para tenants sandbox.
 *
 * Borra movimientos (pedidos, facturas, remisiones, turnos, etc.) preservando
 * catálogos (clientes, productos, almacenes, usuarios, datos fiscales).
 *
 * GUARDIA DE SEGURIDAD: solo opera si tenants.is_sandbox = TRUE. Esto se
 * verifica en el callsite (route o script) y aquí dentro de la transacción.
 *
 * Cubre los módulos: ventas/AR, compras/AP, producción, cotizaciones,
 * caja chica, inventario, auditoría.
 */

const { withTransaction, query } = require('../../db')
const logger = require('../../config/logger')

// Tablas a vaciar. Cada entrada: nombre + estrategia DELETE. Si no se
// especifica `delete`, se usa `DELETE FROM <tabla> WHERE tenant_id = $1`.
// Hijas (lines, scrap, etc.) usan JOIN al padre porque no llevan tenant_id.
//
// Orden importa: hay que borrar hijas antes que padres por foreign keys.
const TRANSACTIONAL_TABLES = [
  // ─── Ventas / AR ──────────────────────────────────────────────────────
  { table: 'ar_payments' },
  { table: 'ar_advances' },
  { table: 'payment_complements' },
  { table: 'credit_notes' },
  { table: 'accounts_receivable' },
  { table: 'invoice_lines',
    delete: `DELETE FROM invoice_lines USING invoices
              WHERE invoice_lines.invoice_id = invoices.id
                AND invoices.tenant_id = $1` },
  { table: 'invoices' },
  { table: 'delivery_record_lines',
    delete: `DELETE FROM delivery_record_lines USING delivery_records
              WHERE delivery_record_lines.delivery_record_id = delivery_records.id
                AND delivery_records.tenant_id = $1` },
  { table: 'delivery_records' },
  { table: 'delivery_note_lines',
    delete: `DELETE FROM delivery_note_lines USING delivery_notes
              WHERE delivery_note_lines.delivery_note_id = delivery_notes.id
                AND delivery_notes.tenant_id = $1` },
  { table: 'delivery_notes' },
  { table: 'sales_order_lines',
    delete: `DELETE FROM sales_order_lines USING sales_orders
              WHERE sales_order_lines.sales_order_id = sales_orders.id
                AND sales_orders.tenant_id = $1` },
  { table: 'sales_orders' },
  { table: 'document_status_log' },

  // ─── Cotizaciones (s13) ───────────────────────────────────────────────
  { table: 'quotation_lines',
    delete: `DELETE FROM quotation_lines USING quotations
              WHERE quotation_lines.quotation_id = quotations.id
                AND quotations.tenant_id = $1` },
  { table: 'quotations' },

  // ─── Compras / AP ─────────────────────────────────────────────────────
  { table: 'ap_payments' },
  { table: 'ap_advances' },
  { table: 'accounts_payable' },
  { table: 'supplier_invoice_lines',
    delete: `DELETE FROM supplier_invoice_lines USING supplier_invoices
              WHERE supplier_invoice_lines.supplier_invoice_id = supplier_invoices.id
                AND supplier_invoices.tenant_id = $1` },
  { table: 'supplier_invoices' },
  { table: 'supplier_receipt_lines',
    delete: `DELETE FROM supplier_receipt_lines USING supplier_receipts
              WHERE supplier_receipt_lines.supplier_receipt_id = supplier_receipts.id
                AND supplier_receipts.tenant_id = $1` },
  { table: 'supplier_receipts' },
  { table: 'purchase_order_lines',
    delete: `DELETE FROM purchase_order_lines USING purchase_orders
              WHERE purchase_order_lines.purchase_order_id = purchase_orders.id
                AND purchase_orders.tenant_id = $1` },
  { table: 'purchase_orders' },

  // ─── Producción (s10-s11) ─────────────────────────────────────────────
  // Hijas del turno primero (FK a production_shifts):
  { table: 'shift_corrections',
    delete: `DELETE FROM shift_corrections USING production_shifts
              WHERE shift_corrections.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_cost_snapshot',
    delete: `DELETE FROM shift_cost_snapshot USING production_shifts
              WHERE shift_cost_snapshot.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_handovers',
    delete: `DELETE FROM shift_handovers USING production_shifts
              WHERE shift_handovers.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_incidents',
    delete: `DELETE FROM shift_incidents USING production_shifts
              WHERE shift_incidents.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_mp_loads',
    delete: `DELETE FROM shift_mp_loads USING production_shifts
              WHERE shift_mp_loads.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_progress',
    delete: `DELETE FROM shift_progress USING production_shifts
              WHERE shift_progress.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_receptions',
    delete: `DELETE FROM shift_receptions USING production_shifts
              WHERE shift_receptions.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'shift_scrap',
    delete: `DELETE FROM shift_scrap USING production_shifts
              WHERE shift_scrap.shift_id = production_shifts.id
                AND production_shifts.tenant_id = $1` },
  { table: 'production_shifts' },
  { table: 'production_cost_items',
    delete: `DELETE FROM production_cost_items USING production_orders
              WHERE production_cost_items.production_order_id = production_orders.id
                AND production_orders.tenant_id = $1` },
  { table: 'production_orders' },

  // ─── Caja chica (s23) ─────────────────────────────────────────────────
  // petty_cash_movements es transaccional. funds y categories son catálogo
  // — se preservan.
  { table: 'petty_cash_movements' },

  // ─── Auditoría ────────────────────────────────────────────────────────
  { table: 'audit_logs' },
]

// Tablas extra a contar/reportar pero NO en la lista anterior (porque las
// borramos vía JOIN al padre que sí tiene tenant_id, así no las podemos
// contar directamente con WHERE tenant_id).
const COUNT_ONLY_VIA_PARENT = new Set([
  'invoice_lines', 'delivery_record_lines', 'delivery_note_lines',
  'sales_order_lines', 'quotation_lines',
  'supplier_invoice_lines', 'supplier_receipt_lines', 'purchase_order_lines',
  'shift_corrections', 'shift_cost_snapshot', 'shift_handovers',
  'shift_incidents', 'shift_mp_loads', 'shift_progress',
  'shift_receptions', 'shift_scrap', 'production_cost_items',
])

// Cache estática: qué tablas tienen columna tenant_id directa.
let tenantIdMap = null

async function loadTenantIdMap() {
  if (tenantIdMap) return tenantIdMap
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'`
  )
  tenantIdMap = new Set(rows.map(r => r.table_name))
  return tenantIdMap
}

async function tableExists(name) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`, [name]
  )
  return rows.length > 0
}

/**
 * Cuenta cuántos registros se borrarían, sin borrar nada. Útil para mostrar
 * antes de pedir confirmación.
 */
async function previewCounts(tenantId, { keepInventory = false } = {}) {
  const tIds = await loadTenantIdMap()
  const counts = []

  for (const spec of TRANSACTIONAL_TABLES) {
    if (!(await tableExists(spec.table))) continue
    if (COUNT_ONLY_VIA_PARENT.has(spec.table)) continue
    if (!tIds.has(spec.table)) continue

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM ${spec.table} WHERE tenant_id = $1`,
      [tenantId]
    )
    if (rows[0].n > 0) counts.push({ table: spec.table, count: rows[0].n })
  }

  if (!keepInventory && await tableExists('inventory_movements')) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM inventory_movements WHERE tenant_id = $1`,
      [tenantId]
    )
    if (rows[0].n > 0) counts.push({ table: 'inventory_movements', count: rows[0].n })
  }

  const total = counts.reduce((s, c) => s + c.count, 0)
  return { counts, total, keepInventory }
}

/**
 * Verifica que el tenant existe y está marcado como sandbox.
 * Si no lo es: throw con status 400. Llamar antes de tocar nada.
 */
async function assertSandbox(tenantId) {
  const { rows } = await query(
    `SELECT id, slug, name, is_sandbox FROM tenants WHERE id = $1`, [tenantId]
  )
  if (!rows.length) {
    const err = new Error('Tenant no encontrado.')
    err.status = 404
    throw err
  }
  if (!rows[0].is_sandbox) {
    const err = new Error(
      `El tenant '${rows[0].slug}' NO está marcado como sandbox. ` +
      `Esta operación solo se permite en tenants con is_sandbox=true para ` +
      `prevenir borrados accidentales en producción.`
    )
    err.status = 400
    err.code = 'TENANT_NOT_SANDBOX'
    throw err
  }
  return rows[0]
}

/**
 * Ejecuta el reset. Pre-condición: assertSandbox debe haber pasado.
 * @returns {{ deletedBy: Array<{table, count}>, total: number }}
 */
async function resetTenantData(tenantId, { keepInventory = false } = {}) {
  const tenant = await assertSandbox(tenantId)
  const tIds = await loadTenantIdMap()

  const result = { deletedBy: [], total: 0 }

  await withTransaction(async (client) => {
    for (const spec of TRANSACTIONAL_TABLES) {
      if (!(await tableExistsClient(client, spec.table))) continue

      const sql = spec.delete
        || (tIds.has(spec.table)
            ? `DELETE FROM ${spec.table} WHERE tenant_id = $1`
            : null)

      if (!sql) {
        logger.warn(`[reset-sandbox] sin estrategia para ${spec.table}, saltada`)
        continue
      }

      const r = await client.query(sql, [tenantId])
      if (r.rowCount > 0) {
        result.deletedBy.push({ table: spec.table, count: r.rowCount })
        result.total += r.rowCount
      }
    }

    if (!keepInventory && await tableExistsClient(client, 'inventory_movements')) {
      const r = await client.query(
        `DELETE FROM inventory_movements WHERE tenant_id = $1`, [tenantId]
      )
      if (r.rowCount > 0) {
        result.deletedBy.push({ table: 'inventory_movements', count: r.rowCount })
        result.total += r.rowCount
      }
      // inventory_levels almacena CONFIG (min/max/reorder) — se preserva.
      // El saldo on_hand se calcula sumando movimientos, queda en 0.
    }
  })

  logger.info(`[reset-sandbox] tenant '${tenant.slug}': ${result.total} registros borrados`)
  return result
}

async function tableExistsClient(client, name) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`, [name]
  )
  return rows.length > 0
}

module.exports = {
  TRANSACTIONAL_TABLES,
  previewCounts,
  assertSandbox,
  resetTenantData,
}
