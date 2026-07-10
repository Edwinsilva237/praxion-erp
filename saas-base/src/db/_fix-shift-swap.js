'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// CORRECCIÓN ONE-OFF (gh-insumos-prod, 2026-07-10):
//   Nancy hizo la producción de la mañana (500 pzas) pero quedó registrada como
//   Turno 3. Jorshua tiene un Turno 1 VACÍO. Queremos:
//     • Nancy → Turno 1 con sus 500 piezas (sigue capturando ahí, turno ACTIVO).
//     • Borrar el Turno 1 vacío de Jorshua.
//     • Liberar el slot Turno 3 y dejarlo programado para Jorshua (inicia de 0 esta noche).
//
// SEGURIDAD:
//   • Corre DENTRO del Render Shell (base interna, withBypass). No abre IPs.
//   • TODO va en una transacción. Por defecto hace SIMULACRO (ROLLBACK) y te
//     muestra cómo quedaría. Solo aplica de verdad con  DIAG_APPLY=1.
//   • Guardas duras: aborta si el "turno vacío" NO está vacío, o si la mañana
//     no tiene captura. Idempotente (si ya se aplicó, no hace nada).
//
// Uso:
//   Ensayo:   node src/db/_fix-shift-swap.js
//   Aplicar:  DIAG_APPLY=1 node src/db/_fix-shift-swap.js
// ─────────────────────────────────────────────────────────────────────────────

const { getClient, withBypass, pool } = require('./index')

const PS_EMPTY   = '374ab2a4-60b7-4afe-bddb-9086f19ac2e6' // Jorshua, Turno 1, VACÍO
const PS_MORNING = '341cb0b9-f6f3-4007-90c8-de6b549a64b5' // Nancy,   Turno 3, 500 pzas
const APPLY = process.env.DIAG_APPLY === '1'

const one = async (client, sql, params) => (await client.query(sql, params)).rows[0]

withBypass(async () => {
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const empty   = await one(client, `SELECT * FROM production_shifts WHERE id=$1`, [PS_EMPTY])
    const morning = await one(client, `SELECT * FROM production_shifts WHERE id=$1`, [PS_MORNING])

    if (!morning) throw new Error('No existe el turno de la mañana (PS_MORNING). Aborto.')

    // Idempotencia
    if (!empty && String(morning.shift_number) === '1') {
      console.log('✅ Ya estaba aplicado (mañana=Turno 1, vacío borrado). No-op.')
      await client.query('ROLLBACK'); return
    }
    if (!empty) throw new Error('No existe el turno vacío pero la mañana no es Turno 1 — estado inesperado, revisar a mano.')

    // Guardas duras
    const ec = await one(client, `SELECT COUNT(*)::int n FROM shift_progress WHERE shift_id=$1`, [PS_EMPTY])
    if (ec.n !== 0) throw new Error(`ABORTO: el turno a borrar tiene ${ec.n} capturas — NO está vacío.`)
    const mc = await one(client, `SELECT COUNT(*)::int n, COALESCE(SUM(quantity_units),0)::int u FROM shift_progress WHERE shift_id=$1`, [PS_MORNING])
    if (mc.n === 0) throw new Error('ABORTO: la mañana no tiene capturas — algo no cuadra.')

    const tenantId  = morning.tenant_id
    const nancyId   = morning.operator_id
    const jorshuaId = empty.operator_id
    const shiftDate = morning.shift_date

    const nancy   = await one(client, `SELECT full_name FROM users WHERE id=$1`, [nancyId])
    const jorshua = await one(client, `SELECT full_name FROM users WHERE id=$1`, [jorshuaId])

    console.log(`Tenant=${tenantId}  fecha=${String(shiftDate).slice(0,10)}`)
    console.log(`Vacío  : Turno ${empty.shift_number} (${jorshua?.full_name}) status=${empty.status} — 0 capturas → SE BORRA`)
    console.log(`Mañana : Turno ${morning.shift_number} (${nancy?.full_name}) status=${morning.status} — ${mc.u} pzas → pasa a TURNO 1`)

    const ss1 = await one(client, `SELECT id FROM scheduled_shifts WHERE shift_id=$1`, [PS_EMPTY])   // Turno 1 prog (Jorshua)
    const ss3 = await one(client, `SELECT id FROM scheduled_shifts WHERE shift_id=$1`, [PS_MORNING]) // Turno 3 prog (Nancy)
    const roleRow = await one(client, `SELECT id FROM tenant_shift_roles WHERE tenant_id=$1 AND code='capturista' AND is_active=true LIMIT 1`, [tenantId])
    const capRole = roleRow?.id || null
    console.log(`SS1(Turno1 prog)=${ss1?.id || '—'}   SS3(Turno3 prog)=${ss3?.id || '—'}   rolCapturista=${capRole || '—'}`)

    // 1) Re-apuntar el Turno 1 PROGRAMADO a la mañana, operador Nancy, activo.
    if (ss1) {
      await client.query(
        `UPDATE scheduled_shifts
            SET shift_id=$2, operator_id=$3, status='active',
                confirmed_at=COALESCE(confirmed_at,NOW()), confirmed_by=COALESCE(confirmed_by,$3)
          WHERE id=$1`, [ss1.id, PS_MORNING, nancyId])
      if (capRole) {
        await client.query(`DELETE FROM scheduled_shift_members WHERE scheduled_shift_id=$1`, [ss1.id])
        await client.query(`INSERT INTO scheduled_shift_members (scheduled_shift_id, user_id, role_id, is_handover_responsible) VALUES ($1,$2,$3,true)`, [ss1.id, nancyId, capRole])
      }
    }

    // 2) Limpiar referencias RESTRICT al turno vacío.
    await client.query(`DELETE FROM shift_handovers WHERE shift_id=$1`, [PS_EMPTY])
    await client.query(`UPDATE production_shifts SET handover_waiting_shift_id=NULL WHERE handover_waiting_shift_id=$1`, [PS_EMPTY])
    await client.query(`DELETE FROM shift_receptions WHERE outgoing_shift_id=$1 OR incoming_shift_id=$1`, [PS_EMPTY])
    const lc = await one(client, `SELECT COUNT(*)::int n FROM lot_consumption WHERE shift_id=$1`, [PS_EMPTY])
    if (lc.n > 0) throw new Error(`ABORTO: el vacío tiene ${lc.n} lot_consumption (RESTRICT). Revisar a mano.`)
    const delMov = await client.query(`DELETE FROM inventory_movements WHERE reference_type='production_shift' AND reference_id=$1`, [PS_EMPTY])
    console.log(`Movimientos de inv. del vacío borrados (neto 0): ${delMov.rowCount}`)

    // 3) Borrar el turno vacío (CASCADE a members/overhead/cost/etc.).
    await client.query(`DELETE FROM production_shifts WHERE id=$1`, [PS_EMPTY])

    // 4) Renombrar la mañana a Turno 1 (el slot ya quedó libre).
    await client.query(`UPDATE production_shifts SET shift_number='1' WHERE id=$1`, [PS_MORNING])

    // 5) Liberar el Turno 3 PROGRAMADO y reasignarlo a Jorshua para esta noche.
    if (ss3) {
      await client.query(
        `UPDATE scheduled_shifts
            SET shift_id=NULL, operator_id=$2, status='scheduled', confirmed_at=NULL, confirmed_by=NULL
          WHERE id=$1`, [ss3.id, jorshuaId])
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
      console.log('\n✅ APLICADO (COMMIT). Nancy = Turno 1 con sus piezas; Turno 3 libre para Jorshua.')
    } else {
      await client.query('ROLLBACK')
      console.log('\n🟡 SIMULACRO (ROLLBACK) — NO se cambió nada. Si el estado final de arriba te cuadra, aplica con:')
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
