'use strict'

const { query }   = require('../../db')
const { audit }   = require('../../utils/audit')
const { enqueueEmail } = require('../../queues/emailQueue')
const { generatePaymentReceiptPDF } = require('./paymentReceiptPdfService')

/**
 * Envía por correo (SMTP) el recibo de pago en PDF al cliente.
 * BCC al correo institucional (tenants.notification_email) o al usuario logueado.
 */
async function sendReceiptByEmail({ tenantId, paymentId, emails, userId, ipAddress, userAgent }) {
  // Datos básicos para asunto + destinatarios
  const { rows: pRows } = await query(
    `SELECT arp.id, arp.amount, arp.payment_date,
            ar.document_number AS ar_document_number, ar.document_type,
            ar.currency, ar.partner_id,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            tfi.razon_social AS emisor_nombre,
            t.name AS tenant_name
       FROM ar_payments arp
       JOIN accounts_receivable ar ON ar.id = arp.ar_id
       JOIN business_partners bp   ON bp.id = ar.partner_id
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = arp.tenant_id
       LEFT JOIN tenants t         ON t.id = arp.tenant_id
      WHERE arp.id = $1 AND arp.tenant_id = $2`,
    [paymentId, tenantId]
  )
  if (!pRows.length) throw createError(404, 'Pago no encontrado.')
  const p = pRows[0]

  // Destinatarios
  let recipients = Array.isArray(emails) ? emails.filter(Boolean) : []
  if (!recipients.length) {
    const { rows: contacts } = await query(
      `SELECT email FROM business_partner_contacts
        WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
        ORDER BY is_primary DESC NULLS LAST, id ASC`,
      [p.partner_id]
    )
    recipients = contacts.map(r => r.email).filter(Boolean)
  }
  if (!recipients.length) {
    throw createError(400,
      'No se pudo determinar el destinatario: el cliente no tiene contactos con correo y no se especificaron correos en la solicitud.')
  }

  // BCC institucional
  let copyEmail = null
  const { rows: tr } = await query(`SELECT notification_email FROM tenants WHERE id = $1`, [tenantId])
  if (tr[0]?.notification_email) copyEmail = tr[0].notification_email
  else if (userId) {
    const { rows: u } = await query(`SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId])
    copyEmail = u[0]?.email || null
  }
  if (copyEmail && recipients.includes(copyEmail)) copyEmail = null

  // Generar PDF
  const { buffer, folio } = await generatePaymentReceiptPDF({ tenantId, paymentId })

  const tenantDisplayName  = p.emisor_nombre || p.tenant_name || 'Emisor'
  const partnerDisplayName = p.partner_tax_name || p.partner_name || ''
  const dateStr = p.payment_date ? new Date(p.payment_date).toISOString().slice(0, 10) : ''
  const amountStr = new Intl.NumberFormat('es-MX',
    { style: 'currency', currency: p.currency || 'MXN' }).format(parseFloat(p.amount))
  const docTypeLabel = p.document_type === 'invoice' ? 'factura'
                     : p.document_type === 'remission' ? 'remisión'
                     : 'documento'

  const html = `
    <p>Estimado(a) ${partnerDisplayName || 'cliente'}:</p>
    <p>Adjuntamos el recibo de pago <strong>${folio}</strong>
       correspondiente al pago de <strong>${amountStr}</strong> aplicado el ${dateStr}
       a la ${docTypeLabel} <strong>${p.ar_document_number}</strong>.</p>
    <p>Este recibo es un comprobante interno; <em>no tiene efectos fiscales</em>
       y no sustituye al CFDI cuando este aplique.</p>
    <p>Quedamos atentos a cualquier aclaración.</p>
    <p>— ${tenantDisplayName}</p>
  `

  await enqueueEmail({
    to:        recipients,
    bcc:       copyEmail || undefined,
    replyTo:   copyEmail || undefined,
    subject:   `Recibo de pago ${folio} — ${p.ar_document_number} — ${tenantDisplayName}`,
    html,
    fromName:  tenantDisplayName,
    attachments: [
      { filename: `${folio}.pdf`, content: buffer, contentType: 'application/pdf' },
    ],
  })

  await audit({
    tenantId, userId, action: 'payment_receipt.sent_by_email',
    resource: 'ar_payments', resourceId: paymentId,
    payload: { folio, recipients, bcc: copyEmail, ar_document_number: p.ar_document_number },
    ipAddress, userAgent,
  })

  return { sent: true, folio, recipients, bcc: copyEmail }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { sendReceiptByEmail }
