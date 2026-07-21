import api from './axios'

const B = '/communications'

export const communicationsApi = {
  // Clientes + proveedores con correo (para el selector de audiencia).
  getRecipients: () => api.get(`${B}/recipients`).then(r => r.data),

  // Enviar un comunicado. `formData` = FormData con subject, message?, category?,
  // clientIds (JSON[]), supplierIds (JSON[]), manualEmails?, files[].
  // Responde al instante: el fan-out corre en segundo plano (status 'queued').
  send: (formData) =>
    api.post(`${B}/send`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then(r => r.data),

  // Historial. `category` (opcional) filtra por categoría.
  listSends: (category) =>
    api.get(`${B}/sends`, { params: category ? { category } : undefined }).then(r => r.data),
  getSend: (id) => api.get(`${B}/sends/${id}`).then(r => r.data),

  // Descarga un adjunto de un comunicado (blob → abrir/guardar).
  downloadAttachment: (sendId, attachmentId) =>
    api.get(`${B}/sends/${sendId}/attachments/${attachmentId}/download`, { responseType: 'blob' })
      .then(r => r.data),

  // ── Plantillas / borradores ────────────────────────────────────────────────
  listTemplates: () => api.get(`${B}/templates`).then(r => r.data),
  createTemplate: (data) => api.post(`${B}/templates`, data).then(r => r.data),
  updateTemplate: (id, data) => api.put(`${B}/templates/${id}`, data).then(r => r.data),
  deleteTemplate: (id) => api.delete(`${B}/templates/${id}`).then(r => r.data),

  // ── Categorías configurables por tenant ─────────────────────────────────────
  listCategories: (activeOnly = false) =>
    api.get(`${B}/categories`, { params: activeOnly ? { activeOnly: true } : undefined }).then(r => r.data),
  createCategory: (data) => api.post(`${B}/categories`, data).then(r => r.data),
  updateCategory: (id, data) => api.put(`${B}/categories/${id}`, data).then(r => r.data),
  deleteCategory: (id) => api.delete(`${B}/categories/${id}`).then(r => r.data),
}
