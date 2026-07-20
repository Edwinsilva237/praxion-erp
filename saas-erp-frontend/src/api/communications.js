import api from './axios'

const B = '/communications'

export const communicationsApi = {
  // Clientes + proveedores con correo (para el selector de audiencia).
  getRecipients: () => api.get(`${B}/recipients`).then(r => r.data),

  // Enviar un comunicado. `formData` = FormData con subject, message?, category?,
  // clientIds (JSON[]), supplierIds (JSON[]), manualEmails?, files[].
  send: (formData) =>
    api.post(`${B}/send`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then(r => r.data),

  listSends: () => api.get(`${B}/sends`).then(r => r.data),
  getSend: (id) => api.get(`${B}/sends/${id}`).then(r => r.data),

  // Descarga un adjunto de un comunicado (blob → abrir/guardar).
  downloadAttachment: (sendId, attachmentId) =>
    api.get(`${B}/sends/${sendId}/attachments/${attachmentId}/download`, { responseType: 'blob' })
      .then(r => r.data),
}
