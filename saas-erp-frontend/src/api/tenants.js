import api from './axios'

const B = '/tenants'

export const tenantsApi = {
  getCurrent: () => api.get(`${B}/current`).then(r => r.data),
  updateCurrent: (body) => api.patch(`${B}/current`, body).then(r => r.data),

  // Branding del tenant — sube/elimina logo. El nombre comercial se actualiza
  // con updateCurrent({ displayName }).
  uploadLogo: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post(`${B}/current/logo`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },
  deleteLogo: () => api.delete(`${B}/current/logo`).then(r => r.data),

  // Sincroniza logo + colores con Facturapi (el PDF del CFDI sale con la
  // identidad del cliente). Devuelve { logo, colors } con el estado de cada
  // parte. Si el tenant no tiene perfil fiscal aún, ambos vuelven con
  // { synced: false, reason: 'sin_organizacion_fiscal' }.
  syncFiscalBranding: () =>
    api.post(`${B}/current/branding/sync-fiscal`).then(r => r.data),
}
