'use strict'

/**
 * SaaS v2 — Service de tipos de producto (tenant_product_kinds).
 *
 * CRUD del catálogo. Reglas:
 *  - code único por tenant.
 *  - attribute_schema y capture_schema validados contra meta-schema (ajv).
 *  - version del schema auto-incrementa cuando fields cambian (string-equality
 *    sobre JSON.stringify de los fields).
 *  - base_unit_id, default_quality_grade_id deben pertenecer al tenant si != NULL.
 *  - default_shelf_life_days > 0 si != NULL.
 *
 * Política de schema evolution: por ahora cualquier cambio se acepta (validado
 * el meta-schema). La política completa (§2.2.8 — "modal de confirmación si
 * hay datos") se implementa cuando existan datos reales referenciando este
 * kind. Ver migration 125 para contexto.
 *
 * Referencia: §2.2.8.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')
const { validateSchema, emptySchema, withBumpedVersion } = require('./schemaValidator')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listKinds({ tenantId, isActive, isProduced }) {
  const params = [tenantId]
  const filters = []
  if (isActive !== undefined) {
    params.push(isActive); filters.push(`tpk.is_active = $${params.length}`)
  }
  if (isProduced !== undefined) {
    params.push(isProduced); filters.push(`tpk.is_produced = $${params.length}`)
  }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT tpk.*,
            tu.code AS base_unit_code, tu.symbol AS base_unit_symbol,
            tqg.code AS default_quality_grade_code, tqg.grade_number AS default_quality_grade_number
     FROM tenant_product_kinds tpk
     LEFT JOIN tenant_units          tu  ON tu.id  = tpk.base_unit_id
     LEFT JOIN tenant_quality_grades tqg ON tqg.id = tpk.default_quality_grade_id
     WHERE tpk.tenant_id = $1 ${where}
     ORDER BY tpk.code`,
    params
  )
  return rows
}

async function getKind({ tenantId, id }) {
  const { rows } = await query(
    `SELECT tpk.*,
            tu.code AS base_unit_code, tu.symbol AS base_unit_symbol,
            tqg.code AS default_quality_grade_code, tqg.grade_number AS default_quality_grade_number
     FROM tenant_product_kinds tpk
     LEFT JOIN tenant_units          tu  ON tu.id  = tpk.base_unit_id
     LEFT JOIN tenant_quality_grades tqg ON tqg.id = tpk.default_quality_grade_id
     WHERE tpk.id = $1 AND tpk.tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

// ─── Escrituras ──────────────────────────────────────────────────────────

async function createKind({
  tenantId, userId,
  code, name,
  isProduced = true,
  baseUnitId = null,
  attributeSchema = null,
  captureSchema = null,
  requiresLots = null,
  defaultShelfLifeDays = null,
  defaultQualityGradeId = null,
  ipAddress, userAgent,
}) {
  if (!code) throw badReq('code es requerido.')
  if (!name) throw badReq('name es requerido.')
  if (typeof isProduced !== 'boolean') throw badReq('is_produced debe ser boolean.')
  if (requiresLots !== null && requiresLots !== undefined && typeof requiresLots !== 'boolean') {
    throw badReq('requires_lots debe ser boolean o null.')
  }
  if (defaultShelfLifeDays !== null && defaultShelfLifeDays !== undefined) {
    if (!Number.isInteger(defaultShelfLifeDays) || defaultShelfLifeDays <= 0) {
      throw badReq('default_shelf_life_days debe ser entero positivo o null.')
    }
  }

  // FK validations
  if (baseUnitId) await assertTenantUnitExists(tenantId, baseUnitId)
  if (defaultQualityGradeId) await assertTenantQualityGradeExists(tenantId, defaultQualityGradeId)

  // Schemas: si el caller mandó null/undefined, usar vacío. Si mandó algo,
  // normalizar (acepta tanto wrapper { version, fields } como solo fields[]
  // como array plano, y wrap en wrapper). Luego validar.
  const attrSchema = normalizeSchemaInput(attributeSchema)
  const capSchema  = normalizeSchemaInput(captureSchema)

  validateSchema(attrSchema, 'attribute_schema')
  validateSchema(capSchema,  'capture_schema')

  try {
    const { rows } = await query(
      `INSERT INTO tenant_product_kinds
         (tenant_id, code, name, is_produced,
          base_unit_id, attribute_schema, capture_schema,
          requires_lots, default_shelf_life_days, default_quality_grade_id,
          created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, code, name, isProduced,
       baseUnitId, JSON.stringify(attrSchema), JSON.stringify(capSchema),
       requiresLots, defaultShelfLifeDays, defaultQualityGradeId,
       userId]
    )
    await audit({
      tenantId, userId,
      action: 'tenant_product_kind.created',
      resource: 'tenant_product_kinds',
      resourceId: rows[0].id,
      payload: { code, isProduced, attrSchemaVersion: attrSchema.version, capSchemaVersion: capSchema.version },
      ipAddress, userAgent,
    })
    return rows[0]
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'tpk_code_per_tenant') {
      throw conflict(`Ya existe un product_kind con code="${code}".`)
    }
    throw err
  }
}

async function updateKind({
  tenantId, userId, id,
  name, isProduced,
  baseUnitId,
  attributeSchema, captureSchema,
  requiresLots, defaultShelfLifeDays, defaultQualityGradeId,
  isActive,
  ipAddress, userAgent,
}) {
  const current = await getKind({ tenantId, id })
  if (!current) {
    const err = new Error('Product kind no encontrado.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) {
    setters.push(`name = $${i++}`); params.push(name)
  }
  if (isProduced !== undefined) {
    if (typeof isProduced !== 'boolean') throw badReq('is_produced debe ser boolean.')
    setters.push(`is_produced = $${i++}`); params.push(isProduced)
  }
  if (baseUnitId !== undefined) {
    if (baseUnitId !== null) await assertTenantUnitExists(tenantId, baseUnitId)
    setters.push(`base_unit_id = $${i++}`); params.push(baseUnitId)
  }
  if (defaultQualityGradeId !== undefined) {
    if (defaultQualityGradeId !== null) await assertTenantQualityGradeExists(tenantId, defaultQualityGradeId)
    setters.push(`default_quality_grade_id = $${i++}`); params.push(defaultQualityGradeId)
  }
  if (requiresLots !== undefined) {
    if (requiresLots !== null && typeof requiresLots !== 'boolean') {
      throw badReq('requires_lots debe ser boolean o null.')
    }
    setters.push(`requires_lots = $${i++}`); params.push(requiresLots)
  }
  if (defaultShelfLifeDays !== undefined) {
    if (defaultShelfLifeDays !== null) {
      if (!Number.isInteger(defaultShelfLifeDays) || defaultShelfLifeDays <= 0) {
        throw badReq('default_shelf_life_days debe ser entero positivo o null.')
      }
    }
    setters.push(`default_shelf_life_days = $${i++}`); params.push(defaultShelfLifeDays)
  }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  // Schemas: si el caller mandó cualquier valor != undefined, recalculamos
  // wrapper con auto-increment. La comparación se hace contra el schema actual.
  if (attributeSchema !== undefined) {
    const incoming = normalizeSchemaInput(attributeSchema)
    validateSchema(incoming, 'attribute_schema')
    const bumped = withBumpedVersion(current.attribute_schema, incoming)
    setters.push(`attribute_schema = $${i++}::jsonb`); params.push(JSON.stringify(bumped))
  }
  if (captureSchema !== undefined) {
    const incoming = normalizeSchemaInput(captureSchema)
    validateSchema(incoming, 'capture_schema')
    const bumped = withBumpedVersion(current.capture_schema, incoming)
    setters.push(`capture_schema = $${i++}::jsonb`); params.push(JSON.stringify(bumped))
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar.')

  setters.push(`updated_by_user_id = $${i++}`); params.push(userId)
  params.push(id, tenantId)

  const { rows } = await query(
    `UPDATE tenant_product_kinds SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING *`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'tenant_product_kind.updated',
    resource: 'tenant_product_kinds',
    resourceId: id,
    payload: { changedFields: setters.length - 1 },
    ipAddress, userAgent,
  })

  return rows[0]
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function normalizeSchemaInput(input) {
  if (input === null || input === undefined) return emptySchema()
  // Si llegó como array (formato plano del design doc) → wrap.
  if (Array.isArray(input)) return { version: 1, fields: input }
  // Si llegó como objeto sin version → asignar version 1.
  if (typeof input === 'object') {
    if (input.fields && !Array.isArray(input.fields)) {
      throw badReq('schema.fields debe ser un array.')
    }
    const version = Number.isInteger(input.version) && input.version >= 1 ? input.version : 1
    const fields = Array.isArray(input.fields) ? input.fields : []
    return { version, fields }
  }
  throw badReq('schema debe ser objeto { version, fields } o array de fields.')
}

async function assertTenantUnitExists(tenantId, unitId) {
  const { rows } = await query(
    `SELECT 1 FROM tenant_units WHERE id = $1 AND tenant_id = $2`,
    [unitId, tenantId]
  )
  if (rows.length === 0) throw badReq('base_unit_id no existe en este tenant.')
}

async function assertTenantQualityGradeExists(tenantId, gradeId) {
  const { rows } = await query(
    `SELECT 1 FROM tenant_quality_grades WHERE id = $1 AND tenant_id = $2`,
    [gradeId, tenantId]
  )
  if (rows.length === 0) throw badReq('default_quality_grade_id no existe en este tenant.')
}

function badReq(msg)   { const e = new Error(msg); e.status = 400; return e }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e }

module.exports = {
  listKinds, getKind, createKind, updateKind,
}
