import api from './axios'

export const authApi = {
  // Login con discovery: no requiere tenant en header. El backend identifica
  // a qué tenants pertenece el email y, si solo hay uno, devuelve la sesión.
  // Si hay varios, devuelve { needsTenantSelection: true, tenants: [...] }
  // y el frontend pide al usuario que elija para luego llamar a `login`
  // normal pasando el slug elegido en X-Tenant-Slug.
  loginDiscover: (body) =>
    api.post('/auth/login-discover', body, {
      // NO mandamos X-Tenant-Slug: el interceptor lo inyecta automáticamente
      // desde localStorage. Lo borramos temporalmente para esta llamada.
      headers: { 'X-Tenant-Slug': '' },
      // Más paciencia que el resto de la app: el primer login de la mañana
      // puede pegarle a un servidor que apenas está arrancando.
      timeout: 60000,
    }).then(r => r.data),

  me: () =>
    api.get('/auth/me').then(r => r.data),

  // Body: { currentPassword, newPassword }
  changePassword: (body) =>
    api.post('/auth/change-password', body).then(r => r.data),

  // Body: { email }
  forgotPassword: (body) =>
    api.post('/auth/forgot-password', body).then(r => r.data),

  // Body: { token, newPassword }
  resetPassword: (body) =>
    api.post('/auth/reset-password', body).then(r => r.data),

  // Endpoint público para obtener branding del tenant (logo + colores).
  // Usado en pantallas pre-login (reset password, etc.).
  tenantBrand: (slug) =>
    api.get(`/auth/tenant-brand/${encodeURIComponent(slug)}`, {
      headers: { 'X-Tenant-Slug': '' },
    }).then(r => r.data),
}
