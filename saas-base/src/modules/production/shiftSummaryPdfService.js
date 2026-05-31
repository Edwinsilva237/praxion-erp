'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo } = require('../../utils/pdfBranding')

const STATUS_LABEL = {
  active: 'Activo', pending_handover: 'Pendiente', reviewed: 'Validado', cancelled: 'Cancelado',
}
const INCIDENT_LABEL = {
  paro_maquina: 'Paro de máquina', problema_mp: 'Problema de MP',
  cambio_orden: 'Cambio de orden', calidad: 'Calidad', otro: 'Otro',
}

const fmt  = (n, d = 2) => Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d })
const fmtN = (n) => Math.round(Number(n || 0)).toLocaleString('es-MX')

/**
 * PDF del resumen de un turno de producción, con branding del tenant (logo +
 * colores). NO recalcula nada: recibe el `summary` tal cual lo produce
 * `getShiftSummary` (misma fuente de verdad que la pantalla del histórico) y lo
 * pinta. Pensado para imprimir o compartir desde el histórico de turnos.
 *
 * @param {string} tenantId
 * @param {object} summary  resultado de productionService.getShiftSummary
 */
async function generateShiftSummaryPDF({ tenantId, summary }) {
  const { rows } = await query(
    `SELECT t.name AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary, t.logo_storage_path,
            tfi.razon_social AS emisor_nombre, tfi.rfc AS emisor_rfc
     FROM tenants t
     LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId]
  )
  const brand = rows[0] || {}
  const logoBuffer = await loadTenantLogo(brand.logo_storage_path)

  const { shift, production, materials, costs, incidents = [], formulaChanges = [], corrections = [], reception, forceClose } = summary
  const hasMeters = (production.totalMeters || 0) > 0

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER', bufferPages: true })
    const buffers = []
    doc.on('data', c => buffers.push(c))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const M = 40
    const W = doc.page.width - M * 2
    const RIGHT = M + W
    const BOTTOM = doc.page.height - 50 // margen para el footer Praxion
    const gris     = '#F5F5F5'
    const azul     = brand.brand_color_primary || '#5E9F32'
    const negro    = '#222222'
    const grisText = '#666666'

    let y = M

    // Salta de página si no caben `h` puntos más a partir de la posición actual.
    const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = M } }

    // Barra de título de sección (azul de marca).
    const band = (title) => {
      ensure(20)
      doc.rect(M, y, W, 16).fill(azul)
      doc.fillColor('white').fontSize(8.5).font('Helvetica-Bold').text(title, M + 5, y + 4)
      y += 16
    }

    // Fila etiqueta/valor dentro de una sección.
    const kv = (label, value, opts = {}) => {
      ensure(16)
      const { bold = false, color = negro, labelColor = grisText } = opts
      doc.fillColor(labelColor).fontSize(8.5).font('Helvetica').text(label, M + 6, y + 3, { width: W * 0.62 })
      doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(value, M + W * 0.62, y + 3, { width: W * 0.38 - 6, align: 'right' })
      y += 15
    }

    const sep = () => { doc.moveTo(M + 6, y + 1).lineTo(RIGHT - 6, y + 1).strokeColor('#E5E5E5').lineWidth(0.5).stroke(); y += 5 }

    // ─── ENCABEZADO ────────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(M, y, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)
    doc.fillColor('white').fontSize(17).font('Helvetica-Bold')
       .text(brand.emisor_nombre || brand.tenant_name || 'EMISOR', htx, y + 14, { width: W * 0.6 - (htx - 55) })
    if (brand.emisor_rfc) {
      doc.fontSize(9).font('Helvetica').text(`RFC: ${brand.emisor_rfc}`, htx, y + 38)
    }
    doc.fontSize(16).font('Helvetica-Bold')
       .text('RESUMEN DE TURNO', M + W * 0.45, y + 16, { width: W * 0.55 - 5, align: 'right' })
    doc.fontSize(10).font('Helvetica')
       .text(STATUS_LABEL[shift.status] || shift.status, M + W * 0.45, y + 40, { width: W * 0.55 - 5, align: 'right' })
    y += 82

    // ─── DATOS DEL TURNO ───────────────────────────────────────────
    const durationStr = shift.durationMin
      ? `${Math.floor(shift.durationMin / 60)}h ${shift.durationMin % 60}min`
      : '—'
    const shiftDateStr = shift.shiftDate
      ? new Date(shift.shiftDate).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : '—'
    band('DATOS DEL TURNO')
    doc.rect(M, y, W, 1).fill(gris)
    kv('Turno', `N.º ${shift.shiftNumber}`)
    kv('Fecha', shiftDateStr)
    kv('Línea', String(shift.lineId ?? '—'))
    kv('Operador', shift.operatorName || '—')
    if (shift.supervisorName) kv('Supervisor', shift.supervisorName)
    kv('Duración', durationStr)
    y += 8

    // ─── PRODUCCIÓN ────────────────────────────────────────────────
    band('PRODUCCIÓN')
    kv('Piezas buenas', `${fmtN(production.goodUnits)} pzas`)
    kv('Calidades menores / 2da', `${fmtN(production.secondUnits)} pzas`)
    if (hasMeters) kv('Metros producidos', `${fmt(production.totalMeters, 1)} m`)
    kv('Paquetes', String(production.totalPackages ?? 0))
    if (production.outOfRangePackages > 0)
      kv('Paquetes fuera de rango', `${production.outOfRangePackages} paq`, { color: '#A32D2D' })
    y += 8

    // Producción por orden
    if ((production.orderSummary || []).length > 0) {
      band(`PRODUCCIÓN POR ORDEN (${production.orderSummary.length})`)
      production.orderSummary.forEach(o => {
        const right = `${fmtN(o.units)} pzas${o.meters > 0 ? ` · ${fmt(o.meters, 1)} m` : ''}`
        kv(`${o.productName || o.orderNumber}  (${o.orderNumber})`, right)
      })
      y += 8
    }

    // ─── BALANCE DE MATERIA PRIMA ──────────────────────────────────
    band('BALANCE DE MATERIA PRIMA')
    kv('MP cargada total', `${fmt(materials.totalMpKg, 3)} kg`)
    kv('Peso en piezas buenas', `${fmt(materials.goodKg, 3)} kg`, { color: '#27500A' })
    kv('Peso calidades menores', `${fmt(materials.secondKg, 3)} kg`, { color: '#633806' })
    sep()
    kv('Merma (MP − producido)', `${fmt(materials.scrapKg, 3)} kg (${fmt(materials.scrapPct, 2)}%)`, {
      bold: true, color: materials.scrapPct > 5 ? '#A32D2D' : negro,
    })
    if (materials.scrapCapturedKg > 0)
      kv('Merma capturada (registrada)', `${fmt(materials.scrapCapturedKg, 3)} kg`)
    y += 8

    // ─── DESGLOSE DE COSTOS ────────────────────────────────────────
    const hasCosts = costs.avgCostPerKg > 0 || (costs.items || []).length > 0 || (costs.overheadItems || []).length > 0
    band('DESGLOSE DE COSTOS DEL TURNO')
    if (!hasCosts) {
      doc.fillColor(grisText).fontSize(8.5).font('Helvetica')
         .text('Sin costos registrados para este turno.', M + 6, y + 3, { width: W - 12 })
      y += 16
    } else {
      if (costs.avgCostPerKg > 0) {
        kv(`Materia prima (${fmt(costs.ptKg ?? costs.estimatedMpKg, 2)} kg × $${fmt(costs.avgCostPerKg, 4)}/kg)`,
           `$${fmt(costs.mpCostPT ?? costs.estimatedMpCost, 2)}`)
      }
      if (costs.mpCostScrap > 0) kv('Merma cargada al producto', `$${fmt(costs.mpCostScrap, 2)}`)
      if (costs.mpCostScrapLoss > 0)
        kv('Merma a pérdida del período (no carga al producto)', `$${fmt(costs.mpCostScrapLoss, 2)}`, { color: grisText })
      ;(costs.items || []).forEach(it => kv(it.name, `$${fmt(it.amount, 2)}`))
      ;(costs.overheadItems || []).forEach(it => kv(`${it.name} (gasto indirecto)`, `$${fmt(it.amount, 2)}`))
      if (costs.packagingCost > 0) kv('Empaque (receta)', `$${fmt(costs.packagingCost, 2)}`)
      sep()
      kv('Costo total del turno', `$${fmt(costs.totalCost, 2)}`, { bold: true, color: '#0C447C' })
      kv('Costo por pieza', `$${fmt(costs.costPerUnit, 4)}`, { bold: !hasMeters, color: '#0C447C' })
      if (hasMeters) kv('Costo por metro lineal', `$${fmt(costs.costPerMeter, 4)}`, { bold: true, color: '#0C447C' })
    }
    y += 8

    // ─── INCIDENCIAS ───────────────────────────────────────────────
    if (incidents.length > 0) {
      band(`INCIDENCIAS (${incidents.length})`)
      incidents.forEach(inc => {
        ensure(26)
        const head = INCIDENT_LABEL[inc.category] || inc.category || 'Incidencia'
        doc.fillColor(negro).fontSize(8.5).font('Helvetica-Bold').text(head, M + 6, y + 3, { width: W * 0.7 })
        if (inc.duration_min)
          doc.fillColor('#633806').font('Helvetica').text(`${inc.duration_min} min`, M + W * 0.7, y + 3, { width: W * 0.3 - 6, align: 'right' })
        y += 13
        if (inc.description) {
          doc.fillColor(grisText).fontSize(8).font('Helvetica')
          const h = doc.heightOfString(inc.description, { width: W - 12 })
          ensure(h + 4)
          doc.text(inc.description, M + 6, y, { width: W - 12 })
          y += h + 4
        }
      })
      y += 8
    }

    // ─── RECEPCIÓN / CIERRE FORZADO ────────────────────────────────
    if (forceClose || (reception && reception.accepted === false && reception.issueDescription)) {
      band('RECEPCIÓN DEL TURNO')
      if (forceClose) {
        kv('Cierre forzado por', `${forceClose.byName || 'Supervisor'}`, { color: '#A32D2D' })
        if (forceClose.reason) {
          doc.fillColor('#7A2222').fontSize(8).font('Helvetica-Oblique')
          const h = doc.heightOfString(`Motivo: ${forceClose.reason}`, { width: W - 12 })
          ensure(h + 4)
          doc.text(`Motivo: ${forceClose.reason}`, M + 6, y, { width: W - 12 })
          y += h + 4
        }
      }
      if (reception && reception.accepted === false && reception.issueDescription) {
        kv('Observaciones del entrante', reception.receivedByName || 'Operador', { color: '#633806' })
        doc.fillColor('#5B3608').fontSize(8).font('Helvetica-Oblique')
        const txt = `“${reception.issueDescription}”`
        const h = doc.heightOfString(txt, { width: W - 12 })
        ensure(h + 4)
        doc.text(txt, M + 6, y, { width: W - 12 })
        y += h + 4
      }
      y += 8
    }

    // ─── CAMBIOS DE FÓRMULA ────────────────────────────────────────
    if (formulaChanges.length > 0) {
      band(`CAMBIOS DE FÓRMULA (${formulaChanges.length})`)
      formulaChanges.forEach(fc => {
        ensure(24)
        const when = fc.changedAt ? new Date(fc.changedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : ''
        doc.fillColor(negro).fontSize(8.5).font('Helvetica-Bold').text(fc.changedByName || 'Usuario', M + 6, y + 3, { width: W * 0.6 })
        doc.fillColor(grisText).font('Helvetica').fontSize(8).text(when, M + W * 0.6, y + 3, { width: W * 0.4 - 6, align: 'right' })
        y += 13
        const fmtFormula = (arr) => (arr || []).map(m => `${m.material} ${parseFloat(m.percentage).toFixed(1)}%`).join(' · ')
        const line = `De: ${fmtFormula(fc.originalFormula)}  →  A: ${fmtFormula(fc.newFormula)}`
        doc.fillColor(negro).fontSize(8).font('Helvetica')
        const h = doc.heightOfString(line, { width: W - 12 })
        ensure(h + 4); doc.text(line, M + 6, y, { width: W - 12 }); y += h + 2
        if (fc.reason) {
          doc.fillColor(grisText).fontSize(8).font('Helvetica-Oblique')
          const hr = doc.heightOfString(`“${fc.reason}”`, { width: W - 12 })
          ensure(hr + 4); doc.text(`“${fc.reason}”`, M + 6, y, { width: W - 12 }); y += hr + 6
        }
      })
      y += 8
    }

    // ─── CORRECCIONES DEL SUPERVISOR ───────────────────────────────
    if (corrections.length > 0) {
      band(`CORRECCIONES DEL SUPERVISOR (${corrections.length})`)
      const TARGET = { shift_progress: 'paquete', shift_scrap: 'merma', shift_incidents: 'incidencia' }
      const ACTION = { update: 'editó', delete: 'eliminó', create: 'agregó' }
      corrections.forEach(c => {
        ensure(20)
        const when = c.correctedAt ? new Date(c.correctedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : ''
        const head = `${c.correctedByName || 'Usuario'} ${ACTION[c.action] || c.action} ${TARGET[c.targetType] || c.targetType}`
        doc.fillColor(negro).fontSize(8.5).font('Helvetica').text(head, M + 6, y + 3, { width: W * 0.7 })
        doc.fillColor(grisText).fontSize(8).text(when, M + W * 0.7, y + 3, { width: W * 0.3 - 6, align: 'right' })
        y += 13
        if (c.reason) {
          doc.fillColor(grisText).fontSize(8).font('Helvetica-Oblique')
          const h = doc.heightOfString(`“${c.reason}”`, { width: W - 12 })
          ensure(h + 4); doc.text(`“${c.reason}”`, M + 6, y, { width: W - 12 }); y += h + 4
        }
      })
      y += 8
    }

    // Marca de agua si el turno fue cancelado.
    if (shift.status === 'cancelled') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#DDDDDD').fontSize(60).font('Helvetica-Bold').opacity(0.3)
         .text('CANCELADO', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterAllPagesPDF(doc)
    doc.end()
  })
}

module.exports = { generateShiftSummaryPDF }
