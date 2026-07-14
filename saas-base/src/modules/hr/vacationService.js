'use strict'

/**
 * Motor de PERIODOS VACACIONALES (RH).
 *
 * Reglas de negocio:
 *   - El derecho a vacaciones se genera POR AÑO DE SERVICIO CUMPLIDO (aniversario
 *     de la fecha de ingreso), no proporcional intra-año (el proporcional/finiquito
 *     es de pre-nómina, fuera de alcance de este submódulo).
 *   - Los días por antigüedad salen de la tabla del tenant (vacation_entitlement_rules)
 *     o, si el tenant no la personalizó, de la tabla LFT 2023 por default.
 *   - Cada periodo prescribe (para efectos de disfrute) 18 meses después del
 *     aniversario en que venció (art. 78 LFT). Se marca 'expired' pero NO se borra.
 *   - Saldo(periodo) = days_entitled − Σ taken − Σ paid + Σ adjustment.
 *
 * Todas las fechas se manejan como cadenas 'YYYY-MM-DD' para evitar el corrimiento
 * de zona horaria (node-pg parsea DATE a medianoche local) — por eso las queries
 * seleccionan las fechas con to_char.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

const PRIMA_VACACIONAL_PCT = 0.25   // 25% mínimo LFT (informativo; el pago se timbra en nómina)
const PRESCRIPTION_MONTHS = 18      // disfrute prescribe 18 meses tras el aniversario (art. 78 LFT)

/**
 * Tabla LFT 2023 (reforma vigente 01-ene-2023, art. 76) como rangos de años → días.
 * Se usa cuando el tenant no ha personalizado su tabla. Para años más allá del
 * último rango, se extrapola +2 días por cada bloque de 5 años adicional.
 */
const LFT_2023_DEFAULT = [
  { years_from: 1,  years_to: 1,  days_entitled: 12 },
  { years_from: 2,  years_to: 2,  days_entitled: 14 },
  { years_from: 3,  years_to: 3,  days_entitled: 16 },
  { years_from: 4,  years_to: 4,  days_entitled: 18 },
  { years_from: 5,  years_to: 5,  days_entitled: 20 },
  { years_from: 6,  years_to: 10, days_entitled: 22 },
  { years_from: 11, years_to: 15, days_entitled: 24 },
  { years_from: 16, years_to: 20, days_entitled: 26 },
  { years_from: 21, years_to: 25, days_entitled: 28 },
  { years_from: 26, years_to: 30, days_entitled: 30 },
  { years_from: 31, years_to: 35, days_entitled: 32 },
]

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

// ── Utilidades de fecha (calendario puro, sin zona horaria) ──────────────────

/** Hoy en zona horaria de México como 'YYYY-MM-DD'. */
function mxToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
}

function parseYmd(str) {
  const [y, m, d] = String(str).slice(0, 10).split('-').map(Number)
  return { y, m, d }
}
function fmtYmd({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate() }

/** Aniversario k de una fecha de ingreso, clampando 29-feb a 28-feb en años no bisiestos. */
function anniversary(hire, k) {
  const y = hire.y + k
  const m = hire.m
  const d = Math.min(hire.d, daysInMonth(y, m))
  return { y, m, d }
}

/** Suma n meses a una fecha (clampando el día al último del mes destino). */
function addMonths(date, n) {
  const total = (date.m - 1) + n
  const y = date.y + Math.floor(total / 12)
  const m = (total % 12 + 12) % 12 + 1
  const d = Math.min(date.d, daysInMonth(y, m))
  return { y, m, d }
}

/** -1 si a<b, 0 si iguales, 1 si a>b. */
function cmpYmd(a, b) {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1
  if (a.m !== b.m) return a.m < b.m ? -1 : 1
  if (a.d !== b.d) return a.d < b.d ? -1 : 1
  return 0
}

/** Años de servicio CUMPLIDOS entre ingreso y una fecha de corte. */
function completedYearsOfService(hire, asOf) {
  let years = asOf.y - hire.y
  // Si aún no llega el mes/día del aniversario en el año de corte, resta uno.
  if (asOf.m < hire.m || (asOf.m === hire.m && asOf.d < hire.d)) years -= 1
  return Math.max(0, years)
}

/** Días que corresponden al año de servicio `year` según una tabla de rangos. */
function entitledDaysFor(year, rules) {
  if (year < 1) return 0
  const sorted = [...rules].sort((a, b) => a.years_from - b.years_from)
  for (const r of sorted) {
    const to = r.years_to == null ? Infinity : r.years_to
    if (year >= r.years_from && year <= to) return Number(r.days_entitled)
  }
  // Más allá del último rango cerrado: extrapola +2 días por cada bloque de 5 años.
  const last = sorted[sorted.length - 1]
  if (last && last.years_to != null && year > last.years_to) {
    const blocks = Math.floor((year - last.years_to - 1) / 5) + 1
    return Number(last.days_entitled) + 2 * blocks
  }
  return sorted.length ? Number(sorted[0].days_entitled) : 0
}

// ── Tabla de días por antigüedad (configurable por tenant) ───────────────────

/**
 * Devuelve la tabla EFECTIVA del tenant: sus renglones si personalizó, o la
 * tabla LFT 2023 por default. `isDefault` indica cuál se usó.
 */
async function getEntitlementRules({ tenantId }) {
  const { rows } = await query(
    `SELECT years_from, years_to, days_entitled
       FROM vacation_entitlement_rules
      WHERE tenant_id = $1
      ORDER BY years_from`,
    [tenantId]
  )
  if (rows.length) {
    return {
      rules: rows.map(r => ({
        years_from: r.years_from,
        years_to: r.years_to,
        days_entitled: Number(r.days_entitled),
      })),
      isDefault: false,
      primaPct: PRIMA_VACACIONAL_PCT,
    }
  }
  return { rules: LFT_2023_DEFAULT.map(r => ({ ...r })), isDefault: true, primaPct: PRIMA_VACACIONAL_PCT }
}

function validateRules(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw createError(400, 'La tabla de vacaciones debe tener al menos un renglón.')
  }
  const rules = input.map((r, i) => {
    const yf = parseInt(r.years_from ?? r.yearsFrom, 10)
    const ytRaw = r.years_to ?? r.yearsTo
    const yt = ytRaw === null || ytRaw === undefined || ytRaw === '' ? null : parseInt(ytRaw, 10)
    const days = Number(r.days_entitled ?? r.daysEntitled ?? r.days)
    if (!Number.isInteger(yf) || yf < 1) throw createError(400, `Renglón ${i + 1}: "años desde" debe ser un entero ≥ 1.`)
    if (yt !== null && (!Number.isInteger(yt) || yt < yf)) throw createError(400, `Renglón ${i + 1}: "años hasta" debe ser ≥ "años desde".`)
    if (!(days >= 0) || Number.isNaN(days)) throw createError(400, `Renglón ${i + 1}: los días deben ser un número ≥ 0.`)
    return { years_from: yf, years_to: yt, days_entitled: days }
  }).sort((a, b) => a.years_from - b.years_from)

  // Sin traslapes ni duplicados de years_from.
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].years_from === rules[i - 1].years_from) {
      throw createError(400, `Hay dos renglones que empiezan en el año ${rules[i].years_from}.`)
    }
    const prevTo = rules[i - 1].years_to == null ? Infinity : rules[i - 1].years_to
    if (rules[i].years_from <= prevTo) {
      throw createError(400, `Los rangos de años se traslapan cerca del año ${rules[i].years_from}.`)
    }
  }
  return rules
}

/** Reemplaza la tabla del tenant por completo (o la borra para volver al default LFT). */
async function updateEntitlementRules({ tenantId, userId, rules, ipAddress, userAgent }) {
  const clean = validateRules(rules)
  await withTransaction(async (client) => {
    await client.query('DELETE FROM vacation_entitlement_rules WHERE tenant_id = $1', [tenantId])
    for (const r of clean) {
      await client.query(
        `INSERT INTO vacation_entitlement_rules (tenant_id, years_from, years_to, days_entitled)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, r.years_from, r.years_to, r.days_entitled]
      )
    }
  })
  await audit({
    tenantId, userId, action: 'hr.vacation_rules_updated',
    resource: 'vacation_entitlement_rules', payload: { rows: clean.length }, ipAddress, userAgent,
  })
  return getEntitlementRules({ tenantId })
}

/** Restaura el default LFT 2023 borrando la personalización del tenant. */
async function resetEntitlementRules({ tenantId, userId, ipAddress, userAgent }) {
  await query('DELETE FROM vacation_entitlement_rules WHERE tenant_id = $1', [tenantId])
  await audit({
    tenantId, userId, action: 'hr.vacation_rules_reset',
    resource: 'vacation_entitlement_rules', ipAddress, userAgent,
  })
  return getEntitlementRules({ tenantId })
}

// ── Generación de periodos ───────────────────────────────────────────────────

async function loadEmployee({ tenantId, employeeId }) {
  const { rows } = await query(
    `SELECT id, full_name, employee_number,
            to_char(hire_date, 'YYYY-MM-DD')        AS hire_date,
            to_char(termination_date, 'YYYY-MM-DD') AS termination_date,
            status, daily_salary
       FROM employees WHERE id = $1 AND tenant_id = $2`,
    [employeeId, tenantId]
  )
  return rows[0] || null
}

/**
 * Crea/actualiza los periodos vacacionales de un empleado desde su ingreso hasta
 * hoy (o su baja). Idempotente: re-corrre sin duplicar (ON CONFLICT) y refresca
 * días/fechas si cambió la tabla o la fecha de ingreso. NO borra periodos con
 * movimientos aunque la antigüedad "baje" (protege el histórico).
 *
 * @returns {Promise<{created:number, updated:number, periods:number}>}
 */
async function generatePeriodsForEmployee({ tenantId, employeeId, userId, asOf = mxToday() }) {
  const emp = await loadEmployee({ tenantId, employeeId })
  if (!emp) throw createError(404, 'Empleado no encontrado.')

  const hire = parseYmd(emp.hire_date)
  // Corte: hoy, o la fecha de baja si ya no está activo.
  let cutoff = parseYmd(asOf)
  if (emp.termination_date) {
    const term = parseYmd(emp.termination_date)
    if (cmpYmd(term, cutoff) < 0) cutoff = term
  }
  const fullYears = completedYearsOfService(hire, cutoff)

  const { rules } = await getEntitlementRules({ tenantId })

  let created = 0, updated = 0
  await withTransaction(async (client) => {
    for (let k = 1; k <= fullYears; k++) {
      const periodStart = anniversary(hire, k - 1)
      const periodEnd   = anniversary(hire, k)          // aniversario en que vencen los días
      const expiresAt   = addMonths(periodEnd, PRESCRIPTION_MONTHS)
      const days        = entitledDaysFor(k, rules)

      const { rows } = await client.query(
        `INSERT INTO vacation_periods
           (tenant_id, employee_id, period_number, period_start, period_end, days_entitled, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (employee_id, period_number) DO UPDATE
           SET period_start  = EXCLUDED.period_start,
               period_end    = EXCLUDED.period_end,
               expires_at    = EXCLUDED.expires_at,
               days_entitled = EXCLUDED.days_entitled
         RETURNING (xmax = 0) AS inserted`,
        [tenantId, employeeId, k, fmtYmd(periodStart), fmtYmd(periodEnd), days, fmtYmd(expiresAt)]
      )
      if (rows[0].inserted) created++; else updated++
    }
  })

  if (created > 0 && userId) {
    await audit({
      tenantId, userId, action: 'hr.vacation_periods_generated',
      resource: 'vacation_periods', resourceId: employeeId,
      payload: { created, updated, full_years: fullYears },
    })
  }
  return { created, updated, periods: fullYears }
}

// ── Saldos ────────────────────────────────────────────────────────────────────

function effectiveStatus(period, pending, today) {
  if (period.status === 'closed') return 'closed'
  if (pending <= 0) return 'exhausted'
  if (cmpYmd(parseYmd(period.expires_at), parseYmd(today)) < 0) return 'expired'
  return 'open'
}

/**
 * Saldo vacacional de un empleado: cada periodo con días gozados/pendientes,
 * prima vacacional (informativa) y un resumen agregado.
 */
async function getBalance({ tenantId, employeeId, asOf = mxToday() }) {
  const emp = await loadEmployee({ tenantId, employeeId })
  if (!emp) throw createError(404, 'Empleado no encontrado.')

  const { rows } = await query(
    `SELECT vp.id, vp.period_number,
            to_char(vp.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(vp.period_end,   'YYYY-MM-DD') AS period_end,
            to_char(vp.expires_at,   'YYYY-MM-DD') AS expires_at,
            vp.days_entitled, vp.status,
            COALESCE(SUM(CASE WHEN vl.entry_type = 'taken'      THEN vl.days ELSE 0 END), 0) AS taken,
            COALESCE(SUM(CASE WHEN vl.entry_type = 'paid'       THEN vl.days ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN vl.entry_type = 'adjustment' THEN vl.days ELSE 0 END), 0) AS adjustment
       FROM vacation_periods vp
       LEFT JOIN vacation_ledger vl ON vl.period_id = vp.id
      WHERE vp.employee_id = $1 AND vp.tenant_id = $2
      GROUP BY vp.id
      ORDER BY vp.period_number`,
    [employeeId, tenantId]
  )

  const dailySalary = emp.daily_salary == null ? null : Number(emp.daily_salary)
  const periods = rows.map(r => {
    const daysEntitled = Number(r.days_entitled)
    const taken = Number(r.taken)
    const paid = Number(r.paid)
    const adjustment = Number(r.adjustment)
    const pending = +(daysEntitled - taken - paid + adjustment).toFixed(2)
    const prima = dailySalary == null ? null : +(daysEntitled * dailySalary * PRIMA_VACACIONAL_PCT).toFixed(2)
    return {
      id: r.id,
      period_number: r.period_number,
      period_start: r.period_start,
      period_end: r.period_end,
      expires_at: r.expires_at,
      days_entitled: daysEntitled,
      taken, paid, adjustment,
      pending,
      prima_vacacional: prima,
      status: effectiveStatus(r, pending, asOf),
    }
  })

  const summary = periods.reduce((acc, p) => {
    acc.total_entitled += p.days_entitled
    acc.total_taken += p.taken + p.paid
    acc.total_pending += p.status === 'expired' ? 0 : p.pending
    acc.total_expired += p.status === 'expired' ? p.pending : 0
    if (p.prima_vacacional != null) acc.total_prima += p.prima_vacacional
    return acc
  }, { total_entitled: 0, total_taken: 0, total_pending: 0, total_expired: 0, total_prima: 0 })

  for (const k of Object.keys(summary)) summary[k] = +summary[k].toFixed(2)

  return {
    employee: {
      id: emp.id, full_name: emp.full_name, employee_number: emp.employee_number,
      hire_date: emp.hire_date, status: emp.status, daily_salary: dailySalary,
    },
    years_of_service: completedYearsOfService(parseYmd(emp.hire_date), parseYmd(asOf)),
    prima_pct: PRIMA_VACACIONAL_PCT,
    periods,
    summary,
  }
}

// ── Movimientos (ledger) ──────────────────────────────────────────────────────

async function loadPeriod({ tenantId, periodId, employeeId }) {
  const { rows } = await query(
    `SELECT vp.id, vp.employee_id, vp.days_entitled,
            COALESCE(SUM(CASE WHEN vl.entry_type = 'taken' OR vl.entry_type = 'paid' THEN vl.days ELSE 0 END), 0) AS deducted,
            COALESCE(SUM(CASE WHEN vl.entry_type = 'adjustment' THEN vl.days ELSE 0 END), 0) AS adjustment
       FROM vacation_periods vp
       LEFT JOIN vacation_ledger vl ON vl.period_id = vp.id
      WHERE vp.id = $1 AND vp.tenant_id = $2 AND vp.employee_id = $3
      GROUP BY vp.id`,
    [periodId, tenantId, employeeId]
  )
  if (!rows.length) return null
  const p = rows[0]
  p.pending = +(Number(p.days_entitled) - Number(p.deducted) + Number(p.adjustment)).toFixed(2)
  return p
}

async function insertLedger({ tenantId, employeeId, periodId, entryType, days, startDate, endDate, note, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `INSERT INTO vacation_ledger
       (tenant_id, period_id, employee_id, entry_type, days, start_date, end_date, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, entry_type, days,
               to_char(start_date, 'YYYY-MM-DD') AS start_date,
               to_char(end_date,   'YYYY-MM-DD') AS end_date,
               note, created_at`,
    [tenantId, periodId, employeeId, entryType, days, startDate || null, endDate || null, note || null, userId]
  )
  await audit({
    tenantId, userId, action: `hr.vacation_${entryType}`,
    resource: 'vacation_ledger', resourceId: rows[0].id,
    payload: { employee_id: employeeId, period_id: periodId, days }, ipAddress, userAgent,
  })
  return rows[0]
}

/** Registra días GOZADOS. Valida que no exceda el saldo pendiente del periodo. */
async function registerTaken({ tenantId, employeeId, periodId, days, startDate, endDate, note, userId, ipAddress, userAgent }) {
  const d = Number(days)
  if (!(d > 0)) throw createError(400, 'Los días deben ser mayores a 0.')
  const period = await loadPeriod({ tenantId, periodId, employeeId })
  if (!period) throw createError(404, 'Periodo vacacional no encontrado.')
  if (d > period.pending + 1e-9) {
    throw createError(400, `No hay saldo suficiente: quedan ${period.pending} día(s) en este periodo.`)
  }
  return insertLedger({ tenantId, employeeId, periodId, entryType: 'taken', days: d, startDate, endDate, note, userId, ipAddress, userAgent })
}

/** Registra días PAGADOS sin gozar. Misma validación de saldo que 'taken'. */
async function registerPaid({ tenantId, employeeId, periodId, days, note, userId, ipAddress, userAgent }) {
  const d = Number(days)
  if (!(d > 0)) throw createError(400, 'Los días deben ser mayores a 0.')
  const period = await loadPeriod({ tenantId, periodId, employeeId })
  if (!period) throw createError(404, 'Periodo vacacional no encontrado.')
  if (d > period.pending + 1e-9) {
    throw createError(400, `No hay saldo suficiente: quedan ${period.pending} día(s) en este periodo.`)
  }
  return insertLedger({ tenantId, employeeId, periodId, entryType: 'paid', days: d, note, userId, ipAddress, userAgent })
}

/** Ajuste manual (con signo): +otorga días extra, −descuenta. Requiere nota. */
async function registerAdjustment({ tenantId, employeeId, periodId, days, note, userId, ipAddress, userAgent }) {
  const d = Number(days)
  if (!d || Number.isNaN(d)) throw createError(400, 'El ajuste debe ser un número distinto de 0.')
  if (!note || !String(note).trim()) throw createError(400, 'El ajuste requiere una nota que lo justifique.')
  const period = await loadPeriod({ tenantId, periodId, employeeId })
  if (!period) throw createError(404, 'Periodo vacacional no encontrado.')
  if (period.pending + d < -1e-9) {
    throw createError(400, `El ajuste dejaría el saldo en negativo (pendiente actual ${period.pending}).`)
  }
  return insertLedger({ tenantId, employeeId, periodId, entryType: 'adjustment', days: d, note, userId, ipAddress, userAgent })
}

/** Movimientos de un empleado (bitácora), más recientes primero. */
async function getLedger({ tenantId, employeeId }) {
  const { rows } = await query(
    `SELECT vl.id, vl.period_id, vp.period_number, vl.entry_type, vl.days,
            to_char(vl.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(vl.end_date,   'YYYY-MM-DD') AS end_date,
            vl.note, vl.created_at, u.full_name AS created_by_name
       FROM vacation_ledger vl
       JOIN vacation_periods vp ON vp.id = vl.period_id
       LEFT JOIN users u ON u.id = vl.created_by
      WHERE vl.employee_id = $1 AND vl.tenant_id = $2
      ORDER BY vl.created_at DESC`,
    [employeeId, tenantId]
  )
  return rows.map(r => ({ ...r, days: Number(r.days) }))
}

/** Borra un movimiento del ledger (corrección de captura). */
async function deleteLedgerEntry({ tenantId, employeeId, entryId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `DELETE FROM vacation_ledger
      WHERE id = $1 AND tenant_id = $2 AND employee_id = $3
      RETURNING id, entry_type, days`,
    [entryId, tenantId, employeeId]
  )
  if (!rows.length) throw createError(404, 'Movimiento no encontrado.')
  await audit({
    tenantId, userId, action: 'hr.vacation_entry_deleted',
    resource: 'vacation_ledger', resourceId: entryId,
    payload: { entry_type: rows[0].entry_type, days: Number(rows[0].days) }, ipAddress, userAgent,
  })
  return rows[0]
}

module.exports = {
  // constantes / helpers puros (exportados para pruebas)
  LFT_2023_DEFAULT,
  PRIMA_VACACIONAL_PCT,
  completedYearsOfService,
  entitledDaysFor,
  anniversary,
  addMonths,
  parseYmd,
  fmtYmd,
  // reglas
  getEntitlementRules,
  updateEntitlementRules,
  resetEntitlementRules,
  // periodos / saldos
  generatePeriodsForEmployee,
  getBalance,
  // movimientos
  registerTaken,
  registerPaid,
  registerAdjustment,
  getLedger,
  deleteLedgerEntry,
}
