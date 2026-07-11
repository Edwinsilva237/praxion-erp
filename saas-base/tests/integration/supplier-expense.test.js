'use strict'

/**
 * Módulo de GASTOS — detalle, edición y cancelación (supplier_invoices con
 * is_expense=true). Cubre las reglas de seguridad:
 *   - editar montos solo sin pago aplicado (CXP en sync);
 *   - agregar el CFDI después + anti-duplicado por UUID;
 *   - cancelar solo sin pago → status=cancelled + CXP cancelado;
 *   - un gasto pagado no se edita en monto ni se cancela (pero sí en notas).
 */

const crypto = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, getExpense, updateExpense, cancelExpense, registerPayment,
  listExpensesSummary, getExpenseConceptos, reReadExpenseFromXml,
} = require('../../src/modules/purchases/supplierInvoiceService')
const { parseSupplierDocument } = require('../../src/modules/purchases/documentParserService')

function cfdiXml({ rfc, uuid, subtotal = 1000, total = 1160 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" ` +
    `Serie="A" Folio="123" Fecha="2026-06-15T10:00:00" SubTotal="${subtotal}" Total="${total}" Moneda="MXN">` +
    `<cfdi:Emisor Rfc="${rfc}" Nombre="PROVEEDOR XML SA" RegimenFiscal="601"/>` +
    `<cfdi:Receptor Rfc="XAXX010101000" Nombre="MI EMPRESA"/>` +
    `<cfdi:Complemento><tfd:TimbreFiscalDigital ` +
    `xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/></cfdi:Complemento>` +
    `</cfdi:Comprobante>`
}

let tenantId, userId, supplierId, categoryId, categoryId2

async function makeSupplier(name = 'Proveedor Gasto') {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, supplier_credit_days)
     VALUES ($1,'supplier',$2,0) RETURNING id`, [tenantId, name]))
  return rows[0].id
}
async function makeCategory(code, name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO tenant_expense_categories (tenant_id, code, name)
     VALUES ($1,$2,$3) RETURNING id`, [tenantId, code, name]))
  return rows[0].id
}
async function getAp(apId) {
  const { rows } = await withBypass(() => query(
    `SELECT status, amount_total, amount_paid FROM accounts_payable WHERE id = $1`, [apId]))
  return rows[0]
}
async function makeExpense({ subtotal = 1000, tax = 160, uuidSat = null } = {}) {
  return registerInvoice({
    tenantId, supplierId,
    documentNumber: `GASTO-${crypto.randomUUID().slice(0, 8)}`,
    subtotal, tax, total: subtotal + tax,
    isExpense: true, expenseCategoryId: categoryId, uuidSat, userId,
  })
}

describe('Gastos — detalle, edición y cancelación', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'gastos', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    supplierId  = await makeSupplier()
    categoryId  = await makeCategory('test_renta', 'Renta test')
    categoryId2 = await makeCategory('test_luz',   'Luz test')
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('registrar gasto → getExpense con los dos semáforos', async () => {
    const exp = await makeExpense()
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.is_expense).toBe(true)
    expect(got.has_cfdi).toBe(false)         // sin CFDI
    expect(got.ap_status).toBe('pending')    // sin pagar
    expect(parseFloat(got.total)).toBeCloseTo(1160)
    expect(got.expense_category_id).toBe(categoryId)
  })

  test('editar categoría + agregar el CFDI después', async () => {
    const exp = await makeExpense()
    const uuid = crypto.randomUUID()
    await updateExpense({ tenantId, id: exp.id, userId, expenseCategoryId: categoryId2, uuidSat: uuid })
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.expense_category_id).toBe(categoryId2)
    expect(got.has_cfdi).toBe(true)
    expect(got.uuid_sat).toBe(uuid)
  })

  test('editar monto sin pago → actualiza factura Y CXP', async () => {
    const exp = await makeExpense({ subtotal: 1000, tax: 160 })
    await updateExpense({ tenantId, id: exp.id, userId, subtotal: 2000, tax: 320 })
    const got = await getExpense({ tenantId, id: exp.id })
    expect(parseFloat(got.total)).toBeCloseTo(2320)
    const ap = await getAp(exp.ap_id)
    expect(parseFloat(ap.amount_total)).toBeCloseTo(2320)  // el CXP quedó en sync
  })

  test('UUID duplicado al editar → 409', async () => {
    const uuid = crypto.randomUUID()
    await makeExpense({ uuidSat: uuid })
    const b = await makeExpense()
    await expect(updateExpense({ tenantId, id: b.id, userId, uuidSat: uuid }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('gasto PAGADO → no se edita el monto ni se cancela (pero sí las notas)', async () => {
    const exp = await makeExpense({ subtotal: 500, tax: 80 })
    await registerPayment({
      tenantId, supplierId, method: 'transfer', reference: 'TR-1',
      amount: 580, currency: 'MXN',
      applications: [{ apId: exp.ap_id, amountApplied: 580 }], userId,
    })
    await expect(updateExpense({ tenantId, id: exp.id, userId, subtotal: 999 }))
      .rejects.toMatchObject({ status: 409 })
    await expect(cancelExpense({ tenantId, id: exp.id, userId }))
      .rejects.toMatchObject({ status: 409 })
    const upd = await updateExpense({ tenantId, id: exp.id, userId, notes: 'pagado en efectivo' })
    expect(upd.notes).toContain('pagado')   // editar campos NO monetarios sí se permite
  })

  test('cancelar gasto sin pago → status cancelled + CXP cancelado; ya no se edita', async () => {
    const exp = await makeExpense()
    const res = await cancelExpense({ tenantId, id: exp.id, userId, reason: 'capturado por error' })
    expect(res.status).toBe('cancelled')
    const ap = await getAp(exp.ap_id)
    expect(ap.status).toBe('cancelled')
    await expect(updateExpense({ tenantId, id: exp.id, userId, notes: 'x' }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('getExpenseConceptos parsea los conceptos del XML guardado', async () => {
    const uuid = crypto.randomUUID()
    const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
      `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" ` +
      `Serie="A" Folio="77" Fecha="2026-06-15T10:00:00" SubTotal="1000" Total="1160" Moneda="MXN">` +
      `<cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROV" RegimenFiscal="601"/>` +
      `<cfdi:Receptor Rfc="XAXX010101000" Nombre="MI EMPRESA"/>` +
      `<cfdi:Conceptos>` +
      `<cfdi:Concepto Cantidad="2" ClaveUnidad="H87" Descripcion="Tornillos" ValorUnitario="500" Importe="1000"/>` +
      `</cfdi:Conceptos>` +
      `<cfdi:Complemento><tfd:TimbreFiscalDigital ` +
      `xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/></cfdi:Complemento>` +
      `</cfdi:Comprobante>`
    const exp = await registerInvoice({
      tenantId, supplierId, documentNumber: `G-XML-${crypto.randomUUID().slice(0, 6)}`,
      subtotal: 1000, tax: 160, total: 1160,
      isExpense: true, expenseCategoryId: categoryId, uuidSat: uuid, xmlContent: xml, userId,
    })
    const res = await getExpenseConceptos({ tenantId, id: exp.id })
    expect(res.hasXml).toBe(true)
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0].description).toBe('Tornillos')
    expect(res.lines[0].quantity).toBe(2)
    expect(res.lines[0].amount).toBeCloseTo(1000, 2)
  })

  test('gasto manual sin XML → conceptos vacío (hasXml=false)', async () => {
    const exp = await makeExpense()
    const res = await getExpenseConceptos({ tenantId, id: exp.id })
    expect(res.hasXml).toBe(false)
    expect(res.lines).toHaveLength(0)
  })

  test('tras CANCELAR se puede RECARGAR la factura con el mismo UUID y folio', async () => {
    const uuid = crypto.randomUUID()
    const folio = `GASTO-${crypto.randomUUID().slice(0, 8)}`
    // Carga inicial (mal cargada) → se cancela.
    const bad = await registerInvoice({
      tenantId, supplierId, documentNumber: folio,
      subtotal: 1000, tax: 160, total: 1160,
      isExpense: true, expenseCategoryId: categoryId, uuidSat: uuid, userId,
    })
    await cancelExpense({ tenantId, id: bad.id, userId, reason: 'mal cargada' })

    // Recarga con el MISMO UUID + MISMO folio → ya no la bloquea.
    const good = await registerInvoice({
      tenantId, supplierId, documentNumber: folio,
      subtotal: 1000, tax: 160, total: 1160,
      isExpense: true, expenseCategoryId: categoryId, uuidSat: uuid, userId,
    })
    expect(good.id).toBeTruthy()
    expect(good.id).not.toBe(bad.id)

    // Y una SEGUNDA viva con el mismo UUID sí se bloquea (anti-dup sigue activo).
    await expect(registerInvoice({
      tenantId, supplierId, documentNumber: `${folio}-2`,
      subtotal: 1000, tax: 160, total: 1160,
      isExpense: true, expenseCategoryId: categoryId, uuidSat: uuid, userId,
    })).rejects.toMatchObject({ status: 409 })
  })

  // ── Corrección de moneda mal detectada (bug "Dólares" en notas del PDF) ───
  test('corregir moneda USD→MXN recalcula total_mxn y la CXP', async () => {
    // Simula un CFDI en pesos que el parser marcó USD: el total 6,338.18 se
    // infló al multiplicarse por el tipo de cambio del día.
    const date = '2026-05-20'
    await withBypass(() => query(
      `INSERT INTO exchange_rates (tenant_id, rate_date, currency, rate_mxn, source)
       VALUES ($1,$2,'USD',17.3480,'dof_auto')
       ON CONFLICT (tenant_id, rate_date, currency) DO NOTHING`, [tenantId, date]))

    const exp = await registerInvoice({
      tenantId, supplierId, documentNumber: `USD-${crypto.randomUUID().slice(0, 8)}`,
      currency: 'USD', subtotal: 5463.95, tax: 874.23, total: 6338.18,
      invoiceDate: date, isExpense: true, expenseCategoryId: categoryId, userId,
    })
    const before = await getExpense({ tenantId, id: exp.id })
    expect(before.currency).toBe('USD')
    expect(parseFloat(before.total_mxn)).toBeCloseTo(6338.18 * 17.348, 1)  // inflado

    // Corregir a MXN: total_mxn y la CXP vuelven al importe del documento.
    await updateExpense({ tenantId, id: exp.id, userId, currency: 'MXN' })
    const after = await getExpense({ tenantId, id: exp.id })
    expect(after.currency).toBe('MXN')
    expect(parseFloat(after.total)).toBeCloseTo(6338.18)
    expect(parseFloat(after.total_mxn)).toBeCloseTo(6338.18)
    const ap = await getAp(exp.ap_id)
    expect(parseFloat(ap.amount_total)).toBeCloseTo(6338.18)
  })

  test('no se puede cambiar la moneda de un gasto con pago aplicado', async () => {
    const exp = await makeExpense({ subtotal: 500, tax: 80 })
    await registerPayment({
      tenantId, supplierId, method: 'transfer', reference: 'TR-CUR',
      amount: 580, currency: 'MXN',
      applications: [{ apId: exp.ap_id, amountApplied: 580 }], userId,
    })
    await expect(updateExpense({ tenantId, id: exp.id, userId, currency: 'USD' }))
      .rejects.toMatchObject({ status: 409 })
  })

  // ── Fase 2: alta de gasto desde CFDI XML ──────────────────────────────────
  test('parsear un CFDI XML y crear el gasto desde sus datos + respaldo + anti-dup', async () => {
    const uuid = crypto.randomUUID()
    const xml  = cfdiXml({ rfc: 'PXM010101AB1', uuid })

    // El parser extrae los datos del CFDI
    const parsed = await parseSupplierDocument(Buffer.from(xml), 'application/xml', 'cfdi.xml')
    expect(parsed.uuid).toBe(uuid)
    expect(parsed.subtotal).toBeCloseTo(1000)
    expect(parsed.tax).toBeCloseTo(160)
    expect(parsed.emisor.rfc).toBe('PXM010101AB1')

    // Se crea el gasto con esos datos (reusa registerInvoice) + guarda el XML de respaldo
    const exp = await registerInvoice({
      tenantId, supplierId,
      documentNumber: [parsed.serie, parsed.folio].filter(Boolean).join('-'),
      subtotal: parsed.subtotal, tax: parsed.tax, total: parsed.total,
      invoiceDate: parsed.invoiceDate, isExpense: true, expenseCategoryId: categoryId,
      uuidSat: parsed.uuid, xmlContent: xml, userId,
    })
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.has_cfdi).toBe(true)
    expect(got.uuid_sat).toBe(uuid)
    const { rows } = await withBypass(() => query(
      `SELECT xml_content FROM supplier_invoices WHERE id = $1`, [exp.id]))
    expect(rows[0].xml_content).toContain('Comprobante')   // respaldo guardado

    // Anti-duplicado: el mismo UUID no se registra dos veces
    await expect(registerInvoice({
      tenantId, supplierId, documentNumber: 'DUP', subtotal: 1, tax: 0, total: 1,
      isExpense: true, expenseCategoryId: categoryId, uuidSat: uuid, userId,
    })).rejects.toMatchObject({ status: 409 })
  })

  // ── #1: resumen por categoría ─────────────────────────────────────────────
  test('resumen por categoría agrupa, suma, calcula sin_cfdi y EXCLUYE cancelados', async () => {
    const d = '2026-03-10'  // ventana propia, aislada de los demás tests (fecha de hoy)
    const reg = (num, cat, total, uuidSat) => registerInvoice({
      tenantId, supplierId, documentNumber: num, subtotal: total, tax: 0, total,
      isExpense: true, expenseCategoryId: cat, invoiceDate: d, uuidSat, userId,
    })
    await reg('SUM-A1', categoryId,  1000, crypto.randomUUID())   // A con CFDI
    await reg('SUM-A2', categoryId,   500, null)                  // A sin CFDI
    await reg('SUM-B1', categoryId2,  300, crypto.randomUUID())   // B con CFDI
    const cancelled = await reg('SUM-C1', categoryId, 9999, null) // se cancela → NO cuenta
    await cancelExpense({ tenantId, id: cancelled.id, userId })

    const sum = await listExpensesSummary({ tenantId, from: '2026-03-01', to: '2026-03-31' })
    expect(sum.total_mxn).toBeCloseTo(1800)      // 1000+500+300 (sin el cancelado 9999)
    expect(sum.count).toBe(3)
    expect(sum.sin_cfdi_mxn).toBeCloseTo(500)    // solo A2
    const a = sum.by_category.find(c => c.category_id === categoryId)
    const b = sum.by_category.find(c => c.category_id === categoryId2)
    expect(a.total_mxn).toBeCloseTo(1500)
    expect(b.total_mxn).toBeCloseTo(300)
    expect(sum.by_category[0].category_id).toBe(categoryId)  // orden desc por total
  })

  // ── reReadExpenseFromXml: recuperar el emisor del XML guardado ("Proveedor (correo)") ──
  const emisorCfdi = ({ uuid, rfc = 'DIM071012I11', subtotal = 8000, total = 9280 }) =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" ` +
    `Serie="M" Folio="711" Fecha="2026-06-30T10:00:00" SubTotal="${subtotal}" Total="${total}" Moneda="MXN">` +
    `<cfdi:Emisor Rfc="${rfc}" Nombre="DISTRIBUIDORA MORALES SA DE CV" RegimenFiscal="601"/>` +
    `<cfdi:Receptor Rfc="XAXX010101000" Nombre="MI EMPRESA"/>` +
    `<cfdi:Complemento><tfd:TimbreFiscalDigital ` +
    `xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/></cfdi:Complemento>` +
    `</cfdi:Comprobante>`

  // Gasto GENÉRICO (sin proveedor, como el que crea el buzón cuando el PDF no trae
  // nombre) con un XML de respaldo guardado en xml_content.
  async function makeGenericWithXml({ xml, generic = 'Proveedor (correo)', subtotal = 1, total = 1 }) {
    const exp = await registerInvoice({
      tenantId, genericSupplier: generic,
      documentNumber: `GEN-${crypto.randomUUID().slice(0, 8)}`,
      subtotal, tax: 0, total,
      isExpense: true, expenseCategoryId: null, userId,
    })
    await withBypass(() => query(
      `UPDATE supplier_invoices SET xml_content = $1 WHERE id = $2`, [xml, exp.id]))
    return exp
  }

  test('gasto "Proveedor (correo)" → releer el XML recupera nombre, RFC y totales', async () => {
    const uuid = crypto.randomUUID()
    const exp = await makeGenericWithXml({ xml: emisorCfdi({ uuid }) })  // arranca con total=1 (mal leído)
    const res = await reReadExpenseFromXml({ tenantId, id: exp.id, userId })
    expect(res.updated).toBe(true)
    expect(res.name).toBe('DISTRIBUIDORA MORALES SA DE CV')
    expect(res.rfc).toBe('DIM071012I11')

    const { rows } = await withBypass(() => query(
      `SELECT generic_supplier, rfc_emisor, subtotal, total FROM supplier_invoices WHERE id = $1`, [exp.id]))
    expect(rows[0].generic_supplier).toBe('DISTRIBUIDORA MORALES SA DE CV')
    expect(rows[0].rfc_emisor).toBe('DIM071012I11')
    expect(parseFloat(rows[0].subtotal)).toBeCloseTo(8000, 2)   // totales refrescados
    expect(parseFloat(rows[0].total)).toBeCloseTo(9280, 2)
  })

  test('releer con datos ya correctos → updated:false (idempotente)', async () => {
    const uuid = crypto.randomUUID()
    const exp = await makeGenericWithXml({ xml: emisorCfdi({ uuid }) })
    await reReadExpenseFromXml({ tenantId, id: exp.id, userId })
    const again = await reReadExpenseFromXml({ tenantId, id: exp.id, userId })
    expect(again.updated).toBe(false)
  })

  test('sin XML guardado → 400', async () => {
    const exp = await registerInvoice({
      tenantId, genericSupplier: 'Proveedor (correo)',
      documentNumber: `NOXML-${crypto.randomUUID().slice(0, 8)}`,
      subtotal: 100, tax: 16, total: 116,
      isExpense: true, expenseCategoryId: null, userId,
    })
    await expect(reReadExpenseFromXml({ tenantId, id: exp.id, userId }))
      .rejects.toMatchObject({ status: 400 })
  })

  test('gasto con proveedor asignado y CXP → releer corrige serie/folio pero NO toca identidad ni totales', async () => {
    const exp = await makeExpense({ subtotal: 500, tax: 80 })  // con supplierId → tiene CXP
    await withBypass(() => query(
      `UPDATE supplier_invoices SET xml_content = $1 WHERE id = $2`,
      [emisorCfdi({ uuid: crypto.randomUUID(), subtotal: 9999, total: 11599 }), exp.id]))
    const res = await reReadExpenseFromXml({ tenantId, id: exp.id, userId })

    // Serie/folio SÍ se corrigen aunque el proveedor esté identificado (lo pedido).
    expect(res.updated).toBe(true)
    expect(res.changed.serie).toBe('M')
    expect(res.changed.folio).toBe('711')
    expect(res.changed.folioNumber).toBe('M-711')
    // Totales NO se tocan (hay CXP) pero se reporta el desfase como aviso.
    expect(res.changed.totals).toBeUndefined()
    expect(res.changed.totalsBlocked).toMatchObject({ xmlTotal: 11599, current: 580 })

    const { rows } = await withBypass(() => query(
      `SELECT partner_id, generic_supplier, total, serie, folio, invoice_number
         FROM supplier_invoices WHERE id = $1`, [exp.id]))
    expect(rows[0].partner_id).toBe(supplierId)
    expect(rows[0].generic_supplier).toBeNull()
    expect(parseFloat(rows[0].total)).toBeCloseTo(580, 2)   // totales intactos (tiene CXP)
    expect(rows[0].serie).toBe('M')
    expect(rows[0].folio).toBe('711')
    expect(rows[0].invoice_number).toBe('M-711')

    // El folio de la CXP queda en sync con el nuevo invoice_number.
    const { rows: ap } = await withBypass(() => query(
      `SELECT document_number FROM accounts_payable WHERE document_id = $1 AND tenant_id = $2`,
      [exp.id, tenantId]))
    expect(ap[0].document_number).toBe('M-711')
  })
})
