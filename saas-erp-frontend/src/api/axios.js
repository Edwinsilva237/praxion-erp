import axios from 'axios'
import { Capacitor } from '@capacitor/core'
import useServerStatus from '@/store/useServerStatus'

// ── Detección de tenant slug por subdomain ────────────────────────────────
// SOLO activa en hosts terminados en `.praxionops.com` (dominio oficial del
// SaaS). Esto evita activar la lógica en `praxion-web.onrender.com` — donde
// el host no es un tenant válido y rompería todas las llamadas API.
//
// Hosts soportados:
//   acme.praxionops.com               → slug = 'acme' (tenant)
//   gh-insumos-prod.praxionops.com    → slug = 'gh-insumos-prod' (tenant)
//   praxionops.com / www.praxionops.com / app.praxionops.com → null (genérico)
//   praxion-web.onrender.com          → null (URL legacy, no toca localStorage)
//   localhost, 127.0.0.1, IP LAN      → null (dev local, usa localStorage)
//
// Subdomains reservados que NO son tenants aunque sean parte de praxionops.com.
const RESERVED_SUBDOMAINS = ['www', 'app', 'api', 'admin', 'mail', 'smtp']
const TENANT_DOMAIN_SUFFIX = '.praxionops.com'

function detectTenantSlugFromHost() {
  const host = (window.location.hostname || '').toLowerCase()
  // Solo procesamos hosts del dominio oficial del SaaS. Cualquier otro
  // (onrender.com, localhost, IP, dominio custom de cliente) cae al
  // comportamiento legacy basado en localStorage.
  if (!host.endsWith(TENANT_DOMAIN_SUFFIX)) return null
  // Caso apex: praxionops.com sin subdomain → null
  if (host === 'praxionops.com') return null
  const sub = host.slice(0, -TENANT_DOMAIN_SUFFIX.length)
  // Subdominios con punto (ej. foo.bar.praxionops.com) — no son tenants.
  if (sub.includes('.')) return null
  if (RESERVED_SUBDOMAINS.includes(sub)) return null
  return sub
}

const subdomainSlug = detectTenantSlugFromHost()
if (subdomainSlug) {
  // URL siempre gana: si el host trae tenant, sobrescribimos el localStorage.
  localStorage.setItem('erp_tenant_slug', subdomainSlug)
} else if (!localStorage.getItem('erp_tenant_slug')) {
  // Fallback default solo para entornos sin nada cacheado (primera visita
  // en dev local o en app.praxionops.com). loginDiscover sobrescribirá esto
  // después del primer login.
  localStorage.setItem('erp_tenant_slug', 'demo')
}

// En dev: VITE_API_URL vacío → usa '/api' y el proxy de Vite forwardea a :3000.
// En prod web: VITE_API_URL=https://api.tu-dominio.com/api → llamadas directas
// al backend (CORS abre el dominio + subdominios).
//
// En la app nativa (Capacitor) NO hay proxy de Vite ni subdominio: el webview
// corre en `https://localhost`, así que un baseURL relativo `/api` apuntaría al
// propio bundle. Por eso en nativo SIEMPRE usamos una URL absoluta — la del
// build si se definió, o el backend de producción como red de seguridad.
//
// ⚠️ DEBE ser el endpoint Render DIRECTO, NO el dominio Cloudflare
// (`api.praxionops.com`): Cloudflare responde el preflight OPTIONS él mismo y NO
// devuelve `Access-Control-Allow-Origin` para el origen `https://localhost` del
// webview → bloquea TODA llamada de la app ("No pudimos contactar al servidor").
// La web sí puede usar Cloudflare porque su origen es `*.praxionops.com`. Para la
// latencia de la mañana confiamos en el warm-up (calienta esta conexión al abrir).
const NATIVE_FALLBACK_API = 'https://praxion-api.onrender.com/api'
const baseURL = Capacitor.isNativePlatform()
  ? (import.meta.env.VITE_API_URL || NATIVE_FALLBACK_API)
  : (import.meta.env.VITE_API_URL || '/api')

// URL base ya resuelta (incluye el fallback nativo). Exportada para que el
// pre-calentamiento del login derive el /health del MISMO backend que usa la
// app — en la APK VITE_API_URL está vacío, así que leerla directo daba '' y el
// warm-up nunca despertaba al servidor (solo la web pre-calentaba).
export const API_BASE_URL = baseURL

// ── Pre-calentamiento del backend (arranque frío de Render) ────────────────
// Dispara un ping best-effort a /health para que el servidor, si estuvo
// inactivo, empiece a despertar cuanto antes. Se llama al cargar este módulo
// (= apenas abre la app, incluso para un usuario YA logueado que no ve el
// login) y también desde la pantalla de login mientras el usuario teclea.
// `no-cors`: la respuesta es opaca pero la petición SÍ llega y despierta al
// server (clave en el webview nativo, cuyo origen no está en el CORS del API).
let lastWarmAt = 0
export function warmUpServer() {
  const base = API_BASE_URL
  // Solo tiene sentido con base absoluta (web prod o app nativa). En dev la base
  // es '/api' (relativa, vía proxy de Vite) → no hay arranque frío que calentar.
  if (!/^https?:\/\//i.test(base)) return
  // Throttle: el warm-up se dispara al cargar el módulo Y al volver el foco
  // (visibilitychange) → evita pings duplicados cuando ambos coinciden.
  const now = Date.now()
  if (now - lastWarmAt < 5000) return
  lastWarmAt = now
  const healthUrl = base.replace(/\/api\/?$/, '') + '/health'
  try { fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}) } catch { /* noop */ }
}

// Despierta al servidor lo antes posible: este módulo se importa en el arranque
// (stores + primera pantalla), así que el ping sale antes de pintar la UI.
warmUpServer()

const api = axios.create({
  baseURL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

// ── Refresh del token — UNA sola vía compartida ────────────────────────────
// El access token vive pocas horas; una sesión dejada abierta de un día para
// otro siempre llega vencida. Dos cosas pueden querer renovarlo casi a la vez:
// el interceptor de respuesta (ante un 401) y el refresh proactivo (al arrancar
// / volver del background). El backend ROTA el refresh token y revoca el viejo
// al usarlo (uso único) → si ambos renovaran con el mismo token, el segundo
// daría 401 y deslogueo falso. Por eso ambos pasan por `performTokenRefresh`,
// deduplicado en un único vuelo. Usa axios "pelado" (NO la instancia `api`)
// para no re-entrar en este mismo interceptor → evita recursión/deadlock.
function decodeJwtExp(token) {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch { return null }
}

// ¿El access token está vencido o a punto de vencer (< 30s)? Si no se puede
// decodificar el exp devolvemos false (que lo maneje el interceptor con su 401).
export function accessTokenNeedsRefresh() {
  const token = localStorage.getItem('erp_access_token')
  if (!token) return false
  const exp = decodeJwtExp(token)
  if (exp == null) return false
  return (exp * 1000) - Date.now() < 30000
}

let refreshInFlight = null
// Renueva el access token usando el refresh token. Deduplicado: llamadas
// concurrentes comparten el MISMO vuelo (clave para no quemar dos veces el
// refresh token de uso único). Resuelve al nuevo access token; rechaza si falla.
function performTokenRefresh() {
  if (refreshInFlight) return refreshInFlight
  const p = (async () => {
    const refreshToken = localStorage.getItem('erp_refresh_token')
    if (!refreshToken) throw new Error('No hay refresh token')
    const slug = localStorage.getItem('erp_tenant_slug') || 'demo'
    // Timeout amplio: en el primer arranque de la mañana la conexión del
    // dispositivo puede estar fría; con 15s fallaba la renovación y botaba a login.
    const { data } = await axios.post(
      `${API_BASE_URL.replace(/\/$/, '')}/auth/refresh`,
      { refreshToken },
      { timeout: 60000, headers: { 'Content-Type': 'application/json', 'X-Tenant-Slug': slug } }
    )
    localStorage.setItem('erp_access_token', data.accessToken)
    if (data.refreshToken) localStorage.setItem('erp_refresh_token', data.refreshToken)
    api.defaults.headers.common.Authorization = `Bearer ${data.accessToken}`
    return data.accessToken
  })()
  refreshInFlight = p
  // Libera el vuelo al terminar (éxito o error) sin tocar la promesa devuelta.
  p.catch(() => {}).finally(() => { if (refreshInFlight === p) refreshInFlight = null })
  return p
}

// Renueva proactivamente si el token está por vencer. Idempotente; NUNCA rechaza
// (resuelve a boolean) — si el refresh falla, las consultas siguientes caen en el
// 401 del interceptor (que redirige a login si el refresh ya murió). Sin refresh
// token (ej. sesión impersonada, que por diseño no se renueva) no hace nada.
export function ensureFreshToken() {
  if (!accessTokenNeedsRefresh()) return Promise.resolve(false)
  if (!localStorage.getItem('erp_refresh_token')) return Promise.resolve(false)
  return performTokenRefresh().then(() => true, () => false)
}

// ── Detección de "servidor lento / despertando" ────────────────────────────
// Si una petición tarda más de SLOW_MS sin responder (típico cuando el backend
// estuvo inactivo y está arrancando), avisamos a la UI para mostrar un aviso
// discreto — pero SOLO si de verdad se demora. Cuando la petición responde,
// limpiamos el temporizador. (El store no importa axios → no hay ciclo.)
const SLOW_MS = 8000
let slowCount = 0
function syncWaking() {
  useServerStatus.getState().setWaking(slowCount > 0)
}
function startSlowTimer(config) {
  config.__slowTimer = setTimeout(() => {
    config.__wasSlow = true
    slowCount += 1
    syncWaking()
  }, SLOW_MS)
}
function clearSlowTimer(config) {
  if (!config) return
  if (config.__slowTimer) { clearTimeout(config.__slowTimer); config.__slowTimer = null }
  if (config.__wasSlow) {
    config.__wasSlow = false
    slowCount = Math.max(0, slowCount - 1)
    syncWaking()
  }
}

// ── Request: adjunta access token y tenant slug ────────────────────────────
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('erp_access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`

  const slug = localStorage.getItem('erp_tenant_slug') || 'demo'
  config.headers['X-Tenant-Slug'] = slug

  startSlowTimer(config)
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
  (response) => { clearSlowTimer(response.config); return response },
  async (error) => {
    const original = error.config
    clearSlowTimer(original)

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
        // Vía compartida con el refresh proactivo (deduplicada) → nunca se quema
        // el refresh token de uso único dos veces. Bare axios por dentro, así que
        // un 401 del propio refresh NO re-entra aquí (sin recursión).
        const newToken = await performTokenRefresh()
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

// Al volver el foco a la pestaña / app (visibilitychange → visible): calienta la
// conexión Y renueva el token si venció estando en segundo plano. Cubre el caso
// "dejé la sesión abierta de ayer": la app no se recarga, así que el refresh al
// montar RequireAuth no se dispara, pero esto sí — el token queda fresco antes
// de que el usuario toque nada.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      warmUpServer()
      ensureFreshToken()
    }
  })
}

export default api
