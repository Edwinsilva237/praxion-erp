'use strict'

const { query, withTransaction } = require('../../db')

/**
 * Series y folios para TODOS los documentos numerados del ERP.
 *
 * Entity types soportados:
 *   - invoice              (CFDI; requiere fiscal_profile_id)
 *   - sales_order          (PV)
 *   - delivery_note        (REM)
 *   - sales_return         (REC venta)
 *   - quotation            (COT)
 *   - purchase_order       (OC)
 *   - supplier_receipt     (REC compra)
 *   - inventory_adjustment (AJ)
 *
 * Para `invoice`: 1 perfil fiscal → N series. La default puede ser por
 * cfdi_type ('I','E','P','N','T') o genérica.
 * Para los demás: 1 (tenant, entity_type) → N series. La default es una sola.
 *
 * `consumeNextFolio` es atómico (UPDATE...RETURNING) — seguro bajo concurrencia.
 * Sin esto, dos emisiones simultáneas tomarían el mismo folio.
 */

function createError(status, message) {
  const err = new Error(message); err.status = status; return err
}

const ENTITY_TYPES = [
  'invoice', 'sales_order', 'delivery_note', 'sales_return',
  'quotation', 'purchase_order', 'supplier_receipt', 'inventory_adjustment',
]

const ENTITY_LABELS = {
  invoice:              'Facturas (CFDI)',
  sales_order:          'Pedidos de venta',
  delivery_note:        'Remisiones',
  sales_return:         'Devoluciones de venta',
  quotation:            'Cotizaciones',
  purchase_order:       'Órdenes de compra',
  supplier_receipt:     'Recepciones de proveedor',
  inventory_adjustment: 'Ajustes de inventario',
}

const ENTITY_GROUPS = {
  ventas:     ['invoice', 'sales_order', 'delivery_note', 'sales_return', 'quotation'],
  compras:    ['purchase_order', 'supplier_receipt'],
  inventario: ['inventory_adjustment'],
}

const VALID_CFDI_TYPES = ['I', 'E', 'P', 'N', 'T']
const SERIE_REGEX = /^[A-Za-z0-9_-]{1,10}$/

function validateInput({ entityType, serie, folioNext, cfdiType, fiscalProfileId }) {
  if (entityType != null && !ENTITY_TYPES.includes(entityType)) {
    throw createError(400, `Tipo de documento inválido: ${entityType}.`)
  }
  if (serie != null && !SERIE_REGEX.test(String(serie).trim())) {
    throw createError(400, 'La serie debe tener 1-10 caracteres (letras, números, guion o guion bajo).')
  }
  if (folioNext != null) {
    const n = parseInt(folioNext, 10)
    if (!Number.isFinite(n) || n < 1) {
      throw createError(400, 'El folio inicial debe ser un entero mayor o igual a 1.')
    }
  }
  if (entityType === 'invoice') {
    if (!fiscalProfileId) {
      throw createError(400, 'Las series de facturas requieren un perfil fiscal.')
    }
    if (cfdiType != null && cfdiType !== '' && !VALID_CFDI_TYPES.includes(cfdiType)) {
      throw createError(400, `Tipo de CFDI inválido: ${cfdiType}.`)
    }
  } else {
    if (fiscalProfileId) {
      throw createError(400, `El tipo "${entityType}" no usa perfil fiscal.`)
    }
    if (cfdiType) {
      throw createError(400, `El tipo "${entityType}" no usa cfdi_type.`)
    }
  }
}

/**
 * Lista las series con metadata del último folio usado en el documento real.
 * Para facturas, busca en `invoices` filtrando por fiscal_profile_id+serie.
 * Para los demás, busca en su tabla respectiva (document_number column).
 *
 * El "last_used_folio" se calcula con un OUTER LATERAL para no requerir N+1.
 */
async function listSeries({ tenantId, entityType = null, includeInactive = false }) {
  const params = [tenantId]
  const filters = ['s.tenant_id = $1']
  if (entityType) {
    params.push(entityType)
    filters.push(`s.entity_type = $${params.length}`)
  }
  if (!includeInactive) filters.push(`s.is_active = TRUE`)

  const { rows } = await query(
    `SELECT s.id, s.entity_type, s.fiscal_profile_id, s.serie, s.folio_next,
            s.cfdi_type, s.is_default, s.is_active, s.notes,
            s.created_at, s.updated_at,
            fp.rfc      AS profile_rfc,
            fp.tax_name AS profile_tax_name,
            lastUsed.last_folio AS last_used_folio
       FROM tenant_document_series s
       LEFT JOIN tenant_fiscal_profiles fp ON fp.id = s.fiscal_profile_id
       LEFT JOIN LATERAL (
         SELECT MAX(folio_int) AS last_folio FROM (
           SELECT NULLIF(regexp_replace(folio, '[^0-9]', '', 'g'), '')::INT AS folio_int
             FROM invoices
            WHERE tenant_id = s.tenant_id
              AND series = s.serie
              AND (s.fiscal_profile_id IS NULL OR fiscal_profile_id = s.fiscal_profile_id)
              AND s.entity_type = 'invoice'
         ) x
       ) lastUsed ON s.entity_type = 'invoice'
      WHERE ${filters.join(' AND ')}
      ORDER BY s.entity_type, fp.tax_name NULLS FIRST, s.serie`,
    params
  )
  return rows
}

async function getSeries({ tenantId, seriesId }) {
  const { rows } = await query(
    `SELECT s.*, fp.rfc AS profile_rfc, fp.tax_name AS profile_tax_name
       FROM tenant_document_series s
       LEFT JOIN tenant_fiscal_profiles fp ON fp.id = s.fiscal_profile_id
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [seriesId, tenantId]
  )
  return rows[0] || null
}

async function createSeries({
  tenantId, entityType, fiscalProfileId = null, serie, folioNext = 1,
  cfdiType = null, isDefault = false, notes = null, userId = null,
}) {
  validateInput({ entityType, serie, folioNext, cfdiType, fiscalProfileId })

  return withTransaction(async (client) => {
    if (entityType === 'invoice') {
      const { rows: pr } = await client.query(
        `SELECT id FROM tenant_fiscal_profiles WHERE id = $1 AND tenant_id = $2`,
        [fiscalProfileId, tenantId]
      )
      if (!pr.length) throw createError(404, 'Perfil fiscal no encontrado.')
    }

    if (isDefault) {
      if (entityType === 'invoice') {
        await client.query(
          `UPDATE tenant_document_series SET is_default = FALSE
            WHERE entity_type = 'invoice'
              AND fiscal_profile_id = $1
              AND COALESCE(cfdi_type, '') = COALESCE($2::VARCHAR, '')`,
          [fiscalProfileId, cfdiType]
        )
      } else {
        await client.query(
          `UPDATE tenant_document_series SET is_default = FALSE
            WHERE tenant_id = $1 AND entity_type = $2`,
          [tenantId, entityType]
        )
      }
    }

    try {
      const { rows } = await client.query(
        `INSERT INTO tenant_document_series
           (tenant_id, entity_type, fiscal_profile_id, serie, folio_next,
            cfdi_type, is_default, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [tenantId, entityType, fiscalProfileId, serie.trim(), parseInt(folioNext, 10),
         cfdiType || null, !!isDefault, notes, userId]
      )
      return rows[0]
    } catch (err) {
      if (err.code === '23505') {
        throw createError(409, `La serie "${serie}" ya existe para este documento.`)
      }
      throw err
    }
  })
}

async function updateSeries({ tenantId, seriesId, serie, folioNext, cfdiType, isDefault, isActive, notes }) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT * FROM tenant_document_series WHERE id = $1 AND tenant_id = $2`,
      [seriesId, tenantId]
    )
    if (!existing.length) throw createError(404, 'Serie no encontrada.')
    const current = existing[0]

    if (serie != null || folioNext != null || cfdiType !== undefined) {
      validateInput({
        entityType: current.entity_type,
        serie, folioNext,
        cfdiType: cfdiType !== undefined ? cfdiType : current.cfdi_type,
        fiscalProfileId: current.fiscal_profile_id,
      })
    }

    const updates = []
    const params = []
    if (serie       !== undefined) { params.push(serie.trim());                updates.push(`serie       = $${params.length}`) }
    if (folioNext   !== undefined) { params.push(parseInt(folioNext, 10));     updates.push(`folio_next  = $${params.length}`) }
    if (cfdiType    !== undefined && current.entity_type === 'invoice') {
      params.push(cfdiType || null);
      updates.push(`cfdi_type   = $${params.length}`)
    }
    if (isActive    !== undefined) { params.push(!!isActive);                  updates.push(`is_active   = $${params.length}`) }
    if (notes       !== undefined) { params.push(notes);                       updates.push(`notes       = $${params.length}`) }

    let willBeDefault = current.is_default
    if (isDefault !== undefined) {
      willBeDefault = !!isDefault
      params.push(willBeDefault)
      updates.push(`is_default  = $${params.length}`)
    }

    if (willBeDefault && (isDefault === true || !current.is_default)) {
      if (current.entity_type === 'invoice') {
        const newCfdiType = cfdiType !== undefined ? (cfdiType || null) : current.cfdi_type
        await client.query(
          `UPDATE tenant_document_series SET is_default = FALSE
            WHERE entity_type = 'invoice'
              AND fiscal_profile_id = $1
              AND id <> $2
              AND COALESCE(cfdi_type, '') = COALESCE($3::VARCHAR, '')`,
          [current.fiscal_profile_id, seriesId, newCfdiType]
        )
      } else {
        await client.query(
          `UPDATE tenant_document_series SET is_default = FALSE
            WHERE tenant_id = $1 AND entity_type = $2 AND id <> $3`,
          [tenantId, current.entity_type, seriesId]
        )
      }
    }

    if (!updates.length) return current

    params.push(seriesId, tenantId)
    try {
      const { rows } = await client.query(
        `UPDATE tenant_document_series SET ${updates.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
          RETURNING *`,
        params
      )
      return rows[0]
    } catch (err) {
      if (err.code === '23505') {
        throw createError(409, 'La serie ya existe para este documento.')
      }
      throw err
    }
  })
}

async function deleteSeries({ tenantId, seriesId }) {
  // Para facturas validamos contra invoices.series + fiscal_profile_id.
  // Para otros documentos no podemos validar tan barato (cada uno en su tabla);
  // por ahora dejamos borrar si no es invoice — si rompe FK, Postgres avisa.
  const { rows } = await query(
    `SELECT entity_type, serie, fiscal_profile_id FROM tenant_document_series
      WHERE id = $1 AND tenant_id = $2`,
    [seriesId, tenantId]
  )
  if (!rows.length) return false
  const row = rows[0]

  if (row.entity_type === 'invoice') {
    const { rows: usage } = await query(
      `SELECT COUNT(*)::INT AS n FROM invoices
        WHERE tenant_id = $1 AND series = $2 AND fiscal_profile_id = $3`,
      [tenantId, row.serie, row.fiscal_profile_id]
    )
    if (usage[0].n > 0) {
      throw createError(409, 'No se puede eliminar: ya hay facturas emitidas con esta serie. Desactívala en lugar de borrarla.')
    }
  }

  const { rowCount } = await query(
    `DELETE FROM tenant_document_series WHERE id = $1 AND tenant_id = $2`,
    [seriesId, tenantId]
  )
  return rowCount > 0
}

/**
 * Consume el siguiente folio ATÓMICAMENTE.
 */
async function consumeNextFolio({ client, seriesId }) {
  const { rows } = await client.query(
    `UPDATE tenant_document_series
        SET folio_next = folio_next + 1
      WHERE id = $1 AND is_active = TRUE
      RETURNING serie, folio_next - 1 AS folio, entity_type, fiscal_profile_id, tenant_id`,
    [seriesId]
  )
  if (!rows.length) throw createError(404, 'Serie no encontrada o inactiva.')
  return {
    folio:            rows[0].folio,
    serie:            rows[0].serie,
    entityType:       rows[0].entity_type,
    fiscalProfileId:  rows[0].fiscal_profile_id,
    tenantId:         rows[0].tenant_id,
  }
}

/**
 * Resuelve qué serie usar al emitir un documento.
 *
 * Para invoice: usa fiscalProfileId obligatorio. Prioridad:
 *   seriesId > seriesCode + profile > default por (profile, cfdiType) > default profile > primera activa
 *
 * Para no-invoice: ignora fiscalProfileId. Prioridad:
 *   seriesId > seriesCode + tenant + entity > default por (tenant, entity) > primera activa
 *
 * Si no encuentra ninguna serie configurada, devuelve null — el caller debe
 * caer al patrón legacy hardcoded.
 */
async function resolveSeriesForEmission({ client, tenantId, entityType, fiscalProfileId = null, seriesId = null, seriesCode = null, cfdiType = null }) {
  if (seriesId) {
    const { rows } = await client.query(
      `SELECT * FROM tenant_document_series
        WHERE id = $1 AND tenant_id = $2 AND entity_type = $3 AND is_active = TRUE`,
      [seriesId, tenantId, entityType]
    )
    if (!rows.length) throw createError(404, 'Serie seleccionada no encontrada o inactiva.')
    return rows[0]
  }

  if (entityType === 'invoice') {
    if (!fiscalProfileId) return null
    if (seriesCode) {
      const { rows } = await client.query(
        `SELECT * FROM tenant_document_series
          WHERE entity_type='invoice' AND fiscal_profile_id = $1 AND serie = $2 AND is_active = TRUE
          LIMIT 1`,
        [fiscalProfileId, seriesCode]
      )
      if (rows.length) return rows[0]
    }
    if (cfdiType) {
      const { rows } = await client.query(
        `SELECT * FROM tenant_document_series
          WHERE entity_type='invoice' AND fiscal_profile_id = $1
            AND is_active = TRUE AND is_default = TRUE AND cfdi_type = $2
          LIMIT 1`,
        [fiscalProfileId, cfdiType]
      )
      if (rows.length) return rows[0]
    }
    const { rows: gen } = await client.query(
      `SELECT * FROM tenant_document_series
        WHERE entity_type='invoice' AND fiscal_profile_id = $1
          AND is_active = TRUE AND is_default = TRUE AND cfdi_type IS NULL
        LIMIT 1`,
      [fiscalProfileId]
    )
    if (gen.length) return gen[0]
    const { rows: fb } = await client.query(
      `SELECT * FROM tenant_document_series
        WHERE entity_type='invoice' AND fiscal_profile_id = $1 AND is_active = TRUE
        ORDER BY created_at ASC LIMIT 1`,
      [fiscalProfileId]
    )
    return fb[0] || null
  }

  // No-invoice
  if (seriesCode) {
    const { rows } = await client.query(
      `SELECT * FROM tenant_document_series
        WHERE tenant_id = $1 AND entity_type = $2 AND serie = $3 AND is_active = TRUE
        LIMIT 1`,
      [tenantId, entityType, seriesCode]
    )
    if (rows.length) return rows[0]
  }
  const { rows: def } = await client.query(
    `SELECT * FROM tenant_document_series
      WHERE tenant_id = $1 AND entity_type = $2 AND is_active = TRUE AND is_default = TRUE
      LIMIT 1`,
    [tenantId, entityType]
  )
  if (def.length) return def[0]
  const { rows: fb } = await client.query(
    `SELECT * FROM tenant_document_series
      WHERE tenant_id = $1 AND entity_type = $2 AND is_active = TRUE
      ORDER BY created_at ASC LIMIT 1`,
    [tenantId, entityType]
  )
  return fb[0] || null
}

/**
 * Helper para los generadores de documentos. Resuelve serie + consume folio
 * atómicamente. Si no hay serie configurada, devuelve null para que el caller
 * use su patrón legacy.
 *
 * Devuelve { docNumber, serie, folio, fiscalProfileId } o null.
 *
 * El formato del docNumber por default es `{serie}-{folio_padded_4}`.
 * El caller puede pasar `padding` distinto si su numeración legacy tenía otro.
 */
async function generateDocumentNumber({ client, tenantId, entityType, opts = {} }) {
  const { fiscalProfileId, seriesId, seriesCode, cfdiType, padding = 4 } = opts
  const series = await resolveSeriesForEmission({
    client, tenantId, entityType, fiscalProfileId, seriesId, seriesCode, cfdiType,
  })
  if (!series) return null
  const { folio, serie } = await consumeNextFolio({ client, seriesId: series.id })
  return {
    docNumber:        `${serie}-${String(folio).padStart(padding, '0')}`,
    serie,
    folio:            String(folio),
    fiscalProfileId:  series.fiscal_profile_id,
  }
}

module.exports = {
  listSeries,
  getSeries,
  createSeries,
  updateSeries,
  deleteSeries,
  consumeNextFolio,
  resolveSeriesForEmission,
  generateDocumentNumber,
  ENTITY_TYPES,
  ENTITY_LABELS,
  ENTITY_GROUPS,
}
