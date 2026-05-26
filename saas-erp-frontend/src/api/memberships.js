import api from './axios'

export const membershipsApi = {
  // Lista las empresas a las que pertenece el usuario autenticado.
  // Respuesta: { activeTenantId, memberships: [{ id, slug, name, role, ... }] }
  me: () =>
    api.get('/memberships/me').then((r) => r.data),

  // Cambia el tenant activo. Reemite JWT y refresh token bound al nuevo tenant.
  // Respuesta tiene el mismo shape que login(): accessToken, refreshToken,
  // user, tenant, permissions, uiPrefs, membership.
  switch: (tenantId) =>
    api.post('/memberships/switch', { tenantId }).then((r) => r.data),
}
