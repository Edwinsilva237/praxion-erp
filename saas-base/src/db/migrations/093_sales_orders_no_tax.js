'use strict'

/**
 * Pedidos (sales_orders) NO llevan IVA.
 *
 * Decisión de producto: el pedido es un documento pre-fiscal (no es CFDI).
 * Hay pedidos que nunca se facturan (clientes que pagan sin requerir CFDI,
 * pedidos cancelados, pedidos consolidados en otra factura). Mostrar IVA en
 * el pedido genera expectativa errónea de cobro.
 *
 * El IVA se calcula automáticamente en `invoiceService` al momento de timbrar
 * la factura (CFDI), desde las líneas — no depende de tax_mxn del pedido.
 *
 * Esta migración:
 *   - Reescribe tax_mxn = 0 y total_mxn = subtotal_mxn en todos los pedidos
 *     existentes (datos legacy con IVA precalculado).
 *
 * Las columnas se conservan para compatibilidad con queries existentes y por
 * si en el futuro se quiere reactivar IVA en órdenes para algún flujo.
 */

const up = `
  UPDATE sales_orders
     SET tax_mxn   = 0,
         total_mxn = subtotal_mxn;
`

// No hay down razonable: no podemos recalcular el IVA original sin tasa
// histórica. Si hace falta revertir, se vuelve a 0.16 * subtotal.
const down = `
  UPDATE sales_orders
     SET tax_mxn   = subtotal_mxn * 0.16,
         total_mxn = subtotal_mxn * 1.16;
`

module.exports = { up, down }
