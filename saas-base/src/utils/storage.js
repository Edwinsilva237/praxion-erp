'use strict'

const fs = require('fs')
const path = require('path')
const config = require('../config')
const logger = require('../config/logger')

// Modo dual: si R2_BUCKET está vacío, escribimos a disco local (UPLOAD_DIR) —
// permite trabajar en dev sin credenciales de Cloudflare. Si está configurado,
// usamos el cliente S3 contra el endpoint R2.
const useR2 = !!config.storage.bucket

let s3Client = null
let GetObjectCommand, PutObjectCommand, DeleteObjectCommand, getSignedUrl

if (useR2) {
  const sdk = require('@aws-sdk/client-s3')
  ;({ GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = sdk)
  ;({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'))

  s3Client = new sdk.S3Client({
    region: config.storage.region,
    endpoint: `https://${config.storage.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  })
  logger.info('[storage] R2 habilitado', { bucket: config.storage.bucket })
} else {
  logger.info('[storage] R2 no configurado — usando disco local', { dir: config.uploads.dir })
}

const LOCAL_DIR = path.resolve(config.uploads.dir)

if (!useR2 && !fs.existsSync(LOCAL_DIR)) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// API pública: put / remove / serve. Los servicios consumen estos tres
// métodos y reciben un `key` opaco (string) que guardan en BD. Internamente
// el key es la ruta relativa al bucket (R2) o al UPLOAD_DIR (disco).
// ─────────────────────────────────────────────────────────────────────────────

async function put(key, buffer, { contentType } = {}) {
  if (useR2) {
    await s3Client.send(new PutObjectCommand({
      Bucket:      config.storage.bucket,
      Key:         key,
      Body:        buffer,
      ContentType: contentType || 'application/octet-stream',
    }))
    return
  }
  const full = path.join(LOCAL_DIR, key)
  const dir = path.dirname(full)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(full, buffer)
}

async function remove(key) {
  if (!key) return
  if (useR2) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: config.storage.bucket,
        Key:    key,
      }))
    } catch (err) {
      // No bloqueamos si el objeto ya no existe — solo logueamos.
      logger.warn('[storage] No se pudo borrar objeto R2', { key, error: err.message })
    }
    return
  }
  const full = path.join(LOCAL_DIR, key)
  if (fs.existsSync(full)) {
    try { fs.unlinkSync(full) } catch (err) {
      logger.warn('[storage] No se pudo borrar archivo local', { key, error: err.message })
    }
  }
}

/**
 * Sirve un objeto al cliente. En R2 devuelve un 302 redirect a un signed URL
 * (el browser descarga directo de R2 sin pasar bytes por nuestro backend).
 * En modo disco usa res.sendFile.
 *
 * @param {object} res          - express response
 * @param {string} key          - key/path opaco devuelto por `put`
 * @param {object} opts
 * @param {string} opts.filename     - nombre que verá el usuario al descargar
 * @param {string} opts.mimeType     - Content-Type a forzar
 * @param {string} [opts.disposition='attachment']  - 'attachment' | 'inline'
 */
async function serve(res, key, { filename, mimeType, disposition = 'attachment' } = {}) {
  if (useR2) {
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: config.storage.bucket,
        Key:    key,
        ResponseContentType:        mimeType,
        ResponseContentDisposition: filename
          ? `${disposition}; filename="${encodeURIComponent(filename)}"`
          : undefined,
      }),
      { expiresIn: config.storage.signedUrlTtl }
    )
    return res.redirect(302, url)
  }
  const full = path.join(LOCAL_DIR, key)
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Archivo no encontrado.' })
  }
  if (mimeType)  res.setHeader('Content-Type', mimeType)
  if (filename)  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`)
  return res.sendFile(full)
}

/**
 * Útil cuando el caller quiere el bytestream (p.ej. adjuntar a un email).
 * En disco devuelve el path absoluto; en R2 devuelve el buffer descargado.
 * Solo usar para archivos pequeños — para serving al cliente, usa `serve()`.
 */
async function fetchBuffer(key) {
  if (useR2) {
    const out = await s3Client.send(new GetObjectCommand({
      Bucket: config.storage.bucket, Key: key,
    }))
    return Buffer.concat(await streamToChunks(out.Body))
  }
  const full = path.join(LOCAL_DIR, key)
  if (!fs.existsSync(full)) return null
  return fs.readFileSync(full)
}

async function streamToChunks(stream) {
  const chunks = []
  for await (const c of stream) chunks.push(c)
  return chunks
}

module.exports = { put, remove, serve, fetchBuffer, useR2 }
