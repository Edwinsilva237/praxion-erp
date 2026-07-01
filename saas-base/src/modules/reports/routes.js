'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard }      = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const requireModule      = require('../../middleware/requireModule')
const { query } = require('../../db')
const { generateAccountingWorkbook } = require('./accountingReport')
const { getFinancialSnapshot } = require('./financialSnapshot')
const { getSalesReport, getSalesDetail } = require('./salesReport')
const { generateSalesWorkbook } = require('./salesReportExcel')
const { generateSalesPdf } = require('./salesReportPdf')
const { getProductionReport } = require('./productionReport')
const { generateProductionWorkbook } = require('./productionReportExcel')
const { generateProductionPdf } = require('./productionReportPdf')
const { getInventoryReport } = require('./inventoryReport')
const { generateInventoryWorkbook } = require('./inventoryReportExcel')
const { generateInventoryPdf } = require('./inventoryReportPdf')
const { getAccountStatement, getPartnerStatement } = require('./accountStatementReport')
const { generateAccountStatementWorkbook } = require('./accountStatementExcel')
const { generateAccountStatementPdf } = require('./accountStatementPdf')
const { enqueueEmail } = require('../../queues/emailQueue')
const { audit } = require('../../utils/audit')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('reports'))

// Para account-statement el permiso depende de la dirección del estado:
// "cuentas-por-cobrar" → reports:cxc, "cuentas-por-pagar" → reports:cxp.
function reportsStatementPermission(req, res, next) {
  const dir = req.params.direction
  const action = dir === 'cuentas-por-cobrar' ? 'cxc'
               : dir === 'cuentas-por-pagar'  ? 'cxp'
               : null
  if (!action) return res.status(400).json({ error: 'direction inválida.' })
  return checkPermission('reports', action)(req, res, next)
}

/**
 * GET /api/reports/accounting?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Genera y descarga el reporte contable mensual en formato Excel multi-hoja.
 * - from: fecha inicial inclusiva
 * - to:   fecha final EXCLUSIVA
 */
router.get('/accounting',
  checkPermission('reports', 'accounting'),
  async (req, res, next) => {
    try {
      const { from, to, fiscalOnly } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'Parámetros from y to en formato YYYY-MM-DD requeridos.' })
      }
      if (from >= to) {
        return res.status(400).json({ error: '"from" debe ser anterior a "to".' })
      }
      // Default true: el reporte está pensado para el contador, donde solo
      // documentos con valor fiscal son relevantes.
      const fiscalOnlyFlag = fiscalOnly !== 'false'

      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`,
        [req.tenant.id]
      )
      const tenantName = rows[0]?.tenant_name || 'Empresa'

      const buffer = await generateAccountingWorkbook({
        tenantId: req.tenant.id,
        from, to, tenantName,
        fiscalOnly: fiscalOnlyFlag,
      })

      const filename = `reporte-contable-${from}-a-${to}.xlsx`
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(Buffer.from(buffer))
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/financial-snapshot?month=YYYY-MM
 * Snapshot en tiempo real del mes en curso (o el indicado).
 * Devuelve: ventas (facturadas vs sin factura) + IVA (trasladado, acreditable, neto).
 */
router.get('/financial-snapshot',
  checkPermission('reports', 'accounting'),
  async (req, res, next) => {
    try {
      const { month } = req.query
      if (month && !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month debe ser YYYY-MM.' })
      }
      const snap = await getFinancialSnapshot({ tenantId: req.tenant.id, month })
      res.json(snap)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de ventas con todas las vistas: por cliente, por producto (incluye
 * metros para esquineros), top clientes, alertas de margen negativo,
 * comparativa con periodo previo y tendencia semanal.
 */
router.get('/sales',
  checkPermission('reports', 'sales'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      if (from >= to) {
        return res.status(400).json({ error: '"from" debe ser anterior a "to".' })
      }
      const data = await getSalesReport({ tenantId: req.tenant.id, from, to })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/sales/excel?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de ventas en Excel multi-hoja para análisis financiero.
 */
router.get('/sales/excel',
  checkPermission('reports', 'sales'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`,
        [req.tenant.id]
      )
      const tenantName = rows[0]?.tenant_name || 'Empresa'
      const buffer = await generateSalesWorkbook({
        tenantId: req.tenant.id, from, to, tenantName,
      })
      const filename = `reporte-ventas-${from}-a-${to}.xlsx`
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(Buffer.from(buffer))
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/sales/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de ventas en PDF con diseño ejecutivo para socios.
 * Usa logo y colores del tenant cuando estén configurados.
 */
router.get('/sales/pdf',
  checkPermission('reports', 'sales'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      const buffer = await generateSalesPdf({
        tenantId: req.tenant.id, from, to,
      })
      const filename = `reporte-ventas-${from}-a-${to}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/sales/detail?type=customer|product&id=UUID&from=...&to=...
 * Detalle de facturas y remisiones para una fila clickeada en el reporte.
 */
router.get('/sales/detail',
  checkPermission('reports', 'sales'),
  async (req, res, next) => {
    try {
      const { type, id, from, to } = req.query
      if (!['customer', 'product'].includes(type)) {
        return res.status(400).json({ error: 'type debe ser customer o product.' })
      }
      if (!id) return res.status(400).json({ error: 'id requerido.' })
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      const data = await getSalesDetail({ tenantId: req.tenant.id, type, id, from, to })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/production?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de producción: por producto, por operador, mermas, costos, eficiencia
 * (teórico vs real), comparativa con periodo anterior y tendencia semanal.
 */
router.get('/production',
  checkPermission('reports', 'production'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      if (from >= to) {
        return res.status(400).json({ error: '"from" debe ser anterior a "to".' })
      }
      const data = await getProductionReport({ tenantId: req.tenant.id, from, to })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/production/excel?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de producción en Excel multi-hoja.
 */
router.get('/production/excel',
  checkPermission('reports', 'production'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`,
        [req.tenant.id]
      )
      const tenantName = rows[0]?.tenant_name || 'Empresa'
      const buffer = await generateProductionWorkbook({
        tenantId: req.tenant.id, from, to, tenantName,
      })
      const filename = `reporte-produccion-${from}-a-${to}.xlsx`
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(Buffer.from(buffer))
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/production/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Reporte de producción en PDF ejecutivo con marca del tenant.
 */
router.get('/production/pdf',
  checkPermission('reports', 'production'),
  async (req, res, next) => {
    try {
      const { from, to } = req.query
      if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'from y to en formato YYYY-MM-DD requeridos.' })
      }
      const buffer = await generateProductionPdf({
        tenantId: req.tenant.id, from, to,
      })
      const filename = `reporte-produccion-${from}-a-${to}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) { next(err) }
  }
)

// ─── Inventario — valor y existencias a la fecha o AL CIERRE DE MES ─────────
// ?countId=<uuid> → valuación reconstruida de la foto de ese conteo (month_close);
// sin countId → snapshot vivo a la fecha de hoy.
/** GET /api/reports/inventory — existencias y valor (JSON). */
router.get('/inventory',
  checkPermission('reports', 'inventory'),
  async (req, res, next) => {
    try {
      const data = await getInventoryReport({ tenantId: req.tenant.id, countId: req.query.countId || null })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/** GET /api/reports/inventory/excel — Excel multi-hoja del inventario. */
router.get('/inventory/excel',
  checkPermission('reports', 'inventory'),
  async (req, res, next) => {
    try {
      const countId = req.query.countId || null
      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`, [req.tenant.id])
      const tenantName = rows[0]?.tenant_name || 'Empresa'
      const buffer = await generateInventoryWorkbook({ tenantId: req.tenant.id, tenantName, countId })
      const stamp = new Date().toISOString().slice(0, 10)
      const suffix = countId ? 'cierre' : stamp
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="reporte-inventario-${suffix}.xlsx"`)
      res.send(Buffer.from(buffer))
    } catch (err) { next(err) }
  }
)

/** GET /api/reports/inventory/pdf — PDF ejecutivo con gráficos. */
router.get('/inventory/pdf',
  checkPermission('reports', 'inventory'),
  async (req, res, next) => {
    try {
      const countId = req.query.countId || null
      const buffer = await generateInventoryPdf({ tenantId: req.tenant.id, countId })
      const stamp = new Date().toISOString().slice(0, 10)
      const suffix = countId ? 'cierre' : stamp
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="reporte-inventario-${suffix}.pdf"`)
      res.send(buffer)
    } catch (err) { next(err) }
  }
)

// ─── Estado de cuenta — CXC / CXP ──────────────────────────────────────────
// :direction = 'cuentas-por-cobrar' | 'cuentas-por-pagar'
function mapStatementDirection(slug) {
  if (slug === 'cuentas-por-cobrar') return 'in'
  if (slug === 'cuentas-por-pagar')  return 'out'
  return null
}

function parseFilters(req) {
  const { partnerId, statusFilter, search } = req.query
  return {
    partnerId:    partnerId   || null,
    statusFilter: statusFilter || null, // overdue|due_soon|current|no_due
    search:       search       || null,
  }
}

/**
 * GET /api/reports/account-statement/:direction
 * Snapshot del estado de cuenta (todos los partners).
 * Query params opcionales: partnerId, statusFilter, search.
 */
router.get('/account-statement/:direction',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction debe ser cuentas-por-cobrar o cuentas-por-pagar.' })
      const data = await getAccountStatement({
        tenantId: req.tenant.id, direction, filters: parseFilters(req),
      })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/account-statement/:direction/excel
 * Excel con todos los registros (acepta los mismos filtros que el JSON).
 */
router.get('/account-statement/:direction/excel',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction inválida.' })
      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`,
        [req.tenant.id]
      )
      const tenantName = rows[0]?.tenant_name || 'Empresa'
      const buffer = await generateAccountStatementWorkbook({
        tenantId: req.tenant.id, tenantName, direction, filters: parseFilters(req),
      })
      const slug = direction === 'in' ? 'cuentas-por-cobrar' : 'cuentas-por-pagar'
      const filename = `${slug}-${new Date().toISOString().slice(0,10)}.xlsx`
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(Buffer.from(buffer))
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/account-statement/:direction/pdf
 * PDF ejecutivo general (para socios).
 */
router.get('/account-statement/:direction/pdf',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction inválida.' })
      const buffer = await generateAccountStatementPdf({
        tenantId: req.tenant.id, direction, mode: 'all',
        filters: parseFilters(req),
      })
      const slug = direction === 'in' ? 'cuentas-por-cobrar' : 'cuentas-por-pagar'
      const filename = `${slug}-${new Date().toISOString().slice(0,10)}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/account-statement/:direction/partners/:partnerId
 * Detalle del estado de cuenta para UN partner (JSON).
 */
router.get('/account-statement/:direction/partners/:partnerId',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction inválida.' })
      const data = await getPartnerStatement({
        tenantId: req.tenant.id, direction, partnerId: req.params.partnerId,
      })
      res.json(data)
    } catch (err) { next(err) }
  }
)

/**
 * GET /api/reports/account-statement/:direction/partners/:partnerId/pdf
 * PDF individual del partner (para enviar a cobranza).
 */
router.get('/account-statement/:direction/partners/:partnerId/pdf',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction inválida.' })
      const buffer = await generateAccountStatementPdf({
        tenantId: req.tenant.id, direction, mode: 'partner',
        partnerId: req.params.partnerId,
      })
      const filename = `estado-cuenta-${new Date().toISOString().slice(0,10)}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/reports/account-statement/:direction/partners/:partnerId/email
 * Envía el estado de cuenta del partner por correo. Body:
 *   { to: ['email1@...', 'email2@...'], cc, message }
 * Si no se especifica `to`, usa los contactos del partner que tengan email.
 */
router.post('/account-statement/:direction/partners/:partnerId/email',
  reportsStatementPermission,
  async (req, res, next) => {
    try {
      const direction = mapStatementDirection(req.params.direction)
      if (!direction) return res.status(400).json({ error: 'direction inválida.' })
      if (direction !== 'in') {
        return res.status(400).json({ error: 'Envío por correo solo aplica a cuentas por cobrar.' })
      }

      const data = await getPartnerStatement({
        tenantId: req.tenant.id, direction, partnerId: req.params.partnerId,
      })

      // Destinatarios: si vienen en el body los usa; si no, infiere de contactos.
      let recipients = Array.isArray(req.body?.to) ? req.body.to.filter(Boolean) : []
      if (recipients.length === 0) {
        recipients = data.contacts.filter(c => c.email).map(c => c.email)
      }
      if (recipients.length === 0) {
        return res.status(400).json({ error: 'No se encontraron destinatarios. Agrega un contacto con email al cliente.' })
      }

      const buffer = await generateAccountStatementPdf({
        tenantId: req.tenant.id, direction, mode: 'partner',
        partnerId: req.params.partnerId,
      })

      const { rows } = await query(
        `SELECT COALESCE(display_name, name) AS tenant_name FROM tenants WHERE id = $1`,
        [req.tenant.id]
      )
      const tenantName = rows[0]?.tenant_name || 'Su proveedor'
      const partnerName = data.partner.name
      const userMessage = (req.body?.message || '').trim()

      const subject = `Estado de cuenta — ${tenantName} · ${data.snapshot_date}`
      const html = buildStatementEmailHtml({
        tenantName, partnerName, snapshot: data.snapshot_date,
        summary: data.summary, userMessage,
      })

      await enqueueEmail({
        to: recipients,
        cc: req.body?.cc,
        subject,
        html,
        attachments: [{
          filename:    `estado-cuenta-${data.snapshot_date}.pdf`,
          content:     buffer,
          contentType: 'application/pdf',
        }],
      })

      try {
        await audit({
          tenantId: req.tenant.id,
          userId:   req.auth?.userId,
          action:   'account_statement.sent_by_email',
          resource: 'business_partners',
          resourceId: req.params.partnerId,
          payload:  { recipients, snapshot: data.snapshot_date },
        })
      } catch (_) { /* audit no debe romper el envío */ }

      res.json({ ok: true, recipients })
    } catch (err) { next(err) }
  }
)

function buildStatementEmailHtml({ tenantName, partnerName, snapshot, summary, userMessage }) {
  const fmt = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
  return `
    <div style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1F2937">
      <h2 style="color:#1F2937">Estado de cuenta — ${escapeHtml(tenantName)}</h2>
      <p>Estimad@ <strong>${escapeHtml(partnerName)}</strong>,</p>
      <p>Adjuntamos su estado de cuenta al <strong>${snapshot}</strong>. Resumen:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px;border-bottom:1px solid #E5E7EB">Pendiente total</td>
            <td style="padding:6px;border-bottom:1px solid #E5E7EB;text-align:right"><strong>${fmt(summary.total_pending_amount)}</strong></td></tr>
        <tr><td style="padding:6px;border-bottom:1px solid #E5E7EB;color:#991B1B">Vencido</td>
            <td style="padding:6px;border-bottom:1px solid #E5E7EB;text-align:right;color:#991B1B"><strong>${fmt(summary.overdue.amount)}</strong></td></tr>
        <tr><td style="padding:6px;border-bottom:1px solid #E5E7EB;color:#B45309">Próximo a vencer</td>
            <td style="padding:6px;border-bottom:1px solid #E5E7EB;text-align:right;color:#B45309"><strong>${fmt(summary.due_soon.amount)}</strong></td></tr>
        <tr><td style="padding:6px"><strong>Saldo neto</strong></td>
            <td style="padding:6px;text-align:right"><strong>${fmt(summary.net_balance)}</strong></td></tr>
      </table>
      ${userMessage ? `<p style="background:#F9FAFB;padding:12px;border-left:3px solid #5E9F32">${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>` : ''}
      <p>Cualquier discrepancia, favor de comunicarse para conciliación.</p>
      <p>Saludos cordiales,<br><strong>${escapeHtml(tenantName)}</strong></p>
    </div>
  `
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

module.exports = router
