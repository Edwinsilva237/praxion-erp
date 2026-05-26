'use strict'

const { htmlWitnessMark } = require('../../../utils/praxionWitnessMark')

/**
 * Plantillas de correo para Ventas/Facturación.
 * Se usan con emailService.sendEmail.
 *
 * El wrapper HTML es el mismo que el resto del sistema (baseTemplate de index.js),
 * pero personalizado con el nombre del tenant emisor.
 */

function fmtCurrency(amount, currency = 'MXN') {
  const n = parseFloat(amount || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${currency} $${n}`
}

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * Wrapper HTML — copia del baseTemplate de email/templates/index.js pero
 * con el nombre del tenant emisor (no del SaaS) en el header.
 */
function shellHTML({ headerName, title, preheader, body, brandColor }) {
  // El header del email y el color del total usan el brand_color_primary del
  // tenant. Si no está configurado, mantenemos el azul histórico #1a3a5c.
  const primary = brandColor || '#1a3a5c'
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .header { background: ${primary}; padding: 28px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    .body { padding: 36px 40px; color: #374151; font-size: 15px; line-height: 1.65; }
    .body h2 { color: #111827; font-size: 19px; font-weight: 600; margin: 0 0 14px; }
    .body p { margin: 0 0 14px; }
    .summary { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .summary .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
    .summary .row strong { color: #111827; }
    .total { border-top: 1px solid #e5e7eb; margin-top: 8px; padding-top: 8px; font-size: 15px; font-weight: 600; color: ${primary}; }
    .footer { padding: 20px 40px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
  <div class="wrapper">
    <div class="header"><h1>${escapeHTML(headerName)}</h1></div>
    <div class="body">${body}</div>
    <div class="footer">
      <p>${escapeHTML(headerName)} · ${new Date().getFullYear()}</p>
    </div>
    ${htmlWitnessMark()}
  </div>
</body>
</html>`
}

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/**
 * Email para enviar una remisión al cliente.
 */
function remisionEmail({ tenantName, brandColor, partnerName, docNumber, total, currency, issueDate, dueDate, orderNumber, poNumber }) {
  const summaryRows = [
    ['Remisión', docNumber],
    ['Emitida', fmtDate(issueDate)],
  ]
  if (orderNumber) summaryRows.push(['Pedido', orderNumber])
  if (poNumber)    summaryRows.push(['OC del cliente', poNumber])
  if (dueDate)     summaryRows.push(['Vence', fmtDate(dueDate)])

  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title:      `Remisión ${docNumber}`,
    preheader:  `Adjuntamos la remisión ${docNumber} por ${fmtCurrency(total, currency)}`,
    body: `
      <h2>Remisión ${escapeHTML(docNumber)}</h2>
      <p>Estimados <strong>${escapeHTML(partnerName)}</strong>:</p>
      <p>Adjunto encontrarán la remisión correspondiente a la mercancía entregada/por entregar. Este documento es la representación impresa de la operación; el comprobante fiscal (CFDI) se enviará por separado cuando aplique.</p>
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>Total</span><span>${fmtCurrency(total, currency)}</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">Si tienen cualquier observación sobre el contenido o la entrega, no duden en responder a este correo.</p>
    `,
  })
}

/**
 * Email para enviar una factura (CFDI) al cliente.
 * Se usa para el caso en que Facturapi NO envía por nosotros (p.ej. factura
 * borrador) o cuando queremos un acompañante manual desde nuestro lado.
 */
function invoiceEmail({ tenantName, brandColor, partnerName, docNumber, total, currency, issueDate, uuid, poNumber }) {
  const summaryRows = [
    ['Factura', docNumber],
    ['Emitida', fmtDate(issueDate)],
  ]
  if (uuid)     summaryRows.push(['UUID', uuid])
  if (poNumber) summaryRows.push(['OC del cliente', poNumber])

  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title:      `Factura ${docNumber}`,
    preheader:  `Adjuntamos la factura ${docNumber} por ${fmtCurrency(total, currency)}`,
    body: `
      <h2>Factura ${escapeHTML(docNumber)}</h2>
      <p>Estimados <strong>${escapeHTML(partnerName)}</strong>:</p>
      <p>Adjuntamos la factura correspondiente. ${uuid ? 'Encontrarán el CFDI timbrado y su representación impresa.' : 'Encontrarán la representación preliminar; el CFDI fiscal se enviará una vez timbrada.'}</p>
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>Total</span><span>${fmtCurrency(total, currency)}</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">Quedamos atentos a cualquier observación.</p>
    `,
  })
}

/**
 * Email para enviar una cotización al cliente.
 */
function quotationEmail({ tenantName, brandColor, partnerName, docNumber, total, currency, issueDate, validUntil, notes }) {
  const summaryRows = [
    ['Cotización', docNumber],
    ['Emitida', fmtDate(issueDate)],
  ]
  if (validUntil) summaryRows.push(['Vigencia hasta', fmtDate(validUntil)])

  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  const notesBlock = notes
    ? `<p style="font-size:13px;color:#374151;border-left:3px solid ${brandColor || '#1a3a5c'};padding-left:12px;margin:18px 0;">${escapeHTML(notes)}</p>`
    : ''

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title:      `Cotización ${docNumber}`,
    preheader:  `Adjuntamos la cotización ${docNumber} por ${fmtCurrency(total, currency)}`,
    body: `
      <h2>Cotización ${escapeHTML(docNumber)}</h2>
      <p>Estimados <strong>${escapeHTML(partnerName)}</strong>:</p>
      <p>Adjuntamos la cotización solicitada. Los precios están sujetos a vigencia y disponibilidad. El IVA (16%) se agrega al emitir la factura.</p>
      ${notesBlock}
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>Total</span><span>${fmtCurrency(total, currency)}</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">Si tienen cualquier observación o desean proceder, no duden en responder a este correo.</p>
    `,
  })
}

module.exports = { remisionEmail, invoiceEmail, quotationEmail }
