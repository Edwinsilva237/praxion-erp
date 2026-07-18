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
// HEIC/HEIF = formato nativo de foto del iPhone; se acepta como evidencia
// (se descarga para verla, no se renderiza inline).
const PHONE_PHOTO = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
const MIME_BY_CATEGORY = {
  image:           ['image/jpeg', 'image/png', 'image/webp'],
  technical_sheet: ['application/pdf'],
  evidence:        PHONE_PHOTO,
  // Evidencia aditiva de remisión (foto del acuse, firma en pantalla PNG, o la
  // factura impresa firmada / un escaneo en PDF) → imágenes + PDF.
  delivery_evidence: [...PHONE_PHOTO, 'application/pdf'],
  // Documento de la orden de compra del cliente adjuntado al pedido (sales_order):
  // el PDF o la foto de la OC que manda el cliente, para imprimirla al entregar.
  customer_po: [...PHONE_PHOTO, 'application/pdf'],
  // Respaldo del CFDI recibido (por correo o subido) pegado a su gasto/factura
  // de proveedor: el XML timbrado y/o su representación impresa en PDF. Único
  // caso que acepta XML (los demás son imágenes/PDF).
  cfdi: ['application/xml', 'text/xml', 'application/pdf'],
  // Documentos fiscales PROPIOS del tenant, guardados a nivel tenant para
  // distribuirlos a clientes: la Constancia de Situación Fiscal (CSF) y la
  // Opinión de Cumplimiento (art. 32-D). Se descargan del SAT en PDF.
  fiscal_csf: ['application/pdf'],
  fiscal_32d: ['application/pdf'],
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

  // Imagen única del producto: además de guardar el attachment, denormalizamos
  // su id en `products.image_attachment_id` para que el frontend la encuentre
  // sin tener que escanear la lista de attachments. Sin este UPDATE el campo
  // queda en NULL y ProductImageUploader nunca solicita el blob — síntoma:
  // la imagen "se sube sin error pero no aparece".
  if (entityType === 'product' && category === 'image') {
    await query(
      `UPDATE products SET image_attachment_id = $1
        WHERE id = $2 AND tenant_id = $3`,
      [rows[0].id, entityId, tenantId]
    )
  }

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
     RETURNING id, storage_path, filename, entity_type, entity_id, category`,
    [attachmentId, tenantId]
  )

  if (rows.length === 0) return null

  await storage.remove(rows[0].storage_path)
  logger.info('Attachment deleted', { key: rows[0].storage_path })

  // Espejo de la denormalización en saveAttachment: si era la imagen del
  // producto, limpiar la referencia para que el front sepa que ya no existe.
  if (rows[0].entity_type === 'product' && rows[0].category === 'image') {
    await query(
      `UPDATE products SET image_attachment_id = NULL
        WHERE id = $1 AND tenant_id = $2 AND image_attachment_id = $3`,
      [rows[0].entity_id, tenantId, rows[0].id]
    )
  }

  return rows[0]
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { saveAttachment, listAttachments, getAttachmentInfo, deleteAttachment }
