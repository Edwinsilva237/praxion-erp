import api from './axios'

const B = '/sales'

export const salesApi = {
  // ── Pedidos ────────────────────────────────────────────────────────────
  listOrders:      (p) => api.get(`${B}/orders`, { params: p }).then(r => r.data),
  getOrder:        (id) => api.get(`${B}/orders/${id}`).then(r => r.data),
  createOrder:     (body) => api.post(`${B}/orders`, body).then(r => r.data),
  updateOrder:     (id, body) => api.patch(`${B}/orders/${id}`, body).then(r => r.data),
  confirmOrder:    (id) => api.post(`${B}/orders/${id}/confirm`).then(r => r.data),
  cancelOrder:     (id, body) => api.post(`${B}/orders/${id}/cancel`, body).then(r => r.data),
  assignDriver:    (id, body) => api.post(`${B}/orders/${id}/assign-driver`, body).then(r => r.data),
  suggestedPrice:  (partnerId, productId, orderCurrency = 'MXN') =>
    api.get(`${B}/suggested-price`, { params: { partnerId, productId, orderCurrency } }).then(r => r.data),
  pendingQuantities: (orderId) =>
    api.get(`${B}/orders/${orderId}/pending-quantities`).then(r => r.data),

  // Líneas de pedido (draft)
  addLine:    (orderId, body) => api.post(`${B}/orders/${orderId}/lines`, body).then(r => r.data),
  updateLine: (orderId, lineId, body) =>
    api.patch(`${B}/orders/${orderId}/lines/${lineId}`, body).then(r => r.data),
  deleteLine: (orderId, lineId) =>
    api.delete(`${B}/orders/${orderId}/lines/${lineId}`).then(r => r.data),

  // ── Remisiones ─────────────────────────────────────────────────────────
  listDeliveryNotes:  (p) => api.get(`${B}/delivery-notes`, { params: p }).then(r => r.data),
  getDeliveryNote:    (id) => api.get(`${B}/delivery-notes/${id}`).then(r => r.data),
  createDeliveryNote: (body) => api.post(`${B}/delivery-notes`, body).then(r => r.data),
  sendEmail:          (id, emails) =>
    api.post(`${B}/delivery-notes/${id}/send-email`, emails ? { emails } : {}).then(r => r.data),
  downloadPdf:        (id) =>
    api.get(`${B}/delivery-notes/${id}/pdf`, { responseType: 'blob' }),
  setNoInvoice:       (id, noInvoice) =>
    api.post(`${B}/delivery-notes/${id}/no-invoice`, { noInvoice }).then(r => r.data),
  recordDelivery:     (id, formData) =>
    api.post(`${B}/delivery-notes/${id}/deliver`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  cancelDeliveryNote: (id, body) =>
    api.post(`${B}/delivery-notes/${id}/cancel`, body || {}).then(r => r.data),
}
