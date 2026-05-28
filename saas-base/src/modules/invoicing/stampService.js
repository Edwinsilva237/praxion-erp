'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const logger = require('../../config/logger')
const { getFacturapiForTenant } = require('./facturapiClient')
const { assertSubscriptionActive, assertCanStampInvoice } = require('../billing/enforcement')
const { validateAgainstSatCatalogs } = require('./satCatalogValidator')

/**
 * Timbra una factura en borrador usando Facturapi.
 * En sandbox: genera CFDI de prueba sin valor fiscal.
 * En producción: timbra real ante el SAT.
 */
async function stampInvoice({ tenantId, invoiceId, userId, ipAddress, userAgent }) {
  // Enforcement de billing ANTES de tocar Facturapi: si el tenant no está
  // suscrito o ya excedió el cap mensual, tiramos 402 sin gastar la llamada
  // al SAT (que es lenta y posiblemente cobrada).
  await assertSubscriptionActive(tenantId)
  await assertCanStampInvoice(tenantId)

  const stampResult = await withTransaction(async (client) => {
    // Obtener factura completa
    const { rows: invRows } = await client.query(
      `SELECT inv.*,
              bp.name AS partner_name,
              bp.tax_name AS partner_tax_name,
              bp.rfc AS partner_rfc,
              bp.tax_regime_code AS partner_tax_regime,
              bp.zip_code AS partner_zip_code,
              bp.facturapi_id AS partner_facturapi_id,
              tfi.rfc AS emisor_rfc, tfi.razon_social AS emisor_nombre,
              tfi.tax_regime AS emisor_regime, tfi.zip_code AS emisor_zip
       FROM invoices inv
       JOIN business_partners bp ON bp.id = inv.partner_id
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = inv.tenant_id
       WHERE inv.id = $1 AND inv.tenant_id = $2 AND inv.status = 'draft'`,
      [invoiceId, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Factura no encontrada o ya timbrada.')
    const inv = invRows[0]

    // Pre-validación de datos fiscales del receptor (CFDI 4.0).
    // Algunos clientes se crean con "captura rápida" (solo nombre + contacto)
    // para emitir remisiones. Al llegar la facturación los datos fiscales
    // pueden faltar — interceptamos antes de Facturapi para devolver un error
    // estructurado que el frontend interpreta y abre el form de completar datos.
    const missing = []
    if (!inv.partner_rfc)         missing.push({ field: 'rfc',           label: 'RFC' })
    if (!inv.partner_tax_name)    missing.push({ field: 'taxName',       label: 'Razón social fiscal' })
    if (!inv.partner_tax_regime)  missing.push({ field: 'taxRegimeCode', label: 'Régimen fiscal' })
    if (!inv.partner_zip_code)    missing.push({ field: 'zipCode',       label: 'C.P. fiscal' })
    if (missing.length) {
      const err = createError(422,
        `Faltan datos fiscales del receptor: ${missing.map(m => m.label).join(', ')}.`
      )
      err.code = 'MISSING_FISCAL_DATA'
      err.details = {
        partnerId:     inv.partner_id,
        partnerName:   inv.partner_name,
        missingFields: missing,
      }
      throw err
    }

    // Validación contra catálogos oficiales del SAT (mig 170). Bloquea antes
    // de gastar la llamada al PAC si hay datos invalidos: régimen incompatible
    // con persona física/moral, uso CFDI no permitido por el régimen del
    // receptor, forma/método de pago inexistente, etc. Estos son rechazos
    // típicos que el PAC reporta tarde y consumen timbres.
    const satErrors = await validateAgainstSatCatalogs(inv)
    if (satErrors.length) {
      const err = createError(422,
        `La factura tiene datos no válidos contra el catálogo del SAT: ${satErrors[0].message}`
      )
      err.code = 'SAT_CATALOG_VALIDATION_FAILED'
      err.details = { errors: satErrors }
      throw err
    }

    // Obtener líneas
    const { rows: lines } = await client.query(
      `SELECT il.*, p.sku, p.name AS product_name
       FROM invoice_lines il
       LEFT JOIN products p ON p.id = il.product_id
       WHERE il.invoice_id = $1
       ORDER BY il.line_number`,
      [invoiceId]
    )
    if (!lines.length) throw createError(400, 'La factura no tiene líneas.')

    // Inicializar Facturapi: el helper elige FACTURAPI_KEY o FACTURAPI_KEY_TEST
    // según si el tenant está marcado como sandbox.
    const facturapi = await getFacturapiForTenant(tenantId)

    // Payload base del cliente para Facturapi.
    // CFDI 4.0 exige razón social. Prioridad:
    //   1. receptor_legal_name (override por factura, p.ej. variación pedida por el cliente)
    //   2. business_partners.tax_name (razón social del catálogo)
    //   3. business_partners.name (nombre comercial — último recurso)
    const legalName = (inv.receptor_legal_name || inv.partner_tax_name || inv.partner_name || '').toUpperCase()
    const customerPayload = {
      legal_name: legalName,
      tax_id:     inv.partner_rfc,
      tax_system: inv.receptor_tax_regime || inv.partner_tax_regime || '601',
      address: {
        zip:     inv.receptor_zip_code || inv.partner_zip_code || '60000',
        country: 'MEX',
      },
    }

    // Registrar o recuperar cliente en Facturapi
    let facturCustomerId = inv.partner_facturapi_id
    if (facturCustomerId) {
      // Sincronizar datos si cambiaron en BD (razón social, RFC, etc.)
      try {
        await facturapi.customers.update(facturCustomerId, customerPayload)
      } catch (e) {
        // No bloquear el timbrado por un error de update — el customer ya
        // existe y los datos del CFDI vienen del invoice payload de abajo.
      }
    }
    if (!facturCustomerId) {
      try {
        const newCustomer = await facturapi.customers.create(customerPayload)
        facturCustomerId = newCustomer.id
        // Guardar facturapi_id en BD para futuros timbrados
        await client.query(
          'UPDATE business_partners SET facturapi_id = $1 WHERE id = $2',
          [facturCustomerId, inv.partner_id]
        )
      } catch (custErr) {
        // Si el RFC no es válido en Facturapi, buscar si ya existe
        const search = await facturapi.customers.list({ q: inv.partner_rfc })
        if (search.data && search.data.length > 0) {
          facturCustomerId = search.data[0].id
          await client.query(
            'UPDATE business_partners SET facturapi_id = $1 WHERE id = $2',
            [facturCustomerId, inv.partner_id]
          )
        } else {
          throw createError(422, `No se pudo registrar el cliente en Facturapi: ${custErr.message}`)
        }
      }
    }

    // Resolver remisiones origen para mostrar en el PDF.
    // Caso 1: factura de 1 remisión → invoices.delivery_note_id.
    // Caso 2: factura consolidada → AR de remisiones con marca
    //         "[Consolidada en factura X]" en notes (ver createFromRemissions).
    let remisionNumbers = []
    if (inv.delivery_note_id) {
      const { rows: dn } = await client.query(
        `SELECT document_number FROM delivery_notes WHERE id = $1`,
        [inv.delivery_note_id]
      )
      if (dn[0]) remisionNumbers = [dn[0].document_number]
    } else {
      const { rows: consolidated } = await client.query(
        `SELECT document_number FROM accounts_receivable
          WHERE tenant_id = $1
            AND document_type = 'remission'
            AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'
          ORDER BY document_number`,
        [tenantId, inv.document_number]
      )
      remisionNumbers = consolidated.map(r => r.document_number)
    }

    // Detectar TC efectivo (header USD o líneas revaluadas)
    let effectiveRate = null
    let effectiveRateDate = null
    let effectiveRateLabel = null
    if (inv.currency === 'USD' && inv.exchange_rate_value) {
      effectiveRate = parseFloat(inv.exchange_rate_value)
      effectiveRateLabel = 'Tipo de cambio'
    } else {
      const usdLine = lines.find(l =>
        l.original_currency === 'USD' && l.applied_exchange_rate
      )
      if (usdLine) {
        effectiveRate = parseFloat(usdLine.applied_exchange_rate)
        effectiveRateDate = usdLine.applied_exchange_rate_date || null
        effectiveRateLabel = 'TC aplicado a líneas USD'
      }
    }

    // Construir HTML para pdf_custom_section — solo incluye los bloques
    // que tienen contenido para no saturar el PDF.
    const pdfCustomSection = buildPdfCustomSection({
      poNumber:        inv.po_number,
      effectiveRate,
      effectiveRateDate,
      effectiveRateLabel,
      remisionNumbers,
      invoiceNotes:    cleanInvoiceNotes(inv.notes),
    })

    // Armar payload para Facturapi
    // external_id = invoiceId nuestro. Funciona como marker de búsqueda
    // post-mortem: si el proceso muere entre el invoices.create y el UPDATE
    // local, reconcileInvoice() puede encontrar la factura en Facturapi
    // por este campo sin volver a timbrar.
    const payload = {
      type: 'I',
      external_id: invoiceId,
      customer: facturCustomerId,
      items: lines.map(line => ({
        product: {
          description:  line.description,
          product_key:  line.sat_product_code || '44102305',
          unit_key:     line.sat_unit_code    || 'H87',
          unit_name:    line.unit             || 'Pieza',
          price:        parseFloat(line.unit_price),
          tax_included: false,
          taxes: [
            {
              type: 'IVA',
              rate: parseFloat(line.tax_rate || 16) / 100,
              factor: 'Tasa',
            },
          ],
        },
        quantity:     parseFloat(line.quantity),
        discount:     parseFloat(line.discount_pct || 0) / 100,
      })),
      payment_form:   inv.payment_form   || '03',
      payment_method: inv.payment_method || 'PUE',
      use:            inv.use_cfdi       || 'G01',
      currency:       inv.currency       || 'MXN',
      exchange:       inv.currency === 'USD' ? parseFloat(inv.exchange_rate_value) : undefined,
      export:         inv.exportacion    || '01',
      series:         inv.series         || 'F',
      folio_number:   parseInt(inv.folio || 1, 10),
    }
    if (pdfCustomSection) payload.pdf_custom_section = pdfCustomSection

    // Timbrar con Facturapi
    const logger = require('../../config/logger')
    logger.info('Facturapi payload', { payload: JSON.stringify(payload) })
    let facturInvoice
    try {
      facturInvoice = await facturapi.invoices.create(payload)
    } catch (facturErr) {
      const msg = facturErr?.message || 'Error al timbrar con Facturapi.'
      const detail = JSON.stringify(facturErr?.response?.data || facturErr?.body || {})
      throw createError(422, `Error de timbrado: ${msg} | ${detail}`)
    }

    // Actualizar factura en BD con datos del timbre
    const { rows: updated } = await client.query(
      `UPDATE invoices SET
         status           = 'stamped',
         cfdi_uuid        = $1,
         folio            = $2,
         stamp_date       = NOW()
       WHERE id = $3
       RETURNING *`,
      [facturInvoice.uuid, facturInvoice.folio_number?.toString(), invoiceId]
    )

    // Guardar facturapi_id en metadata para descargas futuras
    await client.query(
      `UPDATE invoices SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\n[facturapi_id:${facturInvoice.id}]`, invoiceId]
    )

    await audit({
      tenantId, userId, action: 'invoice.stamped',
      resource: 'invoices', resourceId: invoiceId,
      payload: { uuid: facturInvoice.uuid, folio: facturInvoice.folio_number },
      ipAddress, userAgent,
    })

    return {
      invoice:       updated[0],
      facturapi_id:  facturInvoice.id,
      uuid:          facturInvoice.uuid,
      folio:         facturInvoice.folio_number,
      verification_url: facturInvoice.verification_url,
      // Marcadores para el auto-send fuera de la transacción
      _autoSend: {
        partnerId: inv.partner_id,
      },
    }
  })

  // Auto-send fuera de la transacción: si el cliente tiene auto_send_invoice=true
  // y hay al menos un contacto con correo, disparamos sendByEmail. Cualquier error
  // se loguea pero NO rompe el resultado del timbrado.
  try {
    const autoSend = await maybeAutoSendStampedInvoice({
      tenantId, invoiceId,
      partnerId:   stampResult._autoSend.partnerId,
      facturapiId: stampResult.facturapi_id,
      userId, ipAddress, userAgent,
    })
    stampResult.autoSent = autoSend
  } catch (err) {
    logger.warn('Auto-send de factura falló', { invoiceId, error: err.message })
    stampResult.autoSent = { sent: false, error: err.message }
  }

  delete stampResult._autoSend
  return stampResult
}

/**
 * Si el cliente está marcado con auto_send_invoice=true, envía la factura
 * recién timbrada por Facturapi a sus contactos con correo.
 */
async function maybeAutoSendStampedInvoice({ tenantId, invoiceId, partnerId, facturapiId, userId, ipAddress, userAgent }) {
  const { rows: bpRows } = await query(
    `SELECT auto_send_invoice FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  if (!bpRows.length || !bpRows[0].auto_send_invoice) {
    return { sent: false, reason: 'auto_send_invoice=false' }
  }

  const { rows: contacts } = await query(
    `SELECT email FROM business_partner_contacts
      WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [partnerId]
  )
  const emails = contacts.map(r => r.email).filter(Boolean)
  if (!emails.length) {
    return { sent: false, reason: 'sin_contactos_con_email' }
  }

  // Incluir copia institucional (tenants.notification_email) o, si no está,
  // del usuario que timbró. Facturapi acepta un solo array de destinatarios.
  const copyEmail = await resolveCopyEmail({ tenantId, userId })
  if (copyEmail && !emails.includes(copyEmail)) emails.push(copyEmail)

  const facturapi = await getFacturapiForTenant(tenantId)
  await facturapi.invoices.sendByEmail(facturapiId, { email: emails })

  await audit({
    tenantId, userId, action: 'invoice.auto_sent_by_email',
    resource: 'invoices', resourceId: invoiceId,
    payload: { emails }, ipAddress, userAgent,
  })

  return { sent: true, emails }
}

/**
 * Descarga el XML timbrado desde Facturapi.
 */
async function downloadXML({ invoiceId, tenantId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  const facturApiId = await getFacturapiId(invoiceId, tenantId)
  const stream = await facturapi.invoices.downloadXml(facturApiId)
  return stream
}

/**
 * Descarga el PDF oficial desde Facturapi.
 */
async function downloadPDF({ invoiceId, tenantId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  const facturApiId = await getFacturapiId(invoiceId, tenantId)
  const stream = await facturapi.invoices.downloadPdf(facturApiId)
  return stream
}

/**
 * Sincroniza una factura local con su estado real en Facturapi/SAT.
 *
 * Casos detectados y resueltos:
 *   - Facturapi reporta 'canceled' pero local está 'stamped' → marca cancelled
 *     y revierte AR (mismo helper que cancelStampedInvoice).
 *   - Facturapi sigue 'valid' y local 'stamped' → no-op.
 *   - Facturapi reporta cancellation_status='pending' o 'verifying' → solo
 *     reporta sin cambiar nada (la cancelación está en trámite).
 *
 * Devuelve un resumen de qué cambió, útil para mostrarlo al usuario.
 */
async function syncInvoiceWithSAT({ tenantId, invoiceId, userId, ipAddress, userAgent }) {
  const facturapi = await getFacturapiForTenant(tenantId)

  const { rows } = await query(
    `SELECT id, document_number, status, cfdi_uuid, notes, delivery_note_id, total_mxn
       FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Factura no encontrada.')
  const local = rows[0]
  if (local.status === 'draft') {
    throw createError(400, 'Factura en borrador — no está en SAT todavía.')
  }
  const match = (local.notes || '').match(/\[facturapi_id:([^\]]+)\]/)
  if (!match) throw createError(500, 'No se encontró el ID de Facturapi en la factura.')
  const facturApiId = match[1]

  // Traer estado actual desde Facturapi
  let remote
  try {
    remote = await facturapi.invoices.retrieve(facturApiId)
  } catch (e) {
    throw createError(502, `Error consultando Facturapi: ${e.message}`)
  }

  const changes = []
  const remoteStatus = remote.status                  // 'valid' | 'canceled' | ...
  const remoteCancelStatus = remote.cancellation_status  // 'none' | 'pending' | 'accepted' | etc.

  // Caso 1: Facturapi dice cancelled, local sigue stamped → reconciliar.
  if (remoteStatus === 'canceled' && local.status !== 'cancelled') {
    await withTransaction(async (client) => {
      const { rows: invRows } = await client.query(
        `UPDATE invoices SET
           status = 'cancelled',
           cancellation_date = COALESCE($1, NOW()),
           cancellation_reason = COALESCE(cancellation_reason, $2)
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, document_number, delivery_note_id, total_mxn`,
        [remote.cancellation_status_date || null,
         remote.cancellation_motive || '02',
         invoiceId, tenantId]
      )
      const invoice = invRows[0]

      // Revertir AR siguiendo el mismo patrón de cancelStampedInvoice.
      if (invoice.delivery_note_id) {
        const { revertInvoiceArOnCancel } = require('./invoiceService')
        await revertInvoiceArOnCancel(client, { tenantId, invoice })
      } else {
        await client.query(
          `UPDATE accounts_receivable SET status = 'cancelled'
            WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
          [tenantId, invoiceId]
        )
        await client.query(
          `UPDATE accounts_receivable
              SET status = 'pending',
                  notes  = NULLIF(REPLACE(COALESCE(notes, ''), ' [Consolidada en factura ' || $2 || ']', ''), '')
            WHERE tenant_id = $1 AND document_type = 'remission'
              AND status = 'cancelled'
              AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'`,
          [tenantId, invoice.document_number]
        )
      }
    })
    changes.push({
      type: 'cancelled_in_sat',
      message: `Factura cancelada en SAT (motivo ${remote.cancellation_motive || '02'}). Local actualizado y AR revertido.`,
    })
  }

  // Caso 2: Facturapi dice valid pero local cancelled (raro — alguien reactivó).
  else if (remoteStatus === 'valid' && local.status === 'cancelled') {
    changes.push({
      type: 'local_cancelled_remote_valid',
      level: 'warning',
      message: `Local marca cancelada pero Facturapi reporta vigente. Requiere revisión manual.`,
    })
  }

  // Caso 3: Cancelación en trámite — solo informar.
  else if (remoteCancelStatus && ['pending', 'verifying'].includes(remoteCancelStatus)) {
    changes.push({
      type: 'cancellation_in_progress',
      level: 'info',
      message: `Cancelación en trámite ante SAT (${remoteCancelStatus}). Sin cambios locales.`,
    })
  }

  // Caso 4: Cancelación rechazada.
  else if (remoteCancelStatus === 'rejected') {
    changes.push({
      type: 'cancellation_rejected',
      level: 'warning',
      message: `SAT rechazó la cancelación. La factura sigue vigente.`,
    })
  }

  await audit({
    tenantId, userId, action: 'invoice.synced_sat',
    resource: 'invoices', resourceId: invoiceId,
    payload: { remoteStatus, remoteCancelStatus, changes },
    ipAddress, userAgent,
  })

  return {
    invoiceId,
    document_number: local.document_number,
    remoteStatus,
    remoteCancelStatus,
    changes,
    upToDate: changes.length === 0,
  }
}

/**
 * Descarga el acuse de cancelación SAT (prueba legal de cancelación) en PDF o XML.
 * Solo disponible para facturas ya canceladas ante el SAT.
 */
async function downloadCancellationReceipt({ invoiceId, tenantId, format }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  const { rows } = await query(
    `SELECT status, notes FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Factura no encontrada.')
  if (rows[0].status !== 'cancelled') {
    throw createError(400, 'La factura no está cancelada — no hay acuse disponible.')
  }
  const match = (rows[0].notes || '').match(/\[facturapi_id:([^\]]+)\]/)
  if (!match) throw createError(500, 'No se encontró el ID de Facturapi en la factura.')
  const facturApiId = match[1]

  const stream = format === 'xml'
    ? await facturapi.invoices.downloadCancellationReceiptXml(facturApiId)
    : await facturapi.invoices.downloadCancellationReceiptPdf(facturApiId)
  return stream
}

/**
 * Resuelve el correo de copia institucional:
 * - Prioridad: tenants.notification_email
 * - Fallback:  users.email del usuario operador
 */
async function resolveCopyEmail({ tenantId, userId }) {
  const { rows: t } = await query(
    `SELECT notification_email FROM tenants WHERE id = $1`,
    [tenantId]
  )
  if (t[0]?.notification_email) return t[0].notification_email
  if (!userId) return null
  const { rows: u } = await query(
    `SELECT email FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  )
  return u[0]?.email || null
}

/**
 * Envía la factura por correo desde Facturapi.
 * Si se pasa userId, se incluye el correo del usuario operador como copia
 * (Facturapi acepta un solo array de destinatarios; irá visible).
 */
async function sendByEmail({ invoiceId, tenantId, emails, userId }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  const facturApiId = await getFacturapiId(invoiceId, tenantId)

  const finalEmails = [...emails]
  const copyEmail = await resolveCopyEmail({ tenantId, userId })
  if (copyEmail && !finalEmails.includes(copyEmail)) finalEmails.push(copyEmail)

  await facturapi.invoices.sendByEmail(facturApiId, { email: finalEmails })
  return { sent: true, emails: finalEmails }
}

/**
 * Cancela una factura timbrada ante el SAT.
 */
async function cancelStampedInvoice({ tenantId, invoiceId, motive, substitution, userId, ipAddress, userAgent }) {
  const facturapi = await getFacturapiForTenant(tenantId)
  const facturApiId = await getFacturapiId(invoiceId, tenantId)

  const cancelPayload = { motive: motive || '02' }
  if (motive === '01' && substitution) {
    cancelPayload.substitution = substitution
  }

  await facturapi.invoices.cancel(facturApiId, cancelPayload)

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE invoices SET
         status = 'cancelled',
         cancellation_date = NOW(),
         cancellation_reason = $1
       WHERE id = $2 AND tenant_id = $3
       RETURNING id, document_number, delivery_note_id, total_mxn`,
      [motive || '02', invoiceId, tenantId]
    )
    if (!rows.length) throw createError(404, 'Factura no encontrada.')
    const invoice = rows[0]

    // Misma lógica de reversión de AR que cancelInvoice (draft).
    // Cliente recibió el material → la deuda persiste, solo cambia el
    // documento fiscal.
    if (invoice.delivery_note_id) {
      // Reusa el mismo helper de cancelInvoice para mantener una sola fuente
      // de verdad sobre cómo recalcular AR tras cancelación.
      const { revertInvoiceArOnCancel } = require('./invoiceService')
      await revertInvoiceArOnCancel(client, { tenantId, invoice })
    } else {
      // Factura directa o consolidada: cancelar AR de la factura.
      await client.query(
        `UPDATE accounts_receivable SET status = 'cancelled'
          WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
        [tenantId, invoiceId]
      )
      // Si era consolidada, reactivar AR de remisiones origen.
      await client.query(
        `UPDATE accounts_receivable
            SET status = 'pending',
                notes  = NULLIF(REPLACE(COALESCE(notes, ''), ' [Consolidada en factura ' || $2 || ']', ''), '')
          WHERE tenant_id = $1
            AND document_type = 'remission'
            AND status = 'cancelled'
            AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'`,
        [tenantId, invoice.document_number]
      )
    }

    await audit({
      tenantId, userId, action: 'invoice.cancelled_sat',
      resource: 'invoices', resourceId: invoiceId,
      payload: { motive, substitution },
      ipAddress, userAgent,
    })

    return { cancelled: true, motive }
  })
}

/**
 * Extrae el facturapi_id guardado en las notas de la factura.
 */
async function getFacturapiId(invoiceId, tenantId) {
  const { rows } = await query(
    `SELECT notes, cfdi_uuid, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Factura no encontrada.')
  if (rows[0].status === 'draft') throw createError(400, 'La factura aún no está timbrada.')

  const match = (rows[0].notes || '').match(/\[facturapi_id:([^\]]+)\]/)
  if (!match) throw createError(500, 'No se encontró el ID de Facturapi en la factura.')
  return match[1]
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Quita la marca interna `[facturapi_id:...]` que se anexa a invoices.notes
 * para que no aparezca en el PDF al cliente.
 */
function cleanInvoiceNotes(raw) {
  if (!raw) return null
  const cleaned = raw.replace(/\s*\[facturapi_id:[^\]]+\]\s*/g, '').trim()
  return cleaned || null
}

/**
 * Construye el HTML de pdf_custom_section con campos opcionales.
 * Devuelve null si ningún campo aplica para no inflar el PDF.
 */
function buildPdfCustomSection({
  poNumber, effectiveRate, effectiveRateDate, effectiveRateLabel,
  remisionNumbers = [], invoiceNotes,
}) {
  const rows = []

  if (poNumber) {
    rows.push(row('OC del cliente', escapeHtml(poNumber)))
  }
  if (effectiveRate) {
    let tcText = `$${effectiveRate.toFixed(4)} MXN/USD`
    if (effectiveRateDate) {
      const d = new Date(effectiveRateDate).toLocaleDateString('es-MX', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
      tcText += ` (${d})`
    }
    rows.push(row(effectiveRateLabel || 'Tipo de cambio', tcText))
  }
  if (remisionNumbers.length > 0) {
    const label = remisionNumbers.length === 1 ? 'Remisión origen' : 'Remisiones consolidadas'
    rows.push(row(label, escapeHtml(remisionNumbers.join(', '))))
  }
  if (invoiceNotes) {
    rows.push(row('Notas', escapeHtml(invoiceNotes).replace(/\n/g, '<br/>')))
  }

  if (rows.length === 0) return null

  return `
    <div style="margin-top:12px;padding:8px 10px;border:1px solid #d4d4d4;border-radius:4px;font-family:Arial,sans-serif;font-size:10px;color:#333">
      <table style="width:100%;border-collapse:collapse">
        ${rows.join('\n')}
      </table>
    </div>
  `.trim()
}

function row(label, value) {
  return `<tr>
    <td style="padding:3px 8px 3px 0;font-weight:bold;white-space:nowrap;vertical-align:top;width:1%">${label}:</td>
    <td style="padding:3px 0;vertical-align:top">${value}</td>
  </tr>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Reconcilia una factura que quedó en limbo: timbrada en Facturapi (porque
 * el SAT recibió el CFDI) pero todavía 'draft' en nuestra BD (porque el
 * proceso murió entre la respuesta de Facturapi y el UPDATE local).
 *
 * Busca en Facturapi por external_id = invoiceId. Si encuentra una factura:
 *   - Trae uuid, folio, facturapi_id.
 *   - Marca la local como 'stamped' con esos datos.
 * Si NO la encuentra, no hace nada (la factura simplemente nunca llegó a
 * timbrarse — el usuario puede reintentar con el botón normal de timbrar).
 *
 * Idempotente: llamarla 10 veces con la misma factura produce el mismo
 * resultado que llamarla una vez.
 */
async function reconcileInvoice({ tenantId, invoiceId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `SELECT id, status, document_number FROM invoices
      WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!rows.length) throw createError(404, 'Factura no encontrada.')
  const local = rows[0]

  // Si ya está timbrada o cancelada, no hay nada que reconciliar.
  if (local.status !== 'draft') {
    return {
      reconciled: false,
      reason:     `Factura ya está en estado '${local.status}'. Nada que reconciliar.`,
    }
  }

  // Buscar en Facturapi por external_id
  const facturapi = await getFacturapiForTenant(tenantId)
  let candidates
  try {
    candidates = await facturapi.invoices.list({ q: invoiceId, limit: 5 })
  } catch (e) {
    throw createError(502, `Error consultando Facturapi: ${e.message}`)
  }

  // `q` busca en varios campos. Filtramos a exact match en external_id.
  const match = (candidates?.data || []).find(inv => inv.external_id === invoiceId)
  if (!match) {
    return {
      reconciled: false,
      reason:     'No se encontró una factura en Facturapi con este ID. Vuelve a timbrar normalmente.',
    }
  }

  // Encontrada — importar los datos a local.
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE invoices SET
         status     = 'stamped',
         cfdi_uuid  = $1,
         folio      = $2,
         stamp_date = COALESCE(stamp_date, $3)
       WHERE id = $4`,
      [match.uuid, match.folio_number?.toString(), match.date || new Date(), invoiceId]
    )
    await client.query(
      `UPDATE invoices SET notes = COALESCE(notes, '') || $1 WHERE id = $2`,
      [`\n[facturapi_id:${match.id}]`, invoiceId]
    )
  })

  await audit({
    tenantId, userId, action: 'invoice.reconciled',
    resource: 'invoices', resourceId: invoiceId,
    payload: { uuid: match.uuid, folio: match.folio_number, facturapi_id: match.id },
    ipAddress, userAgent,
  })

  logger.info('[reconcile] factura reconciliada con Facturapi', {
    invoiceId, uuid: match.uuid,
  })

  return {
    reconciled:      true,
    uuid:            match.uuid,
    folio:           match.folio_number,
    facturapi_id:    match.id,
    verification_url: match.verification_url,
  }
}

module.exports = {
  stampInvoice,
  reconcileInvoice,
  downloadXML,
  downloadPDF,
  sendByEmail,
  cancelStampedInvoice,
  downloadCancellationReceipt,
  syncInvoiceWithSAT,
}