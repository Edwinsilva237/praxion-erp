import api from './axios'

const B = '/petty-cash'

export const pettyCashApi = {
  // ── Fondos ───────────────────────────────────────────────────────────────
  listFunds:  (params = {}) => api.get(`${B}/funds`, { params }).then(r => r.data),
  getFund:    (id)          => api.get(`${B}/funds/${id}`).then(r => r.data),
  createFund: (payload)     => api.post(`${B}/funds`, payload).then(r => r.data),
  updateFund: (id, payload) => api.patch(`${B}/funds/${id}`, payload).then(r => r.data),

  // ── Categorías ───────────────────────────────────────────────────────────
  listCategories:  (params = {}) => api.get(`${B}/categories`, { params }).then(r => r.data),
  createCategory:  (payload)     => api.post(`${B}/categories`, payload).then(r => r.data),
  updateCategory:  (id, payload) => api.patch(`${B}/categories/${id}`, payload).then(r => r.data),

  // ── Movimientos ──────────────────────────────────────────────────────────
  listMovements: (params = {}) => api.get(`${B}/movements`, { params }).then(r => r.data),
  getMovement:   (id)          => api.get(`${B}/movements/${id}`).then(r => r.data),
  createMovement:(payload)     => api.post(`${B}/movements`, payload).then(r => r.data),
  cancelMovement:(id, reason)  => api.post(`${B}/movements/${id}/cancel`, { reason }).then(r => r.data),

  // ── Comprobantes (attachments) ───────────────────────────────────────────
  uploadReceipt: (movementId, file, description = null) => {
    const fd = new FormData()
    fd.append('file', file)
    if (description) fd.append('description', description)
    return api.post(`${B}/movements/${movementId}/attachment`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  getReceiptUrl: (movementId) => `${api.defaults.baseURL}${B}/movements/${movementId}/attachment`,
  deleteReceipt: (movementId) => api.delete(`${B}/movements/${movementId}/attachment`).then(r => r.data),
}
