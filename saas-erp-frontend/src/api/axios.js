import axios from 'axios'

// ── Slug por defecto al arrancar ───────────────────────────────────────────
if (!localStorage.getItem('erp_tenant_slug')) {
  localStorage.setItem('erp_tenant_slug', 'demo')
}

// En dev: VITE_API_URL vacío → usa '/api' y el proxy de Vite forwardea a :3000.
// En prod: VITE_API_URL=https://api.tu-dominio.com/api → llamadas directas al
// backend en su propio subdominio (CORS abre el dominio + subdominios).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// ── Request: adjunta access token y tenant slug ────────────────────────────
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('erp_access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`

  const slug = localStorage.getItem('erp_tenant_slug') || 'demo'
  config.headers['X-Tenant-Slug'] = slug

  return config
})

// Limpia tokens Y el estado persistido de Zustand antes de redirigir a /login.
// Sin esto, Zustand rehidrata con isAuthenticated=true al recargar la página,
// RequireGuest redirige a '/', el API vuelve a fallar con 401 → bucle infinito.
function clearAuthAndRedirect() {
  localStorage.removeItem('erp_access_token')
  localStorage.removeItem('erp_refresh_token')
  try {
    const raw = localStorage.getItem('erp-auth')
    if (raw) {
      const stored = JSON.parse(raw)
      if (stored?.state) {
        stored.state.isAuthenticated = false
        stored.state.user = null
        stored.state.tenant = null
        stored.state.permissions = []
        stored.state.impersonation = null
        localStorage.setItem('erp-auth', JSON.stringify(stored))
      }
    }
  } catch { /* si el JSON está corrupto no bloqueamos */ }
  window.location.href = '/login'
}

// ── Response: maneja 401 → intenta refresh → reintenta ────────────────────
let isRefreshing = false
let failedQueue = []

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error)
    else prom.resolve(token)
  })
  failedQueue = []
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config

    // Tenant suspendido: aterrizamos al usuario en /suspendido (única pantalla
    // donde puede pagar o cerrar sesión). Excluimos /billing/* y la propia
    // pantalla — esas llamadas SÍ deben funcionar (de hecho son justo lo que
    // permite recuperarse).
    if (error.response?.status === 403
        && error.response?.data?.code === 'TENANT_SUSPENDED'
        && typeof window !== 'undefined'
        && window.location.pathname !== '/suspendido') {
      window.location.href = '/suspendido'
      return Promise.reject(error)
    }

    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`
          return api(original)
        })
      }

      original._retry = true
      isRefreshing = true

      const refreshToken = localStorage.getItem('erp_refresh_token')

      if (!refreshToken) {
        isRefreshing = false
        clearAuthAndRedirect()
        return Promise.reject(error)
      }

      try {
        // Usar api (no axios) para que lleve X-Tenant-Slug automáticamente
        const { data } = await api.post('/auth/refresh', { refreshToken })
        const newToken = data.accessToken
        localStorage.setItem('erp_access_token', newToken)
        if (data.refreshToken) localStorage.setItem('erp_refresh_token', data.refreshToken)
        api.defaults.headers.common.Authorization = `Bearer ${newToken}`
        processQueue(null, newToken)
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)
      } catch (refreshError) {
        processQueue(refreshError, null)
        clearAuthAndRedirect()
        return Promise.reject(refreshError)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(error)
  }
)

export default api
