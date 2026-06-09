import api from './axios'

const B = '/purchases'

export const purchasesApi = {
  // ── Órdenes de compra ──────────────────────────────────────────────────
  listOrders:     (p) => api.get(`${B}/orders`, { params: p }).then(r => r.data),
  getOrder:       (id) => api.get(`${B}/orders/${id}`).then(r => r.data),
  createOrder:    (body) => api.post(`${B}/orders`, body).then(r => r.data),
  updateOrder:    (id, body) => api.patch(`${B}/orders/${id}`, body).then(r => r.data),
  authorizeOrder: (id) => api.post(`${B}/orders/${id}/confirm`).then(r => r.data),
  sendOrder:      (id) => api.patch(`${B}/orders/${id}`, { status: 'sent' }).then(r => r.data),
  cancelOrder:    (id, body) => api.post(`${B}/orders/${id}/cancel`, body).then(r => r.data),

  // ── Precios por proveedor (precarga de OC) ──────────────────────────────
  suggestedSupplierPrice: (supplierId, itemType, itemId, currency = 'MXN') =>
    api.get(`${B}/suggested-price`, { params: { supplierId, itemType, itemId, currency } }).then(r => r.data),
  listSupplierPrices:  (params) => api.get(`${B}/supplier-prices`, { params }).then(r => r.data),
  upsertSupplierPrice: (body) => api.post(`${B}/supplier-prices`, body).then(r => r.data),
  deleteSupplierPrice: (id) => api.delete(`${B}/supplier-prices/${id}`).then(r => r.data),

  // PDF de la OC (control interno, no fiscal)
  downloadOrderPdf: (id) =>
    api.get(`${B}/orders/${id}/pdf`, { responseType: 'blob' }).then(r => r.data),

  // PDF de la recepción con branding del tenant (incluye firma/evidencia)
  downloadReceiptPdf: (id) =>
    api.get(`${B}/receipts/${id}/pdf`, { responseType: 'blob' }).then(r => r.data),

  // ── Recepciones ────────────────────────────────────────────────────────
  listReceipts:   (p) => api.get(`${B}/receipts`, { params: p }).then(r => r.data),
  getReceipt:     (id) => api.get(`${B}/receipts/${id}`).then(r => r.data),
  createReceipt:  (body) => api.post(`${B}/receipts`, body).then(r => r.data),
  updateReceipt:  (id, body) => api.put(`${B}/receipts/${id}`, body).then(r => r.data),
  confirmReceipt: (id) => api.post(`${B}/receipts/${id}/confirm`).then(r => r.data),
  cancelReceipt:  (id, body) => api.post(`${B}/receipts/${id}/cancel`, body).then(r => r.data),
  listPendingInvoiceReceipts: (partnerId) =>
    api.get(`${B}/receipts/pending-invoice`, { params: partnerId ? { partner_id: partnerId } : {} }).then(r => r.data),

  // Evidencia
  uploadEvidence: (id, formData) =>
    api.post(`${B}/receipts/${id}/evidence`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  getEvidenceUrl: (id) => `${B}/receipts/${id}/evidence`,

  // ── Facturas proveedor ─────────────────────────────────────────────────
  listInvoices:  (p) => api.get(`${B}/invoices`, { params: p }).then(r => r.data),
  getInvoice:    (id) => api.get(`${B}/invoices/${id}`).then(r => r.data),
  createInvoice: (body) => api.post(`${B}/invoices`, body).then(r => r.data),
  // Parsea un documento de proveedor (XML CFDI o PDF) → datos extraídos +
  // proveedor encontrado por RFC. Campo de archivo 'file'. Vía axios (NO fetch
  // nativo) para que use el baseURL correcto + headers de auth/tenant en prod.
  parseDocument: (formData) =>
    api.post(`${B}/parse-document`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),

  // Adjuntos (respaldo XML/PDF) de una factura de proveedor.
  listInvoiceAttachments: (id) =>
    api.get(`${B}/invoices/${id}/attachments`).then(r => r.data),
  addInvoiceAttachment: (id, formData) =>
    api.post(`${B}/invoices/${id}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  downloadInvoiceAttachment: (id, attId) =>
    api.get(`${B}/invoices/${id}/attachments/${attId}/download`, { responseType: 'blob' }).then(r => r.data),

  // ── Gastos (módulo de Gastos, Fase 1) ──────────────────────────────────
  listExpenses:  (p) => api.get(`${B}/expenses`, { params: p }).then(r => r.data),
  createExpense: (body) => api.post(`${B}/expenses`, body).then(r => r.data),

  // ── Devoluciones a proveedor (Fase 1) ──────────────────────────────────
  listReturnReasons: (includeInactive = false) =>
    api.get(`${B}/return-reasons`, { params: includeInactive ? { includeInactive: 'true' } : {} }).then(r => r.data),
  createReturnReason: (body) => api.post(`${B}/return-reasons`, body).then(r => r.data),
  updateReturnReason: (id, body) => api.patch(`${B}/return-reasons/${id}`, body).then(r => r.data),
  listReturnableLots: (params) => api.get(`${B}/returnable-lots`, { params }).then(r => r.data),
  listReturns:   (p) => api.get(`${B}/returns`, { params: p }).then(r => r.data),
  getReturn:     (id) => api.get(`${B}/returns/${id}`).then(r => r.data),
  createReturn:  (body) => api.post(`${B}/returns`, body).then(r => r.data),
  confirmReturn: (id) => api.post(`${B}/returns/${id}/confirm`).then(r => r.data),
  cancelReturn:  (id) => api.post(`${B}/returns/${id}/cancel`).then(r => r.data),
  // Fase 2: resolución fiscal del CFDI (nota de crédito / cancelación / sustitución).
  resolveReturn: (id, body) => api.post(`${B}/returns/${id}/resolve`, body).then(r => r.data),
}
