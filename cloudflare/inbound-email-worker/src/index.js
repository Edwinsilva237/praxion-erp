/**
 * Email Worker — buzón de facturas entrantes de Praxion ERP.
 *
 * Cloudflare Email Routing entrega aquí, vía una regla CATCH-ALL del subdominio
 * `inbox.praxionops.com`, TODO correo dirigido a `<token>@inbox.praxionops.com`.
 * El token es per-tenant (lo genera la mig 208 y se ve/rota en Gastos → Buzón).
 *
 * Flujo:
 *   1. Saca el token del local-part del destinatario (rutea al tenant).
 *   2. Parsea el MIME con postal-mime y se queda con los adjuntos XML/PDF.
 *   3. POSTea { token, from, attachments[] } a la API (Render) con el secret
 *      compartido en el header `X-Ingest-Secret`.
 *
 * La validación de seguridad de verdad (candado RFC receptor == RFC del tenant,
 * match de proveedor, anti-dup por UUID) vive en la API — este Worker solo es
 * el transporte. Si la API rechaza, NO rebotamos al proveedor: dejamos rastro
 * en los logs (`wrangler tail`) y seguimos.
 *
 * Secrets (wrangler secret put / dashboard del Worker):
 *   INGEST_URL    — base de la API, ej. https://praxion-api.onrender.com
 *   INGEST_SECRET — DEBE coincidir con INBOUND_INGEST_SECRET en Render.
 */

import PostalMime from 'postal-mime'

// Solo nos interesan facturas: CFDI XML o PDF.
const WANTED_MIME = ['application/xml', 'text/xml', 'application/pdf']
function isWanted(att) {
  const mt = (att.mimeType || '').toLowerCase()
  const name = (att.filename || '').toLowerCase()
  return WANTED_MIME.includes(mt) || name.endsWith('.xml') || name.endsWith('.pdf')
}

// ArrayBuffer/Uint8Array → base64, sin Buffer y en chunks (no revienta el stack).
function toBase64(content) {
  if (typeof content === 'string') return content   // postal-mime ya lo dio en base64
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export default {
  async email(message, env, ctx) {
    const to = (message.to || '').toLowerCase().trim()
    const token = to.split('@')[0].trim()
    if (!token) { message.setReject('Dirección de buzón no reconocida.'); return }

    // Tope de tamaño de Email Routing (25 MiB). Evita parsear correos enormes.
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject('El correo excede el tamaño permitido.'); return
    }

    let parsed
    try {
      const raw = await new Response(message.raw).arrayBuffer()   // raw es de un solo uso
      parsed = await PostalMime.parse(raw)
    } catch (e) {
      // MIME ilegible → descartar sin rebotar (evita tormentas de bounces).
      console.log('inbound-worker: MIME ilegible', { token, error: e?.message })
      return
    }

    const attachments = (parsed.attachments || [])
      .filter(isWanted)
      .map(a => ({
        filename: a.filename || 'adjunto',
        mimetype: a.mimeType || 'application/octet-stream',
        contentBase64: toBase64(a.content),
      }))

    if (!attachments.length) {
      // Correo sin factura adjunta (texto, firma, imagen) → nada que registrar.
      console.log('inbound-worker: sin adjunto XML/PDF, descartado', { token, from: message.from })
      return
    }

    try {
      const res = await fetch(`${env.INGEST_URL}/api/inbound/expense`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ingest-Secret': env.INGEST_SECRET,
        },
        body: JSON.stringify({ token, from: message.from, attachments }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.log('inbound-worker: la API respondió error', { status: res.status, body: body.slice(0, 300) })
      } else {
        console.log('inbound-worker: entregado a la API', { token, attachments: attachments.length })
      }
    } catch (e) {
      // La API no respondió (deploy/spin-down). No rebotamos: mejor revisar
      // logs que devolverle un bounce al proveedor por un hipo de infra.
      console.log('inbound-worker: fallo al postear a la API', { token, error: e?.message })
    }
  },
}
