import api from './axios'

const PUB   = '/system-messages'
const ADMIN = '/system-messages/admin'

export const systemMessagesApi = {
  // Endpoint público — devuelve los mensajes vigentes para el banner.
  active: () => api.get(`${PUB}/active`).then((r) => r.data),

  // Super-admin
  list:   (params) => api.get(ADMIN, { params }).then((r) => r.data),
  get:    (id) => api.get(`${ADMIN}/${id}`).then((r) => r.data),
  create: (body) => api.post(ADMIN, body).then((r) => r.data),
  update: (id, patch) => api.patch(`${ADMIN}/${id}`, patch).then((r) => r.data),
  cancel: (id, reason) => api.post(`${ADMIN}/${id}/cancel`, { reason }).then((r) => r.data),
}
