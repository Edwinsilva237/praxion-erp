'use strict'

const { query, withTransaction } = require('../../db')
const createError = require('http-errors')

const VALID_TYPES = ['raw_material', 'wip', 'finished_product', 'regrind', 'resale']
const RESIN_REQUIRED_TYPES = ['raw_material', 'regrind']

/**
 * Lista todos los almacenes con conteo de stock y movimientos.
 */
async function list({ tenantId, type, includeInactive = false }) {
  const conds  = ['w.tenant_id = $1']
  const params = [tenantId]
  let i = 2

  if (type)              { conds.push(`w.type = $${i++}`); params.push(type) }
  if (!includeInactive)  { conds.push(`w.is_active = true`) }

  const sql = `
    SELECT
      w.id, w.name, w.type, w.resin_type, w.description,
      w.is_active, w.is_default,
      w.created_at, w.updated_at,
      COALESCE(stock_count.cnt, 0) AS stock_items_count,
      COALESCE(stock_count.qty, 0) AS stock_total_qty,
      COALESCE(mov_count.cnt, 0)   AS movements_count
    FROM warehouses w
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt, COALESCE(SUM(quantity), 0) AS qty
      FROM inventory_stock
      WHERE warehouse_id = w.id AND quantity > 0
    ) stock_count ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt
      FROM inventory_movements
      WHERE warehouse_id = w.id
    ) mov_count ON true
    WHERE ${conds.join(' AND ')}
    ORDER BY
      CASE w.type
        WHEN 'raw_material'     THEN 1
        WHEN 'wip'              THEN 2
        WHEN 'finished_product' THEN 3
        WHEN 'regrind'          THEN 4
        WHEN 'resale'           THEN 5
        ELSE 6
      END,
      w.is_default DESC,
      w.name ASC
  `
  const { rows } = await query(sql, params)
  return rows
}

async function getById({ tenantId, id }) {
  const { rows } = await query(
    `SELECT * FROM warehouses WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  return rows[0] || null
}

/**
 * Crea un almacén.
 *
 * Reglas:
 *   - Tipo debe ser uno de los 5 del sistema.
 *   - Tipos raw_material y regrind requieren resin_type.
 *   - Si makeDefault=true, desmarca el default existente del mismo tipo.
 *   - Si NO existe ningún default activo del tipo, este se marca default
 *     automáticamente (para evitar que un tipo se quede sin default).
 */
async function create({ tenantId, name, type, resinType, description, isActive = true, makeDefault = false }) {
  if (!name || !name.trim()) throw createError(400, 'El nombre es obligatorio.')
  if (!VALID_TYPES.includes(type)) {
    throw createError(400, `type inválido. Valores permitidos: ${VALID_TYPES.join(', ')}.`)
  }
  if (RESIN_REQUIRED_TYPES.includes(type) && !resinType) {
    throw createError(400, `Los almacenes tipo ${type} requieren resin_type (PP o PE).`)
  }
  if (resinType && !['PP', 'PE'].includes(resinType)) {
    throw createError(400, 'resin_type debe ser PP o PE.')
  }

  // Mapa enum legacy → code en tenant_warehouse_types (migration 121)
  const TYPE_TO_CATALOG_CODE = {
    raw_material:     'materia_prima',
    regrind:          'merma',
    wip:              'wip',
    finished_product: 'producto_terminado',
  }

  return withTransaction(async (client) => {
    // ¿Existe ya un default activo de este tipo?
    const { rows: defaults } = await client.query(
      `SELECT id FROM warehouses
       WHERE tenant_id = $1 AND type = $2 AND is_default = true AND is_active = true`,
      [tenantId, type]
    )
    const existsDefault = defaults.length > 0

    // Auto-default si es el primer activo del tipo
    let willBeDefault = makeDefault
    if (!existsDefault && isActive) willBeDefault = true

    // Si va a ser default, desmarcar el actual
    if (willBeDefault && existsDefault) {
      await client.query(
        `UPDATE warehouses SET is_default = false
         WHERE tenant_id = $1 AND type = $2 AND is_default = true`,
        [tenantId, type]
      )
    }

    // Resolver warehouse_type_id desde catálogo SaaS v2 (migration 121)
    let warehouseTypeId = null
    const catalogCode = TYPE_TO_CATALOG_CODE[type]
    if (catalogCode) {
      const { rows: twt } = await client.query(
        `SELECT id FROM tenant_warehouse_types WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
        [tenantId, catalogCode]
      )
      warehouseTypeId = twt[0]?.id || null
    }

    const { rows } = await client.query(
      `INSERT INTO warehouses (tenant_id, name, type, resin_type, description, is_active, is_default, warehouse_type_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, name.trim(), type, resinType || null, description || null, isActive, willBeDefault, warehouseTypeId]
    )
    return rows[0]
  })
}

/**
 * Actualiza un almacén. NO permite cambiar el tipo (rompe historial).
 *
 * Reglas:
 *   - Para activar un almacén default que estaba desactivado, debe haber
 *     coordinación con el default actual.
 *   - Para desactivar el default activo, primero debe haber otro default
 *     o se debe transferir el default a otro almacén.
 */
async function update({ tenantId, id, patch }) {
  const allowed = ['name', 'resin_type', 'description', 'is_active']
  const fields  = []
  const params  = []
  let i = 1

  return withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT * FROM warehouses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    )
    if (!cur[0]) throw createError(404, 'Almacén no encontrado.')
    const wh = cur[0]

    // Validación de tipo (no se puede cambiar)
    if ('type' in patch && patch.type !== wh.type) {
      throw createError(400, 'No se puede cambiar el tipo de un almacén existente. Desactívalo y crea uno nuevo.')
    }

    // Validación de resin_type
    if ('resin_type' in patch) {
      if (RESIN_REQUIRED_TYPES.includes(wh.type) && !patch.resin_type) {
        throw createError(400, `Los almacenes tipo ${wh.type} requieren resin_type.`)
      }
      if (patch.resin_type && !['PP', 'PE'].includes(patch.resin_type)) {
        throw createError(400, 'resin_type debe ser PP o PE.')
      }
    }

    // Validación de desactivación del default
    if ('is_active' in patch && patch.is_active === false && wh.is_default && wh.is_active) {
      // ¿Hay otro almacén activo del mismo tipo que pueda tomar el default?
      const { rows: others } = await client.query(
        `SELECT id FROM warehouses
         WHERE tenant_id = $1 AND type = $2 AND is_active = true AND id <> $3`,
        [tenantId, wh.type, id]
      )
      if (others.length === 0) {
        throw createError(409,
          `No se puede desactivar este almacén: es el único almacén activo de tipo ${wh.type}. ` +
          `Crea otro o ya no podrás operar este tipo.`)
      }
      // Auto-transferir el default al primero disponible
      await client.query(
        `UPDATE warehouses SET is_default = true WHERE id = $1`,
        [others[0].id]
      )
      // Quitar el default del actual
      patch.is_default = false  // se aplica abajo
      fields.push(`is_default = false`)
    }

    // Construir UPDATE
    for (const key of allowed) {
      if (key in patch) {
        fields.push(`${key} = $${i++}`)
        params.push(patch[key])
      }
    }

    if (fields.length === 0) {
      return wh
    }

    fields.push('updated_at = NOW()')
    params.push(id, tenantId)

    const { rows } = await client.query(
      `UPDATE warehouses SET ${fields.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING *`,
      params
    )
    return rows[0]
  })
}

/**
 * Marca un almacén como default de su tipo.
 *
 * Desmarca al default actual (si existe) y marca a este.
 * Solo puede marcarse default si está activo.
 */
async function setDefault({ tenantId, id }) {
  return withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT * FROM warehouses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    )
    if (!cur[0]) throw createError(404, 'Almacén no encontrado.')
    const wh = cur[0]

    if (!wh.is_active) {
      throw createError(409, 'No se puede marcar como default un almacén inactivo. Actívalo primero.')
    }
    if (wh.is_default) {
      return wh  // ya es default
    }

    // Desmarcar el actual default del tipo
    await client.query(
      `UPDATE warehouses SET is_default = false
       WHERE tenant_id = $1 AND type = $2 AND is_default = true`,
      [tenantId, wh.type]
    )
    // Marcar este como default
    const { rows } = await client.query(
      `UPDATE warehouses SET is_default = true, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    )
    return rows[0]
  })
}

/**
 * Elimina un almacén SOLO si:
 *   - No tiene stock (cualquier saldo)
 *   - No tiene movimientos históricos
 *   - No es el último activo de su tipo
 *
 * En la mayoría de los casos, lo correcto es desactivar, no eliminar.
 */
async function remove({ tenantId, id }) {
  return withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `SELECT * FROM warehouses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, tenantId]
    )
    if (!cur[0]) throw createError(404, 'Almacén no encontrado.')
    const wh = cur[0]

    // ¿Tiene stock?
    const { rows: stock } = await client.query(
      `SELECT COUNT(*) AS cnt FROM inventory_stock WHERE warehouse_id = $1 AND quantity > 0`,
      [id]
    )
    if (parseInt(stock[0].cnt) > 0) {
      throw createError(409,
        'No se puede eliminar: el almacén tiene stock. Vacíalo primero o desactívalo en lugar de eliminar.')
    }

    // ¿Tiene movimientos?
    const { rows: movs } = await client.query(
      `SELECT COUNT(*) AS cnt FROM inventory_movements WHERE warehouse_id = $1`,
      [id]
    )
    if (parseInt(movs[0].cnt) > 0) {
      throw createError(409,
        'No se puede eliminar: el almacén tiene movimientos en kardex. Desactívalo en lugar de eliminar.')
    }

    // ¿Es el último de su tipo?
    const { rows: others } = await client.query(
      `SELECT COUNT(*) AS cnt FROM warehouses
       WHERE tenant_id = $1 AND type = $2 AND id <> $3`,
      [tenantId, wh.type, id]
    )
    if (parseInt(others[0].cnt) === 0) {
      throw createError(409,
        `No se puede eliminar: es el único almacén tipo ${wh.type} del tenant.`)
    }

    await client.query(`DELETE FROM warehouses WHERE id = $1`, [id])
    return { id, deleted: true }
  })
}

module.exports = {
  list,
  getById,
  create,
  update,
  setDefault,
  remove,
  VALID_TYPES,
}
