import api from './axios'

export const usersApi = {
  list: (params) =>
    api.get('/users', { params }).then(r => r.data),

  get: (id) =>
    api.get(`/users/${id}`).then(r => r.data),

  // Body: { email, fullName, roleIds?: [uuid] }
  invite: (body) =>
    api.post('/users/invite', body).then(r => r.data),

  // Body: { fullName?, isActive? }
  update: (id, body) =>
    api.patch(`/users/${id}`, body).then(r => r.data),

  deactivate: (id) =>
    api.delete(`/users/${id}`).then(r => r.data),

  // Reemplaza la lista completa de roles del usuario.
  // Body: { roleIds: [uuid], primaryRoleId?: uuid|null }
  setRoles: (id, roleIds, primaryRoleId = null) =>
    api.put(`/users/${id}/roles`, { roleIds, primaryRoleId }).then(r => r.data),
}
