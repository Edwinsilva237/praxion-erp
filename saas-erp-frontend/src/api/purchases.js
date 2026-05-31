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
}
