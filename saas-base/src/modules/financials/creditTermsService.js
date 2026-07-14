'use strict'

/**
 * Aplicar los días de crédito ACTUALES de un socio a sus documentos ABIERTOS,
 * recalculando la fecha de vencimiento (congelada al emitir el documento).
 *
 * Motivación: el `due_date` del AR/AP se calcula al crear la factura/remisión
 * con los días de crédito que el socio tenía en ESE momento. Si el plazo no se
 * capturó (o cambió después), el vencimiento queda "pegado" — a veces como
 * "Sin fecha pactada". Esta utilidad deja que el usuario, tras cambiar el
 * crédito del socio, propague el nuevo vencimiento a los documentos abiertos.
 *
 * Reglas (acordadas):
 *   - SOLO documentos ABIERTOS (status pending/partial/overdue). NUNCA toca
 *     pagados ni cancelados (historial intacto).
 *   - Cliente (AR): recalcula facturas y remisiones. Excluye notas de crédito
 *     y anticipos (no son ventas a crédito).
 *   - Proveedor (AP): recalcula documentos respaldados por una factura de
 *     proveedor (supplier_invoices).
 *   - Vencimiento nuevo = fecha_emisión + días_crédito. Contado (0 días) =
 *     vence el mismo día de emisión (no "sin fecha").
 *   - Sincroniza el vencimiento visible del documento origen (delivery_notes,
 *     supplier_invoices). La factura de VENTA no guarda vencimiento propio
 *     (vive en el AR), por eso no se sincroniza.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const OPEN_STATUSES = ['pending', 'partial', 'overdue']

async function loadPartnerCredit({ tenantId, partnerId }) {
  const { rows } = await query(
    `SELECT id, name, credit_type, credit_days, supplier_credit_days
       FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  return rows[0] || null
}

/**
 * Cuántos documentos abiertos se verían afectados por lado, más el crédito
 * vigente del socio (para armar el mensaje del diálogo).
 */
async function previewCreditImpact({ tenantId, partnerId }) {
  const partner = await loadPartnerCredit({ tenantId, partnerId })
  if (!partner) throw createError(404, 'Socio no encontrado.')

  const { rows: arRows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM accounts_receivable
      WHERE tenant_id = $1 AND partner_id = $2
        AND status = ANY($3::ar_status[])
        AND document_type IN ('invoice', 'remission')`,
    [tenantId, partnerId, OPEN_STATUSES]
  )
  const { rows: apRows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM accounts_payable ap
      WHERE ap.tenant_id = $1 AND ap.partner_id = $2
        AND ap.status = ANY($3::ar_status[])
        AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = ap.document_id)`,
    [tenantId, partnerId, OPEN_STATUSES]
  )

  return {
    partner: {
      id: partner.id, name: partner.name,
      credit_type: partner.credit_type, credit_days: partner.credit_days,
      supplier_credit_days: partner.supplier_credit_days,
    },
    customer: { open_count: arRows[0].n },
    supplier: { open_count: apRows[0].n },
  }
}

/**
 * Recalcula el vencimiento de los documentos abiertos del socio usando su
 * crédito ACTUAL. `sides` = arreglo con 'customer' y/o 'supplier'.
 * @returns {Promise<{customer_updated:number, supplier_updated:number}>}
 */
async function applyCreditTerms({ tenantId, userId, partnerId, sides = [], ipAddress, userAgent }) {
  const partner = await loadPartnerCredit({ tenantId, partnerId })
  if (!partner) throw createError(404, 'Socio no encontrado.')

  const doCustomer = sides.includes('customer')
  const doSupplier = sides.includes('supplier')
  if (!doCustomer && !doSupplier) throw createError(400, 'Indica al menos un lado (customer/supplier).')

  // Días efectivos: crédito con días > 0 → esos días; en cualquier otro caso
  // (contado o 0) → 0 = vence el día de emisión.
  const customerDays = partner.credit_type === 'credit' && partner.credit_days > 0 ? partner.credit_days : 0
  const supplierDays = partner.supplier_credit_days > 0 ? partner.supplier_credit_days : 0

  let customerUpdated = 0, supplierUpdated = 0

  await withTransaction(async (client) => {
    if (doCustomer) {
      const { rowCount } = await client.query(
        `UPDATE accounts_receivable ar
            SET due_date = ar.issue_date + ($4::int)
          WHERE ar.tenant_id = $1 AND ar.partner_id = $2
            AND ar.status = ANY($3::ar_status[])
            AND ar.document_type IN ('invoice', 'remission')`,
        [tenantId, partnerId, OPEN_STATUSES, customerDays]
      )
      customerUpdated = rowCount

      // Sincronizar el vencimiento visible del documento origen desde el AR ya
      // recalculado. NOTA: la factura de VENTA (invoices) no guarda su propio
      // vencimiento — vive en el AR — así que solo se sincroniza la remisión.
      await client.query(
        `UPDATE delivery_notes dn SET credit_due_date = ar.due_date
           FROM accounts_receivable ar
          WHERE ar.document_type = 'remission' AND ar.document_id = dn.id
            AND ar.tenant_id = $1 AND ar.partner_id = $2
            AND ar.status = ANY($3::ar_status[])`,
        [tenantId, partnerId, OPEN_STATUSES]
      )
    }

    if (doSupplier) {
      const { rowCount } = await client.query(
        `UPDATE accounts_payable ap
            SET due_date = ap.issue_date + ($4::int)
          WHERE ap.tenant_id = $1 AND ap.partner_id = $2
            AND ap.status = ANY($3::ar_status[])
            AND EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.id = ap.document_id)`,
        [tenantId, partnerId, OPEN_STATUSES, supplierDays]
      )
      supplierUpdated = rowCount

      await client.query(
        `UPDATE supplier_invoices si SET due_date = ap.due_date
           FROM accounts_payable ap
          WHERE ap.document_id = si.id
            AND ap.tenant_id = $1 AND ap.partner_id = $2
            AND ap.status = ANY($3::ar_status[])`,
        [tenantId, partnerId, OPEN_STATUSES]
      )
    }
  })

  await audit({
    tenantId, userId, action: 'financials.credit_terms_applied',
    resource: 'business_partners', resourceId: partnerId,
    payload: {
      sides, credit_type: partner.credit_type, credit_days: partner.credit_days,
      supplier_credit_days: partner.supplier_credit_days,
      customer_updated: customerUpdated, supplier_updated: supplierUpdated,
    },
    ipAddress, userAgent,
  })

  return { customer_updated: customerUpdated, supplier_updated: supplierUpdated }
}

module.exports = { previewCreditImpact, applyCreditTerms }
