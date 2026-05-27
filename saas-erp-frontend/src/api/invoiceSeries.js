import api from './axios'

const B = '/invoice-series'

export const invoiceSeriesApi = {
  list:   (fiscalProfileId = null) =>
    api.get(B, { params: fiscalProfileId ? { fiscalProfileId, includeInactive: true } : { includeInactive: true } })
      .then(r => r.data),

  get:    (id) => api.get(`${B}/${id}`).then(r => r.data),
  create: (body) => api.post(B, body).then(r => r.data),
  update: (id, body) => api.patch(`${B}/${id}`, body).then(r => r.data),
  delete: (id) => api.delete(`${B}/${id}`).then(r => r.data),
}
