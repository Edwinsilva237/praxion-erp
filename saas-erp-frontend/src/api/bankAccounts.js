import api from './axios'

const B = '/bank-accounts'

export const bankAccountsApi = {
  list:   (params = {}) => api.get(B, { params }).then(r => r.data),
  get:    (id)          => api.get(`${B}/${id}`).then(r => r.data),
  create: (body)        => api.post(B, body).then(r => r.data),
  update: (id, body)    => api.patch(`${B}/${id}`, body).then(r => r.data),
  remove: (id)          => api.delete(`${B}/${id}`).then(r => r.data),
}
