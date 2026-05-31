import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import api from '@/api/axios'
import { authApi } from '@/api/auth'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'

const schema = z.object({
  email:    z.string().email('Correo inválido'),
  password: z.string().min(1, 'Requerido'),
})

// El login espera más que el resto de la app: un servidor que estuvo inactivo
// (p. ej. el primer arranque de la mañana) puede tardar en responder. 15s no
// alcanza y el usuario veía un falso "credencial incorrecta".
const LOGIN_TIMEOUT = 60000

// Traduce un error de login a un mensaje honesto. Antes, CUALQUIER fallo (incl.
// timeout / sin red) caía a "Credenciales incorrectas", lo que hacía creer que
// la contraseña estaba mal cuando en realidad el servidor no respondió a tiempo.
function loginErrorMessage(err) {
  // Sin respuesta del servidor: timeout, servidor iniciando, o sin conexión.
  if (err?.code === 'ECONNABORTED' || !err?.response) {
    return 'No pudimos contactar al servidor (puede estar iniciando). Espera unos segundos y vuelve a intentar.'
  }
  if (err.response.status === 401) {
    return err.response.data?.error || 'Correo o contraseña incorrectos.'
  }
  return err.response.data?.error || err.response.data?.message || 'Ocurrió un error. Vuelve a intentar.'
}

// Pre-calienta el backend al abrir el login: si está dormido, empieza a
// despertar mientras el usuario escribe sus datos. Best-effort: ignora errores
// y usa no-cors (la petición igual llega al servidor y lo despierta).
function warmUpServer() {
  const base = import.meta.env.VITE_API_URL
  if (!base) return // dev con proxy: no hay arranque frío que calentar
  const healthUrl = base.replace(/\/api\/?$/, '') + '/health'
  try { fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}) } catch { /* noop */ }
}

// ── Modal: Olvidé contraseña ───────────────────────────────────────────────
// Para forgot-password sí necesitamos saber el tenant. Si el usuario aún no
// se ha logueado, le pedimos el dominio/slug.
function ForgotPasswordModal({ defaultEmail, onClose }) {
  const [email, setEmail]     = useState(defaultEmail || '')
  const [tenant, setTenant]   = useState(localStorage.getItem('erp_tenant_slug') || '')
  const [loading, setLoading] = useState(false)
  const [sent, setSent]       = useState(false)
  const [error, setError]     = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email.trim()) { setError('Captura tu email.'); return }
    if (!tenant.trim()) { setError('Captura el código de tu empresa.'); return }
    setLoading(true); setError(null)
    try {
      localStorage.setItem('erp_tenant_slug', tenant.trim().toLowerCase())
      await authApi.forgotPassword({ email: email.trim() })
      setSent(true)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error al solicitar')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow">SEGURIDAD</p>
            <h2 className="text-base font-semibold text-ink-primary mt-1">Recuperar contraseña</h2>
            <p className="text-xs text-ink-muted mt-1">
              Te enviaremos un enlace al correo registrado.
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="btn-icon text-ink-muted hover:text-ink-primary hover:bg-white/[0.04] rounded-md">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {sent ? (
          <>
            <div className="alert-success">
              Si <strong>{email}</strong> está registrado, recibirás un correo con instrucciones en los próximos minutos.
              <p className="text-[11px] text-brand-300/80 mt-2">
                Revisa también la carpeta de spam. El enlace expira en 1 hora.
              </p>
            </div>
            <button type="button" onClick={onClose} className="btn-primary w-full justify-center">
              Entendido
            </button>
          </>
        ) : (
          <>
            <div>
              <label className="label">Correo electrónico</label>
              <input type="email" autoComplete="email" className="input" autoFocus
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="correo@empresa.com" />
            </div>
            <div>
              <label className="label">Código de tu empresa</label>
              <input type="text" className="input font-mono"
                value={tenant} onChange={e => setTenant(e.target.value)}
                placeholder="gh-insumos" />
              <p className="text-[10px] text-ink-muted mt-1">
                El código corto que tu administrador te compartió al darte de alta.
              </p>
            </div>

            {error && <p className="field-error">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">
                Cancelar
              </button>
              <button type="submit" disabled={loading || !email.trim() || !tenant.trim()}
                className="btn-primary flex-1 justify-center">
                {loading ? <Spinner size="sm" /> : 'Enviar enlace'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

export default function Login() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [serverError, setServerError] = useState(null)
  const [showForgot, setShowForgot] = useState(false)

  // Estado para selector de tenant cuando hay varios matches del mismo email.
  const [tenantsChoice, setTenantsChoice] = useState(null)
  const [pendingCreds, setPendingCreds]   = useState(null)
  const [selecting, setSelecting]         = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema) })

  // Despierta el servidor en cuanto se abre el login (arranque frío de la mañana).
  useEffect(() => { warmUpServer() }, [])

  // Primer intento: discovery sin tenant.
  const onSubmit = async ({ email, password }) => {
    setServerError(null)
    try {
      const data = await authApi.loginDiscover({ email, password })

      // Caso 1: el usuario pertenece a varios tenants → mostrar selector.
      if (data.needsTenantSelection) {
        setTenantsChoice(data.tenants)
        setPendingCreds({ email, password })
        return
      }

      // Caso 2: login directo (1 tenant match).
      completeLogin(data)
    } catch (err) {
      setServerError(loginErrorMessage(err))
    }
  }

  // Segundo paso (solo si hay varios tenants): el usuario eligió uno.
  async function pickTenant(tenant) {
    if (!pendingCreds) return
    setSelecting(true)
    setServerError(null)
    try {
      localStorage.setItem('erp_tenant_slug', tenant.slug)
      const { data } = await api.post('/auth/login', pendingCreds, { timeout: LOGIN_TIMEOUT })
      completeLogin(data)
    } catch (err) {
      setServerError(loginErrorMessage(err))
      setSelecting(false)
    }
  }

  function completeLogin(data) {
    localStorage.setItem('erp_tenant_slug', data.tenant?.slug || '')
    login({
      user:         data.user,
      tenant:       data.tenant,
      permissions:  data.permissions || [],
      uiPrefs:      data.uiPrefs,
      accessToken:  data.accessToken,
      refreshToken: data.refreshToken,
    })
    // Tenant suspendido: aterriza directo en /suspendido para que vea el
    // mensaje claro y pueda abrir el portal de pagos. El resto de la app
    // está bloqueado por requireActiveTenant en backend.
    const suspended = data.tenant?.is_active === false
    navigate(suspended ? '/suspendido' : '/', { replace: true })
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-bg-primary">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-40 w-[480px] h-[480px] rounded-full bg-brand-500/[0.05] blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-[480px] h-[480px] rounded-full bg-brand-700/[0.04] blur-3xl"></div>
      </div>

      <div className="w-full max-w-md relative">
        {/* Logo Praxion — protagonista del login */}
        <div className="flex justify-center mb-6">
          <img
            src="/praxion-logo.svg"
            alt="Praxion Systems · Inteligencia aplicada a la operación"
            className="h-40 sm:h-48 w-auto max-w-full select-none"
            draggable="false"
          />
        </div>

        <div className="card glow-praxion">
          {tenantsChoice ? (
            // ── Paso 2: el usuario pertenece a múltiples empresas ───────
            <>
              <p className="eyebrow text-center">SELECCIONA TU EMPRESA</p>
              <h2 className="text-xl font-semibold text-ink-primary text-center mt-2">
                ¿A qué cuenta quieres entrar?
              </h2>
              <p className="text-sm text-ink-muted text-center mt-1 mb-5">
                Tu correo está asociado a más de una empresa.
              </p>
              <div className="flex flex-col gap-2">
                {tenantsChoice.map(t => {
                  const suspended = t.is_active === false
                  return (
                    <button
                      key={t.id}
                      onClick={() => pickTenant(t)}
                      disabled={selecting}
                      title={suspended
                        ? 'Esta organización está suspendida — solo tendrás acceso al panel de pagos.'
                        : undefined}
                      className="btn-secondary justify-between text-left">
                      <span className="font-medium flex items-center gap-2">
                        {t.display_name || t.name}
                        {suspended && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-status-danger/15 text-status-danger">
                            Suspendida
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-xs text-ink-muted">{t.slug}</span>
                    </button>
                  )
                })}
              </div>
              {serverError && (
                <div className="alert-error mt-4">{serverError}</div>
              )}
              <button onClick={() => { setTenantsChoice(null); setPendingCreds(null); setServerError(null) }}
                className="text-xs text-ink-muted hover:text-ink-secondary hover:underline w-full text-center mt-4">
                ← Volver al inicio de sesión
              </button>
            </>
          ) : (
            // ── Paso 1: email + password (sin tenant) ───────────────────
            <>
              <p className="eyebrow text-center">INGRESO AL SISTEMA</p>
              <h2 className="text-xl font-semibold text-ink-primary text-center mt-2">Iniciar sesión</h2>
              <p className="text-sm text-ink-muted text-center mt-1 mb-6">
                Accede a tu panel operativo.
              </p>

              <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
                <div>
                  <label className="label" htmlFor="email">Correo electrónico</label>
                  <input
                    id="email" type="email" autoComplete="email" autoFocus
                    placeholder="correo@empresa.com"
                    className={`input ${errors.email ? 'input-error' : ''}`}
                    {...register('email')}
                  />
                  {errors.email && <p className="field-error">{errors.email.message}</p>}
                </div>

                <div>
                  <label className="label" htmlFor="password">Contraseña</label>
                  <input
                    id="password" type="password" autoComplete="current-password"
                    placeholder="••••••••"
                    className={`input ${errors.password ? 'input-error' : ''}`}
                    {...register('password')}
                  />
                  {errors.password && <p className="field-error">{errors.password.message}</p>}
                </div>

                {serverError && (
                  <div className="alert-error flex items-start gap-2">
                    <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                    </svg>
                    <span>{serverError}</span>
                  </div>
                )}

                <button
                  type="submit" disabled={isSubmitting}
                  className="btn-primary w-full justify-center mt-2"
                >
                  {isSubmitting && <Spinner size="sm" className="text-white" />}
                  {isSubmitting ? 'Verificando...' : 'Entrar'}
                </button>

                <div className="text-center pt-1">
                  <button type="button"
                    onClick={() => setShowForgot(true)}
                    className="text-xs text-brand-300 hover:text-brand-200 hover:underline transition-colors">
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-[11px] text-ink-muted mt-6 tracking-wide">
          PRAXION SYSTEMS · INTELIGENCIA APLICADA A LA OPERACIÓN
        </p>
      </div>

      {showForgot && (
        <ForgotPasswordModal
          defaultEmail={null}
          onClose={() => setShowForgot(false)}
        />
      )}
    </div>
  )
}
