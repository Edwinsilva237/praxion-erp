'use strict'

const { query } = require('../../db')

const DEFAULT_CONFIG = [
  { shift_number: 1, name: 'Turno Matutino',   start_time: '06:00', duration_hours: 8, confirmation_tolerance_minutes: 15 },
  { shift_number: 2, name: 'Turno Vespertino', start_time: '14:00', duration_hours: 8, confirmation_tolerance_minutes: 15 },
  { shift_number: 3, name: 'Turno Nocturno',   start_time: '22:00', duration_hours: 8, confirmation_tolerance_minutes: 15 },
]

async function getShiftConfig({ tenantId }) {
  const { rows } = await query(
    `SELECT shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes
     FROM tenant_shift_config
     WHERE tenant_id = $1
     ORDER BY shift_number`,
    [tenantId]
  )
  // Si no hay configuración, devolver defaults
  if (rows.length === 0) return DEFAULT_CONFIG
  return rows
}

async function updateShiftConfig({ tenantId, shifts }) {
  // shifts: [{ shiftNumber, name, startTime, durationHours, confirmationToleranceMinutes }]
  for (const s of shifts) {
    await query(
      `INSERT INTO tenant_shift_config
         (tenant_id, shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (tenant_id, shift_number)
       DO UPDATE SET
         name                            = EXCLUDED.name,
         start_time                      = EXCLUDED.start_time,
         duration_hours                  = EXCLUDED.duration_hours,
         confirmation_tolerance_minutes  = EXCLUDED.confirmation_tolerance_minutes,
         updated_at                      = NOW()`,
      [tenantId, s.shiftNumber, s.name, s.startTime,
       s.durationHours || 8, s.confirmationToleranceMinutes || 15]
    )
  }
  return getShiftConfig({ tenantId })
}

module.exports = { getShiftConfig, updateShiftConfig }
