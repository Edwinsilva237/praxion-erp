'use strict'

const { query, withTransaction } = require('../../db')
const { audit }     = require('../../utils/audit')
const { enqueueEmail } = require('../../queues/emailQueue')
const { getFacturapiForTenant } = require('./facturapiClient')

/**
 * Genera un complemento de pago (CFDI tipo P) para una factura PPD.
 *
 * @param {object} params
 * @param {string} params.invoiceId      - ID de la factura PPD en tu BD
 * @param {string} params.paymentDate    - Fecha del pago YYYY-MM-DD
 * @param {string} params.paymentForm    - Forma de pago: 03=transferencia, 01=efectivo, etc.
 * @param {number} params.amount         - Monto pagado
 * @param {string} params.currency       - MXN | USD
 * @param {string} params.reference      - Referencia de la transferencia
 * @param {number} params.exchangeRate   - TC si es USD
 */
async function createPaymentComplement({
  tenantId, invoiceId,
  paymentDate, paymentForm, amount, currency = 'MXN',
  reference, exchangeRate,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Obtener factura PPD timbrada
    const { rows: invRows } = await client.query(
      `SELECT inv.*,
              bp.name AS partner_name, bp.rfc AS partner_rfc,
              bp.facturapi_id AS partner_facturapi_id,
              bp.tax_regime_code AS partner_tax_regime,
              bp.zip_code AS partner_zip_code
       FROM invoices inv
       JOIN business_partners bp ON bp.id = inv.partner_id
       WHERE inv.id = $1 AND inv.tenant_id = $2
         AND inv.status = 'stamped'
         AND inv.payment_method = 'PPD'`,
      [invoiceId, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Factura PPD timbrada no encontrada.')
    const inv = invRows[0]

    // Extraer facturapi_id de la factura original
    const match = (inv.notes || '').match(/\[facturapi_id:([^\]]+)\]/)
    if (!match) throw createError(500, 'No se encontró el ID de Facturapi en la factura.')
    const facturApiInvoiceId = match[1]

    const facturapi = await getFacturapiForTenant(tenantId)

    // Calcular base e IVA del pago
    const amountNum  = parseFloat(amount)
    const taxRate    = 0.16
    const base       = parseFloat((amountNum / (1 + taxRate)).toFixed(2))
    const taxAmount  = parseFloat((amountNum - base).toFixed(2))

    // Armar payload del complemento de pago para Facturapi
    const payload = {
      type: 'P',
      customer: inv.partner_facturapi_id || {
        legal_name: inv.partner_name.toUpperCase(),
        tax_id:     inv.partner_rfc,
        tax_system: inv.partner_tax_regime || '601',
        address: { zip: inv.partner_zip_code || '60000', country: 'MEX' },
      },
      complements: [
        {
          type: 'pago',
          data: {
            payment_form: paymentForm || '03',
            currency:     currency,
            exchange:     currency === 'USD' ? (exchangeRate || 1) : undefined,
            date:         paymentDate ? new Date(paymentDate + 'T12:00:00').toISOString() : new Date().toISOString(),
            related_documents: [
              {
                uuid:         inv.cfdi_uuid,
                installment:  1,
                last_balance: parseFloat(inv.total),
                amount:       amountNum,
                currency:     inv.currency,
                taxes: [
                  {
                    base:  base,
                    type:  'IVA',
                    rate:  taxRate,
                  },
                ],
              },
            ],
          },
        },
      ],
    }

    // Timbrar complemento de pago
    let complement
    try {
      complement = await facturapi.invoices.create(payload)
    } catch (err) {
      throw createError(422, `Error al timbrar complemento de pago: ${err.message}`)
    }

    // Guardar referencia del complemento en BD — tabla payment_complements
    await client.query(
      `INSERT INTO payment_complements
         (tenant_id, invoice_id, facturapi_id, cfdi_uuid,
          payment_date, payment_form, amount, currency,
          reference, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stamped',$10)`,
      [tenantId, invoiceId, complement.id, complement.uuid,
       paymentDate || new Date().toISOString().split('T')[0],
       paymentForm || '03', amount, currency,
       reference || null, userId]
    )

    // Aplicar pago al CXC si existe
    const { rows: arRows } = await client.query(
      `SELECT id, amount_total, amount_paid, amount_pending
       FROM accounts_receivable
       WHERE tenant_id = $1 AND document_id = $2`,
      [tenantId, invoiceId]
    )
    if (arRows.length > 0) {
      const ar = arRows[0]
      const newPaid   = Math.min(parseFloat(ar.amount_paid) + parseFloat(amount), parseFloat(ar.amount_total))
      const newStatus = newPaid >= parseFloat(ar.amount_total) ? 'paid' : 'partial'
      await client.query(
        `UPDATE accounts_receivable SET amount_paid = $1, status = $2 WHERE id = $3`,
        [newPaid, newStatus, ar.id]
      )
      // Insertar en ar_payments
      await client.query(
        `INSERT INTO ar_payments
           (tenant_id, ar_id, amount, payment_method, reference, payment_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, ar.id, amount, 'transfer', reference || null,
         paymentDate || new Date().toISOString().split('T')[0],
         `Complemento de pago ${complement.uuid}`, userId]
      )
    }

    await audit({
      tenantId, userId, action: 'payment_complement.created',
      resource: 'invoices', resourceId: invoiceId,
      payload: { uuid: complement.uuid, amount, paymentForm },
      ipAddress, userAgent,
    })

    return {
      facturapi_id:     complement.id,
      uuid:             complement.uuid,
      amount,
      payment_form:     paymentForm,
      verification_url: complement.verification_url,
      message:          'Complemento de pago timbrado exitosamente.',
    }
  })
}

/**
 * Timbra el CFDI tipo P en Facturapi e inserta en `payment_complements`,
 * SIN tocar AR ni ar_payments. Pensado para invocarse desde otros flujos
 * (p.ej. cxcService.registerPayment) que ya hacen ese trabajo. Trabaja
 * sobre el `client` de la transacción del llamador.
 */
async function stampPaymentComplement(client, {
  tenantId, invoiceId,
  paymentDate, paymentForm, amount, currency = 'MXN',
  reference, exchangeRate,
  userId,
}) {
  const { rows: invRows } = await client.query(
    `SELECT inv.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            bp.facturapi_id AS partner_facturapi_id,
            bp.tax_regime_code AS partner_tax_regime,
            bp.zip_code AS partner_zip_code
     FROM invoices inv
     JOIN business_partners bp ON bp.id = inv.partner_id
     WHERE inv.id = $1 AND inv.tenant_id = $2
       AND inv.status = 'stamped' AND inv.payment_method = 'PPD'`,
    [invoiceId, tenantId]
  )
  if (!invRows.length) throw createError(404, 'Factura PPD timbrada no encontrada.')
  const inv = invRows[0]

  const match = (inv.notes || '').match(/\[facturapi_id:([^\]]+)\]/)
  if (!match) throw createError(500, 'No se encontró el ID de Facturapi en la factura.')

  const facturapi = await getFacturapiForTenant(tenantId)
  const amountNum = parseFloat(amount)
  const taxRate   = 0.16
  const base      = parseFloat((amountNum / (1 + taxRate)).toFixed(2))

  const payload = {
    type: 'P',
    customer: inv.partner_facturapi_id || {
      legal_name: inv.partner_name.toUpperCase(),
      tax_id:     inv.partner_rfc,
      tax_system: inv.partner_tax_regime || '601',
      address: { zip: inv.partner_zip_code || '60000', country: 'MEX' },
    },
    complements: [
      {
        type: 'pago',
        data: {
          payment_form: paymentForm || '03',
          currency,
          exchange:     currency === 'USD' ? (exchangeRate || 1) : undefined,
          date:         paymentDate
            ? new Date(paymentDate + 'T12:00:00').toISOString()
            : new Date().toISOString(),
          related_documents: [
            {
              uuid:         inv.cfdi_uuid,
              installment:  1,
              last_balance: parseFloat(inv.total),
              amount:       amountNum,
              currency:     inv.currency,
              taxes: [{ base, type: 'IVA', rate: taxRate }],
            },
          ],
        },
      },
    ],
  }

  let complement
  try {
    complement = await facturapi.invoices.create(payload)
  } catch (err) {
    throw createError(422, `Error al timbrar complemento de pago de ${inv.document_number}: ${err.message}`)
  }

  const { rows: pcRows } = await client.query(
    `INSERT INTO payment_complements
       (tenant_id, invoice_id, facturapi_id, cfdi_uuid,
        payment_date, payment_form, amount, currency,
        reference, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'stamped',$10)
     RETURNING id`,
    [tenantId, invoiceId, complement.id, complement.uuid,
     paymentDate || new Date().toISOString().split('T')[0],
     paymentForm || '03', amount, currency,
     reference || null, userId]
  )

  return {
    id:           pcRows[0].id,    // id local en payment_complements (para ligar al cobro)
    facturapi_id: complement.id,
    uuid:         complement.uuid,
    invoice_id:   invoiceId,
    invoice_number: inv.document_number,
    amount:       amountNum,
  }
}

/**
 * Cancela un complemento de pago (CFDI tipo P) ante el SAT vía Facturapi y lo
 * marca `cancelled` en BD. Trabaja sobre el `client` de la transacción del
 * llamador (p.ej. cxcService.reversePayment) para que la cancelación y la
 * reversa del saldo sean atómicas. Idempotente: si ya está cancelado NO vuelve
 * a llamar a Facturapi.
 *
 * @param {string} motive - Motivo SAT de cancelación. Para complementos el
 *   correcto es '02' (comprobante emitido con errores SIN relación — los
 *   complementos de pago no se sustituyen).
 */
async function cancelComplement(client, { tenantId, complementId, motive = '02' }) {
  const { rows } = await client.query(
    `SELECT id, facturapi_id, cfdi_uuid, status
       FROM payment_complements
      WHERE id = $1 AND tenant_id = $2
      FOR UPDATE`,
    [complementId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Complemento de pago no encontrado.')
  const pc = rows[0]
  if (pc.status === 'cancelled') {
    return { alreadyCancelled: true, cfdi_uuid: pc.cfdi_uuid }
  }

  const facturapi = await getFacturapiForTenant(tenantId)
  try {
    await facturapi.invoices.cancel(pc.facturapi_id, { motive: motive || '02' })
  } catch (err) {
    throw createError(422,
      `Error al cancelar el complemento de pago ${pc.cfdi_uuid} ante el SAT: ${err.message}`)
  }

  await client.query(
    `UPDATE payment_complements SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2`,
    [pc.id, tenantId]
  )

  return { cancelled: true, cfdi_uuid: pc.cfdi_uuid, facturapi_id: pc.facturapi_id, motive: motive || '02' }
}

/**
 * Descarga el XML del complemento de pago desde Facturapi.
 * `tenantId` es requerido para resolver la API key correcta (prod/sandbox).
 */
async function downloadXML({ tenantId, complementFacurApiId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  return facturapi.invoices.downloadXml(complementFacurApiId)
}

/**
 * Descarga el PDF del complemento de pago desde Facturapi.
 */
async function downloadPDF({ tenantId, complementFacurApiId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  return facturapi.invoices.downloadPdf(complementFacurApiId)
}

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Envía un complemento de pago por correo (SMTP) con XML+PDF adjuntos.
 * Usa el correo institucional del tenant como BCC + reply-to.
 */
async function sendComplementByEmail({
  tenantId, complementId, emails, userId, ipAddress, userAgent,
}) {
  const { rows: pcRows } = await query(
    `SELECT pc.id, pc.facturapi_id, pc.cfdi_uuid, pc.amount, pc.currency,
            pc.payment_date, pc.payment_form, pc.reference,
            pc.invoice_id,
            inv.document_number AS invoice_number,
            inv.partner_id,
            bp.name      AS partner_name,
            bp.tax_name  AS partner_tax_name,
            tfi.razon_social AS emisor_nombre,
            t.name AS tenant_name
       FROM payment_complements pc
       JOIN invoices inv ON inv.id = pc.invoice_id
       JOIN business_partners bp ON bp.id = inv.partner_id
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = pc.tenant_id
       LEFT JOIN tenants t ON t.id = pc.tenant_id
      WHERE pc.id = $1 AND pc.tenant_id = $2`,
    [complementId, tenantId]
  )
  if (!pcRows.length) throw createError(404, 'Complemento no encontrado.')
  const pc = pcRows[0]

  // Destinatarios: si no llegan, usar contactos del cliente
  let recipients = Array.isArray(emails) ? emails.filter(Boolean) : []
  if (!recipients.length) {
    const { rows: contacts } = await query(
      `SELECT email FROM business_partner_contacts
        WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
        ORDER BY is_primary DESC NULLS LAST, id ASC`,
      [pc.partner_id]
    )
    recipients = contacts.map(r => r.email).filter(Boolean)
  }
  if (!recipients.length) {
    throw createError(400,
      'No se pudo determinar el destinatario: el cliente no tiene contactos con correo y no se especificaron correos en la solicitud.')
  }

  // Copia institucional (BCC) — tenants.notification_email o user.email
  let copyEmail = null
  const { rows: t } = await query(`SELECT notification_email FROM tenants WHERE id = $1`, [tenantId])
  if (t[0]?.notification_email) copyEmail = t[0].notification_email
  else if (userId) {
    const { rows: u } = await query(`SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, tenantId])
    copyEmail = u[0]?.email || null
  }
  if (copyEmail && recipients.includes(copyEmail)) copyEmail = null

  // Descargar XML+PDF de Facturapi y convertir a buffer
  const facturapi = await getFacturapiForTenant(tenantId)
  const [xmlStream, pdfStream] = await Promise.all([
    facturapi.invoices.downloadXml(pc.facturapi_id),
    facturapi.invoices.downloadPdf(pc.facturapi_id),
  ])
  const [xmlBuf, pdfBuf] = await Promise.all([
    streamToBuffer(xmlStream),
    streamToBuffer(pdfStream),
  ])

  const tenantDisplayName  = pc.emisor_nombre || pc.tenant_name || 'Emisor'
  const partnerDisplayName = pc.partner_tax_name || pc.partner_name || ''
  const dateStr = pc.payment_date ? new Date(pc.payment_date).toISOString().slice(0, 10) : ''
  const amountStr = new Intl.NumberFormat('es-MX',
    { style: 'currency', currency: pc.currency || 'MXN' }).format(parseFloat(pc.amount))

  const fileBase = `complemento-${pc.invoice_number}-${dateStr || pc.facturapi_id}`

  const html = `
    <p>Estimado(a) ${partnerDisplayName || 'cliente'}:</p>
    <p>Adjuntamos el complemento de pago (CFDI tipo P) timbrado el ${dateStr}
       correspondiente a la factura <strong>${pc.invoice_number}</strong>.</p>
    <ul>
      <li><strong>Monto:</strong> ${amountStr}</li>
      <li><strong>Forma de pago SAT:</strong> ${pc.payment_form}</li>
      ${pc.reference ? `<li><strong>Referencia:</strong> ${pc.reference}</li>` : ''}
      <li><strong>UUID:</strong> ${pc.cfdi_uuid}</li>
    </ul>
    <p>Quedamos atentos a cualquier aclaración.</p>
    <p>— ${tenantDisplayName}</p>
  `

  await enqueueEmail({
    tenantId,
    to:        recipients,
    bcc:       copyEmail || undefined,
    replyTo:   copyEmail || undefined,
    subject:   `Complemento de pago — Factura ${pc.invoice_number} — ${tenantDisplayName}`,
    html,
    fromName:  tenantDisplayName,
    attachments: [
      { filename: `${fileBase}.pdf`, content: pdfBuf, contentType: 'application/pdf' },
      { filename: `${fileBase}.xml`, content: xmlBuf, contentType: 'application/xml' },
    ],
  })

  await audit({
    tenantId, userId, action: 'payment_complement.sent_by_email',
    resource: 'payment_complements', resourceId: complementId,
    payload: { recipients, bcc: copyEmail, invoice_number: pc.invoice_number, uuid: pc.cfdi_uuid },
    ipAddress, userAgent,
  })

  return { sent: true, recipients, bcc: copyEmail, uuid: pc.cfdi_uuid }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  createPaymentComplement, stampPaymentComplement, cancelComplement,
  downloadXML, downloadPDF, sendComplementByEmail,
}