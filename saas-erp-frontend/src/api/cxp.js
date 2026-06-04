import api from './axios'

const B = '/purchases'

export const cxpApi = {
  // ── CXP ────────────────────────────────────────────────────────────────
  listCXP: (params) => api.get(`${B}/cxp`, { params }).then(r => r.data),
  getCXP:  (id)     => api.get(`${B}/cxp/${id}`).then(r => r.data),

  // Historial de pagos EMITIDOS (a proveedor). Params: partnerId, from, to, method, page, limit.
  listPayments: (params) => api.get(`${B}/payments`, { params }).then(r => r.data),

  // ── Estado de cuenta del proveedor ────────────────────────────────────
  supplierStatement: (partnerId, params) =>
    api.get(`${B}/suppliers/${partnerId}/statement`, { params }).then(r => r.data),

  // ── Pagos a proveedor ──────────────────────────────────────────────────
  // Body: { supplierId, paymentDate?, method, reference?, amount, currency?,
  //         applications: [{ apId, amountApplied }], notes? }
  registerPayment: (body) => api.post(`${B}/payments`, body).then(r => r.data),

  // ── Evidencias (attachments) de la factura proveedor ──────────────────
  // El :id acepta supplier_invoice.id O accounts_payable.id
  listAttachments: (id) =>
    api.get(`${B}/invoices/${id}/attachments`).then(r => r.data),

  uploadAttachment: (id, file, description) => {
    const form = new FormData()
    form.append('file', file)
    if (description) form.append('description', description)
    return api.post(`${B}/invoices/${id}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  downloadAttachmentUrl: (id, attachmentId) =>
    `/api/purchases/invoices/${id}/attachments/${attachmentId}/download`,

  downloadAttachment: (id, attachmentId) =>
    api.get(`${B}/invoices/${id}/attachments/${attachmentId}/download`,
      { responseType: 'blob' }),

  deleteAttachment: (id, attachmentId) =>
    api.delete(`${B}/invoices/${id}/attachments/${attachmentId}`).then(r => r.data),

  // ── Anticipos a proveedor ──────────────────────────────────────────────
  listAdvances: (params) =>
    api.get(`${B}/advances`, { params }).then(r => r.data),

  // Body: { partnerId, amount, currency?, paymentMethod, reference?,
  //         bankAccountId?, paymentDate?, notes? }
  registerAdvance: (body) =>
    api.post(`${B}/advances`, body).then(r => r.data),

  // Body: { apId, amount }
  applyAdvance: (advanceId, body) =>
    api.post(`${B}/advances/${advanceId}/apply`, body).then(r => r.data),
}
