'use strict'

const { query } = require('../../db')

/**
 * Conciliación bancaria: dado un monto recibido en el banco sin saber quién
 * lo emitió, busca combinaciones de facturas pendientes del CXC que sumen
 * (exacta o aproximadamente) ese monto.
 *
 * Heurística:
 *   1) Carga facturas con saldo pendiente (status pending|partial) en la
 *      moneda indicada.
 *   2) Las agrupa por cliente — el caso típico es que un cliente paga uno
 *      o varios de sus pendientes; rara vez se mezclan clientes en un
 *      mismo depósito.
 *   3) Por cliente busca combinaciones de tamaño 1..maxComb (default 3)
 *      cuyo `amount_pending` sume el monto buscado (tolerancia configurable
 *      en centavos para absorber redondeos del banco).
 *   4) Marca como `partial` la(s) factura(s) cuyo saldo pendiente exceda
 *      el monto — el operador podría aplicar el pago parcial.
 *
 * Rangos:
 *   - Combinatoria limitada a tamaño ≤ 3 por cliente. Con 20 facturas
 *     por cliente: 20 + 190 + 1140 ≈ 1350 sumas/cliente, barato.
 *   - Pre-orden por `amount_pending` descendente para podar combinaciones
 *     cuyo elemento ya excede el target.
 *
 * @param {object}  params
 * @param {string}  params.tenantId
 * @param {number}  params.amount             - Monto recibido en el banco
 * @param {string}  [params.currency='MXN']
 * @param {number}  [params.tolerance=0.5]    - Tolerancia en la moneda (default 50¢)
 * @param {string}  [params.partnerId]        - Filtra a un solo cliente sospechoso
 * @param {number}  [params.maxComb=3]        - Tamaño máximo de combinación
 */
async function findMatches({
  tenantId, amount, currency = 'MXN',
  tolerance = 0.5, partnerId, maxComb = 3,
}) {
  const target = parseFloat(amount)
  if (!target || target <= 0) throw createError(400, 'amount debe ser mayor a cero.')
  const tol = parseFloat(tolerance)

  const params = [tenantId, currency]
  let where = `ar.tenant_id = $1 AND ar.currency = $2
               AND ar.document_type = 'invoice'
               AND ar.status IN ('pending','partial')
               AND ar.amount_pending > 0`
  if (partnerId) {
    params.push(partnerId)
    where += ` AND ar.partner_id = $${params.length}`
  }

  const { rows: invoices } = await query(
    `SELECT ar.id AS ar_id, ar.document_number, ar.document_id AS invoice_id,
            ar.amount_total, ar.amount_paid, ar.amount_pending,
            ar.issue_date, ar.due_date,
            ar.partner_id,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            inv.payment_method AS invoice_payment_method
       FROM accounts_receivable ar
       JOIN business_partners bp ON bp.id = ar.partner_id
       LEFT JOIN invoices inv     ON inv.id = ar.document_id
      WHERE ${where}
      ORDER BY ar.partner_id, ar.due_date ASC`,
    params
  )

  // Agrupar por cliente
  const byPartner = new Map()
  for (const inv of invoices) {
    inv.amount_pending = parseFloat(inv.amount_pending)
    if (!byPartner.has(inv.partner_id)) {
      byPartner.set(inv.partner_id, {
        partner_id:   inv.partner_id,
        partner_name: inv.partner_name,
        partner_rfc:  inv.partner_rfc,
        invoices:     [],
      })
    }
    byPartner.get(inv.partner_id).invoices.push(inv)
  }

  const matches = []

  for (const group of byPartner.values()) {
    // Ordenar desc por saldo para podar combinaciones que ya exceden el target
    const invs = [...group.invoices].sort((a, b) => b.amount_pending - a.amount_pending)

    // ── 1) Coincidencia exacta de 1 factura ───────────────────────────
    for (const inv of invs) {
      const diff = Math.abs(inv.amount_pending - target)
      if (diff <= tol) {
        matches.push({
          match_type: 'exact_single',
          score:      1000 - diff,           // ranking: cuanto menor diff, mayor score
          diff,
          total:      inv.amount_pending,
          partner_id:   group.partner_id,
          partner_name: group.partner_name,
          partner_rfc:  group.partner_rfc,
          invoices: [oneInvoice(inv, inv.amount_pending)],
        })
      }
    }

    // ── 2) Combinaciones de 2..maxComb ────────────────────────────────
    if (maxComb >= 2 && invs.length >= 2) {
      // Búsqueda recursiva con poda
      const partial = []
      const seen = new Set()

      function search(startIdx, sum, picked) {
        if (picked.length >= 2) {
          const diff = Math.abs(sum - target)
          if (diff <= tol) {
            const key = picked.map(p => p.ar_id).sort().join(',')
            if (!seen.has(key)) {
              seen.add(key)
              matches.push({
                match_type: picked.length === 2 ? 'exact_pair' : 'exact_triple',
                score:      900 - diff - picked.length,
                diff,
                total:      sum,
                partner_id:   group.partner_id,
                partner_name: group.partner_name,
                partner_rfc:  group.partner_rfc,
                invoices: picked.map(p => oneInvoice(p, p.amount_pending)),
              })
            }
          }
        }
        if (picked.length >= maxComb) return
        for (let i = startIdx; i < invs.length; i++) {
          const next = sum + invs[i].amount_pending
          // Poda: si ya pasamos el target + tolerancia, no sigue
          if (next > target + tol) continue
          picked.push(invs[i])
          search(i + 1, next, picked)
          picked.pop()
        }
      }
      search(0, 0, [])
    }

    // ── 3) Match parcial: 1 factura cuyo saldo cubre el monto ─────────
    // Útil cuando el cliente abona parte de una factura grande.
    if (matches.filter(m => m.partner_id === group.partner_id).length === 0) {
      for (const inv of invs) {
        if (inv.amount_pending > target + tol) {
          matches.push({
            match_type: 'partial',
            score:      500 - (inv.amount_pending - target) / 1000,
            diff:       null,
            total:      target,
            partner_id:   group.partner_id,
            partner_name: group.partner_name,
            partner_rfc:  group.partner_rfc,
            invoices: [oneInvoice(inv, target)],
          })
        }
      }
    }
  }

  // Sort por score desc, luego por número de facturas asc (preferir el match
  // más simple), y limitar resultados.
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.invoices.length - b.invoices.length
  })

  return {
    target,
    currency,
    tolerance: tol,
    searched_invoices: invoices.length,
    searched_partners: byPartner.size,
    matches: matches.slice(0, 30),
  }
}

function oneInvoice(inv, amountToApply) {
  return {
    ar_id:           inv.ar_id,
    invoice_id:      inv.invoice_id,
    document_number: inv.document_number,
    amount_total:    parseFloat(inv.amount_total),
    amount_pending:  parseFloat(inv.amount_pending),
    amount_to_apply: parseFloat(parseFloat(amountToApply).toFixed(2)),
    issue_date:      inv.issue_date,
    due_date:        inv.due_date,
    payment_method:  inv.invoice_payment_method,
  }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { findMatches }
