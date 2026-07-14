import api from './axios'

export const partnersApi = {
  list: (params) =>
    api.get('/business-partners', { params }).then((r) => r.data),

  get: (id) =>
    api.get(`/business-partners/${id}`).then((r) => r.data),

  create: (body) =>
    api.post('/business-partners', body).then((r) => r.data),

  update: (id, body) =>
    api.patch(`/business-partners/${id}`, body).then((r) => r.data),

  // Días de crédito → documentos abiertos: conteo de impacto y aplicación.
  creditImpact: (id) =>
    api.get(`/business-partners/${id}/credit-impact`).then((r) => r.data),

  applyCreditTerms: (id, sides) =>
    api.post(`/business-partners/${id}/apply-credit-terms`, { sides }).then((r) => r.data),

  // CSF — pre-llenado desde PDF
  parseCSF: (file) => {
    const form = new FormData()
    form.append('file', file)
    return api.post('/business-partners/parse-csf', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data)
  },

  // Contactos
  addContact: (id, body) =>
    api.post(`/business-partners/${id}/contacts`, body).then((r) => r.data),

  deleteContact: (id, contactId) =>
    api.delete(`/business-partners/${id}/contacts/${contactId}`).then((r) => r.data),

  // Domicilios de entrega
  listAddresses: (id) =>
    api.get(`/business-partners/${id}/addresses`).then((r) => r.data),

  addAddress: (id, body) =>
    api.post(`/business-partners/${id}/addresses`, body).then((r) => r.data),

  updateAddress: (id, addressId, body) =>
    api.patch(`/business-partners/${id}/addresses/${addressId}`, body).then((r) => r.data),

  // Precios por cliente
  listPrices: (id, params) =>
    api.get(`/business-partners/${id}/prices`, { params }).then((r) => r.data),

  setPrice: (id, body) =>
    api.post(`/business-partners/${id}/prices`, body).then((r) => r.data),

  // Edita una fila de precio por su id (precio, moneda, vigencia, notas).
  updatePrice: (id, priceId, body) =>
    api.patch(`/business-partners/${id}/prices/${priceId}`, body).then((r) => r.data),

  deletePrice: (id, priceId) =>
    api.delete(`/business-partners/${id}/prices/${priceId}`).then((r) => r.data),

  pricesSummary: () =>
    api.get('/business-partners/prices-summary').then((r) => r.data),

  // Historial de cambios de precios. Devuelve { rows, total }. Filtros
  // opcionales: { limit, offset, partnerId, productId, action, from, to }.
  pricesHistory: (params = {}) =>
    api.get('/business-partners/prices-history', { params }).then((r) => r.data),
}
