'use strict'

const { query, withTransaction } = require('../../db')

/**
 * Nomenclatura de códigos por catálogo.
 *
 * Tabla `tenant_code_formats`: 1 row por (tenant, entity_type). Sin row →
 * modo manual implícito (el form deja capturar libre sin pista).
 *
 * Entities soportadas: 'product', 'raw_material', 'packaging', 'additive',
 * 'customer', 'supplier'.
 * - 'customer' y 'supplier' mapean al mismo catálogo (business_partners)
 *   pero pueden tener nomenclaturas distintas — el caller decide qué
 *   entity_type pasa según `business_partners.type`.
 * - 'raw_material', 'packaging', 'additive' mapean al mismo catálogo
 *   (raw_materials) discriminado por `item_kind` — el form decide qué
 *   entity_type usar según la selección del capturista.
 *
 * Patrón: string con `{seq}` como placeholder de número secuencial. El
 * parser actual solo conoce {seq} — si en el futuro agregamos `{año}`,
 * `{mes}`, `{cat}`, solo se extiende `resolvePattern()` sin migración.
 *
 * Modos:
 *   - 'manual'    → no actúa. Equivalente a no tener row.
 *   - 'suggested' → form muestra placeholder + botón "siguiente". El
 *                    usuario puede aceptar o escribir su propio código.
 *   - 'auto'      → el sistema genera el código al guardar; el campo
 *                    queda readonly. Garantiza unicidad por construcción.
 */

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const VALID_ENTITIES = ['product', 'raw_material', 'packaging', 'additive', 'customer', 'supplier']
const VALID_MODES    = ['manual', 'suggested', 'auto']

/**
 * Resuelve un patrón con el siguiente seq aplicando padding.
 * Hoy solo entiende {seq}. Futuras variables: {año}, {mes}, {cat}.
 */
function resolvePattern({ pattern, seq, padding }) {
  if (!pattern || !pattern.includes('{seq}')) {
    throw createError(400, 'El patrón debe contener {seq} como placeholder.')
  }
  const padded = String(seq).padStart(padding, '0')
  return pattern.replace(/\{seq\}/g, padded)
}

function validateInput({ entityType, pattern, padding, nextSeq, mode }) {
  if (entityType != null && !VALID_ENTITIES.includes(entityType)) {
    throw createError(400, `Catálogo inválido: ${entityType}. Válidos: ${VALID_ENTITIES.join(', ')}.`)
  }
  if (pattern != null) {
    const p = String(pattern).trim()
    if (!p) throw createError(400, 'El patrón es requerido.')
    if (!p.includes('{seq}')) throw createError(400, 'El patrón debe contener {seq}.')
    if (p.length > 100) throw createError(400, 'El patrón no debe exceder 100 caracteres.')
    // Solo permitimos las variables que hoy entiende el parser. Variables
    // futuras (año, mes, cat) se agregan a esta lista junto con el resolver.
    const allowedVars = ['seq']
    const found = p.match(/\{([^}]+)\}/g) || []
    for (const v of found) {
      const name = v.slice(1, -1)
      if (!allowedVars.includes(name)) {
        throw createError(400, `Variable no soportada: ${v}. Hoy solo se permite {seq}.`)
      }
    }
  }
  if (padding != null) {
    const n = parseInt(padding, 10)
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      throw createError(400, 'El padding debe ser un número entre 1 y 10.')
    }
  }
  if (nextSeq != null) {
    const n = parseInt(nextSeq, 10)
    if (!Number.isFinite(n) || n < 1) {
      throw createError(400, 'El siguiente número debe ser un entero mayor o igual a 1.')
    }
  }
  if (mode != null && !VALID_MODES.includes(mode)) {
    throw createError(400, `Modo inválido: ${mode}. Válidos: ${VALID_MODES.join(', ')}.`)
  }
}

async function listFormats({ tenantId }) {
  const { rows } = await query(
    `SELECT id, entity_type, pattern, padding, next_seq, mode, is_active,
            notes, created_at, updated_at
       FROM tenant_code_formats
      WHERE tenant_id = $1
      ORDER BY entity_type`,
    [tenantId]
  )
  return rows
}

async function getFormatByEntity({ tenantId, entityType }) {
  if (!VALID_ENTITIES.includes(entityType)) return null
  const { rows } = await query(
    `SELECT * FROM tenant_code_formats
      WHERE tenant_id = $1 AND entity_type = $2`,
    [tenantId, entityType]
  )
  return rows[0] || null
}

async function upsertFormat({ tenantId, entityType, pattern, padding = 4, nextSeq = 1, mode = 'suggested', notes = null, isActive = true, userId = null }) {
  validateInput({ entityType, pattern, padding, nextSeq, mode })

  const { rows } = await query(
    `INSERT INTO tenant_code_formats
       (tenant_id, entity_type, pattern, padding, next_seq, mode, is_active, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE
       SET pattern    = EXCLUDED.pattern,
           padding    = EXCLUDED.padding,
           next_seq   = EXCLUDED.next_seq,
           mode       = EXCLUDED.mode,
           is_active  = EXCLUDED.is_active,
           notes      = EXCLUDED.notes
     RETURNING *`,
    [tenantId, entityType, pattern.trim(), parseInt(padding, 10), parseInt(nextSeq, 10), mode, isActive, notes, userId]
  )
  return rows[0]
}

async function updateFormat({ tenantId, formatId, pattern, padding, nextSeq, mode, isActive, notes }) {
  validateInput({ pattern, padding, nextSeq, mode })

  const updates = []
  const params = []
  if (pattern   !== undefined) { params.push(pattern.trim());            updates.push(`pattern   = $${params.length}`) }
  if (padding   !== undefined) { params.push(parseInt(padding, 10));     updates.push(`padding   = $${params.length}`) }
  if (nextSeq   !== undefined) { params.push(parseInt(nextSeq, 10));     updates.push(`next_seq  = $${params.length}`) }
  if (mode      !== undefined) { params.push(mode);                      updates.push(`mode      = $${params.length}`) }
  if (isActive  !== undefined) { params.push(!!isActive);                updates.push(`is_active = $${params.length}`) }
  if (notes     !== undefined) { params.push(notes);                     updates.push(`notes     = $${params.length}`) }

  if (!updates.length) {
    const { rows } = await query(
      `SELECT * FROM tenant_code_formats WHERE id = $1 AND tenant_id = $2`,
      [formatId, tenantId]
    )
    return rows[0] || null
  }

  params.push(formatId, tenantId)
  const { rows } = await query(
    `UPDATE tenant_code_formats SET ${updates.join(', ')}
      WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
      RETURNING *`,
    params
  )
  return rows[0] || null
}

async function deleteFormat({ tenantId, formatId }) {
  const { rowCount } = await query(
    `DELETE FROM tenant_code_formats WHERE id = $1 AND tenant_id = $2`,
    [formatId, tenantId]
  )
  return rowCount > 0
}

/**
 * Devuelve el siguiente código que se generaría SIN consumir el seq.
 * Usado por el form para pre-llenar el campo cuando el capturista pulsa "Sugerir".
 */
async function previewNext({ tenantId, entityType }) {
  const fmt = await getFormatByEntity({ tenantId, entityType })
  if (!fmt || fmt.mode === 'manual' || !fmt.is_active) {
    return { code: null, mode: fmt?.mode || 'manual', active: !!fmt?.is_active }
  }
  return {
    code: resolvePattern({ pattern: fmt.pattern, seq: fmt.next_seq, padding: fmt.padding }),
    mode: fmt.mode,
    pattern: fmt.pattern,
    nextSeq: fmt.next_seq,
    padding: fmt.padding,
    active: true,
  }
}

/**
 * Consume el siguiente código ATÓMICAMENTE (incrementa next_seq con
 * UPDATE...RETURNING). Lo llaman los services de productos / raw materials /
 * partners cuando el modo es 'auto', o cuando 'suggested' y el usuario aceptó
 * la sugerencia (no escribió su propio código).
 *
 * Si no hay formato activo o el modo es 'manual', devuelve null y el caller
 * usa el código capturado a mano.
 */
async function consumeNext({ client, tenantId, entityType }) {
  const useClient = client || query
  const isExternalClient = !!client
  const runner = isExternalClient
    ? (sql, params) => client.query(sql, params)
    : (sql, params) => query(sql, params)

  const { rows } = await runner(
    `UPDATE tenant_code_formats
        SET next_seq = next_seq + 1
      WHERE tenant_id = $1 AND entity_type = $2
        AND is_active = TRUE AND mode <> 'manual'
      RETURNING pattern, padding, next_seq - 1 AS used_seq, mode`,
    [tenantId, entityType]
  )
  if (!rows.length) return null
  const { pattern, padding, used_seq: usedSeq, mode } = rows[0]
  return {
    code: resolvePattern({ pattern, seq: usedSeq, padding }),
    seq:  usedSeq,
    mode,
  }
}

/**
 * Resuelve el código que debe quedar guardado para un catálogo según el modo
 * configurado. Lo llaman los services de create (products, business-partners,
 * raw-materials). Reglas:
 *
 *   - manual / sin formato / inactivo → devuelve providedCode sin tocar nada.
 *   - auto                            → consume seq y sobrescribe providedCode.
 *   - suggested + code === preview    → consume seq (el user aceptó la sugerencia).
 *   - suggested + code custom o vacío → devuelve providedCode sin consumir.
 *
 * Debe correr DENTRO de la misma transacción que el INSERT del catálogo: si
 * el INSERT falla, el seq no debe quedar incrementado. Por eso recibe el
 * client de la transacción (opcional — si no se pasa, usa query global).
 */
async function applyCodeFormat({ client, tenantId, entityType, providedCode }) {
  if (!entityType || !VALID_ENTITIES.includes(entityType)) {
    return providedCode
  }

  const fmt = await getFormatByEntity({ tenantId, entityType })
  if (!fmt || !fmt.is_active || fmt.mode === 'manual') {
    return providedCode
  }

  if (fmt.mode === 'auto') {
    const consumed = await consumeNext({ client, tenantId, entityType })
    return consumed?.code || providedCode
  }

  if (fmt.mode === 'suggested' && providedCode) {
    const preview = resolvePattern({
      pattern: fmt.pattern,
      seq: fmt.next_seq,
      padding: fmt.padding,
    })
    if (String(providedCode).trim() === preview) {
      const consumed = await consumeNext({ client, tenantId, entityType })
      return consumed?.code || providedCode
    }
  }

  return providedCode
}

module.exports = {
  listFormats,
  getFormatByEntity,
  upsertFormat,
  updateFormat,
  deleteFormat,
  previewNext,
  consumeNext,
  applyCodeFormat,
  resolvePattern,
  VALID_ENTITIES,
  VALID_MODES,
}
