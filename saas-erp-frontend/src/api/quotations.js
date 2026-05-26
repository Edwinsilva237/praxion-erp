import api from './axios'

export const quotationsApi = {
  // Listado con filtros
  list: (params) => api.get('/quotations', { params }).then(r => r.data),

  // Detalle (incluye líneas)
  get: (id) => api.get(`/quotations/${id}`).then(r => r.data),

  // Crear (draft con líneas)
  create: (payload) => api.post('/quotations', payload).then(r => r.data),

  // Actualizar datos generales (solo draft)
  update: (id, payload) => api.patch(`/quotations/${id}`, payload).then(r => r.data),

  // Líneas (solo draft)
  addLine:    (id, payload)         => api.post(`/quotations/${id}/lines`, payload).then(r => r.data),
  updateLine: (id, lineId, payload) => api.patch(`/quotations/${id}/lines/${lineId}`, payload).then(r => r.data),
  deleteLine: (id, lineId)          => api.delete(`/quotations/${id}/lines/${lineId}`).then(r => r.data),

  // Contactos del cliente (para modal de envío)
  contacts: (id) => api.get(`/quotations/${id}/contacts`).then(r => r.data),

  // PDF (blob)
  downloadPdf: (id) => api.get(`/quotations/${id}/pdf`, { responseType: 'blob' }),

  // Transiciones — `payload` admite { emails: string[] } o { skipEmail: true }
  send:    (id, payload = {}) => api.post(`/quotations/${id}/send`, payload).then(r => r.data),
  accept:  (id)          => api.post(`/quotations/${id}/accept`).then(r => r.data),
  convert: (id)          => api.post(`/quotations/${id}/convert`).then(r => r.data),
  reject:  (id, reason)  => api.post(`/quotations/${id}/reject`, { reason }).then(r => r.data),
  cancel:  (id)          => api.post(`/quotations/${id}/cancel`).then(r => r.data),
}
