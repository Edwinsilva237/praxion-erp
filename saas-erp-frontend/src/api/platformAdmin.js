import api from './axios'

// Cliente HTTP del panel Super Admin (dueños de Praxion). Llama a las rutas
// /api/platform-admin/* — protegidas por is_platform_admin en el backend.

const B = '/platform-admin'

export const platformAdminApi = {
  metrics: () => api.get(`${B}/metrics`).then(r => r.data),

  modules: () => api.get(`${B}/modules`).then(r => r.data),

  listTenants: ({ q = '', page = 1, limit = 50 } = {}) =>
    api.get(`${B}/tenants`, { params: { q, page, limit } }).then(r => r.data),

  getTenant: (id) => api.get(`${B}/tenants/${id}`).then(r => r.data),

  listTenantUsers: (id) => api.get(`${B}/tenants/${id}/users`).then(r => r.data),

  createTenant: (body) => api.post(`${B}/tenants`, body).then(r => r.data),

  updateTenant: (id, patch) => api.patch(`${B}/tenants/${id}`, patch).then(r => r.data),

  // reason: 'payment' (auto-reactivable cuando Stripe confirma pago)
  //       | 'manual'  (requiere reactivación manual desde el panel)
  suspendTenant: (id, reason = 'manual') =>
    api.post(`${B}/tenants/${id}/suspend`, { reason }).then(r => r.data),

  reactivateTenant: (id) => api.post(`${B}/tenants/${id}/reactivate`).then(r => r.data),

  // Impersonar tenant
  impersonate: (tenantId, reason = null) =>
    api.post(`${B}/tenants/${tenantId}/impersonate`, { reason }).then((r) => r.data),

  endImpersonation: () =>
    api.post(`${B}/impersonation/end`).then((r) => r.data),

  listImpersonationHistory: (tenantId, limit = 50) =>
    api.get(`${B}/tenants/${tenantId}/impersonation-history`, {
      params: { limit },
    }).then((r) => r.data),

  // Reset de datos sandbox
  sandboxResetPreview: (tenantId, keepInventory = false) =>
    api.get(`${B}/tenants/${tenantId}/sandbox-reset-preview`, {
      params: { keepInventory: keepInventory ? 'true' : 'false' },
    }).then((r) => r.data),

  sandboxReset: (tenantId, { keepInventory = false } = {}) =>
    api.post(`${B}/tenants/${tenantId}/sandbox-reset`, {
      confirm: 'RESET',
      keepInventory,
    }).then((r) => r.data),

  // Planes de suscripción
  listPlans: () => api.get(`${B}/plans`).then(r => r.data),
  getPlan:   (id) => api.get(`${B}/plans/${id}`).then(r => r.data),
  updatePlan: (id, patch) => api.patch(`${B}/plans/${id}`, patch).then(r => r.data),

  // Configuración de proceso del tenant (flags operativos)
  getTenantProcessConfig:    (id) => api.get(`${B}/tenants/${id}/process-config`).then(r => r.data),
  updateTenantProcessConfig: (id, patch) => api.patch(`${B}/tenants/${id}/process-config`, patch).then(r => r.data),

  // Membresías del tenant (tab Miembros)
  listTenantMembers: (id) =>
    api.get(`${B}/tenants/${id}/members`).then(r => r.data),

  addTenantMember: (id, { userId, role }) =>
    api.post(`${B}/tenants/${id}/members`, { userId, role }).then(r => r.data),

  removeTenantMember: (tenantId, userId) =>
    api.delete(`${B}/tenants/${tenantId}/members/${userId}`).then(r => r.data),
}
