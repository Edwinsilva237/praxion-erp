import api from './axios'

export const rolesApi = {
  list: () =>
    api.get('/roles').then(r => r.data),

  get: (id) =>
    api.get(`/roles/${id}`).then(r => r.data),

  // Body: { name, description?, permissionIds: [uuid] }
  create: (body) =>
    api.post('/roles', body).then(r => r.data),

  // Body: { name?, description?, permissionIds? }
  update: (id, body) =>
    api.patch(`/roles/${id}`, body).then(r => r.data),

  delete: (id) =>
    api.delete(`/roles/${id}`).then(r => r.data),

  // Catálogo global de permisos
  listAllPermissions: () =>
    api.get('/roles/permissions/all').then(r => r.data),

  // Asigna un rol a un usuario
  assignToUser: (roleId, userId) =>
    api.post(`/roles/${roleId}/assign`, { userId }).then(r => r.data),
}
