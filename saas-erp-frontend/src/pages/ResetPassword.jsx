import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { authApi } from '@/api/auth'
import Spinner from '@/components/ui/Spinner'
import { validatePassword, MIN_LENGTH } from '@/utils/passwordPolicy'

export default function ResetPassword() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token  = params.get('token')
  const tenant = params.get('tenant')

  const [newPwd, setNew]         = useState('')
  const [confirmPwd, setConfirm] = useState('')
  const [loading, setLoading]    = useState(false)
  const [error, setError]        = useState(null)
  const [done, setDone]          = useState(false)
  const [brand, setBrand]        = useState(null)

  // Si el link incluye tenant, lo persistimos en localStorage para que axios
  // mande el header X-Tenant-Slug correcto en el POST a /auth/reset-password.
  useEffect(() => {
    if (tenant) {
      localStorage.setItem('erp_tenant_slug', tenant.toLowerCase().trim())
    }
  }, [tenant])

  // Cargar branding del tenant (logo + colores) para personalizar la pantalla.
  // Endpoint público — si falla, se cae al branding Praxion.
  useEffect(() => {
    if (!tenant) return
    let cancelled = false
    authApi.tenantBrand(tenant)
      .then(data => { if (!cancelled) setBrand(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tenant])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!token) { setError('El enlace de restablecimiento no es válido.'); return }
    const pwCheck = validatePassword(newPwd)
    if (!pwCheck.valid) { setError(pwCheck.reason); return }
    if (newPwd !== confirmPwd) { setError('Las contraseñas no coinciden.'); return }

    setLoading(true)
    try {
      await authApi.resetPassword({ token, newPassword: newPwd })
      setDone(true)
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error al restablecer')
    } finally {
      setLoading(false)
    }
  }

  // Sin token → mensaje + ir a login
  if (!token) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
        <div className="card w-full max-w-sm p-6 text-center">
          <p className="eyebrow">SEGURIDAD</p>
          <h1 className="text-base font-semibold text-ink-primary mt-2 mb-2">Enlace inválido</h1>
          <p className="text-sm text-ink-secondary mb-4">
            Este enlace no es válido o está incompleto. Solicita uno nuevo desde la pantalla de inicio.
          </p>
          <button onClick={() => navigate('/login', { replace: true })} className="btn-primary w-full justify-center">
            Ir al inicio
          </button>
        </div>
      </div>
    )
  }

  // Assets/colores del tenant. Si no hay brand, se usa Praxion.
  const hasBrand   = !!brand?.brand_color_primary
  const primary    = brand?.brand_color_primary   || null
  const secondary  = brand?.brand_color_secondary || null
  const logoUrl    = brand?.logo_url              || '/praxion-logo.svg'
  const footerText = brand?.display_name || brand?.name || 'PRAXION SYSTEMS · INTELIGENCIA APLICADA A LA OPERACIÓN'

  const btnStyle      = hasBrand ? { backgroundColor: primary, borderColor: primary } : undefined
  const haloOneStyle  = hasBrand ? { backgroundColor: `${primary}1A` } : undefined
  const haloTwoStyle  = secondary ? { backgroundColor: `${secondary}14` } : undefined
  const successBoxStyle = hasBrand
    ? { backgroundColor: `${primary}26`, borderColor: `${primary}66`, color: primary }
    : undefined
  const tagStyle      = hasBrand ? { color: primary } : undefined

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-bg-primary">
      <div className="pointer-events-none absolute inset-0">
        <div
          className={haloOneStyle
            ? 'absolute -top-40 -right-40 w-[480px] h-[480px] rounded-full blur-3xl'
            : 'absolute -top-40 -right-40 w-[480px] h-[480px] rounded-full bg-brand-500/[0.05] blur-3xl'}
          style={haloOneStyle}
        />
        <div
          className={haloTwoStyle
            ? 'absolute -bottom-40 -left-40 w-[480px] h-[480px] rounded-full blur-3xl'
            : 'absolute -bottom-40 -left-40 w-[480px] h-[480px] rounded-full bg-brand-700/[0.04] blur-3xl'}
          style={haloTwoStyle}
        />
      </div>

      <div className="w-full max-w-md relative">
        <div className="flex justify-center mb-6">
          <img src={logoUrl} alt={brand?.display_name || brand?.name || 'Praxion Systems'}
            className="h-40 sm:h-48 w-auto max-w-full select-none object-contain" draggable="false" />
        </div>

        <div className="card glow-praxion">
          {done ? (
            <div className="text-center">
              <div
                className={successBoxStyle
                  ? 'w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3 border'
                  : 'w-12 h-12 rounded-full bg-brand-500/15 text-brand-300 mx-auto flex items-center justify-center mb-3 border border-brand-500/40'}
                style={successBoxStyle}
              >
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-ink-primary">Contraseña actualizada</h2>
              <p className="text-sm text-ink-secondary mt-1">
                Ya puedes iniciar sesión con tu nueva contraseña.
              </p>
              <button onClick={() => navigate('/login', { replace: true })}
                style={btnStyle}
                className="btn-primary w-full justify-center mt-5">
                Iniciar sesión
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <p className="eyebrow">SEGURIDAD</p>
                <h2 className="text-lg font-semibold text-ink-primary mt-1 mb-1">Nueva contraseña</h2>
                <p className="text-sm text-ink-secondary">
                  Captura tu nueva contraseña. Mínimo 8 caracteres.
                  {tenant && (
                    <> Tenant: <strong
                      className={tagStyle ? 'font-mono' : 'font-mono text-brand-300'}
                      style={tagStyle}
                    >{tenant}</strong></>
                  )}
                </p>
              </div>

              <div>
                <label className="label">Nueva contraseña</label>
                <input type="password" autoComplete="new-password" minLength={MIN_LENGTH} autoFocus
                  className="input"
                  value={newPwd} onChange={e => setNew(e.target.value)} />
                <p className="text-[11px] text-ink-muted mt-1">
                  Mínimo {MIN_LENGTH} caracteres. Evita contraseñas comunes como "password123" o "qwerty1234".
                </p>
                {newPwd.length > 0 && (() => {
                  const c = validatePassword(newPwd)
                  return !c.valid
                    ? <p className="text-[11px] text-status-warning mt-1">{c.reason}</p>
                    : <p className="text-[11px] text-status-success mt-1">✓ Contraseña válida</p>
                })()}
              </div>

              <div>
                <label className="label">Confirmar contraseña</label>
                <input type="password" autoComplete="new-password" minLength={MIN_LENGTH}
                  className="input"
                  value={confirmPwd} onChange={e => setConfirm(e.target.value)} />
                {confirmPwd && newPwd && confirmPwd !== newPwd && (
                  <p className="text-[11px] text-status-danger mt-1">Las contraseñas no coinciden.</p>
                )}
              </div>

              {error && (
                <div className="alert-error">{error}</div>
              )}

              <button type="submit" disabled={loading || !newPwd || !confirmPwd}
                style={btnStyle}
                className="btn-primary w-full justify-center mt-2">
                {loading && <Spinner size="sm" className="text-white" />}
                {loading ? 'Actualizando...' : 'Restablecer contraseña'}
              </button>

              <div className="text-center pt-1">
                <button type="button"
                  onClick={() => navigate('/login', { replace: true })}
                  className="text-xs text-ink-muted hover:text-ink-secondary hover:underline transition-colors">
                  ← Volver al inicio de sesión
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-ink-muted mt-6 tracking-wide uppercase">
          {footerText}
        </p>
      </div>
    </div>
  )
}
