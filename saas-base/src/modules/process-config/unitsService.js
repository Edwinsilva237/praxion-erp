'use strict'

/**
 * SaaS v2 — Service de unidades de medida (tenant_units + tenant_unit_conversions).
 *
 * CRUD de las unidades de un tenant + lookup de conversiones. Reglas:
 *  - Solo una base por (tenant_id, unit_type) — protegido por unique index.
 *  - Conversiones son unidireccionales (1 row = 1 dirección); el inverso se
 *    calcula al vuelo en convert().
 *  - Solo entre unidades del mismo unit_type.
 *  - No se puede desactivar una unidad que está siendo referenciada (defer
 *    al implementarse las tablas que las referencian — por ahora soft-delete
 *    sin validación de uso).
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.2, §2.2.3.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

const UNIT_TYPES = ['weight', 'volume', 'count', 'length', 'area', 'time']

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listUnits({ tenantId, unitType, isActive }) {
  const params = [tenantId]
  const filters = []
  if (unitType) { params.push(unitType); filters.push(`unit_type = $${params.length}`) }
  if (isActive !== undefined) {
    params.push(isActive)
    filters.push(`is_active = $${params.length}`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT * FROM tenant_units
     WHERE tenant_id = $1 ${where}
     ORDER BY unit_type, sort_order, code`,
    params
  )
  return rows
}

async function getUnit({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM tenant_units WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

async function listConversions({ tenantId, fromUnitId, toUnitId }) {
  const params = [tenantId]
  const filters = []
  if (fromUnitId) { params.push(fromUnitId); filters.push(`from_unit_id = $${params.length}`) }
  if (toUnitId)   { params.push(toUnitId);   filters.push(`to_unit_id = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT c.*,
            fu.code AS from_code, fu.name AS from_name, fu.unit_type AS from_unit_type,
            tu.code AS to_code,   tu.name AS to_name,   tu.unit_type AS to_unit_type
     FROM tenant_unit_conversions c
     JOIN tenant_units fu ON fu.id = c.from_unit_id
     JOIN tenant_units tu ON tu.id = c.to_unit_id
     WHERE c.tenant_id = $1 ${where}
     ORDER BY fu.unit_type, fu.code, tu.code`,
    params
  )
  return rows
}

// ─── Escrituras ───────────────────────────────────────────────────────────

async function createUnit({
  tenantId, userId,
  code, name, symbol, unitType,
  isBase = false, decimals = 2, sortOrder = 0,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (!symbol) throw badReq('symbol es requerido.')
  if (!UNIT_TYPES.includes(unitType)) {
    throw badReq(`unit_type debe ser uno de: ${UNIT_TYPES.join(', ')}.`)
  }
  if (typeof isBase !== 'boolean') throw badReq('is_base debe ser boolean.')
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
    throw badReq('decimals debe ser entero entre 0 y 6.')
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_units
         (tenant_id, code, name, symbol, unit_type, is_base, decimals, sort_order, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [tenantId, code, name, symbol, unitType, isBase, decimals, sortOrder, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_unit.created',
      resource: 'tenant_units',
      resourceId: rows[0].id,
      payload: { code, unitType, isBase },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tu_code_per_tenant') {
      throw conflict(`Ya existe una unidad con código "${code}".`)
    }
    if (err.code === '23505' && err.constraint === 'tu_one_base_per_type') {
      throw conflict(`Ya existe una unidad base para el tipo "${unitType}". Solo puede haber una.`)
    }
    throw err
  }
}

async function updateUnit({
  tenantId, userId, id,
  name, symbol, decimals, sortOrder, isActive,
  ipAddress, userAgent,
}) {
  const current = await getUnit({ tenantId, id })
  if (!current) {
    const err = new Error('Unidad no encontrada.')
    err.status = 404
    throw err
  }

  // Solo actualizamos los campos provistos (PATCH)
  const setters = []
  const params = []
  let i = 1
  if (name !== undefined)      { setters.push(`name = $${i++}`);      params.push(name) }
  if (symbol !== undefined)    { setters.push(`symbol = $${i++}`);    params.push(symbol) }
  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
      throw badReq('decimals debe ser entero entre 0 y 6.')
    }
    setters.push(`decimals = $${i++}`); params.push(decimals)
  }
  if (sortOrder !== undefined) { setters.push(`sort_order = $${i++}`); params.push(sortOrder) }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }
  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_units SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_unit.updated',
    resource: 'tenant_units',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

async function createConversion({
  tenantId, userId,
  fromUnitId, toUnitId, factor,
  ipAddress, userAgent,
}) {
  if (!fromUnitId || !toUnitId) throw badReq('from_unit_id y to_unit_id son requeridos.')
  if (fromUnitId === toUnitId) throw badReq('from_unit_id y to_unit_id deben ser distintos.')
  const factorNum = parseFloat(factor)
  if (!isFinite(factorNum) || factorNum <= 0) throw badReq('factor debe ser un número > 0.')

  // Cargar ambas unidades para validar que existen y son del mismo unit_type
  const { rows: units } = await query(
    `SELECT id, unit_type FROM tenant_units
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, [fromUnitId, toUnitId]]
  )
  if (units.length !== 2) {
    const err = new Error('Una o ambas unidades no existen en este tenant.')
    err.status = 404
    throw err
  }
  if (units[0].unit_type !== units[1].unit_type) {
    throw badReq('Las dos unidades deben ser del mismo unit_type.')
  }

  try {
    const { rows } = await query(
      `INSERT INTO tenant_unit_conversions
         (tenant_id, from_unit_id, to_unit_id, factor, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [tenantId, fromUnitId, toUnitId, factorNum, userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_unit_conversion.created',
      resource: 'tenant_unit_conversions',
      resourceId: rows[0].id,
      payload: { fromUnitId, toUnitId, factor: factorNum },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tuc_unique') {
      throw conflict('Ya existe una conversión para ese par from→to.')
    }
    throw err
  }
}

// ─── Conversor (utilidad para el motor) ──────────────────────────────────

/**
 * Convierte una cantidad entre dos unidades del mismo unit_type del tenant.
 * Usa la conversión directa (from→to), la inversa (to→from invertido), o pasa
 * por la base si no hay link directo.
 *
 * Devuelve null si no se puede convertir (unidades de tipos distintos, o sin
 * conversión disponible). La app no debe asumir conversión silenciosa.
 */
async function convert({ tenantId, fromUnitId, toUnitId, quantity }) {
  if (fromUnitId === toUnitId) return parseFloat(quantity)

  const { rows: units } = await query(
    `SELECT id, unit_type, is_base FROM tenant_units
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, [fromUnitId, toUnitId]]
  )
  if (units.length !== 2) return null
  if (units[0].unit_type !== units[1].unit_type) return null

  // 1. Buscar conversión directa from→to
  const { rows: direct } = await query(
    `SELECT factor FROM tenant_unit_conversions
     WHERE tenant_id = $1 AND from_unit_id = $2 AND to_unit_id = $3 AND is_active = true`,
    [tenantId, fromUnitId, toUnitId]
  )
  if (direct[0]) return parseFloat(quantity) * parseFloat(direct[0].factor)

  // 2. Buscar inversa to→from
  const { rows: reverse } = await query(
    `SELECT factor FROM tenant_unit_conversions
     WHERE tenant_id = $1 AND from_unit_id = $2 AND to_unit_id = $3 AND is_active = true`,
    [tenantId, toUnitId, fromUnitId]
  )
  if (reverse[0]) return parseFloat(quantity) / parseFloat(reverse[0].factor)

  // 3. Pasar por la base del unit_type (from → base → to)
  const { rows: base } = await query(
    `SELECT id FROM tenant_units
     WHERE tenant_id = $1 AND unit_type = $2 AND is_base = true LIMIT 1`,
    [tenantId, units[0].unit_type]
  )
  if (!base[0]) return null
  const baseId = base[0].id
  if (baseId === fromUnitId || baseId === toUnitId) return null  // ya cubierto arriba

  const toBase = await convert({ tenantId, fromUnitId, toUnitId: baseId, quantity })
  if (toBase == null) return null
  return await convert({ tenantId, fromUnitId: baseId, toUnitId, quantity: toBase })
}

// ─── helpers ──────────────────────────────────────────────────────────────

function badReq(msg) { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  UNIT_TYPES,
  listUnits, getUnit, listConversions,
  createUnit, updateUnit, createConversion,
  convert,
}
