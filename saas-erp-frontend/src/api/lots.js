import api from './axios'

export const lotsApi = {
  getExpiring: (params) => api.get('/lots/expiring', { params }).then(r => r.data),
  runExpirationCheck: () => api.post('/lots/run-expiration-check').then(r => r.data),
}
