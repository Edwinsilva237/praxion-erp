'use strict'

/**
 * Script reutilizable para limpiar turnos de prueba.
 *
 * Uso:
 *   node scripts/clean_test_shifts.js                        # Modo lista (sólo muestra, no borra)
 *   node scripts/clean_test_shifts.js --today                # Borra todos los turnos de hoy (con confirmación)
 *   node scripts/clean_test_shifts.js --date 2026-05-09      # Borra los turnos de una fecha específica
 *   node scripts/clean_test_shifts.js --shift-id <uuid>      # Borra un turno específico por id
 *   node scripts/clean_test_shifts.js --today --yes          # Sin confirmación interactiva
 *   node scripts/clean_test_shifts.js --tenant <uuid>        # Limita a un tenant (default: todos)
 *
 * Qué borra:
 *   - El turno (production_shifts) y por CASCADE: shift_progress, shift_scrap,
 *     shift_mp_loads, shift_incidents.
 *   - shift_handovers asociadas (no tiene CASCADE).
 *   - inventory_movements relacionados (reference_type='shift_progress' con
 *     los progress.id del turno + reference_type='production_shift' con el shift.id).
 *   - Recalcula inventory_stock para todos los (warehouse, item, status) afectados,
 *     dejando los saldos consistentes con los movimientos restantes.
 *   - El scheduled_shift que se activó para el turno (DELETE, ya no UPDATE NULL).
 *   - Cuando se filtra por fecha (--today / --date), también borra scheduled_shifts
 *     HUÉRFANOS (programados pero nunca activados) de esa fecha.
 *
 * Qué NO toca:
 *   - production_orders (no se borran)
 *   - raw_materials, products, warehouses (catálogo)
 *   - audit_logs (se preserva el rastro)
 */

const path = require('path')
const readline = require('readline')

// Cargar config y conexión del proyecto
process.chdir(path.resolve(__dirname, '..'))
require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'saas_base',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
})

// ─── Parsear argumentos ──────────────────────────────────────────────────────
const args = process.argv.slice(2)
function getFlag(name) { return args.includes(`--${name}`) }
function getOpt(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null
}

const flagToday   = getFlag('today')
const flagYes     = getFlag('yes')
const optDate     = getOpt('date')
const optShiftId  = getOpt('shift-id')
const optTenant   = getOpt('tenant')

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, ans => { rl.close(); resolve(ans.trim()) })
  })
}

function fmt(d) {
  if (!d) return '—'
  const x = new Date(d)
  return x.toLocaleString('es-MX', { hour12: false })
}

const colors = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
}
const c = colors

// ─── Limpiar scheduled_shifts huérfanos (programados sin turno activado) ────
// Devuelve cuántos se borraron. Solo aplica si se filtra por fecha (--today / --date).
async function cleanOrphanScheduledShifts({ tenantId, date }) {
  const params = []
  const where  = ['shift_id IS NULL']

  if (tenantId) {
    params.push(tenantId)
    where.push(`tenant_id = $${params.length}`)
  }
  if (date === 'today') {
    where.push(`scheduled_date = CURRENT_DATE`)
  } else if (date) {
    params.push(date)
    where.push(`scheduled_date = $${params.length}::date`)
  } else {
    return { listed: [], deleted: 0 }
  }

  // Listar primero
  const { rows: listed } = await pool.query(
    `SELECT ss.id, ss.scheduled_date, ss.shift_number, ss.line_id, ss.status,
            t.name AS tenant_name
     FROM scheduled_shifts ss
     LEFT JOIN tenants t ON t.id = ss.tenant_id
     WHERE ${where.join(' AND ')}
     ORDER BY ss.scheduled_date, ss.shift_number, ss.line_id`,
    params
  )

  if (listed.length === 0) return { listed: [], deleted: 0 }

  // Borrarlos
  const { rowCount } = await pool.query(
    `DELETE FROM scheduled_shifts WHERE ${where.join(' AND ')}`, params
  )
  return { listed, deleted: rowCount || 0 }
}

// ─── Listar turnos según filtros ─────────────────────────────────────────────
async function listShifts() {
  const params = []
  const where  = []

  if (optShiftId) {
    params.push(optShiftId)
    where.push(`ps.id = $${params.length}`)
  }
  if (optDate) {
    params.push(optDate)
    where.push(`ps.shift_date = $${params.length}::date`)
  }
  if (flagToday) {
    where.push(`ps.shift_date = CURRENT_DATE`)
  }
  if (optTenant) {
    params.push(optTenant)
    where.push(`ps.tenant_id = $${params.length}`)
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT ps.id, ps.tenant_id, ps.shift_number, ps.shift_date, ps.status,
            ps.line_id, ps.started_at, ps.closed_at,
            ps.pt_units_produced,
            (SELECT COUNT(*) FROM shift_progress sp WHERE sp.shift_id = ps.id) AS pkgs,
            (SELECT COUNT(*) FROM shift_scrap     ss WHERE ss.shift_id = ps.id) AS scrap_records,
            (SELECT COUNT(*) FROM inventory_movements im
              WHERE (im.reference_type='shift_progress'
                     AND im.reference_id IN (SELECT id FROM shift_progress sp2 WHERE sp2.shift_id = ps.id))
                 OR (im.reference_type='production_shift' AND im.reference_id = ps.id)) AS movements,
            t.name AS tenant_name
     FROM production_shifts ps
     LEFT JOIN tenants t ON t.id = ps.tenant_id
     ${whereClause}
     ORDER BY ps.shift_date DESC, ps.shift_number ASC, ps.line_id ASC`,
    params
  )
  return rows
}

// ─── Limpiar UN turno ────────────────────────────────────────────────────────
async function cleanOneShift(client, shift) {
  const shiftId  = shift.id
  const tenantId = shift.tenant_id

  // 1. Identificar shift_progress.id del turno
  const { rows: progressRows } = await client.query(
    `SELECT id FROM shift_progress WHERE shift_id = $1`, [shiftId]
  )
  const progressIds = progressRows.map(r => r.id)

  // 2. Identificar movimientos a borrar y las claves de stock afectadas
  let affectedKeys = []
  let movementsToDelete = []

  if (progressIds.length > 0) {
    const { rows } = await client.query(
      `SELECT id, warehouse_id, item_type, item_id, status_to
       FROM inventory_movements
       WHERE tenant_id = $1
         AND reference_type = 'shift_progress'
         AND reference_id = ANY($2::uuid[])`,
      [tenantId, progressIds]
    )
    movementsToDelete = movementsToDelete.concat(rows)
  }

  const { rows: validationMovs } = await client.query(
    `SELECT id, warehouse_id, item_type, item_id, status_to
     FROM inventory_movements
     WHERE tenant_id = $1
       AND reference_type = 'production_shift'
       AND reference_id = $2`,
    [tenantId, shiftId]
  )
  movementsToDelete = movementsToDelete.concat(validationMovs)

  // Únicas combinaciones de (warehouse, item_type, item_id, status) para recalcular
  const seen = new Set()
  for (const m of movementsToDelete) {
    const key = `${m.warehouse_id}|${m.item_type}|${m.item_id}|${m.status_to}`
    if (!seen.has(key)) {
      seen.add(key)
      affectedKeys.push({
        warehouse_id: m.warehouse_id,
        item_type:    m.item_type,
        item_id:      m.item_id,
        status:       m.status_to,
      })
    }
  }

  // 3. Borrar los movimientos
  if (movementsToDelete.length > 0) {
    const ids = movementsToDelete.map(m => m.id)
    await client.query(
      `DELETE FROM inventory_movements WHERE id = ANY($1::uuid[])`, [ids]
    )
  }

  // 4. Recalcular saldos de cada combinación afectada
  for (const k of affectedKeys) {
    // Sumar TODOS los movimientos restantes para esa clave (con signo)
    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM inventory_movements
       WHERE tenant_id = $1
         AND warehouse_id = $2
         AND item_type    = $3
         AND item_id      = $4
         AND status_to    = $5`,
      [tenantId, k.warehouse_id, k.item_type, k.item_id, k.status]
    )
    const newQty = Math.max(0, parseFloat(sumRows[0].total))

    // Verificar si existe el row en inventory_stock
    const { rows: stockRows } = await client.query(
      `SELECT id FROM inventory_stock
       WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type=$3 AND item_id=$4 AND status=$5`,
      [tenantId, k.warehouse_id, k.item_type, k.item_id, k.status]
    )
    if (stockRows[0]) {
      await client.query(
        `UPDATE inventory_stock SET quantity = $1, last_movement_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [newQty.toFixed(4), stockRows[0].id]
      )
    }
    // Si no existe, no hace falta crear nada (no había stock previo).
  }

  // 5. Borrar shift_handovers (no tiene CASCADE) — usamos savepoint para no
  //    romper la transacción principal si la tabla no existe en algún entorno.
  await client.query('SAVEPOINT sp_handovers')
  try {
    await client.query(`DELETE FROM shift_handovers WHERE shift_id = $1`, [shiftId])
    await client.query('RELEASE SAVEPOINT sp_handovers')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_handovers')
    // Tabla puede no existir en entornos viejos; continuamos.
  }

  // 6. Borrar scheduled_shift asociado (el que se activó para este turno).
  //    Antes hacíamos UPDATE shift_id=NULL, pero eso dejaba el turno programado
  //    "fantasma" en el calendario. Mejor lo borramos completo.
  let scheduledDeleted = 0
  await client.query('SAVEPOINT sp_scheduled')
  try {
    const { rowCount } = await client.query(
      `DELETE FROM scheduled_shifts WHERE shift_id = $1`, [shiftId]
    )
    scheduledDeleted = rowCount || 0
    await client.query('RELEASE SAVEPOINT sp_scheduled')
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_scheduled')
    // Tabla puede no existir en entornos viejos; continuamos.
  }

  // 7. Borrar el turno (CASCADE elimina shift_progress, shift_scrap, shift_mp_loads, shift_incidents)
  await client.query(
    `DELETE FROM production_shifts WHERE id = $1`, [shiftId]
  )

  return {
    shiftId,
    progressIds:           progressIds.length,
    movementsDeleted:      movementsToDelete.length,
    stockKeysRecalculated: affectedKeys.length,
    scheduledDeleted,
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const shifts = await listShifts()

  if (shifts.length === 0) {
    console.log(`${c.yellow}No se encontraron turnos con esos filtros.${c.reset}`)
    process.exit(0)
  }

  // Mostrar tabla
  console.log(`\n${c.bold}Turnos encontrados (${shifts.length}):${c.reset}\n`)
  console.log(`${c.dim}${'─'.repeat(110)}${c.reset}`)
  console.log(
    `${'Fecha'.padEnd(12)} ${'#'.padStart(2)} ${'L'.padStart(2)} ${'Estado'.padEnd(20)} ${'Pzas'.padStart(6)} ${'Paq'.padStart(4)} ${'Mov'.padStart(4)} ${'Tenant'.padEnd(20)} ${'ID'.padEnd(36)}`
  )
  console.log(`${c.dim}${'─'.repeat(110)}${c.reset}`)
  for (const s of shifts) {
    const dateStr = s.shift_date ? new Date(s.shift_date).toISOString().slice(0, 10) : '—'
    const statusColored =
      s.status === 'active'           ? `${c.green}${s.status}${c.reset}` :
      s.status === 'pending_handover' ? `${c.yellow}${s.status}${c.reset}` :
      s.status === 'closed'           ? `${c.dim}${s.status}${c.reset}`   :
                                        s.status
    console.log(
      `${dateStr.padEnd(12)} ` +
      `${String(s.shift_number).padStart(2)} ` +
      `${String(s.line_id).padStart(2)} ` +
      `${statusColored.padEnd(30)} ` +  // padding extra por los códigos ANSI
      `${String(s.pt_units_produced || 0).padStart(6)} ` +
      `${String(s.pkgs).padStart(4)} ` +
      `${String(s.movements).padStart(4)} ` +
      `${(s.tenant_name || '—').slice(0, 18).padEnd(20)} ` +
      `${s.id}`
    )
  }
  console.log(`${c.dim}${'─'.repeat(110)}${c.reset}\n`)

  // Si no hay flag de borrado, mostramos también scheduled huérfanos como info
  if (!flagToday && !optDate && !optShiftId) {
    console.log(`${c.cyan}Modo lista. Para borrar usa: --today / --date YYYY-MM-DD / --shift-id <uuid>${c.reset}\n`)
    process.exit(0)
  }

  // Si filtra por fecha, mostrar también los scheduled huérfanos que se borrarían
  if (flagToday || optDate) {
    const { rows: orphans } = await pool.query(
      `SELECT ss.id, ss.scheduled_date, ss.shift_number, ss.line_id, ss.status
       FROM scheduled_shifts ss
       WHERE ss.shift_id IS NULL
         AND ss.scheduled_date = ${flagToday ? 'CURRENT_DATE' : '$1::date'}
         ${optTenant ? `AND ss.tenant_id = ${flagToday ? '$1' : '$2'}` : ''}
       ORDER BY ss.scheduled_date, ss.shift_number, ss.line_id`,
      flagToday
        ? (optTenant ? [optTenant] : [])
        : (optTenant ? [optDate, optTenant] : [optDate])
    )
    if (orphans.length > 0) {
      console.log(`${c.dim}También se borrarán ${orphans.length} programación(es) huérfana(s) (sin turno activado):${c.reset}`)
      for (const sc of orphans) {
        const dateStr = new Date(sc.scheduled_date).toISOString().slice(0, 10)
        console.log(`  ${c.dim}— ${dateStr} turno ${sc.shift_number} (línea ${sc.line_id}, estado ${sc.status})${c.reset}`)
      }
      console.log()
    }
  }

  // Confirmación
  if (!flagYes) {
    const ans = await ask(
      `${c.yellow}${c.bold}¿Confirmas borrar los ${shifts.length} turno(s) listados? (escribe "si" para confirmar): ${c.reset}`
    )
    if (ans.toLowerCase() !== 'si' && ans.toLowerCase() !== 'sí' && ans.toLowerCase() !== 'yes' && ans.toLowerCase() !== 'y') {
      console.log(`${c.dim}Cancelado.${c.reset}`)
      process.exit(0)
    }
  }

  // Procesar uno por uno (cada turno en su propia transacción)
  console.log()
  let totalDeleted = 0, totalMovs = 0, totalKeys = 0, totalScheduled = 0
  for (const s of shifts) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await cleanOneShift(client, s)
      await client.query('COMMIT')
      totalDeleted   += 1
      totalMovs      += result.movementsDeleted
      totalKeys      += result.stockKeysRecalculated
      totalScheduled += result.scheduledDeleted
      console.log(
        `${c.green}✓${c.reset} ${s.shift_date.toISOString?.().slice(0,10) || s.shift_date} turno ${s.shift_number} (línea ${s.line_id}) — ` +
        `${result.progressIds} paquetes, ${result.movementsDeleted} movimientos, ${result.stockKeysRecalculated} saldos recalculados` +
        (result.scheduledDeleted > 0 ? `, ${result.scheduledDeleted} programación borrada` : '')
      )
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.error(`${c.red}✗${c.reset} Turno ${s.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }

  // Limpiar también scheduled_shifts HUÉRFANOS (programados pero nunca activados)
  // del mismo rango de fechas. Esto deja el calendario completamente limpio.
  let orphansResult = { listed: [], deleted: 0 }
  if (flagToday || optDate) {
    orphansResult = await cleanOrphanScheduledShifts({
      tenantId: optTenant || null,
      date:     flagToday ? 'today' : optDate,
    })
    if (orphansResult.deleted > 0) {
      console.log()
      console.log(`${c.cyan}🧹 Limpieza adicional: scheduled_shifts huérfanos (programados sin activar):${c.reset}`)
      for (const sc of orphansResult.listed) {
        const dateStr = new Date(sc.scheduled_date).toISOString().slice(0, 10)
        console.log(`  ${c.green}✓${c.reset} ${dateStr} turno ${sc.shift_number} (línea ${sc.line_id}, estado ${sc.status})`)
      }
    }
  }

  console.log(`\n${c.bold}${c.green}✅ Listo.${c.reset}`)
  console.log(`   Turnos eliminados:        ${totalDeleted}`)
  console.log(`   Movimientos:              ${totalMovs}`)
  console.log(`   Saldos recalculados:      ${totalKeys}`)
  console.log(`   Programaciones borradas:  ${totalScheduled + orphansResult.deleted}` +
    (orphansResult.deleted > 0 ? ` (incluye ${orphansResult.deleted} huérfanas)` : ''))
  console.log()

  await pool.end()
  process.exit(0)
}

main().catch(err => {
  console.error(`${c.red}Error inesperado:${c.reset}`, err)
  process.exit(1)
})
