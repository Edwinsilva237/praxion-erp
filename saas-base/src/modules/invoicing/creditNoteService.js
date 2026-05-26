'use strict'

const { query, withTransaction } = require('../../db')
const { audit }     = require('../../utils/audit')
const { getFacturapiForTenant } = require('./facturapiClient')

/**
 * Genera una nota de crédito (CFDI tipo E) vinculada a una factura timbrada.
 *
 * Casos de uso:
 * - Devolución total o parcial de mercancía
 * - Descuento aplicado después de facturar
 * - Corrección de precio
 *
 * @param {object} params
 * @param {string} params.invoiceId      - ID de la factura original en tu BD
 * @param {string} params.reason         - Motivo: 'return' | 'discount' | 'correction'
 * @param {string} params.description    - Descripción de la nota de crédito
 * @param {number} params.amount         - Monto de la nota (sin IVA)
 * @param {string} params.paymentForm    - Forma de pago: 03=transferencia, etc.
 * @param {string} params.relationship   - Tipo de relación SAT: '01'=nota de crédito (default)
 */
async function createCreditNote({
  tenantId, invoiceId,
  reason, description, amount, paymentForm,
  lines,
  relationship = '01',
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Obtener factura original timbrada
    const { rows: invRows } = await client.query(
      `SELECT inv.*,
              bp.name AS partner_name, bp.rfc AS partner_rfc,
              bp.facturapi_id AS partner_facturapi_id,
              bp.tax_regime_code AS partner_tax_regime,
              bp.zip_code AS partner_zip_code
       FROM invoices inv
       JOIN business_partners bp ON bp.id = inv.partner_id
       WHERE inv.id = $1 AND inv.tenant_id = $2
         AND inv.status = 'stamped'`,
      [invoiceId, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Factura timbrada no encontrada.')
    const inv = invRows[0]

    // Modo: por LÍNEAS (devolución de productos específicos) o por MONTO (descuento/corrección genérica)
    const byLines = Array.isArray(lines) && lines.length > 0
    let items
    let computedAmount

    if (byLines) {
      // Cargar las líneas de la factura origen referenciadas
      const ids = lines.map(l => l.invoiceLineId)
      const { rows: invLines } = await client.query(
        `SELECT id, description, quantity, unit, unit_price, discount_pct,
                tax_rate, sat_product_code, sat_unit_code
           FROM invoice_lines
          WHERE invoice_id = $1 AND id = ANY($2::uuid[])`,
        [invoiceId, ids]
      )
      const byId = Object.fromEntries(invLines.map(r => [r.id, r]))

      items = []
      let subtotal = 0
      for (const l of lines) {
        const orig = byId[l.invoiceLineId]
        if (!orig) throw createError(400, 'Una de las líneas no pertenece a la factura origen.')
        const qty  = parseFloat(l.quantity)
        if (!(qty > 0))                          throw createError(400, 'La cantidad debe ser mayor a cero.')
        if (qty > parseFloat(orig.quantity))     throw createError(400, `La cantidad excede la facturada (${orig.quantity} ${orig.unit}).`)

        const price = parseFloat(orig.unit_price)
        const disc  = parseFloat(orig.discount_pct || 0)
        const lineSubtotal = qty * price * (1 - disc / 100)
        subtotal += lineSubtotal

        items.push({
          product: {
            description:  orig.description,
            product_key:  orig.sat_product_code || '84111506',
            unit_key:     orig.sat_unit_code || 'H87',
            unit_name:    orig.unit || 'Pieza',
            price:        price,
            tax_included: false,
            taxes: [{ type: 'IVA', rate: parseFloat(orig.tax_rate || 16) / 100, factor: 'Tasa' }],
          },
          quantity: qty,
          discount: disc / 100,
        })
      }
      computedAmount = subtotal
    } else {
      if (!amount || parseFloat(amount) <= 0) throw createError(400, 'amount debe ser mayor a cero.')
      if (parseFloat(amount) > parseFloat(inv.total)) {
        throw createError(400, 'El monto de la nota no puede ser mayor al total de la factura.')
      }
      computedAmount = parseFloat(amount)
      items = [
        {
          product: {
            description:  description || reasonLabel(reason),
            product_key:  '84111506',
            unit_key:     'ACT',
            unit_name:    'Actividad',
            price:        computedAmount,
            tax_included: false,
            taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa' }],
          },
          quantity: 1,
        },
      ]
    }

    const facturapi = await getFacturapiForTenant(tenantId)

    // Payload para nota de crédito (CFDI tipo E)
    const payload = {
      type: 'E',
      customer: inv.partner_facturapi_id || {
        legal_name: inv.partner_name.toUpperCase(),
        tax_id:     inv.partner_rfc,
        tax_system: inv.partner_tax_regime || '601',
        address: { zip: inv.partner_zip_code || '60000', country: 'MEX' },
      },
      items,
      payment_form: paymentForm || '03',
      related_documents: [
        {
          relationship: relationship,
          documents:    [inv.cfdi_uuid],
        },
      ],
    }

    // Timbrar nota de crédito
    let creditNote
    try {
      creditNote = await facturapi.invoices.create(payload)
    } catch (err) {
      throw createError(422, `Error al timbrar nota de crédito: ${err.message}`)
    }

    // Guardar nota de crédito en BD. Sufijo secuencial por factura para
    // soportar varias NCs sobre la misma factura sin chocar con el UNIQUE
    // (tenant_id, document_number).
    const { rows: existingNcs } = await client.query(
      `SELECT COUNT(*)::int AS n FROM invoices
        WHERE tenant_id = $1 AND cfdi_type = 'E'
          AND document_number LIKE $2`,
      [tenantId, `NC-${inv.document_number}%`]
    )
    const ncSeq = (existingNcs[0]?.n || 0) + 1
    const docNumber = `NC-${inv.document_number}-${String(ncSeq).padStart(2, '0')}`
    const { rows: cnRows } = await client.query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, document_number,
          partner_id, currency, subtotal, tax_transferred, total, total_mxn,
          payment_form, use_cfdi, exportacion, lugar_expedicion,
          receptor_tax_regime, receptor_zip_code,
          status, cfdi_uuid, stamp_date, issue_date,
          notes, created_by)
       VALUES ($1,'issued','E',$2,$3,$4,$5,$6,$7,$7,$8,$9,'01',$10,$11,$12,'stamped',$13,NOW(),CURRENT_DATE,$14,$15)
       RETURNING id, document_number, cfdi_uuid`,
      [tenantId, docNumber, inv.partner_id,
       inv.currency,
       computedAmount,
       parseFloat((computedAmount * 0.16).toFixed(2)),
       parseFloat((computedAmount * 1.16).toFixed(2)),
       paymentForm || '03', 'G01',
       inv.lugar_expedicion,
       inv.receptor_tax_regime, inv.receptor_zip_code,
       creditNote.uuid,
       `Nota de crédito de ${inv.document_number} — ${reasonLabel(reason)}`,
       userId]
    )
    const cn = cnRows[0]

    // Guardar facturapi_id
    await client.query(
      `UPDATE invoices SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\n[facturapi_id:${creditNote.id}]`, cn.id]
    )

    // Actualizar CXC — sumar al amount_credited (no tocar amount_total). El
    // saldo cobrable lo recalcula la columna generada amount_pending. Decide
    // el nuevo status según el saldo resultante.
    const { rows: arRows } = await client.query(
      `SELECT id, amount_total, amount_paid, amount_credited
       FROM accounts_receivable
       WHERE tenant_id = $1 AND document_id = $2 AND status <> 'cancelled'`,
      [tenantId, invoiceId]
    )
    if (arRows.length > 0) {
      const ar = arRows[0]
      const reduction       = parseFloat((computedAmount * 1.16).toFixed(2))
      const newCredited     = parseFloat(ar.amount_credited || 0) + reduction
      const newPending      = parseFloat(ar.amount_total) - parseFloat(ar.amount_paid || 0) - newCredited
      const newStatus       = newPending <= 0.005
        ? 'paid'
        : (parseFloat(ar.amount_paid || 0) > 0 ? 'partial' : 'pending')
      await client.query(
        `UPDATE accounts_receivable SET amount_credited = $1, status = $2 WHERE id = $3`,
        [newCredited.toFixed(2), newStatus, ar.id]
      )
    }

    await audit({
      tenantId, userId, action: 'credit_note.created',
      resource: 'invoices', resourceId: invoiceId,
      payload: {
        uuid: creditNote.uuid, amount: computedAmount, reason,
        relatedInvoice: inv.document_number,
        mode: byLines ? 'by_lines' : 'by_amount',
        lineCount: byLines ? lines.length : null,
      },
      ipAddress, userAgent,
    })

    return {
      id:               cn.id,
      document_number:  cn.document_number,
      facturapi_id:     creditNote.id,
      uuid:             creditNote.uuid,
      amount:           computedAmount,
      total:            parseFloat((computedAmount * 1.16).toFixed(2)),
      reason,
      related_invoice:  inv.document_number,
      verification_url: creditNote.verification_url,
      message:          'Nota de crédito timbrada exitosamente.',
    }
  })
}

/**
 * Descarga XML de la nota de crédito desde Facturapi.
 * `tenantId` requerido para resolver la API key (prod vs sandbox).
 */
async function downloadXML({ tenantId, facturApiId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  return facturapi.invoices.downloadXml(facturApiId)
}

/**
 * Descarga PDF de la nota de crédito desde Facturapi.
 */
async function downloadPDF({ tenantId, facturApiId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  return facturapi.invoices.downloadPdf(facturApiId)
}

function reasonLabel(reason) {
  const labels = {
    return:     'Devolución de mercancía',
    discount:   'Descuento aplicado',
    correction: 'Corrección de precio',
  }
  return labels[reason] || reason || 'Nota de crédito'
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { createCreditNote, downloadXML, downloadPDF }
