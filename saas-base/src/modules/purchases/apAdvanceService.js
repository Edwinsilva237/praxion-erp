'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Registra un anticipo a proveedor (saldo a favor del tenant que se aplicará
 * a futuras facturas/remisiones).
 *
 * Casos típicos:
 *   - Adelanto contra OC (50% al firmar).
 *   - Depósito o prepago en importaciones.
 *   - Sobre-pago accidental.
 *
 * Si nace del sobrante de un pago aplicado a facturas, pasar
 * `supplierPaymentId` para mantener trazabilidad.
 */
async function registerAdvance({
  tenantId, partnerId,
  amount, currency = 'MXN',
  paymentMethod, reference,
  bankAccountId = null, paymentDate,
  supplierPaymentId = null, notes,
  userId, ipAddress, userAgent,
  client: existingClient,  // permite reusar tx desde registerPayment
}) {
  const exec = async (client) => {
    if (!partnerId) throw createError(400, 'partnerId es requerido para registrar anticipo.')
    if (!amount || amount <= 0) throw createError(400, 'amount debe ser mayor a cero.')
    if (!paymentMethod) throw createError(400, 'paymentMethod es requerido.')
    if (paymentMethod === 'check' && !reference) {
      throw createError(400, 'El número de cheque es requerido.')
    }

    if (bankAccountId) {
      const { rows: baRows } = await client.query(
        `SELECT id FROM bank_accounts WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
        [bankAccountId, tenantId]
      )
      if (!baRows.length) throw createError(400, 'La cuenta bancaria no existe o está inactiva.')
    }

    const { rows } = await client.query(
      `INSERT INTO ap_advances
         (tenant_id, partner_id, amount, currency,
          payment_method, reference, bank_account_id, payment_date,
          supplier_payment_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [tenantId, partnerId, amount, currency,
       paymentMethod, reference || null, bankAccountId || null,
       paymentDate || new Date().toISOString().split('T')[0],
       supplierPaymentId || null, notes || null, userId]
    )
    const advance = rows[0]

    await audit({
      tenantId, userId, action: 'ap_advance.registered',
      resource: 'ap_advances', resourceId: advance.id,
      payload: { partnerId, amount, currency, paymentMethod, supplierPaymentId },
      ipAddress, userAgent,
    })
    return advance
  }
  return existingClient ? exec(existingClient) : withTransaction(exec)
}

/**
 * Aplica un anticipo existente a un AP (factura/remisión de proveedor).
 * Crea supplier_payment con method='advance_application' por la porción
 * aplicada (sin salida real de dinero), lo asocia al AP y actualiza saldos.
 *
 * Body:
 *   advanceId   — anticipo origen
 *   apId        — AP destino
 *   amount      — monto a aplicar (no excede ni saldo de anticipo ni pendiente de AP)
 */
async function applyAdvance({
  tenantId, advanceId, apId, amount,
  userId, ipAddress, userAgent,
  client: existingClient,
}) {
  const exec = async (client) => {
    if (!amount || amount <= 0) throw createError(400, 'amount debe ser mayor a cero.')

    const { rows: advRows } = await client.query(
      `SELECT id, partner_id, currency, amount, amount_applied, amount_available
         FROM ap_advances WHERE id = $1 AND tenant_id = $2`,
      [advanceId, tenantId]
    )
    if (!advRows.length) throw createError(404, 'Anticipo no encontrado.')
    const adv = advRows[0]
    const available = parseFloat(adv.amount_available)
    if (available <= 0) throw createError(400, 'El anticipo no tiene saldo disponible.')

    const { rows: apRows } = await client.query(
      `SELECT id, partner_id, currency, amount_total, amount_paid, amount_pending, status
         FROM accounts_payable WHERE id = $1 AND tenant_id = $2`,
      [apId, tenantId]
    )
    if (!apRows.length) throw createError(404, 'CXP no encontrado.')
    const ap = apRows[0]

    if (ap.partner_id !== adv.partner_id) {
      throw createError(400, 'El anticipo es de otro proveedor.')
    }
    if (ap.status === 'paid' || ap.status === 'cancelled') {
      throw createError(400, 'El CXP ya está pagado o cancelado.')
    }
    if (ap.currency !== adv.currency) {
      throw createError(400, 'Monedas distintas entre anticipo y CXP.')
    }

    const toApply = Math.min(
      parseFloat(amount),
      available,
      parseFloat(ap.amount_pending)
    )
    if (toApply <= 0.001) throw createError(400, 'No hay monto válido a aplicar.')

    // 1. Crear supplier_payment con method='advance_application'
    const { rows: payRows } = await client.query(
      `INSERT INTO supplier_payments
         (tenant_id, partner_id, payment_date,
          method, reference, amount, currency, exchange_rate_value, amount_mxn,
          notes, created_by)
       VALUES ($1,$2,CURRENT_DATE,
               'advance_application'::ap_payment_method, $3, $4, $5, 1, $4,
               $6, $7)
       RETURNING *`,
      [tenantId, adv.partner_id,
       `Anticipo ${advanceId.slice(0, 8)}`,
       toApply, ap.currency,
       `Aplicación de anticipo ${advanceId}`, userId]
    )
    const payment = payRows[0]

    // 2. Crear application contra la supplier_invoice del AP
    await client.query(
      `INSERT INTO supplier_payment_applications
         (supplier_payment_id, supplier_invoice_id, amount_applied, created_by)
       SELECT $1, si.id, $2, $3
         FROM supplier_invoices si
         JOIN accounts_payable ap ON ap.document_id = si.id
        WHERE ap.id = $4`,
      [payment.id, toApply, userId, apId]
    )

    // 3. Actualizar AP
    const newPaid   = parseFloat(ap.amount_paid) + toApply
    const newStatus = newPaid >= parseFloat(ap.amount_total) ? 'paid' : 'partial'
    await client.query(
      `UPDATE accounts_payable SET amount_paid = $1, status = $2 WHERE id = $3`,
      [newPaid, newStatus, apId]
    )

    // 4. Actualizar supplier_invoice.balance
    await client.query(
      `UPDATE supplier_invoices
         SET balance = balance - $1,
             status  = CASE WHEN balance - $1 <= 0
                            THEN 'paid'::supplier_invoice_status
                            ELSE 'partial'::supplier_invoice_status END
       WHERE id = (SELECT document_id FROM accounts_payable WHERE id = $2)`,
      [toApply, apId]
    )

    // 5. Aumentar amount_applied del anticipo
    await client.query(
      `UPDATE ap_advances SET amount_applied = amount_applied + $1 WHERE id = $2`,
      [toApply, advanceId]
    )

    await audit({
      tenantId, userId, action: 'ap_advance.applied',
      resource: 'ap_advances', resourceId: advanceId,
      payload: { apId, amount: toApply, paymentId: payment.id },
      ipAddress, userAgent,
    })

    return { advance_id: advanceId, ap_id: apId, applied: toApply, payment_id: payment.id }
  }
  return existingClient ? exec(existingClient) : withTransaction(exec)
}

/**
 * Lista anticipos de un proveedor.
 *
 * Filtros:
 *   onlyAvailable: si true, solo anticipos con saldo > 0.
 */
async function listAdvances({ tenantId, partnerId, onlyAvailable = false }) {
  const filters = ['ap.tenant_id = $1']
  const params  = [tenantId]
  if (partnerId)     { params.push(partnerId);   filters.push(`ap.partner_id = $${params.length}`) }
  if (onlyAvailable) { filters.push('ap.amount_applied < ap.amount') }

  const { rows } = await query(
    `SELECT ap.id, ap.partner_id, ap.amount, ap.amount_applied, ap.amount_available,
            ap.currency, ap.payment_method, ap.reference,
            ap.payment_date, ap.notes, ap.created_at,
            bp.name AS partner_name,
            ba.bank_name, ba.alias AS bank_alias, ba.account_number AS bank_account_number,
            u.full_name AS created_by_name
       FROM ap_advances ap
       JOIN business_partners bp  ON bp.id = ap.partner_id
       LEFT JOIN bank_accounts ba ON ba.id = ap.bank_account_id
       LEFT JOIN users u          ON u.id  = ap.created_by
      WHERE ${filters.join(' AND ')}
      ORDER BY ap.payment_date DESC, ap.created_at DESC`,
    params
  )
  return rows
}

async function getSupplierAdvanceSummary({ tenantId, partnerId }) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(amount_available), 0)::numeric AS total_available,
       COUNT(*) FILTER (WHERE amount_applied < amount)::int AS active_count
       FROM ap_advances
      WHERE tenant_id = $1 AND partner_id = $2`,
    [tenantId, partnerId]
  )
  return rows[0] || { total_available: 0, active_count: 0 }
}

module.exports = {
  registerAdvance, applyAdvance, listAdvances, getSupplierAdvanceSummary,
}
