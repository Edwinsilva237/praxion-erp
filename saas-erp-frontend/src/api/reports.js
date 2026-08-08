import api from './axios'

const B = '/reports'

export const reportsApi = {
  /**
   * Descarga el reporte contable mensual en Excel.
   * from/to en formato YYYY-MM-DD. `to` es exclusivo.
   * fiscalOnly (default true): excluye borradores y registros sin CFDI.
   */
  downloadAccounting: ({ from, to, fiscalOnly = true }) =>
    api.get(`${B}/accounting`, {
      params: { from, to, fiscalOnly: fiscalOnly ? 'true' : 'false' },
      responseType: 'blob',
    }),

  /**
   * Paquete contable del periodo en ZIP: todos los XML fiscales (emitidos,
   * recibidos, cancelados) + el Reporte Contable en Excel adentro.
   * from/to en formato YYYY-MM-DD. `to` es exclusivo.
   */
  downloadAccountingPackage: ({ from, to }) =>
    api.get(`${B}/accounting-package`, {
      params: { from, to },
      responseType: 'blob',
    }),

  /**
   * Trazabilidad de ventas: expediente de cada factura emitida (pedido,
   * remisiones, devoluciones/NC, cancelación, cobros y complementos).
   * onlyIssues deja solo los expedientes que hay que revisar.
   */
  getSalesTraceability: ({ from, to, partnerId, onlyIssues }) =>
    api.get(`${B}/sales-traceability`, {
      params: { from, to, partnerId, onlyIssues: onlyIssues ? 'true' : undefined },
    }).then(r => r.data),

  /** Excel de la trazabilidad de ventas (siempre con todos los expedientes). */
  downloadSalesTraceabilityExcel: ({ from, to, partnerId }) =>
    api.get(`${B}/sales-traceability/excel`, { params: { from, to, partnerId }, responseType: 'blob' }),

  /**
   * Cuadre fiscal del periodo: universo de CFDI (emitidos, recibidos y REP) e
   * incidencias que impiden cerrar el mes. from inclusivo, to exclusivo.
   */
  getFiscalReconciliation: ({ from, to }) =>
    api.get(`${B}/fiscal-reconciliation`, { params: { from, to } }).then(r => r.data),

  /** Excel del cuadre fiscal: resumen + una fila por incidencia. */
  downloadFiscalReconciliationExcel: ({ from, to }) =>
    api.get(`${B}/fiscal-reconciliation/excel`, { params: { from, to }, responseType: 'blob' }),

  /**
   * Snapshot financiero del mes en curso (o el indicado en YYYY-MM).
   * Devuelve { period, sales, iva }. Pensado para refresco frecuente (60s).
   */
  getFinancialSnapshot: (month) =>
    api.get(`${B}/financial-snapshot`, {
      params: month ? { month } : {},
    }).then(r => r.data),

  /**
   * Reporte de ventas con todas las vistas (cliente, producto, metros,
   * utilidades, comparativa, tendencia). from inclusivo, to exclusivo.
   */
  getSalesReport: ({ from, to }) =>
    api.get(`${B}/sales`, { params: { from, to } }).then(r => r.data),

  /**
   * Detalle de facturas y remisiones de una fila clickeada (cliente o producto)
   * para el periodo seleccionado.
   */
  getSalesDetail: ({ type, id, from, to }) =>
    api.get(`${B}/sales/detail`, { params: { type, id, from, to } }).then(r => r.data),

  /** Excel multi-hoja para análisis financiero. */
  downloadSalesExcel: ({ from, to }) =>
    api.get(`${B}/sales/excel`, { params: { from, to }, responseType: 'blob' }),

  /** PDF ejecutivo con marca del tenant, para presentar a socios. */
  downloadSalesPdf: ({ from, to }) =>
    api.get(`${B}/sales/pdf`, { params: { from, to }, responseType: 'blob' }),

  /**
   * Reporte de producción con todas las vistas (por producto, por operador,
   * mermas, costos, eficiencia, tendencia). from inclusivo, to exclusivo.
   */
  getProductionReport: ({ from, to }) =>
    api.get(`${B}/production`, { params: { from, to } }).then(r => r.data),

  /** Excel multi-hoja del reporte de producción. */
  downloadProductionExcel: ({ from, to }) =>
    api.get(`${B}/production/excel`, { params: { from, to }, responseType: 'blob' }),

  /** PDF ejecutivo de producción con marca del tenant. */
  downloadProductionPdf: ({ from, to }) =>
    api.get(`${B}/production/pdf`, { params: { from, to }, responseType: 'blob' }),

  // ── Inventario — valor y existencias a la fecha o AL CIERRE DE MES ───────
  // countId (opcional) → valuación reconstruida de la foto de ese conteo.
  /** Snapshot de existencias y valor del inventario (JSON). */
  getInventoryReport: (countId = null) =>
    api.get(`${B}/inventory`, { params: countId ? { countId } : {} }).then(r => r.data),

  /** Excel multi-hoja del inventario. */
  downloadInventoryExcel: (countId = null) =>
    api.get(`${B}/inventory/excel`, { params: countId ? { countId } : {}, responseType: 'blob' }),

  /** PDF ejecutivo del inventario con gráficos. */
  downloadInventoryPdf: (countId = null) =>
    api.get(`${B}/inventory/pdf`, { params: countId ? { countId } : {}, responseType: 'blob' }),

  // ── Trazabilidad de compras — expediente OC → factura → pagos → REP ──────
  /** Expedientes del periodo con todos sus eventos. `to` exclusivo. */
  getPurchaseTraceability: ({ from, to, partnerId }) =>
    api.get(`${B}/purchase-traceability`, {
      params: { from, to, ...(partnerId ? { partnerId } : {}) },
    }).then(r => r.data),

  /** Excel de la cadena documental (una fila por evento). */
  downloadPurchaseTraceabilityExcel: ({ from, to, partnerId }) =>
    api.get(`${B}/purchase-traceability/excel`, {
      params: { from, to, ...(partnerId ? { partnerId } : {}) },
      responseType: 'blob',
    }),

  // ── Estado de cuenta — CXC / CXP ────────────────────────────────────────
  // `direction` debe ser 'cuentas-por-cobrar' o 'cuentas-por-pagar'.
  // `filters`: { partnerId, statusFilter, search } — todos opcionales.

  /** Snapshot completo del estado de cuenta. */
  getAccountStatement: ({ direction, filters = {} }) =>
    api.get(`${B}/account-statement/${direction}`, { params: filters }).then(r => r.data),

  /** Excel con todos los documentos pendientes (acepta filtros). */
  downloadAccountStatementExcel: ({ direction, filters = {} }) =>
    api.get(`${B}/account-statement/${direction}/excel`, { params: filters, responseType: 'blob' }),

  /** PDF ejecutivo general (para socios). */
  downloadAccountStatementPdf: ({ direction, filters = {} }) =>
    api.get(`${B}/account-statement/${direction}/pdf`, { params: filters, responseType: 'blob' }),

  /** Detalle del partner (para abrir panel/modal). */
  getPartnerStatement: ({ direction, partnerId }) =>
    api.get(`${B}/account-statement/${direction}/partners/${partnerId}`).then(r => r.data),

  /** Líneas (productos + precios) de un documento del estado de cuenta. */
  getStatementDocumentLines: ({ direction, docId }) =>
    api.get(`${B}/account-statement/${direction}/documents/${docId}/lines`).then(r => r.data),

  /** Pagos aplicados a un documento del estado de cuenta. */
  getStatementDocumentPayments: ({ direction, docId }) =>
    api.get(`${B}/account-statement/${direction}/documents/${docId}/payments`).then(r => r.data),

  /** PDF individual del partner (para enviar a cobranza). */
  downloadPartnerStatementPdf: ({ direction, partnerId }) =>
    api.get(`${B}/account-statement/${direction}/partners/${partnerId}/pdf`, { responseType: 'blob' }),

  /** Envía el estado de cuenta del partner por correo. `to` opcional (autodetecta). */
  emailPartnerStatement: ({ direction, partnerId, to, cc, message }) =>
    api.post(`${B}/account-statement/${direction}/partners/${partnerId}/email`,
      { to, cc, message }).then(r => r.data),
}
