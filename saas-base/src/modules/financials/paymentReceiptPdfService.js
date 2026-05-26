'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')

/**
 * Genera el PDF de un recibo de pago (representación impresa, NO fiscal).
 * Pensado para enviar al cliente como comprobante interno cuando paga
 * remisiones o facturas PUE (que no llevan complemento CFDI).
 *
 * Look-and-feel intencionalmente parecido al PDF de factura para que el
 * cliente reconozca la marca/estructura.
 */
async function generatePaymentReceiptPDF({ tenantId, paymentId }) {
  // ar_payment + AR + documento origen (factura o remisión) + emisor + receptor
  const { rows: pRows } = await query(
    `SELECT arp.id, arp.amount, arp.payment_method, arp.reference,
            arp.payment_date, arp.notes AS payment_notes, arp.created_at,
            arp.bank_account_id,
            u.full_name AS created_by_name,
            ba.bank_name, ba.alias AS bank_alias,
            ba.account_number AS bank_account_number, ba.clabe AS bank_clabe,
            ar.id AS ar_id, ar.document_type, ar.document_id,
            ar.document_number AS ar_document_number,
            ar.currency, ar.amount_total, ar.amount_paid, ar.amount_pending,
            ar.issue_date AS ar_issue_date, ar.due_date AS ar_due_date,
            bp.id AS partner_id, bp.name AS partner_name,
            bp.tax_name AS partner_tax_name,
            bp.rfc AS partner_rfc,
            bp.address AS partner_address, bp.city AS partner_city,
            bp.state AS partner_state, bp.zip_code AS partner_zip,
            tfi.rfc AS emisor_rfc,
            tfi.razon_social AS emisor_nombre,
            tfi.tax_regime AS emisor_regime,
            tfi.zip_code AS emisor_zip,
            t.name AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary
       FROM ar_payments arp
       JOIN accounts_receivable ar ON ar.id = arp.ar_id
       JOIN business_partners bp   ON bp.id = ar.partner_id
       LEFT JOIN bank_accounts ba  ON ba.id = arp.bank_account_id
       LEFT JOIN users u           ON u.id  = arp.created_by
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = arp.tenant_id
       LEFT JOIN tenants t         ON t.id = arp.tenant_id
      WHERE arp.id = $1 AND arp.tenant_id = $2`,
    [paymentId, tenantId]
  )
  if (!pRows.length) throw createError(404, 'Pago no encontrado.')
  const p = pRows[0]

  // Datos del documento origen (folio, fecha emisión) — el AR ya los tiene
  // pero traemos info adicional según tipo
  let docTypeLabel = 'Documento'
  if (p.document_type === 'invoice')   docTypeLabel = 'Factura'
  if (p.document_type === 'remission') docTypeLabel = 'Remisión'
  if (p.document_type === 'credit_note') docTypeLabel = 'Nota de crédito'

  // Saldo previo y nuevo (snapshot al momento del recibo)
  // amount_paid actual ya incluye este pago — el saldo previo es
  // amount_paid - this_payment_amount.
  const amountTotal     = parseFloat(p.amount_total)
  const amountPaidNow   = parseFloat(p.amount_paid)
  const thisAmount      = parseFloat(p.amount)
  const amountPaidPrev  = amountPaidNow - thisAmount
  const amountPendingNow = amountTotal - amountPaidNow

  // Folio interno del recibo: legible y único por pago.
  // Formato RP-YYYYMM-XXXXXX (últimos 6 chars del UUID).
  const dt = p.payment_date ? new Date(p.payment_date) : new Date()
  const ym = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}`
  const folio = `RP-${ym}-${p.id.slice(-6).toUpperCase()}`

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve({ buffer: Buffer.concat(buffers), folio }))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = p.brand_color_primary   || '#1A3A5C'
    const verde    = p.brand_color_secondary || '#2C7A4A'
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ──────────────────────────────────────────────
    doc.rect(40, 40, W, 70).fill(azul)
    // Izquierda: nombre + datos fiscales del emisor. Ancho 0.42W para
    // no chocar con el título "RECIBO DE PAGO" de la derecha.
    doc.fillColor('white').fontSize(15).font('Helvetica-Bold')
       .text(p.emisor_nombre || p.tenant_name || 'EMISOR', 55, 52, { width: W * 0.42 })
    doc.fontSize(9).font('Helvetica')
       .text(`RFC: ${p.emisor_rfc || ''}`, 55, 76, { width: W * 0.42 })
       .text(`Régimen: ${p.emisor_regime || ''}  |  CP: ${p.emisor_zip || ''}`,
             55, 88, { width: W * 0.42 })

    // Posicionamos la columna derecha con margen interior de 15pt al borde
    // del rect azul (en lugar de calcular con porcentajes que se desfasaban
    // por la métrica real del font). fontSize 16 deja holgura para "RECIBO
    // DE PAGO" sin que la O se desborde.
    const padR    = 15
    const rightW  = 220
    const rightX  = 40 + W - rightW - padR
    doc.fontSize(16).font('Helvetica-Bold')
       .text('RECIBO DE PAGO', rightX, 54, { width: rightW, align: 'right' })
    doc.fontSize(10).font('Helvetica')
       .text(folio, rightX, 76, { width: rightW, align: 'right' })
    doc.fontSize(8).fillColor('#CCCCCC')
       .text('Documento de control interno', rightX, 92,
             { width: rightW, align: 'right' })

    // ─── DATOS DEL PAGO ──────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DEL PAGO', 40, y)

    y += 14
    const dataBoxH = 64
    doc.rect(40, y, W, dataBoxH).fill(gris)

    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha del pago:', col1, y + 5)
    doc.text('Método de pago:', col2, y + 5)
    doc.text('Referencia:',     col3, y + 5)
    doc.text('Moneda:',         col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    doc.text(dt.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }),
             col1, y + 17)
    doc.text(METODOS[p.payment_method] || p.payment_method || '-', col2, y + 17)
    doc.text(p.reference || '—', col3, y + 17, { width: col4 - col3 - 5 })
    doc.text(p.currency || 'MXN', col4, y + 17)

    doc.fillColor(grisText).font('Helvetica')
    doc.text('Banco receptor:',  col1, y + 33)
    doc.text('No. cuenta:',      col2, y + 33)
    doc.text('Folio recibo:',    col3, y + 33)
    doc.text('Registró:',        col4, y + 33)

    doc.fillColor(negro).font('Helvetica-Bold')
    const bancoStr = p.bank_name
      ? `${p.bank_name}${p.bank_alias ? ` · ${p.bank_alias}` : ''}`
      : '—'
    doc.text(bancoStr, col1, y + 45, { width: col2 - col1 - 5 })
    doc.text(p.bank_account_number || p.bank_clabe || '—', col2, y + 45,
             { width: col3 - col2 - 5 })
    doc.text(folio, col3, y + 45, { width: col4 - col3 - 5 })
    doc.text(p.created_by_name || '—', col4, y + 45, { width: W - (col4 - 40) - 10 })

    // ─── EMISOR / RECEPTOR ──────────────────────────────────────
    y += dataBoxH + 12
    const halfW = (W - 10) / 2

    doc.rect(40, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('EMISOR (recibe)', 45, y + 3)
    doc.rect(40, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(p.emisor_nombre || p.tenant_name || '', 45, y + 18,
             { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${p.emisor_rfc || ''}`, 45, y + 30)
       .text(`Régimen: ${p.emisor_regime || ''}`, 45, y + 41)
       .text(`CP: ${p.emisor_zip || ''}`, 45, y + 52)

    const rx = 40 + halfW + 10
    doc.rect(rx, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('RECEPTOR (pagador)', rx + 5, y + 3)
    doc.rect(rx, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(p.partner_tax_name || p.partner_name || '', rx + 5, y + 18,
             { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${p.partner_rfc || ''}`, rx + 5, y + 30)
    // Línea de plaza: ciudad, estado, CP (sin la calle larga que rebasaba
    // el bloque y se encimaba con el CP de abajo).
    const plaza = [p.partner_city, p.partner_state].filter(Boolean).join(', ')
       || '—'
    doc.text(plaza, rx + 5, y + 41, { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.text(`CP: ${p.partner_zip || '—'}`, rx + 5, y + 52)

    // ─── DOCUMENTO COBRADO ──────────────────────────────────────
    y += 82
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DOCUMENTO AL QUE SE APLICA EL PAGO', 40, y)

    y += 14
    doc.rect(40, y, W, 16).fill(azul)
    doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
    // Suma = 520 (≤ W=532). El padding interno desde 45 deja 5pt al borde
    // derecho. Antes sumaba 615 y se cortaba ~80pt de "Aplicado/Saldo".
    const cw = { tipo: 65, folio: 90, fecha: 60, total: 75, prev: 75, aplic: 75, rest: 75 }
    let cx = 45
    doc.text('Tipo',           cx, y + 4, { width: cw.tipo });   cx += cw.tipo
    doc.text('Folio',          cx, y + 4, { width: cw.folio });  cx += cw.folio
    doc.text('Fecha',          cx, y + 4, { width: cw.fecha });  cx += cw.fecha
    doc.text('Total doc.',     cx, y + 4, { width: cw.total, align: 'right' }); cx += cw.total
    doc.text('Saldo previo',   cx, y + 4, { width: cw.prev,  align: 'right' }); cx += cw.prev
    doc.text('Aplicado',       cx, y + 4, { width: cw.aplic, align: 'right' }); cx += cw.aplic
    doc.text('Saldo restante', cx, y + 4, { width: cw.rest,  align: 'right' })

    y += 16
    doc.rect(40, y, W, 20).fill('white')
    doc.fillColor(negro).fontSize(8).font('Helvetica')
    cx = 45
    doc.text(docTypeLabel, cx, y + 6, { width: cw.tipo }); cx += cw.tipo
    doc.font('Helvetica-Bold')
       .text(p.ar_document_number, cx, y + 6, { width: cw.folio }); cx += cw.folio
    doc.font('Helvetica')
       .text(new Date(p.ar_issue_date).toLocaleDateString('es-MX',
             { day: '2-digit', month: '2-digit', year: 'numeric' }),
             cx, y + 6, { width: cw.fecha }); cx += cw.fecha
    doc.text(fmt(amountTotal),       cx, y + 6, { width: cw.total, align: 'right' }); cx += cw.total
    doc.text(fmt(amountPaidPrev),    cx, y + 6, { width: cw.prev,  align: 'right' }); cx += cw.prev
    doc.font('Helvetica-Bold').fillColor(verde)
       .text(fmt(thisAmount),        cx, y + 6, { width: cw.aplic, align: 'right' }); cx += cw.aplic
    doc.fillColor(negro).font('Helvetica')
       .text(fmt(amountPendingNow),  cx, y + 6, { width: cw.rest,  align: 'right' })

    // ─── TOTAL APLICADO ─────────────────────────────────────────
    y += 32
    const tw = 220
    const tx = 40 + W - tw

    doc.rect(tx - 5, y, tw + 5, 28).fill(azul)
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('TOTAL RECIBIDO', tx, y + 9, { width: tw * 0.5 })
       .text(`${p.currency || 'MXN'} ${fmt(thisAmount)}`,
             tx + tw * 0.5, y + 9, { width: tw * 0.5 - 5, align: 'right' })

    // Importe en letras
    y += 35
    doc.fillColor(grisText).fontSize(8).font('Helvetica-Oblique')
       .text(`Importe en letras: ${numeroALetras(thisAmount, p.currency || 'MXN')}`,
             40, y, { width: W })

    // ─── ESTADO DE CUENTA RESUMEN ──────────────────────────────
    y += 20
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('ESTADO DE CUENTA DEL DOCUMENTO', 40, y)
    y += 12
    const sumRows = [
      ['Total documento',  fmt(amountTotal)],
      ['Cobrado acumulado', fmt(amountPaidNow)],
      [amountPendingNow > 0.01 ? 'Saldo pendiente' : 'PAGADO TOTALMENTE',
        fmt(Math.max(amountPendingNow, 0))],
    ]
    const sumX = 40 + W - 220
    sumRows.forEach(([label, val], i) => {
      const isLast = i === sumRows.length - 1
      const cleared = amountPendingNow <= 0.01 && isLast
      doc.fillColor(cleared ? verde : grisText).fontSize(8)
         .font(isLast ? 'Helvetica-Bold' : 'Helvetica')
         .text(label, sumX, y, { width: 110 })
      doc.fillColor(cleared ? verde : negro)
         .font(isLast ? 'Helvetica-Bold' : 'Helvetica')
         .text(val, sumX + 110, y, { width: 105, align: 'right' })
      y += 13
    })

    // ─── NOTAS DEL PAGO ────────────────────────────────────────
    if (p.payment_notes) {
      y += 10
      doc.rect(40, y, W, 14).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('NOTAS DEL PAGO', 45, y + 3)
      y += 14
      const notesH = Math.max(20, Math.ceil(p.payment_notes.length / 110) * 12 + 8)
      doc.rect(40, y, W, notesH).fill(gris)
      doc.fillColor(negro).fontSize(8).font('Helvetica')
         .text(p.payment_notes, 50, y + 5, { width: W - 20 })
      y += notesH
    }

    // ─── PIE ────────────────────────────────────────────────────
    y += 25
    doc.fillColor(grisText).fontSize(7).font('Helvetica-Oblique')
       .text('Este recibo es un documento de control interno y NO TIENE EFECTOS FISCALES. ' +
             'No sustituye al CFDI correspondiente.',
             40, y, { width: W, align: 'center' })

    addPraxionFooterPDF(doc)
    doc.end()
  })
}

// ── Catálogos ─────────────────────────────────────────────────────────────
const METODOS = {
  cash:                'Efectivo',
  transfer:            'Transferencia',
  check:               'Cheque',
  advance_application: 'Aplicación de anticipo',
  credit_note:         'Nota de crédito',
}

const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── Conversión de número a letras (estilo SAT) ───────────────────────────
function numeroALetras(num, moneda = 'MXN') {
  const entero    = Math.floor(num)
  const centavos  = Math.round((num - entero) * 100)
  const monedaTxt = moneda === 'USD' ? 'DÓLARES' : 'PESOS'
  const sufijo    = moneda === 'USD' ? 'USD' : 'M.N.'
  const letras    = enteroALetras(entero)
  return `${letras} ${monedaTxt} ${String(centavos).padStart(2, '0')}/100 ${sufijo}`
}

function enteroALetras(n) {
  if (n === 0) return 'CERO'
  if (n === 1) return 'UN'
  const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
                    'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE',
                    'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE',
                    'VEINTE']
  const DECENAS = ['', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA',
                   'SETENTA', 'OCHENTA', 'NOVENTA']
  const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS',
                    'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']

  function decenasFn(n) {
    if (n <= 20) return UNIDADES[n]
    if (n < 30) return n === 20 ? 'VEINTE' : `VEINTI${UNIDADES[n - 20]}`
    const dec = Math.floor(n / 10)
    const uni = n % 10
    return uni === 0 ? DECENAS[dec] : `${DECENAS[dec]} Y ${UNIDADES[uni]}`
  }
  function centenasFn(n) {
    if (n === 100) return 'CIEN'
    const cen = Math.floor(n / 100)
    const resto = n % 100
    return resto === 0 ? CENTENAS[cen] : `${CENTENAS[cen]} ${decenasFn(resto)}`
  }
  function milesFn(n) {
    if (n < 1000) return centenasFn(n)
    const mil = Math.floor(n / 1000)
    const resto = n % 1000
    const prefijo = mil === 1 ? 'MIL' : `${centenasFn(mil)} MIL`
    return resto === 0 ? prefijo : `${prefijo} ${centenasFn(resto)}`
  }
  function millonesFn(n) {
    if (n < 1000000) return milesFn(n)
    const mill = Math.floor(n / 1000000)
    const resto = n % 1000000
    const prefijo = mill === 1 ? 'UN MILLÓN' : `${milesFn(mill)} MILLONES`
    return resto === 0 ? prefijo : `${prefijo} ${milesFn(resto)}`
  }
  return millonesFn(n).trim()
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generatePaymentReceiptPDF }
