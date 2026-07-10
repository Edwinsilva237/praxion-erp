'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico SOLO-LECTURA de TURNOS (production_shifts / scheduled_shifts).
//
// Corre DENTRO de Render (Shell del servicio praxion-api) → usa la base INTERNA
// vía src/db/index.js, sin abrir IPs ni External URL (Render bloquea la externa).
//
// Para qué: cuando un turno quedó MAL ETIQUETADO (p.ej. el operador inició su
// Turno 3 nocturno por la mañana y toda la captura quedó como Turno 3), este
// script muestra:
//   • Los production_shifts activos/pending AHORA: número, fecha, status,
//     operador, piezas capturadas (shift_progress) y su(s) orden(es).
//   • Los scheduled_shifts de HOY y a qué production_shift están ligados.
//   • Los SLOTS (shift_number, shift_date) ya OCUPADOS hoy → si esta noche el
//     Turno 3 con fecha=hoy chocaría con el UNIQUE (tenant,line,number,date).
//
// NO escribe nada. Uso:  node src/db/_diag-shifts.js   (dentro de saas-base/)
//   Opcional: DIAG_TENANT=gh-insumos node src/db/_diag-shifts.js
// ─────────────────────────────────────────────────────────────────────────────

const { query, withBypass, pool } = require('./index')

const slug = process.env.DIAG_TENANT || 'gh-insumos-prod'

;(async () => {
  await withBypass(async () => {
    const { rows: tr } = await query(`SELECT id, name, slug FROM tenants WHERE slug = $1`, [slug])
    if (!tr[0]) { console.log(`⚠ No existe tenant con slug "${slug}".`); return }
    const tenantId = tr[0].id
    console.log(`Tenant: ${tr[0].name} (${tr[0].slug})   id=${tenantId}`)

    const { rows: today } = await query(
      `SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date::text AS d`)
    console.log(`Fecha local MX = ${today[0].d}\n`)

    // ── TODOS los production_shifts de HOY (cualquier status) con detalle ───────
    console.log('── production_shifts de HOY (todos los status) ──')
    const { rows: act } = await query(
      `SELECT ps.id, ps.shift_number, ps.shift_date, ps.status,
              ps.started_at, ps.closed_at, ps.handover_requested_at,
              ps.cost_per_unit,
              u.full_name AS operator,
              COALESCE(cap.pkgs,0)::int   AS paquetes,
              COALESCE(cap.units,0)::int  AS piezas,
              COALESCE(cap.sq_units,0)::int AS piezas_2da,
              cap.orders,
              COALESCE(mv.n,0)::int AS movimientos_inv
         FROM production_shifts ps
         LEFT JOIN users u ON u.id = ps.operator_id
         LEFT JOIN (
           SELECT sp.shift_id,
                  COUNT(*) AS pkgs,
                  SUM(sp.quantity_units) FILTER (WHERE sp.is_second_quality=false) AS units,
                  SUM(sp.quantity_units) FILTER (WHERE sp.is_second_quality=true)  AS sq_units,
                  string_agg(DISTINCT po.order_number, ', ') AS orders
             FROM shift_progress sp
             LEFT JOIN production_orders po ON po.id = sp.production_order_id
            GROUP BY sp.shift_id
         ) cap ON cap.shift_id = ps.id
         LEFT JOIN (
           SELECT reference_id AS shift_id, COUNT(*) AS n
             FROM inventory_movements
            WHERE reference_type = 'production_shift'
            GROUP BY reference_id
         ) mv ON mv.shift_id = ps.id
        WHERE ps.tenant_id = $1
          AND ps.shift_date = (NOW() AT TIME ZONE 'America/Mexico_City')::date
        ORDER BY ps.shift_number, ps.started_at NULLS LAST`,
      [tenantId]
    )
    for (const r of act) {
      console.log('─'.repeat(72))
      console.log(`  Turno ${r.shift_number}  ·  fecha ${String(r.shift_date).slice(0,10)}  ·  status=${r.status}`)
      console.log(`  operador: ${r.operator || '—'}`)
      console.log(`  captura : ${r.paquetes} paquetes / ${r.piezas} piezas 1ª + ${r.piezas_2da} piezas 2ª   orden(es): ${r.orders || '—'}`)
      console.log(`  costo/u = ${r.cost_per_unit == null ? '—' : '$'+Number(r.cost_per_unit).toFixed(4)}   movimientos_inv (production_shift) = ${r.movimientos_inv}`)
      console.log(`  started_at=${r.started_at || '—'}  closed_at=${r.closed_at || '—'}  handover_req=${r.handover_requested_at || '—'}`)
      console.log(`  shift_id=${r.id}`)
    }
    if (!act.length) console.log('  (ninguno hoy)')

    // ── scheduled_shifts de HOY y su ligado ────────────────────────────────────
    console.log('\n── scheduled_shifts de HOY (zona MX) ──')
    const { rows: sched } = await query(
      `SELECT ss.id, ss.shift_number, ss.status AS sched_status,
              ss.scheduled_date, ss.scheduled_start,
              (ss.shift_id IS NOT NULL) AS confirmado,
              ps.status AS prod_status, ps.shift_number AS prod_num
         FROM scheduled_shifts ss
         LEFT JOIN production_shifts ps ON ps.id = ss.shift_id
        WHERE ss.tenant_id = $1
          AND ss.scheduled_date = (NOW() AT TIME ZONE 'America/Mexico_City')::date
        ORDER BY ss.shift_number`,
      [tenantId]
    )
    console.table(sched.map(r => ({
      turno: r.shift_number, sched: r.sched_status, confirmado: r.confirmado,
      prod: r.prod_status || '—', prod_turno: r.prod_num || '—',
      inicio: r.scheduled_start,
    })))
    if (!sched.length) console.log('  (no hay turnos programados para hoy)')

    // ── SLOTS ocupados hoy (production_shifts) — para prever choques ────────────
    console.log('\n── SLOTS (shift_number) OCUPADOS con fecha=HOY en production_shifts ──')
    const { rows: slots } = await query(
      `SELECT ps.shift_number, ps.status, COUNT(*)::int AS n
         FROM production_shifts ps
        WHERE ps.tenant_id = $1
          AND ps.shift_date = (NOW() AT TIME ZONE 'America/Mexico_City')::date
        GROUP BY ps.shift_number, ps.status
        ORDER BY ps.shift_number`,
      [tenantId]
    )
    console.table(slots)
    const num3 = slots.find(s => String(s.shift_number) === '3')
    console.log(
      num3
        ? `🔴 El slot (Turno 3, HOY) YA está ocupado (status=${num3.status}). Un Turno 3 nuevo con fecha=hoy CHOCARÍA con el UNIQUE.`
        : `🟢 El slot (Turno 3, HOY) está libre.`
    )

    // ── catálogo de turnos configurados ────────────────────────────────────────
    console.log('\n── tenant_shift_config (números configurados) ──')
    const { rows: cfg } = await query(
      `SELECT shift_number, name, start_time, duration_hours
         FROM tenant_shift_config WHERE tenant_id = $1 ORDER BY shift_number`,
      [tenantId]
    )
    console.table(cfg)
  })
})()
  .then(() => pool.end())
  .catch((e) => { console.error('ERROR:', e.stack || e.message); pool.end(); process.exitCode = 1 })
