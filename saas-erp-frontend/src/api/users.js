import api from './axios'

export const usersApi = {
  list: (params) =>
    api.get('/users', { params }).then(r => r.data),

  get: (id) =>
    api.get(`/users/${id}`).then(r => r.data),

  // Body: { email, fullName, roleIds?: [uuid] }
  invite: (body) =>
    api.post('/users/invite', body).then(r => r.data),

  // Reenvía la invitación (genera nueva contraseña temporal). Solo para usuarios
  // que aún no inician sesión. Devuelve { emailSent, message, credentials? }.
  resendInvitation: (id) =>
    api.post(`/users/${id}/resend-invitation`).then(r => r.data),

  // Body: { fullName?, isActive? }
  update: (id, body) =>
    api.patch(`/users/${id}`, body).then(r => r.data),

  deactivate: (id) =>
    api.delete(`/users/${id}`).then(r => r.data),

  // Reactiva un usuario desactivado. El backend valida el límite de usuarios
  // activos del plan (402 si está lleno).
  reactivate: (id) =>
    api.patch(`/users/${id}`, { isActive: true }).then(r => r.data),

  // Reemplaza la lista completa de roles del usuario.
  // Body: { roleIds: [uuid], primaryRoleId?: uuid|null }
  setRoles: (id, roleIds, primaryRoleId = null) =>
    api.put(`/users/${id}/roles`, { roleIds, primaryRoleId }).then(r => r.data),
}
