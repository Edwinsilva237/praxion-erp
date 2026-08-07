'use strict'

/**
 * Seed de tenant DEMO "Empacadora San Lorenzo" — perfil compras + almacén.
 *
 * Caso de venta: empresa (empacadora de aguacate) que lleva su producción en
 * OTRO sistema y usa el ERP solo como apoyo administrativo del departamento
 * de compras y almacén. Sin ventas: las salidas son vales de consumo a áreas.
 *
 * Qué crea:
 *   - Tenant `demo-empacadora` (is_sandbox=TRUE) con módulos production/sales/
 *     quotations/invoicing APAGADOS (quedan: compras+CxP, inventario, reportes,
 *     caja chica, gastos, comunicados).
 *   - 3 almacenes: Almacén principal, Almacén de mantenimiento, Oficinas.
 *     (Se eliminan los almacenes default de embalaje/PT/WIP y se desactivan
 *     los tipos de almacén productivos del catálogo.)
 *   - 7 áreas de consumo, 8 proveedores, ~28 insumos.
 *   - ~6 semanas de historia: 8 OCs en varios estados, recepciones confirmadas
 *     (una parcial y una directa sin OC), comprobantes con CxP (pagadas,
 *     por vencer, vencida, pago parcial), 6 vales de salida, caja chica con
 *     movimientos y plantillas de comunicados.
 *
 * Todo se crea VÍA LOS SERVICES reales (movimientos de inventario, kardex,
 * costos promedio y CxP quedan consistentes). Después de cada documento se
 * retro-fechan created_at / fechas de negocio por SQL para que el demo
 * muestre historia y no todo con fecha de hoy.
 *
 * Uso local:
 *   node scripts/seed-demo-empacadora.js
 * Re-sembrar desde cero (BORRA el tenant demo, protegido por is_sandbox):
 *   FRESH=1 node scripts/seed-demo-empacadora.js        (bash)
 *   $env:FRESH="1"; node scripts/seed-demo-empacadora.js  (PowerShell)
 * En producción: correr igual desde Render Shell del servicio praxion-api.
 *
 * Idempotencia: si el tenant ya existe y tiene OCs, el script aborta para no
 * duplicar la historia (usa FRESH=1 para regenerar).
 */

require('dotenv').config()

// Soporte DATABASE_URL (mismo patrón que copy-catalog.js) por si se corre
// contra una URL completa en lugar de variables sueltas.
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL)
  process.env.DB_HOST = u.hostname
  process.env.DB_PORT = u.port || '5432'
  process.env.DB_NAME = u.pathname.replace(/^\//, '')
  process.env.DB_USER = decodeURIComponent(u.username)
  process.env.DB_PASSWORD = decodeURIComponent(u.password)
  process.env.NODE_ENV = process.env.NODE_ENV || 'production'
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'seed-demo-script-dummy-secret-not-used-0123456789'
  }
}

const { pool, query, withBypass } = require('../src/db')
const tenantService     = require('../src/modules/tenants/tenantService')
const partnerService    = require('../src/modules/business-partners/partnerService')
const rawMaterialSvc    = require('../src/modules/raw-materials/rawMaterialService')
const poService         = require('../src/modules/purchases/purchaseOrderService')
const receiptService    = require('../src/modules/purchases/supplierReceiptService')
const invoiceService    = require('../src/modules/purchases/supplierInvoiceService')
const voucherService    = require('../src/modules/inventory/consumptionVoucherService')
const warehouseService  = require('../src/modules/inventory/warehouseService')
const pettyCashService  = require('../src/modules/pettyCash/pettyCashService')
const commsService      = require('../src/modules/communications/communicationsService')

const SLUG        = 'demo-empacadora'
const NAME        = 'Empacadora San Lorenzo'
const ADMIN_EMAIL = 'demo.empacadora@praxionops.com'
const ADMIN_NAME  = 'Administración Demo'
const ADMIN_PASS  = process.env.DEMO_ADMIN_PASSWORD || 'DemoEmpacadora!2026'
const FRESH       = process.env.FRESH === '1'

const log  = (...a) => console.log(...a)
const ok   = (m) => console.log('  ✓', m)
const skip = (m) => console.log('  ⊘', m)
const fail = (m, extra) => { console.error('  ✗', m); if (extra) console.error('   ', extra); process.exit(1) }

// Fecha "hace N días" (medianoche local, formato YYYY-MM-DD para columnas DATE)
function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}
function dateStr(n) {
  const d = daysAgo(n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ─── Retro-fechado ────────────────────────────────────────────────────────

async function backdate(table, id, cols, n) {
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
  const vals = cols.map(() => daysAgo(n))
  await withBypass(() => query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id, ...vals]))
}

async function backdateMovements(tenantId, referenceType, referenceId, n) {
  await withBypass(() => query(
    `UPDATE inventory_movements SET created_at = $1
      WHERE tenant_id = $2 AND reference_type = $3 AND reference_id = $4`,
    [daysAgo(n), tenantId, referenceType, referenceId]
  ))
}

// ─── 1. Tenant ────────────────────────────────────────────────────────────

async function ensureTenant() {
  const { rows } = await withBypass(() =>
    query(`SELECT id, slug, is_sandbox FROM tenants WHERE slug = $1`, [SLUG])
  )
  const existing = rows[0]

  if (existing && FRESH) {
    if (!existing.is_sandbox) fail(`El tenant '${SLUG}' NO está marcado is_sandbox — me niego a borrarlo.`)
    log(`  FRESH=1 → eliminando tenant existente '${SLUG}'…`)
    // Borrado dirigido (hijas → padres). No usamos sandboxResetService porque
    // hoy está desactualizado vs el schema (ver tarea aparte); aquí solo
    // borramos lo que este seed crea.
    const t = existing.id
    await withBypass(async () => {
      await query(`DELETE FROM supplier_payment_applications USING supplier_payments sp
                    WHERE supplier_payment_applications.supplier_payment_id = sp.id AND sp.tenant_id = $1`, [t])
      await query(`DELETE FROM supplier_payments WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM consumption_vouchers WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM ap_advances WHERE tenant_id = $1`, [t]).catch(() => {})
      await query(`DELETE FROM accounts_payable WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM invoice_receipt_links USING supplier_invoices si
                    WHERE invoice_receipt_links.invoice_id = si.id AND si.tenant_id = $1`, [t]).catch(() => {})
      await query(`DELETE FROM supplier_invoice_lines USING supplier_invoices si
                    WHERE supplier_invoice_lines.supplier_invoice_id = si.id AND si.tenant_id = $1`, [t])
        .catch(() => {}) // la tabla no existe en todos los schemas
      await query(`DELETE FROM supplier_invoices WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM raw_material_lots WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM supplier_receipt_lines USING supplier_receipts sr
                    WHERE supplier_receipt_lines.supplier_receipt_id = sr.id AND sr.tenant_id = $1`, [t])
      await query(`DELETE FROM supplier_receipts WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM purchase_order_lines USING purchase_orders po
                    WHERE purchase_order_lines.purchase_order_id = po.id AND po.tenant_id = $1`, [t])
      await query(`DELETE FROM purchase_orders WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM petty_cash_movements WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM inventory_movements WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM inventory_stock WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM document_status_log WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [t])
      await query(`DELETE FROM tenants WHERE id = $1 AND is_sandbox = TRUE`, [t])
    })
    ok('Tenant demo anterior eliminado')
  } else if (existing) {
    const { rows: pos } = await withBypass(() =>
      query(`SELECT COUNT(*)::int AS n FROM purchase_orders WHERE tenant_id = $1`, [existing.id])
    )
    if (pos[0].n > 0) {
      fail(`El tenant '${SLUG}' ya existe y tiene ${pos[0].n} OCs. Usa FRESH=1 para regenerarlo desde cero.`)
    }
    skip(`Tenant '${SLUG}' ya existe vacío — continúo sobre él`)
    return existing.id
  }

  const { tenant } = await tenantService.provisionTenant({
    slug: SLUG,
    name: NAME,
    plan: 'owner',
    adminEmail:    ADMIN_EMAIL,
    adminPassword: ADMIN_PASS,
    adminName:     ADMIN_NAME,
  })
  ok(`Tenant '${SLUG}' creado (id=${tenant.id})`)

  await withBypass(() => query(`UPDATE tenants SET is_sandbox = TRUE WHERE id = $1`, [tenant.id]))
  ok('Marcado is_sandbox=TRUE')
  return tenant.id
}

async function configureTenant(tenantId) {
  // Módulos: apagar todo lo que no es compras/almacén/administración.
  await withBypass(() => query(
    `UPDATE tenants
        SET modules = '{"production":false,"sales":false,"quotations":false,"invoicing":false,"traceability":false,"rh":false}'::jsonb,
            display_name = $2
      WHERE id = $1`,
    [tenantId, NAME]
  ))
  ok('Módulos: production/sales/quotations/invoicing/traceability/rh apagados')

  // Suscripción demo sin vencimiento práctico (evita banner de trial).
  await withBypass(() => query(
    `UPDATE subscriptions
        SET status = 'active', trial_end = NULL,
            current_period_end = NOW() + INTERVAL '10 years'
      WHERE tenant_id = $1`,
    [tenantId]
  ))
  ok('Suscripción demo: active, vence en 10 años')

  // Flags de proceso: perfil administrativo simple, nada de plástico.
  const flags = {
    uses_lots:              false,
    uses_expiry:            false,
    uses_fefo:              false,
    uses_handover:          false,
    uses_supervisor:        false,
    supervisor_validates:   false,
    uses_resin_types:       false,
    tracks_material_origin: false,
    cost_method:            'weighted_avg',
    operation_mode:         'small',
    allow_negative_stock:   false,
  }
  const cols = Object.keys(flags)
  const vals = Object.values(flags)
  const { rows } = await withBypass(() =>
    query(`SELECT 1 FROM tenant_process_config WHERE tenant_id = $1`, [tenantId])
  )
  if (rows.length === 0) {
    const ph = cols.map((_, i) => `$${i + 2}`).join(', ')
    await withBypass(() => query(
      `INSERT INTO tenant_process_config (tenant_id, ${cols.join(', ')}) VALUES ($1, ${ph})`,
      [tenantId, ...vals]
    ))
  } else {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
    await withBypass(() => query(
      `UPDATE tenant_process_config SET ${set} WHERE tenant_id = $1`, [tenantId, ...vals]
    ))
  }
  ok('tenant_process_config: perfil administrativo (sin lotes, sin resinas)')
}

// ─── 2. Almacenes y tipos ─────────────────────────────────────────────────

async function configureWarehouses(tenantId) {
  // El seed default creó tipos (materia_prima, embalaje, producto_terminado,
  // merma, wip) y almacenes para input/output/wip. Para este perfil:
  //   materia_prima → se renombra "Insumos" y sostiene los 3 almacenes reales.
  //   El resto de tipos se desactiva y sus almacenes auto-creados se borran.
  await withBypass(() => query(
    `UPDATE tenant_warehouse_types SET name = 'Insumos'
      WHERE tenant_id = $1 AND code = 'materia_prima'`,
    [tenantId]
  ))

  await withBypass(() => query(
    `DELETE FROM warehouses w
      USING tenant_warehouse_types twt
      WHERE w.tenant_id = $1 AND w.warehouse_type_id = twt.id
        AND twt.code IN ('embalaje','producto_terminado','wip')
        AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.warehouse_id = w.id)`,
    [tenantId]
  ))
  await withBypass(() => query(
    `UPDATE tenant_warehouse_types SET is_active = FALSE
      WHERE tenant_id = $1 AND code IN ('embalaje','producto_terminado','merma','wip')`,
    [tenantId]
  ))
  ok('Tipos productivos desactivados y almacenes auto-creados eliminados')

  // Renombrar el almacén de materia prima → "Almacén principal"
  const { rows: principal } = await withBypass(() => query(
    `UPDATE warehouses w SET name = 'Almacén principal',
            description = 'Empaque, sanidad y limpieza de planta'
       FROM tenant_warehouse_types twt
      WHERE w.tenant_id = $1 AND w.warehouse_type_id = twt.id AND twt.code = 'materia_prima'
      RETURNING w.id`,
    [tenantId]
  ))
  if (principal.length === 0) fail('No encontré el almacén default de materia prima')
  ok('Almacén principal listo')

  const mantenimiento = await withBypass(() => warehouseService.create({
    tenantId, name: 'Almacén de mantenimiento', type: 'raw_material',
    description: 'Refacciones, lubricantes y herramienta',
  }))
  const oficinas = await withBypass(() => warehouseService.create({
    tenantId, name: 'Oficinas', type: 'raw_material',
    description: 'Papelería y consumibles administrativos',
  }))
  ok('Almacenes: mantenimiento y oficinas creados')

  return {
    principal:     principal[0].id,
    mantenimiento: mantenimiento.id,
    oficinas:      oficinas.id,
  }
}

// ─── 3. Áreas de consumo ──────────────────────────────────────────────────

const AREAS = [
  'Línea de empaque', 'Recepción de fruta', 'Cámara de frío', 'Calidad',
  'Mantenimiento', 'Embarques', 'Oficinas administrativas',
]

async function seedAreas(tenantId) {
  const map = {}
  for (const name of AREAS) {
    try {
      const area = await withBypass(() => voucherService.createArea({ tenantId, name }))
      map[name] = area.id
    } catch (err) {
      if (err.status === 409) {
        const areas = await withBypass(() => voucherService.listAreas({ tenantId }))
        map[name] = areas.find(a => a.name === name)?.id
      } else throw err
    }
  }
  ok(`${AREAS.length} áreas de consumo`)
  return map
}

// ─── 4. Proveedores ───────────────────────────────────────────────────────

const SUPPLIERS = [
  { key: 'empaques',    name: 'Empaques y Cartones de Uruapan SA de CV', city: 'Uruapan',  state: 'Michoacán', creditDays: 30, contact: { name: 'Laura Gutiérrez', position: 'Ventas', email: 'ventas@empaquesuruapan.demo', phone: '452 111 0001' } },
  { key: 'flejes',      name: 'Plásticos y Flejes del Occidente',        city: 'Zamora',   state: 'Michoacán', creditDays: 15, contact: { name: 'Raúl Mendoza',    position: 'Ventas', email: 'raul@flejesoccidente.demo',  phone: '351 111 0002' } },
  { key: 'etiquetas',   name: 'Etiquetas e Impresos AvoPrint',           city: 'Guadalajara', state: 'Jalisco', creditDays: 0,  contact: { name: 'Sofía Anaya',    position: 'Atención a clientes', email: 'contacto@avoprint.demo', phone: '33 1111 0003' } },
  { key: 'quimica',     name: 'Química Agroalimentaria del Valle',       city: 'Uruapan',  state: 'Michoacán', creditDays: 30, contact: { name: 'Ing. Paco Ruiz',  position: 'Asesor técnico', email: 'pruiz@quimivalle.demo', phone: '452 111 0004' } },
  { key: 'ferreteria',  name: 'Ferretería Industrial La Huerta',         city: 'Uruapan',  state: 'Michoacán', creditDays: 15, contact: { name: 'Mostrador',       position: 'Mostrador', email: 'pedidos@ferrelahuerta.demo', phone: '452 111 0005' } },
  { key: 'epp',         name: 'Seguridad Industrial y EPP de Michoacán', city: 'Morelia',  state: 'Michoacán', creditDays: 0,  contact: { name: 'Karina López',    position: 'Ventas', email: 'klopez@eppmich.demo', phone: '443 111 0006' } },
  { key: 'papeleria',   name: 'Papelería y Sistemas de Uruapan',         city: 'Uruapan',  state: 'Michoacán', creditDays: 0,  contact: { name: 'Mostrador',       position: 'Mostrador', email: 'ventas@papesistemas.demo', phone: '452 111 0007' } },
  { key: 'agua',        name: 'Purificadora Los Pinos',                  city: 'Uruapan',  state: 'Michoacán', creditDays: 0,  contact: { name: 'Reparto',         position: 'Reparto', email: 'pedidos@aguapinos.demo', phone: '452 111 0008' } },
]

async function seedSuppliers(tenantId, userId) {
  const map = {}
  for (const s of SUPPLIERS) {
    const partner = await withBypass(() => partnerService.createPartner({
      tenantId, userId,
      type: 'supplier',
      name: s.name,
      city: s.city, state: s.state,
      supplierCreditDays: s.creditDays,
      contacts: [{ ...s.contact, isPrimary: true }],
    }))
    map[s.key] = partner.id
  }
  ok(`${SUPPLIERS.length} proveedores`)
  return map
}

// ─── 5. Insumos ───────────────────────────────────────────────────────────

// kind: packaging = material de empaque; raw_material = insumo general.
const ITEMS = [
  // Empaque
  { key: 'caja10',     name: 'Caja de cartón para aguacate 10 kg', kind: 'packaging',    unit: 'pza',      cost: 14.50 },
  { key: 'cajaPlast',  name: 'Caja plástica cosechera',            kind: 'packaging',    unit: 'pza',      cost: 95 },
  { key: 'esquinero',  name: 'Esquinero de cartón 1.20 m',         kind: 'packaging',    unit: 'pza',      cost: 1.80 },
  { key: 'fleje',      name: 'Fleje de polipropileno 12 mm',       kind: 'packaging',    unit: 'rollo',    cost: 620 },
  { key: 'grapas',     name: 'Grapa para fleje (caja 1000)',       kind: 'packaging',    unit: 'caja',     cost: 180 },
  { key: 'etiqueta',   name: 'Etiqueta PLU aguacate (millar)',     kind: 'packaging',    unit: 'millar',   cost: 120 },
  { key: 'playo',      name: 'Película stretch 18" (rollo)',       kind: 'packaging',    unit: 'rollo',    cost: 145 },
  { key: 'tarima',     name: 'Tarima de madera 40x48',             kind: 'packaging',    unit: 'pza',      cost: 165 },
  // Sanidad / EPP
  { key: 'guantes',    name: 'Guantes de nitrilo (caja 100)',      kind: 'raw_material', unit: 'caja',     cost: 145 },
  { key: 'cofias',     name: 'Cofia desechable (caja 100)',        kind: 'raw_material', unit: 'caja',     cost: 90 },
  { key: 'cubrebocas', name: 'Cubrebocas (caja 50)',               kind: 'raw_material', unit: 'caja',     cost: 75 },
  { key: 'botas',      name: 'Botas de hule blancas',              kind: 'raw_material', unit: 'par',      cost: 260 },
  { key: 'mandil',     name: 'Mandil de PVC',                      kind: 'raw_material', unit: 'pza',      cost: 85 },
  // Limpieza
  { key: 'cloro',      name: 'Cloro industrial',                   kind: 'raw_material', unit: 'L',        cost: 18 },
  { key: 'jabon',      name: 'Jabón industrial multiusos',         kind: 'raw_material', unit: 'L',        cost: 32 },
  { key: 'sanitizante', name: 'Sanitizante para fruta',            kind: 'raw_material', unit: 'L',        cost: 96 },
  { key: 'escoba',     name: 'Escoba industrial',                  kind: 'raw_material', unit: 'pza',      cost: 55 },
  { key: 'franela',    name: 'Franela (metro)',                    kind: 'raw_material', unit: 'm',        cost: 22 },
  // Mantenimiento
  { key: 'aceite',     name: 'Aceite hidráulico ISO 68',           kind: 'raw_material', unit: 'L',        cost: 88 },
  { key: 'grasa',      name: 'Grasa grado alimenticio',            kind: 'raw_material', unit: 'kg',       cost: 210 },
  { key: 'rodamiento', name: 'Rodamiento 6205-2RS',                kind: 'raw_material', unit: 'pza',      cost: 78 },
  { key: 'foco',       name: 'Foco LED 18 W',                      kind: 'raw_material', unit: 'pza',      cost: 65 },
  { key: 'soldadura',  name: 'Soldadura 6013 1/8',                 kind: 'raw_material', unit: 'kg',       cost: 145 },
  // Oficina
  { key: 'papel',      name: 'Papel bond carta (paquete 500)',     kind: 'raw_material', unit: 'paquete',  cost: 92 },
  { key: 'toner',      name: 'Tóner negro impresora',              kind: 'raw_material', unit: 'pza',      cost: 1450 },
  { key: 'plumas',     name: 'Plumas (caja 12)',                   kind: 'raw_material', unit: 'caja',     cost: 68 },
  { key: 'cafe',       name: 'Café soluble',                       kind: 'raw_material', unit: 'kg',       cost: 185 },
  { key: 'agua',       name: 'Agua purificada garrafón 20 L',      kind: 'raw_material', unit: 'garrafón', cost: 45 },
]

async function seedItems(tenantId, userId) {
  const map = {}
  for (const it of ITEMS) {
    const row = await withBypass(() => rawMaterialSvc.createRawMaterial({
      tenantId, userId,
      name: it.name,
      itemKind: it.kind,
      unit: it.unit,
      costPerKg: it.cost,
    }))
    map[it.key] = { id: row.id, ...it }
  }
  ok(`${ITEMS.length} insumos`)
  return map
}

// ─── 6. Compras: OC → recepción → comprobante → pago ─────────────────────

async function getOrderLines(tenantId, orderId) {
  const { rows } = await withBypass(() => query(
    `SELECT pol.id, pol.item_type, pol.item_id, pol.quantity, pol.unit, pol.unit_price, pol.warehouse_id
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE po.tenant_id = $1 AND pol.purchase_order_id = $2
      ORDER BY pol.line_number`,
    [tenantId, orderId]
  ))
  return rows
}

/**
 * Crea una OC confirmada y opcionalmente su recepción confirmada.
 * lines: [{ item: mapEntry, qty, warehouseId, receiveQty? }]
 * daysOrder / daysReceipt: antigüedad de cada documento.
 * confirm=false deja la OC en draft; receive=false la deja en 'sent'.
 */
async function purchaseFlow({
  tenantId, userId, partnerId, lines,
  daysOrder, daysReceipt = null, confirm = true, receive = true, notes,
}) {
  const order = await withBypass(() => poService.createOrder({
    tenantId, userId, partnerId,
    expectedDate: dateStr(Math.max(0, daysOrder - 3)),
    notes,
    lines: lines.map(l => ({
      itemType: 'raw_material',
      itemId: l.item.id,
      quantity: l.qty,
      unit: l.item.unit,
      unitPrice: l.item.cost,
      warehouseId: l.warehouseId,
    })),
  }))
  await backdate('purchase_orders', order.id, ['created_at'], daysOrder)

  if (!confirm) return { order, receipt: null }

  await withBypass(() => poService.confirmOrder({ tenantId, orderId: order.id, userId }))
  await backdate('purchase_orders', order.id, ['created_at', 'approved_at'], daysOrder)

  if (!receive) return { order, receipt: null }

  const ocLines = await getOrderLines(tenantId, order.id)
  const receipt = await withBypass(() => receiptService.createReceipt({
    tenantId, userId,
    purchaseOrderId: order.id,
    warehouseId: ocLines[0].warehouse_id,
    receivedDate: dateStr(daysReceipt),
    lines: ocLines.map((ol, i) => ({
      purchaseOrderLineId: ol.id,
      itemType: ol.item_type,
      itemId: ol.item_id,
      quantityReceived: lines[i].receiveQty != null ? lines[i].receiveQty : Number(ol.quantity),
      unit: ol.unit,
      unitPrice: Number(ol.unit_price),
      warehouseId: ol.warehouse_id,
    })),
  }))
  await withBypass(() => receiptService.confirmReceipt({ tenantId, receiptId: receipt.id, userId }))
  await backdate('supplier_receipts', receipt.id, ['created_at', 'confirmed_at'], daysReceipt)
  await backdateMovements(tenantId, 'supplier_receipt', receipt.id, daysReceipt)

  return { order, receipt }
}

async function invoiceAndPay({
  tenantId, userId, supplierId, receiptId, purchaseOrderId,
  documentNumber, daysInvoice, creditDays, subtotal,
  taxRate = 0.16, payments = [],
}) {
  const tax = Math.round(subtotal * taxRate * 100) / 100
  const total = Math.round((subtotal + tax) * 100) / 100
  const inv = await withBypass(() => invoiceService.registerInvoice({
    tenantId, userId,
    supplierId,
    documentType: 'invoice',
    documentNumber,
    invoiceDate: dateStr(daysInvoice),
    subtotal, tax, total,
    receiptIds: receiptId ? [receiptId] : [],
    purchaseOrderId,
    creditDays,
  }))
  if (payments.length && !inv.ap_id) {
    throw new Error(`registerInvoice de ${documentNumber} no generó CxP (ap_id null) — no puedo aplicar pagos.`)
  }
  for (const p of payments) {
    const pay = await withBypass(() => invoiceService.registerPayment({
      tenantId, userId,
      supplierId,
      paymentDate: dateStr(p.daysAgo),
      method: p.method || 'transfer',
      reference: p.reference,
      amount: p.amount != null ? p.amount : total,
      applications: [{ apId: inv.ap_id, amountApplied: p.amount != null ? p.amount : total }],
    }))
    await backdate('supplier_payments', pay.id, ['created_at'], p.daysAgo)
  }
  return { ...inv, total }
}

// ─── 7. Vales de salida ───────────────────────────────────────────────────

async function makeVoucher({ tenantId, userId, warehouseId, areaId, receivedBy, lines, days, notes }) {
  const v = await withBypass(() => voucherService.createVoucher({
    tenantId, userId, warehouseId, areaId, receivedBy, notes,
    lines: lines.map(l => ({ itemType: 'raw_material', itemId: l.item.id, quantity: l.qty })),
  }))
  await backdate('consumption_vouchers', v.id, ['created_at'], days)
  await withBypass(() => query(
    `UPDATE consumption_vouchers SET voucher_date = $2 WHERE id = $1`, [v.id, dateStr(days)]
  ))
  await backdateMovements(tenantId, 'consumption_voucher', v.id, days)
  return v
}

// ─── 8. Caja chica y comunicados ──────────────────────────────────────────

async function seedPettyCash(tenantId, userId) {
  const catOut = {}
  for (const [name, kind] of [
    ['Mensajería y paquetería', 'out'],
    ['Viáticos y casetas', 'out'],
    ['Consumibles menores', 'out'],
    ['Reposición de fondo', 'in'],
  ]) {
    const c = await withBypass(() => pettyCashService.createCategory(tenantId, { name, kind }))
    catOut[name] = c.id
  }

  const fund = await withBypass(() => pettyCashService.createFund(tenantId, userId, {
    name: 'Caja chica administración',
    location: 'Oficina principal',
    initialBalance: 8000,
  }))

  const movements = [
    { kind: 'out', amount: 380,  cat: 'Mensajería y paquetería', paidTo: 'DHL Express',            desc: 'Envío de muestras a cliente de exportación', days: 21 },
    { kind: 'out', amount: 590,  cat: 'Viáticos y casetas',      paidTo: 'Casetas ICAVE',          desc: 'Casetas viaje a Guadalajara (recolección de refacción)', days: 14 },
    { kind: 'out', amount: 160,  cat: 'Consumibles menores',     paidTo: 'Abarrotes La Esquina',   desc: 'Azúcar y vasos para sala de juntas', days: 7 },
    { kind: 'in',  amount: 1500, cat: 'Reposición de fondo',     paidTo: null,                     desc: 'Reposición de fondo fijo', days: 2 },
  ]
  for (const m of movements) {
    const mov = await withBypass(() => pettyCashService.createMovement(tenantId, userId, {
      fundId: fund.id,
      kind: m.kind,
      amount: m.amount,
      categoryId: catOut[m.cat],
      description: m.desc,
      paidTo: m.paidTo || undefined,
      occurredAt: dateStr(m.days),
    }))
    await backdate('petty_cash_movements', mov.id, ['created_at'], m.days).catch(() => {})
  }
  ok('Caja chica: fondo + 4 categorías + 4 movimientos')
}

async function seedCommunications(tenantId, userId) {
  for (const [name, sortOrder] of [['Avisos generales', 10], ['Seguridad e higiene', 20]]) {
    await withBypass(() => commsService.createCategory({ tenantId, name, sortOrder }))
  }
  await withBypass(() => commsService.createTemplate({
    tenantId, createdBy: userId,
    name: 'Corte de agua programado',
    category: 'Avisos generales',
    subject: 'Aviso: corte de agua programado este sábado',
    message: 'Estimado equipo:\n\nEste sábado de 8:00 a 14:00 h habrá corte de agua en la planta por mantenimiento de la cisterna. Favor de programar la sanitización de líneas antes del viernes.\n\nAdministración',
  }))
  await withBypass(() => commsService.createTemplate({
    tenantId, createdBy: userId,
    name: 'Uso obligatorio de EPP en planta',
    category: 'Seguridad e higiene',
    subject: 'Recordatorio: uso obligatorio de EPP en áreas de proceso',
    message: 'Se recuerda a todo el personal que el uso de cofia, cubrebocas y botas sanitarias es obligatorio en línea de empaque y cámara de frío. El equipo se entrega en el almacén principal contra vale de salida.\n\nCalidad e Inocuidad',
  }))
  ok('Comunicados: 2 categorías + 2 plantillas (los envíos se hacen en vivo en el demo)')
}

// ─── 9. Membresía para el admin real (best effort) ────────────────────────

async function grantOperatorMembership(tenantId) {
  const { rows } = await withBypass(() => query(
    `SELECT id, email FROM users WHERE email = 'administracion@ghinsumos.com'`
  ))
  for (const u of rows) {
    await withBypass(() => query(
      `INSERT INTO tenant_memberships (user_id, tenant_id, role)
       VALUES ($1, $2, 'owner') ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [u.id, tenantId]
    ))
  }
  if (rows.length) ok(`Membresía owner al tenant demo para ${rows.length} cuenta(s) administracion@ghinsumos.com`)
  else skip('No existe administracion@ghinsumos.com en esta BD — sin membresía extra')
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  log(`Seed demo '${SLUG}' — ${NAME}`)
  log('─'.repeat(70))

  log('[1] Tenant y configuración…')
  const tenantId = await ensureTenant()
  await configureTenant(tenantId)

  const { rows: adminRows } = await withBypass(() =>
    query(`SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tenantId, ADMIN_EMAIL])
  )
  if (!adminRows.length) fail('No encontré el usuario admin del tenant demo')
  const userId = adminRows[0].id

  log('\n[2] Almacenes…')
  const wh = await configureWarehouses(tenantId)

  log('\n[3] Áreas de consumo…')
  const areas = await seedAreas(tenantId)

  log('\n[4] Proveedores…')
  const sup = await seedSuppliers(tenantId, userId)

  log('\n[5] Insumos…')
  const item = await seedItems(tenantId, userId)

  log('\n[6] Compras (OCs, recepciones, comprobantes, pagos)…')

  // OC-1 Empaques (T-40) → recibida T-38 → factura 30 días pagada T-9
  const f1 = await purchaseFlow({
    tenantId, userId, partnerId: sup.empaques, daysOrder: 40, daysReceipt: 38,
    notes: 'Resurtido de temporada — cajas y esquineros',
    lines: [
      { item: item.caja10,    qty: 3000, warehouseId: wh.principal },
      { item: item.esquinero, qty: 5000, warehouseId: wh.principal },
      { item: item.tarima,    qty: 120,  warehouseId: wh.principal },
    ],
  })
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.empaques,
    receiptId: f1.receipt.id, purchaseOrderId: f1.order.id,
    documentNumber: 'F-2041', daysInvoice: 37, creditDays: 30,
    subtotal: 3000 * 14.5 + 5000 * 1.8 + 120 * 165,
    payments: [{ daysAgo: 9, method: 'transfer', reference: 'SPEI 88213' }],
  })
  ok('OC-1 Empaques: recibida, facturada y pagada')

  // OC-2 Química (T-30) → recibida T-28 → factura 30 días con pago parcial (por vencer)
  const f2 = await purchaseFlow({
    tenantId, userId, partnerId: sup.quimica, daysOrder: 30, daysReceipt: 28,
    lines: [
      { item: item.cloro,       qty: 100, warehouseId: wh.principal },
      { item: item.sanitizante, qty: 60,  warehouseId: wh.principal },
      { item: item.jabon,       qty: 40,  warehouseId: wh.principal },
    ],
  })
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.quimica,
    receiptId: f2.receipt.id, purchaseOrderId: f2.order.id,
    documentNumber: 'A-7719', daysInvoice: 27, creditDays: 30,
    subtotal: 100 * 18 + 60 * 96 + 40 * 32,
    payments: [{ daysAgo: 3, method: 'transfer', amount: 5000, reference: 'SPEI 90114' }],
  })
  ok('OC-2 Química: recibida, factura a crédito con pago parcial (por vencer)')

  // OC-3 Flejes (T-25) → recepción PARCIAL T-22, sin comprobante todavía
  await purchaseFlow({
    tenantId, userId, partnerId: sup.flejes, daysOrder: 25, daysReceipt: 22,
    notes: 'Entrega parcial acordada — resto en segunda remesa',
    lines: [
      { item: item.fleje,  qty: 10, receiveQty: 5,  warehouseId: wh.principal },
      { item: item.playo,  qty: 30, receiveQty: 15, warehouseId: wh.principal },
      { item: item.grapas, qty: 6,  receiveQty: 3,  warehouseId: wh.principal },
    ],
  })
  ok('OC-3 Flejes: parcialmente recibida, pendiente de comprobante')

  // OC-4 EPP (T-20) → recibida T-18 → contado pagada T-17
  const f4 = await purchaseFlow({
    tenantId, userId, partnerId: sup.epp, daysOrder: 20, daysReceipt: 18,
    lines: [
      { item: item.guantes,    qty: 20, warehouseId: wh.principal },
      { item: item.cofias,     qty: 10, warehouseId: wh.principal },
      { item: item.cubrebocas, qty: 10, warehouseId: wh.principal },
      { item: item.botas,      qty: 8,  warehouseId: wh.principal },
    ],
  })
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.epp,
    receiptId: f4.receipt.id, purchaseOrderId: f4.order.id,
    documentNumber: 'B-1268', daysInvoice: 17, creditDays: 0,
    subtotal: 20 * 145 + 10 * 90 + 10 * 75 + 8 * 260,
    payments: [{ daysAgo: 17, method: 'transfer', reference: 'SPEI 89504' }],
  })
  ok('OC-4 EPP: recibida, contado pagado')

  // OC-5 Ferretería (T-15) → recibida T-13 al almacén de mantenimiento → crédito 15, pendiente
  const f5 = await purchaseFlow({
    tenantId, userId, partnerId: sup.ferreteria, daysOrder: 15, daysReceipt: 13,
    lines: [
      { item: item.aceite,     qty: 60, warehouseId: wh.mantenimiento },
      { item: item.grasa,      qty: 10, warehouseId: wh.mantenimiento },
      { item: item.rodamiento, qty: 12, warehouseId: wh.mantenimiento },
      { item: item.foco,       qty: 30, warehouseId: wh.mantenimiento },
      { item: item.soldadura,  qty: 5,  warehouseId: wh.mantenimiento },
    ],
  })
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.ferreteria,
    receiptId: f5.receipt.id, purchaseOrderId: f5.order.id,
    documentNumber: 'FI-3387', daysInvoice: 13, creditDays: 15,
    subtotal: 60 * 88 + 10 * 210 + 12 * 78 + 30 * 65 + 5 * 145,
  })
  ok('OC-5 Ferretería: recibida en mantenimiento, crédito 15 días pendiente')

  // OC-6 Papelería (T-8) → recibida T-6 en Oficinas → contado SIN pagar (vencida)
  const f6 = await purchaseFlow({
    tenantId, userId, partnerId: sup.papeleria, daysOrder: 8, daysReceipt: 6,
    lines: [
      { item: item.papel,  qty: 30, warehouseId: wh.oficinas },
      { item: item.toner,  qty: 4,  warehouseId: wh.oficinas },
      { item: item.plumas, qty: 5,  warehouseId: wh.oficinas },
      { item: item.cafe,   qty: 12, warehouseId: wh.oficinas },
    ],
  })
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.papeleria,
    receiptId: f6.receipt.id, purchaseOrderId: f6.order.id,
    documentNumber: 'PS-9915', daysInvoice: 6, creditDays: 0,
    subtotal: 30 * 92 + 4 * 1450 + 5 * 68 + 12 * 185,
  })
  ok('OC-6 Papelería: recibida en oficinas, contado vencido (CxP roja)')

  // Recepción directa SIN OC: agua semanal (T-5), pagada en efectivo
  const aguaReceipt = await withBypass(() => receiptService.createReceipt({
    tenantId, userId,
    partnerId: sup.agua,
    warehouseId: wh.oficinas,
    receivedDate: dateStr(5),
    notes: 'Entrega semanal de garrafones',
    lines: [{ itemType: 'raw_material', itemId: item.agua.id, quantityReceived: 40, unit: 'garrafón', unitPrice: 45 }],
  }))
  await withBypass(() => receiptService.confirmReceipt({ tenantId, receiptId: aguaReceipt.id, userId }))
  await backdate('supplier_receipts', aguaReceipt.id, ['created_at', 'confirmed_at'], 5)
  await backdateMovements(tenantId, 'supplier_receipt', aguaReceipt.id, 5)
  await invoiceAndPay({
    tenantId, userId, supplierId: sup.agua,
    receiptId: aguaReceipt.id,
    documentNumber: 'NP-0452', daysInvoice: 5, creditDays: 0,
    subtotal: 40 * 45, taxRate: 0,
    payments: [{ daysAgo: 5, method: 'cash' }],
  })
  ok('Recepción directa de agua (sin OC), pagada en efectivo')

  // OC-7 Empaques segunda compra (T-3): confirmada, EN TRÁNSITO (sin recepción)
  await purchaseFlow({
    tenantId, userId, partnerId: sup.empaques, daysOrder: 3, receive: false,
    notes: 'Urge para embarque de la próxima semana',
    lines: [
      { item: item.caja10,   qty: 5000, warehouseId: wh.principal },
      { item: item.etiqueta, qty: 20,   warehouseId: wh.principal },
    ],
  })
  ok('OC-7 Empaques: confirmada, pendiente de recepción')

  // OC-8 Química reorden (hoy): BORRADOR
  await purchaseFlow({
    tenantId, userId, partnerId: sup.quimica, daysOrder: 0, confirm: false,
    notes: 'Reorden de cloro — validar precio con el asesor',
    lines: [{ item: item.cloro, qty: 200, warehouseId: wh.principal }],
  })
  ok('OC-8 Química: borrador de hoy')

  log('\n[7] Vales de salida a áreas…')
  await makeVoucher({
    tenantId, userId, warehouseId: wh.principal, areaId: areas['Línea de empaque'],
    receivedBy: 'Juan Herrera', days: 20, notes: 'Arranque de semana',
    lines: [{ item: item.caja10, qty: 400 }, { item: item.esquinero, qty: 800 }],
  })
  await makeVoucher({
    tenantId, userId, warehouseId: wh.principal, areaId: areas['Línea de empaque'],
    receivedBy: 'Juan Herrera', days: 18,
    lines: [{ item: item.guantes, qty: 4 }, { item: item.cofias, qty: 2 }],
  })
  await makeVoucher({
    tenantId, userId, warehouseId: wh.mantenimiento, areaId: areas['Mantenimiento'],
    receivedBy: 'Marcos Tapia', days: 12, notes: 'Servicio a banda transportadora 2',
    lines: [{ item: item.aceite, qty: 10 }, { item: item.rodamiento, qty: 2 }, { item: item.grasa, qty: 1 }],
  })
  await makeVoucher({
    tenantId, userId, warehouseId: wh.principal, areaId: areas['Calidad'],
    receivedBy: 'Brenda Sandoval', days: 6, notes: 'Sanitización semanal',
    lines: [{ item: item.cloro, qty: 15 }, { item: item.sanitizante, qty: 5 }],
  })
  await makeVoucher({
    tenantId, userId, warehouseId: wh.oficinas, areaId: areas['Oficinas administrativas'],
    receivedBy: 'Lupita Ríos', days: 4,
    lines: [{ item: item.papel, qty: 6 }, { item: item.toner, qty: 1 }, { item: item.cafe, qty: 3 }, { item: item.agua, qty: 10 }],
  })
  await makeVoucher({
    tenantId, userId, warehouseId: wh.principal, areaId: areas['Embarques'],
    receivedBy: 'Óscar Peña', days: 1, notes: 'Embarque contenedor MX-1188',
    lines: [{ item: item.playo, qty: 4 }, { item: item.fleje, qty: 1 }, { item: item.tarima, qty: 12 }],
  })
  ok('6 vales de salida')

  // Retro-fechar last_movement_at del stock al último movimiento real de cada
  // ítem (el seed acaba de correr, pero la historia es de semanas atrás).
  await withBypass(() => query(
    `UPDATE inventory_stock s
        SET last_movement_at = m.max_d
       FROM (SELECT warehouse_id, item_type, item_id, MAX(created_at) AS max_d
               FROM inventory_movements WHERE tenant_id = $1
              GROUP BY warehouse_id, item_type, item_id) m
      WHERE s.tenant_id = $1
        AND s.warehouse_id = m.warehouse_id
        AND s.item_type = m.item_type
        AND s.item_id = m.item_id`,
    [tenantId]
  ))
  ok('Fechas de último movimiento del stock alineadas a la historia')

  log('\n[8] Caja chica…')
  await seedPettyCash(tenantId, userId)

  log('\n[9] Comunicados…')
  await seedCommunications(tenantId, userId)

  log('\n[10] Membresías…')
  await grantOperatorMembership(tenantId)

  // Resumen
  const { rows: c } = await withBypass(() => query(
    `SELECT
       (SELECT COUNT(*) FROM purchase_orders     WHERE tenant_id = $1) AS ocs,
       (SELECT COUNT(*) FROM supplier_receipts   WHERE tenant_id = $1) AS recepciones,
       (SELECT COUNT(*) FROM accounts_payable    WHERE tenant_id = $1) AS cxp,
       (SELECT COUNT(*) FROM consumption_vouchers WHERE tenant_id = $1) AS vales,
       (SELECT COUNT(*) FROM inventory_movements WHERE tenant_id = $1) AS movimientos,
       (SELECT COALESCE(SUM(quantity),0) FROM inventory_stock WHERE tenant_id = $1) AS unidades_stock`,
    [tenantId]
  ))
  log('\n' + '─'.repeat(70))
  log(`Demo '${SLUG}' listo — ${NAME}`)
  log('─'.repeat(70))
  log(`  OCs: ${c[0].ocs} · Recepciones: ${c[0].recepciones} · CxP: ${c[0].cxp} · Vales: ${c[0].vales} · Movimientos: ${c[0].movimientos}`)
  log(`  Login:    ${ADMIN_EMAIL}`)
  log(`  Password: ${process.env.DEMO_ADMIN_PASSWORD ? '(de env DEMO_ADMIN_PASSWORD)' : ADMIN_PASS}`)
  log('─'.repeat(70))
}

main()
  .catch((err) => { console.error('\nError no manejado:', err.stack || err); process.exitCode = 1 })
  .finally(async () => { await pool.end() })
