'use strict'

/**
 * Ingesta de correo entrante (Cloudflare Email Worker → API).
 *
 * NO usa sesión de usuario: lo protege un secret compartido (`INBOUND_INGEST_SECRET`)
 * que el Worker manda en el header `X-Ingest-Secret`. Va montado en app.js ANTES del
 * express.json global porque un PDF adjunto puede superar 1mb.
 *
 * Body: { token, from?, attachments: [{ filename, mimetype, contentBase64 }] }
 *   (también acepta un solo adjunto en el nivel superior).
 */

const crypto = require('crypto')
const express = require('express')
const router = express.Router()
const inboundEmailService = require('./inboundEmailService')

// Comparación en tiempo constante (evita fugas por timing del secret).
function secretOk(provided) {
  const expected = process.env.INBOUND_INGEST_SECRET
  if (!expected || !provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

router.post('/expense', async (req, res, next) => {
  try {
    if (!secretOk(req.get('x-ingest-secret'))) {
      return res.status(401).json({ error: 'No autorizado.' })
    }

    const { token, from } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token requerido.' })

    // Uno o varios adjuntos.
    const attachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments
      : [{ filename: req.body?.filename, mimetype: req.body?.mimetype, contentBase64: req.body?.contentBase64 }]

    const usable = attachments.filter(a => a && a.contentBase64)
    if (!usable.length) return res.status(400).json({ error: 'Sin adjuntos procesables.' })

    // Expande los .zip → XML/PDF de adentro (los CFDI suelen llegar comprimidos).
    const expanded = inboundEmailService.expandAttachments(usable)
    if (!expanded.length) {
      return res.status(422).json({ error: 'El adjunto no contenía un XML/PDF de factura (¿zip vacío o sin CFDI?).' })
    }

    const results = []
    for (const a of expanded) {
      try {
        const r = await inboundEmailService.ingestInboundDocument({
          token, from, filename: a.filename, mimetype: a.mimetype, contentBase64: a.contentBase64,
          siblings: a.siblings,
        })
        results.push(r)
      } catch (e) {
        // No tumbar el lote por un adjunto: reporta el error de ese adjunto y sigue.
        results.push({ status: 'error', filename: a.filename || null, error: e.message, code: e.status || 500 })
      }
    }

    // Si TODOS los adjuntos fallaron por token/RFC (auth de negocio), refleja el peor código.
    const hardFail = results.every(r => r.status === 'error')
    const worst = hardFail ? Math.max(...results.map(r => r.code || 500)) : 200
    res.status(hardFail ? (worst === 200 ? 422 : worst) : 200).json({ results })
  } catch (err) { next(err) }
})

module.exports = router
