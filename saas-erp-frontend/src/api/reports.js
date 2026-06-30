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

  // ── Inventario — valor y existencias a la fecha ─────────────────────────
  /** Snapshot de existencias y valor del inventario (JSON). */
  getInventoryReport: () =>
    api.get(`${B}/inventory`).then(r => r.data),

  /** Excel multi-hoja del inventario. */
  downloadInventoryExcel: () =>
    api.get(`${B}/inventory/excel`, { responseType: 'blob' }),

  /** PDF ejecutivo del inventario con gráficos. */
  downloadInventoryPdf: () =>
    api.get(`${B}/inventory/pdf`, { responseType: 'blob' }),

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

  /** PDF individual del partner (para enviar a cobranza). */
  downloadPartnerStatementPdf: ({ direction, partnerId }) =>
    api.get(`${B}/account-statement/${direction}/partners/${partnerId}/pdf`, { responseType: 'blob' }),

  /** Envía el estado de cuenta del partner por correo. `to` opcional (autodetecta). */
  emailPartnerStatement: ({ direction, partnerId, to, cc, message }) =>
    api.post(`${B}/account-statement/${direction}/partners/${partnerId}/email`,
      { to, cc, message }).then(r => r.data),
}
