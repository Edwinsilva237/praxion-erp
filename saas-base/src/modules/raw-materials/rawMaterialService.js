'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const codeFormatService = require('../code-formats/codeFormatService')

async function listRawMaterials({ tenantId, resinType, materialType, itemKind, isActive, search, withStock = false, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (resinType)    { params.push(resinType);    filters.push(`r.resin_type = $${params.length}`) }
  if (materialType) { params.push(materialType); filters.push(`r.material_type = $${params.length}`) }
  if (itemKind)     { params.push(itemKind);     filters.push(`r.item_kind = $${params.length}`) }
  if (isActive !== undefined) { params.push(isActive); filters.push(`r.is_active = $${params.length}`) }
  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    filters.push(`LOWER(r.name) LIKE $${params.length}`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  // Si withStock=true, agregamos el saldo disponible en almacén MP por LEFT JOIN agregado.
  const stockSelect = withStock
    ? `, COALESCE((
         SELECT SUM(s.quantity)
         FROM inventory_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
         WHERE s.tenant_id = $1
           AND s.item_type = 'raw_material'
           AND s.item_id   = r.id
           AND s.status    = 'available'
           AND w.type = 'raw_material'
           AND w.is_active = true
       ), 0) AS mp_stock_available_kg`
    : ''

  const { rows } = await query(
    `SELECT r.id, r.name, r.resin_type, r.material_type, r.item_kind, r.unit,
            r.max_regrind_pct, r.cost_per_kg, r.description,
            r.lead_time_days, r.is_active, r.created_at${stockSelect}
     FROM raw_materials r
     WHERE r.tenant_id = $1 ${where}
     ORDER BY r.item_kind, r.resin_type NULLS LAST, r.material_type, r.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM raw_materials r WHERE r.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getRawMaterial({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

async function createRawMaterial({
  tenantId, name, code, resinType, materialType, itemKind, unit,
  maxRegrindPct, costPerKg, description, leadTimeDays,
  userId, ipAddress, userAgent,
}) {
  // item_kind por defecto 'raw_material' (compat con clientes legacy).
  // Para packaging/additive, resinType/materialType pueden venir NULL.
  const kind = itemKind || 'raw_material'

  // Envolvemos en transacción para que la resolución del código (que puede
  // incrementar next_seq en tenant_code_formats) y el INSERT sean atómicos:
  // si el INSERT falla por UNIQUE u otra restricción, el seq no avanza.
  return withTransaction(async (client) => {
    const resolvedCode = await codeFormatService.applyCodeFormat({
      client, tenantId, entityType: kind, providedCode: code,
    })

    const { rows } = await client.query(
      `INSERT INTO raw_materials
         (tenant_id, name, code, item_kind, resin_type, material_type, unit, max_regrind_pct,
          cost_per_kg, description, lead_time_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        tenantId,
        name.trim(),
        resolvedCode ? resolvedCode.trim() : null,
        kind,
        resinType || null,
        kind === 'raw_material' ? (materialType || 'virgin') : (materialType || null),
        unit || 'kg',
        maxRegrindPct ?? 30,
        costPerKg ?? 0,
        description || null,
        leadTimeDays != null ? parseInt(leadTimeDays) : 7,
      ]
    )

    await audit({
      tenantId, userId, action: 'raw_material.created', resource: 'raw_materials',
      resourceId: rows[0].id, payload: { name, resinType, materialType },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function updateRawMaterial({
  tenantId, id, name, code, materialType, unit,
  maxRegrindPct, costPerKg, description, isActive, leadTimeDays,
  userId, ipAddress, userAgent,
}) {
  const { rows } = await query(
    `UPDATE raw_materials SET
       name            = COALESCE($1, name),
       code            = COALESCE($2, code),
       material_type   = COALESCE($3, material_type),
       unit            = COALESCE($4, unit),
       max_regrind_pct = COALESCE($5, max_regrind_pct),
       cost_per_kg     = COALESCE($6, cost_per_kg),
       description     = COALESCE($7, description),
       is_active       = COALESCE($8, is_active),
       lead_time_days  = COALESCE($9, lead_time_days)
     WHERE id = $10 AND tenant_id = $11
     RETURNING *`,
    [
      name        || null,
      code !== undefined ? (code || null) : null,
      materialType || null,
      unit        || null,
      maxRegrindPct !== undefined ? maxRegrindPct : null,
      costPerKg   !== undefined   ? costPerKg     : null,
      description !== undefined   ? description   : null,
      isActive    !== undefined   ? isActive       : null,
      leadTimeDays !== undefined && leadTimeDays !== null ? parseInt(leadTimeDays) : null,
      id, tenantId,
    ]
  )
  if (!rows[0]) return null

  await audit({
    tenantId, userId, action: 'raw_material.updated', resource: 'raw_materials',
    resourceId: id, payload: { name, isActive, costPerKg, leadTimeDays },
    ipAddress, userAgent,
  })

  return rows[0]
}

module.exports = { listRawMaterials, getRawMaterial, createRawMaterial, updateRawMaterial }
