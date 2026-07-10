'use strict'

const { query, withTransaction } = require('../../db')

const DEFAULT_CONFIG = [
  { shift_number: 1, name: 'Turno Matutino',   start_time: '06:00', duration_hours: 8, confirmation_tolerance_minutes: 15, early_start_window_minutes: 30 },
  { shift_number: 2, name: 'Turno Vespertino', start_time: '14:00', duration_hours: 8, confirmation_tolerance_minutes: 15, early_start_window_minutes: 30 },
  { shift_number: 3, name: 'Turno Nocturno',   start_time: '22:00', duration_hours: 8, confirmation_tolerance_minutes: 15, early_start_window_minutes: 30 },
]

async function getShiftConfig({ tenantId }) {
  const { rows } = await query(
    `SELECT shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes,
            early_start_window_minutes
     FROM tenant_shift_config
     WHERE tenant_id = $1
     ORDER BY shift_number`,
    [tenantId]
  )
  if (rows.length === 0) return DEFAULT_CONFIG
  return rows
}

/**
 * Reemplaza el set de turnos del tenant. Acepta 1..N turnos.
 *
 * Comportamiento:
 *  - Upsert por (tenant_id, shift_number) para cada entrada.
 *  - Borra los turnos previos cuyo shift_number no esté en el array entrante.
 *  - Valida que no haya horarios solapados entre turnos.
 *
 * Todo en una sola transacción para evitar estados intermedios.
 */
async function updateShiftConfig({ tenantId, shifts }) {
  if (!Array.isArray(shifts) || shifts.length === 0) {
    const err = new Error('Debe enviarse al menos un turno.')
    err.status = 400
    throw err
  }

  const seen = new Set()
  for (const s of shifts) {
    const n = Number(s.shiftNumber)
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      const err = new Error(`shiftNumber inválido: ${s.shiftNumber}.`)
      err.status = 400
      throw err
    }
    if (seen.has(n)) {
      const err = new Error(`shiftNumber duplicado: ${n}.`)
      err.status = 400
      throw err
    }
    seen.add(n)

    if (!s.startTime || !/^\d{2}:\d{2}/.test(s.startTime)) {
      const err = new Error(`startTime inválido para turno ${n}.`)
      err.status = 400
      throw err
    }
    const duration = Number(s.durationHours || 8)
    if (!Number.isInteger(duration) || duration < 1 || duration > 24) {
      const err = new Error(`durationHours inválido para turno ${n} (1-24).`)
      err.status = 400
      throw err
    }
    if (s.earlyStartWindowMinutes != null) {
      const w = Number(s.earlyStartWindowMinutes)
      if (!Number.isInteger(w) || w < 0 || w > 720) {
        const err = new Error(`earlyStartWindowMinutes inválido para turno ${n} (0-720).`)
        err.status = 400
        throw err
      }
    }
  }

  // Validar overlaps: cada turno ocupa [start, start+duration). Los rangos no
  // se pueden cruzar dentro del mismo día. Para turnos que cruzan medianoche
  // (start + duration > 24h), se permite que envuelvan al día siguiente.
  const ranges = shifts.map(s => {
    const [h, m] = String(s.startTime).slice(0, 5).split(':').map(Number)
    const startM = h * 60 + m
    const endM = startM + Number(s.durationHours || 8) * 60
    return { n: Number(s.shiftNumber), startM, endM, name: s.name || `Turno ${s.shiftNumber}` }
  })
  // Normalizar a [0, 1440) tomando módulo. Si el rango cruza medianoche se
  // divide en dos segmentos para detectar overlaps correctamente.
  function segmentsOf(r) {
    const segs = []
    let s = r.startM
    let e = r.endM
    while (e > s) {
      const dayEnd = Math.floor(s / 1440 + 1) * 1440
      segs.push([s % 1440, Math.min(e, dayEnd) % 1440 || 1440])
      s = Math.min(e, dayEnd)
    }
    return segs
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const A = segmentsOf(ranges[i])
      const B = segmentsOf(ranges[j])
      for (const [a1, a2] of A) {
        for (const [b1, b2] of B) {
          if (a1 < b2 && b1 < a2) {
            const err = new Error(
              `Los turnos "${ranges[i].name}" y "${ranges[j].name}" se solapan en horario. Ajusta horas o duración.`
            )
            err.status = 400
            throw err
          }
        }
      }
    }
  }

  await withTransaction(async (client) => {
    // Upsert de los entrantes
    for (const s of shifts) {
      await client.query(
        `INSERT INTO tenant_shift_config
           (tenant_id, shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes,
            early_start_window_minutes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (tenant_id, shift_number)
         DO UPDATE SET
           name                            = EXCLUDED.name,
           start_time                      = EXCLUDED.start_time,
           duration_hours                  = EXCLUDED.duration_hours,
           confirmation_tolerance_minutes  = EXCLUDED.confirmation_tolerance_minutes,
           early_start_window_minutes      = EXCLUDED.early_start_window_minutes,
           updated_at                      = NOW()`,
        [tenantId, s.shiftNumber, s.name || '', s.startTime,
         s.durationHours || 8, s.confirmationToleranceMinutes || 15,
         s.earlyStartWindowMinutes != null ? Number(s.earlyStartWindowMinutes) : 30]
      )
    }
    // Borrar los que ya no vienen en el array (se removieron en la UI)
    const keepNumbers = shifts.map(s => Number(s.shiftNumber))
    await client.query(
      `DELETE FROM tenant_shift_config
       WHERE tenant_id = $1 AND shift_number <> ALL($2::int[])`,
      [tenantId, keepNumbers]
    )
  })

  return getShiftConfig({ tenantId })
}

module.exports = { getShiftConfig, updateShiftConfig, DEFAULT_CONFIG }
