'use strict'

/**
 * CRUD de EMPLEADOS (RH). Los empleados existen independiente de `users`:
 * cubren operadores de piso sin login. `user_id` liga opcionalmente al usuario
 * del ERP.
 *
 * Al crear un empleado (o al cambiar su fecha de ingreso) se generan sus
 * periodos vacacionales automáticamente (motor en vacationService).
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')
const vacationService = require('./vacationService')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const EMP_COLS = `id, user_id, employee_number, full_name,
                  to_char(hire_date, 'YYYY-MM-DD')        AS hire_date,
                  to_char(termination_date, 'YYYY-MM-DD') AS termination_date,
                  daily_salary, position, department, status, notes,
                  created_at, updated_at`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Siguiente folio EMP-#### para el tenant (rellena huecos por el máximo). */
async function nextEmployeeNumber(tenantId) {
  const { rows } = await query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_number, '\\D', '', 'g'), '')::int), 0) AS max_num
       FROM employees
      WHERE tenant_id = $1 AND employee_number ~ '^EMP-'`,
    [tenantId]
  )
  const next = (rows[0].max_num || 0) + 1
  return `EMP-${String(next).padStart(4, '0')}`
}

async function normalize(tenantId, body, { forUpdate = false } = {}) {
  const out = {}

  const fullName = (body.full_name ?? body.fullName ?? '').trim()
  if (!fullName) throw createError(400, 'El nombre del empleado es requerido.')
  out.fullName = fullName

  const hireDate = (body.hire_date ?? body.hireDate ?? '').slice(0, 10)
  if (!hireDate || !DATE_RE.test(hireDate)) throw createError(400, 'La fecha de ingreso es requerida (AAAA-MM-DD).')
  out.hireDate = hireDate

  const termRaw = body.termination_date ?? body.terminationDate
  const termDate = termRaw ? String(termRaw).slice(0, 10) : null
  if (termDate && !DATE_RE.test(termDate)) throw createError(400, 'La fecha de baja no es válida (AAAA-MM-DD).')
  if (termDate && termDate < hireDate) throw createError(400, 'La fecha de baja no puede ser anterior al ingreso.')
  out.terminationDate = termDate

  let dailySalary = body.daily_salary ?? body.dailySalary
  dailySalary = dailySalary === undefined || dailySalary === null || dailySalary === '' ? null : Number(dailySalary)
  if (dailySalary !== null && (Number.isNaN(dailySalary) || dailySalary < 0)) throw createError(400, 'El salario diario no es válido.')
  out.dailySalary = dailySalary

  out.position = (body.position ?? '').trim() || null
  out.department = (body.department ?? '').trim() || null
  out.notes = (body.notes ?? '').trim() || null

  // Estatus: si hay baja, forzamos inactive; si no, lo dado o active.
  const status = (body.status ?? '').trim()
  if (status && !['active', 'inactive'].includes(status)) throw createError(400, 'El estatus debe ser active o inactive.')
  out.status = termDate ? 'inactive' : (status || 'active')

  // user_id opcional: si se da, debe ser un usuario de ESTE tenant y no estar
  // ya ligado a otro empleado.
  let userId = body.user_id ?? body.userId ?? null
  userId = userId || null
  if (userId) {
    const { rows } = await query(`SELECT id FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId])
    if (!rows.length) throw createError(400, 'El usuario ligado no pertenece a este tenant.')
  }
  out.userId = userId

  // employee_number: manual (si viene) o autogenerado en create.
  const empNum = (body.employee_number ?? body.employeeNumber ?? '').trim()
  if (empNum) out.employeeNumber = empNum
  else if (!forUpdate) out.employeeNumber = await nextEmployeeNumber(tenantId)

  return out
}

async function list({ tenantId, includeInactive = false, search }) {
  const filters = ['tenant_id = $1']
  const params = [tenantId]
  if (!includeInactive) filters.push(`status = 'active'`)
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`)
    filters.push(`(full_name ILIKE $${params.length} OR employee_number ILIKE $${params.length} OR position ILIKE $${params.length})`)
  }
  const { rows } = await query(
    `SELECT ${EMP_COLS} FROM employees
      WHERE ${filters.join(' AND ')}
      ORDER BY status ASC, full_name ASC`,
    params
  )
  return rows
}

async function get({ tenantId, id }) {
  const { rows } = await query(
    `SELECT e.id, e.user_id, e.employee_number, e.full_name,
            to_char(e.hire_date, 'YYYY-MM-DD')        AS hire_date,
            to_char(e.termination_date, 'YYYY-MM-DD') AS termination_date,
            e.daily_salary, e.position, e.department, e.status, e.notes,
            e.created_at, e.updated_at,
            u.full_name AS user_full_name, u.email AS user_email
       FROM employees e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = $1 AND e.tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

async function create({ tenantId, userId, body, ipAddress, userAgent }) {
  const v = await normalize(tenantId, body)
  const { rows } = await query(
    `INSERT INTO employees
       (tenant_id, user_id, employee_number, full_name, hire_date, termination_date,
        daily_salary, position, department, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${EMP_COLS}`,
    [tenantId, v.userId, v.employeeNumber, v.fullName, v.hireDate, v.terminationDate,
     v.dailySalary, v.position, v.department, v.status, v.notes, userId]
  )
  const employee = rows[0]
  await audit({
    tenantId, userId, action: 'hr.employee_created',
    resource: 'employees', resourceId: employee.id,
    payload: { employee_number: employee.employee_number, hire_date: employee.hire_date }, ipAddress, userAgent,
  })
  // Generar sus periodos vacacionales de una vez.
  await vacationService.generatePeriodsForEmployee({ tenantId, employeeId: employee.id, userId })
  return employee
}

async function update({ tenantId, userId, id, body, ipAddress, userAgent }) {
  const existing = await query(
    `SELECT ${EMP_COLS} FROM employees WHERE id = $1 AND tenant_id = $2`, [id, tenantId])
  if (!existing.rows.length) throw createError(404, 'Empleado no encontrado.')
  const prev = existing.rows[0]

  // Normalizamos `prev` a camelCase ANTES de mezclar con `body` (que viene en
  // camelCase del frontend). Si se mezclaran las formas snake/camel juntas, el
  // `??` de normalize elegiría el valor viejo de prev sobre el nuevo del body
  // (llaves duplicadas), ignorando la edición. Con una sola forma, body manda
  // limpio — incluido enviar null para limpiar un campo.
  const prevCamel = {
    fullName: prev.full_name,
    employeeNumber: prev.employee_number,
    hireDate: prev.hire_date,
    dailySalary: prev.daily_salary,
    position: prev.position,
    department: prev.department,
    userId: prev.user_id,
    terminationDate: prev.termination_date,
    notes: prev.notes,
    status: prev.status,
  }
  const v = await normalize(tenantId, { ...prevCamel, ...body }, { forUpdate: true })

  const { rows } = await query(
    `UPDATE employees SET
       user_id = $1, employee_number = $2, full_name = $3, hire_date = $4,
       termination_date = $5, daily_salary = $6, position = $7, department = $8,
       status = $9, notes = $10
     WHERE id = $11 AND tenant_id = $12
     RETURNING ${EMP_COLS}`,
    [v.userId, v.employeeNumber || prev.employee_number, v.fullName, v.hireDate,
     v.terminationDate, v.dailySalary, v.position, v.department, v.status, v.notes, id, tenantId]
  )
  const employee = rows[0]
  await audit({
    tenantId, userId, action: 'hr.employee_updated',
    resource: 'employees', resourceId: id,
    payload: { employee_number: employee.employee_number }, ipAddress, userAgent,
  })
  // Si cambió la fecha de ingreso o la baja, re-generar/ajustar periodos.
  if (prev.hire_date !== employee.hire_date || prev.termination_date !== employee.termination_date) {
    await vacationService.generatePeriodsForEmployee({ tenantId, employeeId: id, userId })
  }
  return employee
}

/** Baja lógica (marca inactive + fecha de baja hoy si no se dio). */
async function remove({ tenantId, userId, id, ipAddress, userAgent }) {
  const { rows } = await query(
    `UPDATE employees
        SET status = 'inactive',
            termination_date = COALESCE(termination_date, (NOW() AT TIME ZONE 'America/Mexico_City')::date)
      WHERE id = $1 AND tenant_id = $2
      RETURNING ${EMP_COLS}`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Empleado no encontrado.')
  await audit({
    tenantId, userId, action: 'hr.employee_deactivated',
    resource: 'employees', resourceId: id, ipAddress, userAgent,
  })
  return rows[0]
}

module.exports = { list, get, create, update, remove, nextEmployeeNumber }
