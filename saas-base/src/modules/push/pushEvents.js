'use strict'

/**
 * Catálogo de EVENTOS de negocio que disparan un push.
 *
 * Centraliza el copy (título/cuerpo/emoji por módulo), el enriquecimiento de
 * datos (cliente, monto, folio) y la AUDIENCIA dirigida de cada evento. Los
 * servicios de dominio (ventas, compras, producción, facturación) llaman a una
 * sola función de aquí post-commit — no conocen FCM ni RBAC.
 *
 * Reglas de diseño (acordadas 2026-06-04):
 *  - Dirigido por ROL (permiso), no "a todos". El owner/admin recibe todo gratis
 *    porque tiene todos los permisos.
 *  - El que EJECUTA la acción NO recibe el push de su propio acto (excludeUserIds).
 *  - Cada función es best-effort: nunca lanza (el caller la encadena con .catch()).
 *  - FCM solo muestra ~2 líneas → el detalle largo va en `data`, no en el body.
 *
 * Convención de emoji por hito: ✅ confirmar · 📦 remisión · 🚚 entrega ·
 * 🧾 factura · 🏭 producción · 📥 recepción · 🛒 OC · 👷 turno.
 */

const pushService = require('./pushService')
const { query } = require('../../db')
const logger = require('../../config/logger')

/**
 * Formatea un monto MXN: 4550 → "$4,550.00". Un monto AUSENTE (null/undefined/'')
 * devuelve null para OMITIR la parte del cuerpo; un 0 real sí se muestra ("$0.00").
 * (Number(null) === 0 es un footgun de JS — por eso el guard explícito.)
 */
function money(n) {
  if (n === null || n === undefined || n === '') return null
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Une las partes no vacías con " · " para el cuerpo de la notificación. */
function body(...parts) {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(' · ')
}

/**
 * Envoltura best-effort: corre el fetch+notify y se traga cualquier error para
 * que un fallo de push jamás tumbe el flujo de negocio que lo dispara.
 */
async function safe(label, fn) {
  try {
    await fn()
  } catch (err) {
    logger.warn(`[pushEvents] ${label} falló (ignorado)`, { error: err.message })
  }
}

// ─────────────────────────── VENTAS ───────────────────────────

/** Pedido de venta CONFIRMADO (draft → confirmed). Avisa a ventas. */
async function salesOrderConfirmed(tenantId, { orderId, actorUserId } = {}) {
  return safe('salesOrderConfirmed', async () => {
    const { rows } = await query(
      `SELECT so.order_number, so.total_mxn, bp.name AS partner
         FROM sales_orders so
         LEFT JOIN business_partners bp ON bp.id = so.partner_id
        WHERE so.id = $1 AND so.tenant_id = $2`,
      [orderId, tenantId]
    )
    const o = rows[0]
    if (!o) return
    await pushService.notify(tenantId, {
      audience: { permission: ['sales', 'read'] },
      excludeUserIds: [actorUserId],
      title: `✅ Pedido ${o.order_number} confirmado`,
      body: body(o.partner, money(o.total_mxn)),
      data: { type: 'sales_order.confirmed', orderId, route: `/ventas/${orderId}` },
    })
  })
}

/** Remisión CREADA. Avisa a facturación: queda lista para facturar. */
async function deliveryNoteCreated(tenantId, { noteId, actorUserId } = {}) {
  return safe('deliveryNoteCreated', async () => {
    const { rows } = await query(
      `SELECT dn.document_number, dn.total_mxn, bp.name AS partner
         FROM delivery_notes dn
         LEFT JOIN business_partners bp ON bp.id = dn.partner_id
        WHERE dn.id = $1 AND dn.tenant_id = $2`,
      [noteId, tenantId]
    )
    const n = rows[0]
    if (!n) return
    await pushService.notify(tenantId, {
      audience: { permission: ['invoicing', 'read'] },
      excludeUserIds: [actorUserId],
      title: `📦 Remisión ${n.document_number}`,
      body: body(n.partner, money(n.total_mxn), 'lista para facturar'),
      data: { type: 'delivery_note.created', noteId, route: `/remisiones/${noteId}` },
    })
  })
}

/** Entrega COMPLETADA con evidencia. Avisa a facturación + dueño del pedido. */
async function deliveryNoteDelivered(tenantId, { noteId, receiverName, actorUserId } = {}) {
  return safe('deliveryNoteDelivered', async () => {
    const { rows } = await query(
      `SELECT dn.document_number, bp.name AS partner, so.created_by AS order_owner
         FROM delivery_notes dn
         LEFT JOIN business_partners bp ON bp.id = dn.partner_id
         LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
        WHERE dn.id = $1 AND dn.tenant_id = $2`,
      [noteId, tenantId]
    )
    const n = rows[0]
    if (!n) return
    await pushService.notify(tenantId, {
      audiences: [
        { permission: ['invoicing', 'read'] },
        { userIds: [n.order_owner].filter(Boolean) },
      ],
      excludeUserIds: [actorUserId],
      title: `🚚 Entrega ${n.document_number}`,
      body: body(n.partner, receiverName ? `recibió ${receiverName}` : null),
      data: { type: 'delivery_note.delivered', noteId, route: `/remisiones/${noteId}` },
    })
  })
}

/** Factura TIMBRADA (CFDI). Avisa a facturación. */
async function invoiceStamped(tenantId, { invoiceId, actorUserId } = {}) {
  return safe('invoiceStamped', async () => {
    const { rows } = await query(
      `SELECT inv.document_number, inv.total_mxn, bp.name AS partner
         FROM invoices inv
         LEFT JOIN business_partners bp ON bp.id = inv.partner_id
        WHERE inv.id = $1 AND inv.tenant_id = $2`,
      [invoiceId, tenantId]
    )
    const inv = rows[0]
    if (!inv) return
    await pushService.notify(tenantId, {
      audience: { permission: ['invoicing', 'read'] },
      excludeUserIds: [actorUserId],
      title: `🧾 Factura ${inv.document_number} timbrada`,
      body: body(inv.partner, money(inv.total_mxn)),
      data: { type: 'invoice.stamped', invoiceId, route: `/facturacion/${invoiceId}` },
    })
  })
}

// ─────────────────────────── PRODUCCIÓN ───────────────────────────

/** Orden de producción CREADA. Avisa al piso (production:read_orders). */
async function productionOrderCreated(tenantId, { orderId, actorUserId } = {}) {
  return safe('productionOrderCreated', async () => {
    const { rows } = await query(
      `SELECT po.order_number, po.quantity_packages, p.name AS product_name
         FROM production_orders po
         LEFT JOIN products p ON p.id = po.product_id
        WHERE po.id = $1 AND po.tenant_id = $2`,
      [orderId, tenantId]
    )
    const o = rows[0]
    if (!o) return
    await pushService.notify(tenantId, {
      audience: { permission: ['production', 'read_orders'] },
      excludeUserIds: [actorUserId],
      title: `🏭 Nueva orden ${o.order_number}`,
      body: body(o.product_name, o.quantity_packages ? `${o.quantity_packages} paq` : null),
      data: { type: 'production_order.created', orderId, route: '/produccion/ordenes' },
    })
  })
}

/** Orden de producción COMPLETADA (cerrada). Avisa al piso. */
async function productionOrderCompleted(tenantId, { orderId, produced, target, isPartial, actorUserId } = {}) {
  return safe('productionOrderCompleted', async () => {
    const { rows } = await query(
      `SELECT po.order_number, p.name AS product_name
         FROM production_orders po
         LEFT JOIN products p ON p.id = po.product_id
        WHERE po.id = $1 AND po.tenant_id = $2`,
      [orderId, tenantId]
    )
    const o = rows[0]
    if (!o) return
    const progress = (target != null && produced != null) ? `${produced}/${target}` : null
    await pushService.notify(tenantId, {
      audience: { permission: ['production', 'read_orders'] },
      excludeUserIds: [actorUserId],
      title: `✅ Orden ${o.order_number} completada${isPartial ? ' (parcial)' : ''}`,
      body: body(o.product_name, progress),
      data: { type: 'production_order.completed', orderId, route: '/produccion/ordenes' },
    })
  })
}

/**
 * Turno/rol asignado. Avisa SOLO a los miembros asignados (userIds) — el caller
 * ya descontó a quien programó el turno.
 */
async function shiftAssigned(tenantId, { userIds, shiftNumber, scheduledDate, shiftId } = {}) {
  return safe('shiftAssigned', async () => {
    const ids = (userIds || []).filter(Boolean)
    if (!ids.length) return
    await pushService.notify(tenantId, {
      audience: { userIds: ids },
      title: '👷 Tienes un turno asignado',
      body: body(shiftNumber ? `Turno ${shiftNumber}` : null, scheduledDate),
      data: { type: 'shift.scheduled', shiftId, route: '/produccion/mis-turnos' },
    })
  })
}

// ─────────────────────────── COMPRAS ───────────────────────────

/** Orden de compra CREADA. Avisa a compras. */
async function purchaseOrderCreated(tenantId, { orderId, actorUserId } = {}) {
  return safe('purchaseOrderCreated', async () => {
    const { rows } = await query(
      `SELECT po.order_number, po.total_mxn, bp.name AS partner
         FROM purchase_orders po
         LEFT JOIN business_partners bp ON bp.id = po.partner_id
        WHERE po.id = $1 AND po.tenant_id = $2`,
      [orderId, tenantId]
    )
    const o = rows[0]
    if (!o) return
    await pushService.notify(tenantId, {
      audience: { permission: ['purchases', 'read'] },
      excludeUserIds: [actorUserId],
      title: `🛒 Nueva OC ${o.order_number}`,
      body: body(o.partner, money(o.total_mxn)),
      data: { type: 'purchase_order.created', orderId, route: '/compras/ordenes' },
    })
  })
}

/** Recepción VALIDADA (borrador → confirmada). Avisa a compras + dueño de la OC. */
async function receiptConfirmed(tenantId, { receiptId, actorUserId } = {}) {
  return safe('receiptConfirmed', async () => {
    const { rows } = await query(
      `SELECT sr.receipt_number, bp.name AS partner, po.created_by AS po_owner,
              (SELECT COUNT(*)::int FROM supplier_receipt_lines srl
                WHERE srl.supplier_receipt_id = sr.id) AS line_count
         FROM supplier_receipts sr
         LEFT JOIN business_partners bp ON bp.id = sr.partner_id
         LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
        WHERE sr.id = $1 AND sr.tenant_id = $2`,
      [receiptId, tenantId]
    )
    const r = rows[0]
    if (!r) return
    await pushService.notify(tenantId, {
      audiences: [
        { permission: ['purchases', 'read'] },
        { userIds: [r.po_owner].filter(Boolean) },
      ],
      excludeUserIds: [actorUserId],
      title: `📥 Recepción ${r.receipt_number} validada`,
      body: body(r.partner, r.line_count ? `${r.line_count} artículos` : null),
      data: { type: 'supplier_receipt.confirmed', receiptId, route: '/compras/recepciones' },
    })
  })
}

module.exports = {
  // ventas
  salesOrderConfirmed,
  deliveryNoteCreated,
  deliveryNoteDelivered,
  invoiceStamped,
  // producción
  productionOrderCreated,
  productionOrderCompleted,
  shiftAssigned,
  // compras
  purchaseOrderCreated,
  receiptConfirmed,
  // helpers expuestos para tests
  money,
  body,
}
