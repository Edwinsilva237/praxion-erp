import api from './axios'

const B = '/fiscal-profiles'

export const fiscalProfilesApi = {
  list: () =>
    api.get(B).then(r => r.data),

  // Body completo del profile + opcional createInFacturapi:true
  create: (body) =>
    api.post(B, body).then(r => r.data),

  update: (id, body) =>
    api.patch(`${B}/${id}`, body).then(r => r.data),

  delete: (id) =>
    api.delete(`${B}/${id}`).then(r => r.data),

  // Sube el PDF de la CSF y devuelve los datos extraídos para pre-llenar el form.
  parseCsf: (pdfFile) => {
    const form = new FormData()
    form.append('file', pdfFile)
    return api.post(`${B}/parse-csf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  // Form-data: cer (file), key (file), password (string)
  uploadCertificate: (id, cer, key, password) => {
    const form = new FormData()
    form.append('cer', cer)
    form.append('key', key)
    form.append('password', password)
    return api.post(`${B}/${id}/certificate`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  // Re-vincula a una organization NUEVA en Facturapi (cuando el cliente
  // borró su org en el dashboard y el emisor en BD quedó huérfano).
  relinkFacturapi: (id) =>
    api.post(`${B}/${id}/relink-facturapi`).then(r => r.data),
}
