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
  deleteOrder:     (id) => api.delete(`${B}/orders/${id}`).then(r => r.data),
  assignDriver:    (id, body) => api.post(`${B}/orders/${id}/assign-driver`, body).then(r => r.data),
  suggestedPrice:  (partnerId, productId, orderCurrency = 'MXN') =>
    api.get(`${B}/suggested-price`, { params: { partnerId, productId, orderCurrency } }).then(r => r.data),
  pendingQuantities: (orderId) =>
    api.get(`${B}/orders/${orderId}/pending-quantities`).then(r => r.data),
  // Existencias del producto por almacén (+ niveles configurados) para el
  // indicador de stock al capturar cantidades en un pedido.
  productStockByWarehouse: (itemId, itemType = 'product') =>
    api.get(`${B}/stock/${itemType}/${itemId}`).then(r => r.data),

  // Paquetes en el pedido (draft): agregar explota el paquete en líneas
  // prorrateadas (grupo atómico); quitar elimina el grupo completo.
  addOrderBundle: (orderId, body) =>
    api.post(`${B}/orders/${orderId}/bundles`, body).then(r => r.data),
  removeOrderBundleGroup: (orderId, groupId) =>
    api.delete(`${B}/orders/${orderId}/bundle-groups/${groupId}`).then(r => r.data),

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
  downloadPdf:        (id, { showPrices = true } = {}) =>
    api.get(`${B}/delivery-notes/${id}/pdf`, {
      responseType: 'blob',
      params: showPrices ? undefined : { precios: 0 },
    }),
  setNoInvoice:       (id, noInvoice) =>
    api.post(`${B}/delivery-notes/${id}/no-invoice`, { noInvoice }).then(r => r.data),
  recordDelivery:     (id, formData) =>
    api.post(`${B}/delivery-notes/${id}/deliver`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  cancelDeliveryNote: (id, body) =>
    api.post(`${B}/delivery-notes/${id}/cancel`, body || {}).then(r => r.data),
  // Corrige precios de una remisión NO facturada (con observación obligatoria).
  // lines: [{ lineId, unitPrice, discountPct? }]
  adjustPrices: (id, { lines, reason }) =>
    api.post(`${B}/delivery-notes/${id}/adjust-prices`, { lines, reason }).then(r => r.data),
  deleteDeliveryNote: (id) =>
    api.delete(`${B}/delivery-notes/${id}`).then(r => r.data),

  // Evidencia ADITIVA de remisión (acuse/firma cuando se entrega tras facturar).
  listEvidence: (id) =>
    api.get(`${B}/delivery-notes/${id}/attachments`).then(r => r.data),
  addEvidence: (id, formData) =>
    api.post(`${B}/delivery-notes/${id}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  downloadEvidence: (id, attId) =>
    api.get(`${B}/delivery-notes/${id}/attachments/${attId}/download`, { responseType: 'blob' }).then(r => r.data),
  deleteEvidence: (id, attId) =>
    api.delete(`${B}/delivery-notes/${id}/attachments/${attId}`).then(r => r.data),
  // Quita la FOTO de evidencia del receptor (capturada al registrar la entrega).
  deletePhoto: (id) =>
    api.delete(`${B}/delivery-notes/${id}/photo`).then(r => r.data),

  // OC del cliente adjunta al pedido (documento que el cliente exige para recibir).
  listOrderPo: (orderId) =>
    api.get(`${B}/orders/${orderId}/attachments`).then(r => r.data),
  addOrderPo: (orderId, formData) =>
    api.post(`${B}/orders/${orderId}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data),
  downloadOrderPo: (orderId, attId) =>
    api.get(`${B}/orders/${orderId}/attachments/${attId}/download`, { responseType: 'blob' }).then(r => r.data),
  deleteOrderPo: (orderId, attId) =>
    api.delete(`${B}/orders/${orderId}/attachments/${attId}`).then(r => r.data),
}
