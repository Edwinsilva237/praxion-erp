import api from './axios'

export const rawMaterialsApi = {
  list: (params) =>
    api.get('/raw-materials', { params }).then((r) => r.data),

  get: (id) =>
    api.get(`/raw-materials/${id}`).then((r) => r.data),

  create: (body) =>
    api.post('/raw-materials', body).then((r) => r.data),

  update: (id, body) =>
    api.patch(`/raw-materials/${id}`, body).then((r) => r.data),
}
