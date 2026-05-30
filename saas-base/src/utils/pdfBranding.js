'use strict'

const storage = require('./storage')
const logger = require('../config/logger')

/**
 * Branding del tenant para los PDFs generados con pdfkit (cotización, factura,
 * remisión, orden de compra, recibo de pago, reportes).
 *
 * Los colores (brand_color_primary/secondary) ya se leen en cada servicio. Este
 * módulo centraliza el LOGO: descargarlo del storage y dibujarlo en el header.
 *
 * IMPORTANTE: pdfkit sólo sabe renderizar PNG y JPEG. Un logo en WebP o SVG
 * (formatos también permitidos al subir) reventaría doc.image(). Por eso
 * validamos por *magic bytes* y devolvemos null si no es PNG/JPEG — el header
 * cae al diseño sin logo (idéntico al actual) en vez de romper el PDF.
 */

// Geometría del chip del logo dentro de la banda de color del header.
const LOGO = { x: 48, y: 48, size: 54 }
const HEADER_TEXT_X = LOGO.x + LOGO.size + 10 // 112 — dónde empieza el texto si hay logo
const DEFAULT_TEXT_X = 55                     // dónde empieza el texto si NO hay logo

/** Devuelve el buffer sólo si es PNG/JPEG (lo que pdfkit puede dibujar). */
function asPdfImage(buffer) {
  if (!buffer || buffer.length < 4) return null
  const isPng  = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  return (isPng || isJpeg) ? buffer : null
}

/**
 * Descarga el logo del tenant desde storage y lo devuelve listo para pdfkit
 * (PNG/JPEG). null si no hay logo, no se encontró, o el formato no es soportado.
 */
async function loadTenantLogo(logoStoragePath) {
  if (!logoStoragePath) return null
  try {
    const buf = await storage.fetchBuffer(logoStoragePath)
    const img = asPdfImage(buf)
    if (buf && !img) {
      logger.warn('[pdfBranding] logo del tenant no es PNG/JPEG; se omite en el PDF', { logoStoragePath })
    }
    return img
  } catch (err) {
    logger.warn('[pdfBranding] no se pudo cargar el logo del tenant', { logoStoragePath, error: err.message })
    return null
  }
}

/** x donde debe iniciar el bloque de texto del emisor (desplazado si hay logo). */
function headerTextX(hasLogo) {
  return hasLogo ? HEADER_TEXT_X : DEFAULT_TEXT_X
}

/**
 * Dibuja el logo del tenant como un chip blanco dentro de la banda de color del
 * header. No-op si no hay logo. Nunca lanza (no debe tumbar la generación del PDF).
 */
function drawHeaderLogo(doc, logoBuffer) {
  if (!logoBuffer) return
  try {
    doc.save()
    doc.roundedRect(LOGO.x, LOGO.y, LOGO.size, LOGO.size, 6).fill('#FFFFFF')
    doc.image(logoBuffer, LOGO.x + 4, LOGO.y + 4, {
      fit: [LOGO.size - 8, LOGO.size - 8], align: 'center', valign: 'center',
    })
    doc.restore()
  } catch (err) {
    try { doc.restore() } catch (_) {}
    logger.warn('[pdfBranding] no se pudo dibujar el logo en el PDF', { error: err.message })
  }
}

module.exports = { loadTenantLogo, headerTextX, drawHeaderLogo, asPdfImage }
