'use strict'

const path = require('path')
const crypto = require('crypto')
const { query } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')
const storage = require('../../utils/storage')

/**
 * Restricción de MIME por categoría. Si una categoría no aparece aquí,
 * se valida contra la lista global `config.uploads.allowedMimeTypes`.
 *
 *   image           → fotografías de producto (JPG/PNG/WebP)
 *   technical_sheet → ficha técnica (PDF únicamente)
 *   evidence        → fotos de entrega/recepción (JPG/PNG/WebP)
 */
const MIME_BY_CATEGORY = {
  image:           ['image/jpeg', 'image/png', 'image/webp'],
  technical_sheet: ['application/pdf'],
  evidence:        ['image/jpeg', 'image/png', 'image/webp'],
}

/**
 * Guarda un archivo en object storage y registra el attachment en BD.
 * El campo `storage_path` queda como key opaco (lo usa storage.serve / remove).
 *
 * @param {object}  params
 * @param {boolean} [params.replaceCategory] - Si true, elimina los attachments
 *   previos del mismo (entityType, entityId, category) antes de guardar. Útil
 *   para "imagen principal" donde solo queremos una activa por producto.
 */
async function saveAttachment({
  tenantId,
  entityType,
  entityId,
  category,
  originalFilename,
  buffer,
  mimeType,
  description,
  uploadedBy,
  replaceCategory = false,
}) {
  // Validar tipo MIME por categoría (más estricto) o global (fallback).
  const allowed = MIME_BY_CATEGORY[category] || config.uploads.allowedMimeTypes
  if (!allowed.includes(mimeType)) {
    throw createError(400,
      `Tipo no permitido para "${category}": ${mimeType}. Acepta: ${allowed.join(', ')}.`)
  }

  // Validar tamaño
  const maxBytes = config.uploads.maxSizeMb * 1024 * 1024
  if (buffer.length > maxBytes) {
    throw createError(400, `El archivo excede el tamaño máximo de ${config.uploads.maxSizeMb}MB.`)
  }

  // Reemplazar attachments previos de la misma categoría (para "imagen única")
  if (replaceCategory) {
    const { rows: prev } = await query(
      `SELECT id, storage_path FROM attachments
        WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND category = $4`,
      [tenantId, entityType, entityId, category]
    )
    for (const old of prev) {
      await storage.remove(old.storage_path)
      await query(`DELETE FROM attachments WHERE id = $1`, [old.id])
    }
  }

  // Generar key único — forward slashes funcionan tanto para S3/R2 como
  // para el modo disco (storage.put usa path.join al resolver).
  const ext = path.extname(originalFilename) || '.pdf'
  const key = `${tenantId}/${entityType}/${crypto.randomUUID()}${ext}`

  await storage.put(key, buffer, { contentType: mimeType })
  logger.info('Attachment saved', { key, size: buffer.length })

  const { rows } = await query(
    `INSERT INTO attachments
       (tenant_id, entity_type, entity_id, category, filename, storage_path,
        file_size_bytes, mime_type, description, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, filename, category, file_size_bytes, created_at`,
    [tenantId, entityType, entityId, category, originalFilename,
     key, buffer.length, mimeType, description || null, uploadedBy || null]
  )

  return rows[0]
}

/**
 * Lista los attachments de una entidad.
 */
async function listAttachments({ tenantId, entityType, entityId, category }) {
  const params = [tenantId, entityType, entityId]
  let categoryClause = ''

  if (category) {
    params.push(category)
    categoryClause = `AND category = $${params.length}`
  }

  const { rows } = await query(
    `SELECT a.id, a.category, a.filename, a.file_size_bytes, a.mime_type,
            a.description, a.created_at,
            u.full_name AS uploaded_by_name
     FROM attachments a
     LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.tenant_id = $1 AND a.entity_type = $2 AND a.entity_id = $3
       ${categoryClause}
     ORDER BY a.created_at DESC`,
    params
  )

  return rows
}

/**
 * Obtiene metadata + storage key de un attachment. Los routes usan esto y
 * luego llaman storage.serve(res, key, ...) — que hará 302 a signed URL en
 * R2 o sendFile en modo disco.
 */
async function getAttachmentInfo({ tenantId, attachmentId }) {
  const { rows } = await query(
    `SELECT id, filename, storage_path, mime_type
     FROM attachments
     WHERE id = $1 AND tenant_id = $2`,
    [attachmentId, tenantId]
  )

  return rows[0] || null
}

/**
 * Elimina un attachment del storage y de BD.
 */
async function deleteAttachment({ tenantId, attachmentId }) {
  const { rows } = await query(
    `DELETE FROM attachments WHERE id = $1 AND tenant_id = $2
     RETURNING id, storage_path, filename`,
    [attachmentId, tenantId]
  )

  if (rows.length === 0) return null

  await storage.remove(rows[0].storage_path)
  logger.info('Attachment deleted', { key: rows[0].storage_path })

  return rows[0]
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { saveAttachment, listAttachments, getAttachmentInfo, deleteAttachment }
