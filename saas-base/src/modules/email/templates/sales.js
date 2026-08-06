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

/**
 * Email para enviar una ORDEN DE COMPRA a un proveedor (módulo Compras).
 */
function purchaseOrderEmail({ tenantName, brandColor, supplierName, docNumber, total, currency, issueDate, expectedDate, notes }) {
  const summaryRows = [
    ['Orden de compra', docNumber],
    ['Emitida', fmtDate(issueDate)],
  ]
  if (expectedDate) summaryRows.push(['Entrega esperada', fmtDate(expectedDate)])

  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  const notesBlock = notes
    ? `<p style="font-size:13px;color:#374151;border-left:3px solid ${brandColor || '#1a3a5c'};padding-left:12px;margin:18px 0;">${escapeHTML(notes)}</p>`
    : ''

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title:      `Orden de compra ${docNumber}`,
    preheader:  `Adjuntamos la orden de compra ${docNumber} por ${fmtCurrency(total, currency)}`,
    body: `
      <h2>Orden de compra ${escapeHTML(docNumber)}</h2>
      <p>Estimados <strong>${escapeHTML(supplierName)}</strong>:</p>
      <p>Adjuntamos nuestra orden de compra con el detalle de los artículos solicitados. Agradeceremos confirmar de recibido y la fecha estimada de entrega respondiendo a este correo.</p>
      ${notesBlock}
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>Total</span><span>${fmtCurrency(total, currency)}</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">Cualquier duda sobre esta orden, no duden en responder a este correo.</p>
    `,
  })
}

/**
 * Email para SOLICITAR la factura (CFDI) a un proveedor por un gasto registrado
 * sin comprobante. Lo manda el módulo de Gastos.
 */
function expenseInvoiceRequestEmail({
  tenantName, brandColor, supplierName, concept, folio, total, currency, expenseDate,
  // Opcionales para el flujo de Recepciones (Compras). Los defaults conservan
  // el correo de Gastos tal cual estaba.
  dateLabel = 'Fecha del gasto',
  orderNumber = null,
  totalLabel = 'Total',
  replyNote = 'Pueden responder a este correo con el XML y el PDF del comprobante. ¡Gracias!',
}) {
  const summaryRows = []
  if (concept)     summaryRows.push(['Concepto', concept])
  if (orderNumber) summaryRows.push(['Orden de compra', orderNumber])
  if (expenseDate) summaryRows.push([dateLabel, fmtDate(expenseDate)])
  if (folio)       summaryRows.push(['Nuestra referencia', folio])

  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title:      'Solicitud de factura',
    preheader:  `Le solicitamos la factura de un gasto por ${fmtCurrency(total, currency)}`,
    body: `
      <h2>Solicitud de factura (CFDI)</h2>
      <p>Estimados <strong>${escapeHTML(supplierName || 'proveedor')}</strong>:</p>
      <p>Les solicitamos amablemente la <strong>factura (CFDI)</strong> correspondiente al siguiente gasto, para poder registrarla en nuestra contabilidad:</p>
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>${escapeHTML(totalLabel)}</span><span>${fmtCurrency(total, currency)}</span></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">${escapeHTML(replyNote)}</p>
    `,
  })
}

/**
 * Email para SOLICITAR al proveedor el complemento de pago (REP, CFDI tipo P)
 * de un pago emitido, o su CORRECCIÓN cuando el recibido no cuadra.
 * Lo manda Pagos emitidos.
 *
 * mode: 'missing' (no ha emitido REP) | 'mismatch' (el REP no cuadra).
 * invoices: [{ folio, uuid, amountApplied }] — facturas que liquidó el pago,
 *           con su UUID para que el proveedor arme el DoctoRelacionado.
 * repReceived (solo mismatch): { folio, uuid, amount }.
 * method/bankName: método de pago y banco emisor (con últimos 4 de la cuenta)
 *           para que el proveedor rastree la transferencia en su estado de cuenta.
 */
function repRequestEmail({
  tenantName, brandColor, supplierName, mode,
  paymentDate, amount, currency, reference,
  method = null, bankName = null,
  invoices = [], repReceived = null,
}) {
  const summaryRows = [['Fecha del pago', fmtDate(paymentDate)]]
  if (method)    summaryRows.push(['Método de pago', method])
  if (bankName)  summaryRows.push(['Banco emisor', bankName])
  if (reference) summaryRows.push(['Referencia', reference])
  const rowsHTML = summaryRows.map(([k, v]) =>
    `<div class="row"><span>${k}</span><strong>${escapeHTML(v)}</strong></div>`
  ).join('')

  const invoiceRows = invoices.map(i => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">${escapeHTML(i.folio || '—')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:11px;font-family:monospace;color:#6b7280;">${escapeHTML(i.uuid || '—')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;">${fmtCurrency(i.amountApplied, currency)}</td>
    </tr>`).join('')
  const invoicesBlock = invoices.length ? `
    <p style="font-size:13px;color:#374151;margin:14px 0 6px;">Facturas liquidadas con este pago:</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;">
      <tr>
        <th style="padding:6px 10px;text-align:left;font-size:12px;color:#6b7280;">Folio</th>
        <th style="padding:6px 10px;text-align:left;font-size:12px;color:#6b7280;">UUID (folio fiscal)</th>
        <th style="padding:6px 10px;text-align:right;font-size:12px;color:#6b7280;">Aplicado</th>
      </tr>
      ${invoiceRows}
    </table>` : ''

  const isMismatch = mode === 'mismatch'
  const mismatchBlock = (isMismatch && repReceived) ? `
    <p style="font-size:13px;color:#92400e;background:#fef3c7;border-radius:8px;padding:10px 12px;margin:14px 0;">
      El complemento recibido${repReceived.folio ? ` (folio ${escapeHTML(repReceived.folio)})` : ''}
      ampara <strong>${fmtCurrency(repReceived.amount, currency)}</strong>, pero el pago realizado fue de
      <strong>${fmtCurrency(amount, currency)}</strong>
      (diferencia de <strong>${fmtCurrency(Math.abs(repReceived.amount - amount), currency)}</strong>).${
      repReceived.uuid ? `<br/><span style="font-size:11px;font-family:monospace;">UUID del REP: ${escapeHTML(repReceived.uuid)}</span>` : ''}
    </p>` : ''

  return shellHTML({
    headerName: tenantName,
    brandColor,
    title: isMismatch ? 'Corrección de complemento de pago' : 'Solicitud de complemento de pago',
    preheader: isMismatch
      ? `El REP recibido no coincide con nuestro pago de ${fmtCurrency(amount, currency)}`
      : `Le solicitamos el REP de nuestro pago de ${fmtCurrency(amount, currency)}`,
    body: `
      <h2>${isMismatch ? 'Corrección de complemento de pago (REP)' : 'Solicitud de complemento de pago (REP)'}</h2>
      <p>Estimados <strong>${escapeHTML(supplierName || 'proveedor')}</strong>:</p>
      ${isMismatch
        ? `<p>Recibimos su complemento de pago, pero <strong>no coincide con el pago realizado</strong>. Les pedimos amablemente cancelarlo y reexpedirlo con los datos correctos:</p>`
        : `<p>Les solicitamos amablemente el <strong>complemento de pago (REP, CFDI tipo P)</strong> del siguiente pago, requerido para nuestra contabilidad y deducibilidad:</p>`}
      <div class="summary">
        ${rowsHTML}
        <div class="row total"><span>Monto pagado</span><span>${fmtCurrency(amount, currency)}</span></div>
      </div>
      ${mismatchBlock}
      ${invoicesBlock}
      <p style="font-size:13px;color:#6b7280;margin-top:16px;">Pueden responder a este correo con el XML y el PDF del complemento. ¡Gracias!</p>
    `,
  })
}

module.exports = { remisionEmail, invoiceEmail, quotationEmail, purchaseOrderEmail, expenseInvoiceRequestEmail, repRequestEmail }
