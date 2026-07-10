'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// CORRECCIÓN ONE-OFF (gh-insumos-prod, 2026-07-10):
//   Nancy hizo la producción de la mañana (500 pzas) pero quedó como Turno 3.
//   Además capturó 3 paquetes en el Turno 1 (que era de Jorshua). Queremos:
//     • Consolidar TODA la producción de Nancy en UN turno y que sea TURNO 1.
//     • Liberar el slot Turno 3 y dejarlo programado para Jorshua (inicia de 0 hoy).
//
//   Cómo: se mueven las capturas del Turno 1 (PS_EMPTY) al turno de Nancy
//   (PS_MORNING, el de las 500) renumerando microlotes; así PS_EMPTY queda vacío,
//   se borra, y PS_MORNING pasa a ser el Turno 1 con TODAS las piezas.
//
// SEGURIDAD:
//   • Render Shell (base interna, withBypass). Todo en UNA transacción.
//   • SIMULACRO por defecto (ROLLBACK). Aplica solo con DIAG_APPLY=1.
//   • Guardas: PS_MORNING debe tener captura; tras mover, PS_EMPTY debe quedar en 0.
//
// Uso:  ensayo →  node src/db/_fix-shift-swap.js
//       aplicar → DIAG_APPLY=1 node src/db/_fix-shift-swap.js
// ─────────────────────────────────────────────────────────────────────────────

const { getClient, withBypass, pool } = require('./index')

const PS_EMPTY   = '374ab2a4-60b7-4afe-bddb-9086f19ac2e6' // era Turno 1 (Jorshua); Nancy metió 3 paq
const PS_MORNING = '341cb0b9-f6f3-4007-90c8-de6b549a64b5' // Turno 3 (Nancy), 500 pzas → será Turno 1
const APPLY = process.env.DIAG_APPLY === '1'

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0]

withBypass(async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const empty   = await one(client, `SELECT * FROM production_shifts WHERE id=$1`, [PS_EMPTY])
    const morning = await one(client, `SELECT * FROM production_shifts WHERE id=$1`, [PS_MORNING])
    if (!morning) throw new Error('No existe PS_MORNING. Aborto.')

    if (!empty && String(morning.shift_number) === '1') {
      console.log('✅ Ya aplicado (PS_MORNING=Turno 1, PS_EMPTY borrado). No-op.')
      await client.query('ROLLBACK'); return
    }
    if (!empty) throw new Error('PS_EMPTY no existe pero PS_MORNING no es Turno 1 — estado inesperado, revisar a mano.')

    const tenantId  = morning.tenant_id
    const nancyId   = morning.operator_id
    const jorshuaId = empty.operator_id
    const shiftDate = morning.shift_date

    const cntBefore = async (id) => (await one(client, `SELECT COUNT(*)::int p, COALESCE(SUM(quantity_units),0)::int u FROM shift_progress WHERE shift_id=$1`, [id]))
    const be = await cntBefore(PS_EMPTY)
    const bm = await cntBefore(PS_MORNING)
    if (bm.p === 0) throw new Error('ABORTO: PS_MORNING no tiene capturas — algo no cuadra.')

    const nancy   = await one(client, `SELECT full_name FROM users WHERE id=$1`, [nancyId])
    const jorshua = await one(client, `SELECT full_name FROM users WHERE id=$1`, [jorshuaId])
    console.log(`Tenant=${tenantId}  fecha=${String(shiftDate).slice(0,10)}`)
    console.log(`Turno 1 actual (${jorshua?.full_name}, id ...${PS_EMPTY.slice(-6)}): ${be.p} paq / ${be.u} pzas  → se mueven a Nancy y se borra el cascarón`)
    console.log(`Turno 3 actual (${nancy?.full_name},   id ...${PS_MORNING.slice(-6)}): ${bm.p} paq / ${bm.u} pzas → pasa a TURNO 1`)

    // ── 0) MOVER la producción de PS_EMPTY → PS_MORNING (renumerando microlotes) ──
    if (be.p > 0) {
      await client.query(
        `WITH base AS (SELECT COALESCE(MAX(microlot_number),0) AS m FROM shift_progress WHERE shift_id=$1),
              src  AS (SELECT id, ROW_NUMBER() OVER (ORDER BY microlot_number, id) AS rn
                         FROM shift_progress WHERE shift_id=$2)
         UPDATE shift_progress sp
            SET shift_id=$1, microlot_number = (SELECT m FROM base) + src.rn
           FROM src WHERE sp.id = src.id`,
        [PS_MORNING, PS_EMPTY]
      )
      // Datos asociados del turno (cargas MP, merma, incidencias) también se mueven.
      await client.query(`UPDATE shift_mp_loads  SET shift_id=$1 WHERE shift_id=$2`, [PS_MORNING, PS_EMPTY])
      await client.query(`UPDATE shift_scrap      SET shift_id=$1 WHERE shift_id=$2`, [PS_MORNING, PS_EMPTY])
      await client.query(`UPDATE shift_incidents  SET shift_id=$1 WHERE shift_id=$2`, [PS_MORNING, PS_EMPTY])
      // Recomputar contador de piezas del turno de Nancy.
      await client.query(
        `UPDATE production_shifts SET pt_units_produced =
           (SELECT COALESCE(SUM(quantity_units),0) FROM shift_progress WHERE shift_id=$1 AND is_second_quality=false)
         WHERE id=$1`, [PS_MORNING])
    }
    const ae = await cntBefore(PS_EMPTY)
    if (ae.p !== 0) throw new Error(`ABORTO: tras mover, PS_EMPTY todavía tiene ${ae.p} capturas.`)
    const am = await cntBefore(PS_MORNING)
    console.log(`Tras mover: Turno de Nancy = ${am.p} paq / ${am.u} pzas.  Cascarón = 0.`)

    // ── IDs de programados y rol capturista ──
    const ss1 = await one(client, `SELECT id FROM scheduled_shifts WHERE shift_id=$1`, [PS_EMPTY])
    const ss3 = await one(client, `SELECT id FROM scheduled_shifts WHERE shift_id=$1`, [PS_MORNING])
    const roleRow = await one(client, `SELECT id FROM tenant_shift_roles WHERE tenant_id=$1 AND code='capturista' AND is_active=true LIMIT 1`, [tenantId])
    const capRole = roleRow?.id || null

    // ── 1) Turno 1 PROGRAMADO → mañana de Nancy, activo ──
    if (ss1) {
      await client.query(
        `UPDATE scheduled_shifts SET shift_id=$2, operator_id=$3, status='active',
                confirmed_at=COALESCE(confirmed_at,NOW()), confirmed_by=COALESCE(confirmed_by,$3)
          WHERE id=$1`, [ss1.id, PS_MORNING, nancyId])
      if (capRole) {
        await client.query(`DELETE FROM scheduled_shift_members WHERE scheduled_shift_id=$1`, [ss1.id])
        await client.query(`INSERT INTO scheduled_shift_members (scheduled_shift_id, user_id, role_id, is_handover_responsible) VALUES ($1,$2,$3,true)`, [ss1.id, nancyId, capRole])
      }
    }

    // ── 2) Limpiar refs RESTRICT al cascarón + borrar sus movimientos (neto 0) ──
    await client.query(`DELETE FROM shift_handovers WHERE shift_id=$1`, [PS_EMPTY])
    await client.query(`UPDATE production_shifts SET handover_waiting_shift_id=NULL WHERE handover_waiting_shift_id=$1`, [PS_EMPTY])
    await client.query(`DELETE FROM shift_receptions WHERE outgoing_shift_id=$1 OR incoming_shift_id=$1`, [PS_EMPTY])
    const lc = await one(client, `SELECT COUNT(*)::int n FROM lot_consumption WHERE shift_id=$1`, [PS_EMPTY])
    if (lc.n > 0) throw new Error(`ABORTO: el cascarón tiene ${lc.n} lot_consumption (RESTRICT). Revisar a mano.`)
    const delMov = await client.query(`DELETE FROM inventory_movements WHERE reference_type='production_shift' AND reference_id=$1`, [PS_EMPTY])
    console.log(`Movimientos de inv. del cascarón borrados (neto 0): ${delMov.rowCount}`)

    // ── 3) Borrar el cascarón (ya sin capturas) ──
    await client.query(`DELETE FROM production_shifts WHERE id=$1`, [PS_EMPTY])

    // ── 4) Renombrar la mañana a Turno 1 (slot ya libre) ──
    await client.query(`UPDATE production_shifts SET shift_number='1' WHERE id=$1`, [PS_MORNING])

    // ── 5) Liberar el Turno 3 programado y reasignarlo a Jorshua ──
    if (ss3) {
      await client.query(
        `UPDATE scheduled_shifts SET shift_id=NULL, operator_id=$2, status='scheduled', confirmed_at=NULL, confirmed_by=NULL WHERE id=$1`,
        [ss3.id, jorshuaId])
      if (capRole) {
        await client.query(`DELETE FROM scheduled_shift_members WHERE scheduled_shift_id=$1`, [ss3.id])
        await client.query(`INSERT INTO scheduled_shift_members (scheduled_shift_id, user_id, role_id, is_handover_responsible) VALUES ($1,$2,$3,true)`, [ss3.id, jorshuaId, capRole])
      }
    } else {
      console.log('⚠ No hay Turno 3 programado ligado; Jorshua deberá iniciarlo por self-start o programar uno nuevo.')
    }

    // ── Verificación final ──
    console.log('\n── ESTADO FINAL: production_shifts de esa fecha ──')
    console.table((await client.query(
      `SELECT ps.shift_number AS turno, ps.status, u.full_name AS operador,
              (SELECT COALESCE(SUM(quantity_units),0) FROM shift_progress sp WHERE sp.shift_id=ps.id)::int AS piezas
         FROM production_shifts ps LEFT JOIN users u ON u.id=ps.operator_id
        WHERE ps.tenant_id=$1 AND ps.shift_date=$2 ORDER BY ps.shift_number`,
      [tenantId, shiftDate])).rows)
    console.log('── ESTADO FINAL: scheduled_shifts de esa fecha ──')
    console.table((await client.query(
      `SELECT ss.shift_number AS turno, ss.status, (ss.shift_id IS NOT NULL) AS ligado, u.full_name AS operador
         FROM scheduled_shifts ss LEFT JOIN users u ON u.id=ss.operator_id
        WHERE ss.tenant_id=$1 AND ss.scheduled_date=$2 ORDER BY ss.shift_number`,
      [tenantId, shiftDate])).rows)

    if (APPLY) {
      await client.query('COMMIT')
      console.log('\n✅ APLICADO (COMMIT). Nancy = Turno 1 con TODAS sus piezas; Turno 3 libre para Jorshua.')
    } else {
      await client.query('ROLLBACK')
      console.log('\n🟡 SIMULACRO (ROLLBACK) — NO se cambió nada. Si el estado final te cuadra:')
      console.log('   DIAG_APPLY=1 node src/db/_fix-shift-swap.js')
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('\n❌ ERROR — ROLLBACK, no se cambió nada:', e.message)
    process.exitCode = 1
  } finally {
    client.release()
  }
})
  .then(() => pool.end())
  .catch((e) => { console.error('ERROR fatal:', e.stack || e.message); pool.end(); process.exitCode = 1 })
