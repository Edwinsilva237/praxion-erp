import api from './axios'

const B = '/fiscal-distribution'

export const fiscalDistributionApi = {
  // Documentos fiscales del tenant (CSF + Opinión 32-D)
  getDocs: () =>
    api.get(`${B}/docs`).then(r => r.data),

  // docType = 'csf' | 'opinion'
  uploadDoc: (docType, file) => {
    const form = new FormData()
    form.append('file', file)
    return api.post(`${B}/docs/${docType}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  deleteDoc: (docType) =>
    api.delete(`${B}/docs/${docType}`).then(r => r.data),

  // Descarga el PDF cargado como blob (para abrirlo en una pestaña nueva).
  downloadDoc: (docType) =>
    api.get(`${B}/docs/${docType}/file`, { responseType: 'blob' }).then(r => r.data),

  // Preview de destinatarios. partnerIds opcional (si falta = todos los activos).
  preview: (partnerIds) =>
    api.post(`${B}/preview`, partnerIds ? { partnerIds } : {}).then(r => r.data),

  // Enviar. { partnerIds?, subject?, message? }
  send: (body) =>
    api.post(`${B}/send`, body || {}).then(r => r.data),

  // Historial de envíos
  listSends: () =>
    api.get(`${B}/sends`).then(r => r.data),

  getSend: (id) =>
    api.get(`${B}/sends/${id}`).then(r => r.data),
}
