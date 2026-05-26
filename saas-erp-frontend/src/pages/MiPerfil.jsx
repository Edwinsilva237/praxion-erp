import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { authApi } from '@/api/auth'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'
import { validatePassword, MIN_LENGTH } from '@/utils/passwordPolicy'

export default function MiPerfil() {
  const user        = useAuthStore((s) => s.user)
  const tenant      = useAuthStore((s) => s.tenant)
  const permissions = useAuthStore((s) => s.permissions)
  const updateUser  = useAuthStore((s) => s.updateUser)
  const logout      = useAuthStore((s) => s.logout)

  // ── Sección 1: editar nombre ────────────────────────────────────
  const [fullName, setFullName] = useState(user?.fullName || '')
  const [profileMsg, setProfileMsg] = useState(null)
  const [profileErr, setProfileErr] = useState(null)

  const profileMutation = useMutation({
    mutationFn: () => {
      if (!fullName.trim()) throw new Error('El nombre es requerido.')
      return usersApi.update(user.id, { fullName: fullName.trim() })
    },
    onSuccess: (u) => {
      updateUser({ fullName: u.full_name })
      setProfileMsg('Datos actualizados.')
      setProfileErr(null)
    },
    onError: (e) => setProfileErr(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  // ── Sección 2: cambiar contraseña ──────────────────────────────
  const [currentPwd, setCurrent] = useState('')
  const [newPwd, setNew]         = useState('')
  const [confirmPwd, setConfirm] = useState('')
  const [pwdMsg, setPwdMsg] = useState(null)
  const [pwdErr, setPwdErr] = useState(null)

  const pwdMutation = useMutation({
    mutationFn: () => {
      const c = validatePassword(newPwd)
      if (!c.valid) throw new Error(c.reason)
      if (newPwd !== confirmPwd) throw new Error('Las contraseñas no coinciden.')
      if (newPwd === currentPwd) throw new Error('La nueva debe ser distinta a la actual.')
      return authApi.changePassword({ currentPassword: currentPwd, newPassword: newPwd })
    },
    onSuccess: () => {
      setPwdMsg('Contraseña actualizada. Vuelve a iniciar sesión en otros dispositivos.')
      setPwdErr(null)
      setCurrent(''); setNew(''); setConfirm('')
    },
    onError: (e) => setPwdErr(e.response?.data?.error || e.message || 'Error al cambiar contraseña'),
  })

  return (
    <div className="page-enter flex flex-col gap-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Mi perfil</h1>
        <p className="text-xs text-ink-muted mt-0.5">
          Datos personales y seguridad de tu cuenta en <strong>{tenant?.name}</strong>.
        </p>
      </div>

      {/* ── Card resumen ─────────────────────────────────────── */}
      <div className="card p-5 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-brand-500/15 text-brand-300 text-lg font-semibold flex items-center justify-center shrink-0">
          {user?.fullName?.slice(0, 2).toUpperCase() || 'U'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold text-ink-primary">{user?.fullName}</p>
          <p className="text-xs text-ink-muted font-mono truncate">{user?.email}</p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {(() => {
              const roles = Array.isArray(user?.roles) ? user.roles : []
              return roles.length === 0
                ? <span className="text-[11px] text-ink-muted italic">sin rol</span>
                : roles.map((r, i) => (
                  <span key={i}
                    className="text-[10px] font-bold uppercase tracking-wide bg-brand-500/15 text-brand-300 px-1.5 py-0.5 rounded-full">
                    {r}
                  </span>
                ))
            })()}
          </div>
          <p className="text-[10px] text-ink-muted mt-1">
            {permissions.length} permisos efectivos
          </p>
        </div>
      </div>

      {/* ── Datos personales ────────────────────────────────── */}
      <form className="card p-5 flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); setProfileMsg(null); setProfileErr(null); profileMutation.mutate() }}>
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Datos personales</h2>
          <p className="text-xs text-ink-muted mt-0.5">El email no se puede modificar — contacta a un administrador.</p>
        </div>

        <div>
          <label className="label">Nombre completo</label>
          <input className="input" value={fullName} onChange={e => setFullName(e.target.value)} />
        </div>

        <div>
          <label className="label">Email</label>
          <input className="input bg-surface-elevated/40 text-ink-muted" value={user?.email || ''} disabled readOnly />
        </div>

        {profileMsg && (
          <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
            <p className="text-sm text-status-success">{profileMsg}</p>
          </div>
        )}
        {profileErr && <p className="field-error">{profileErr}</p>}

        <div className="flex justify-end">
          <button type="submit"
            disabled={profileMutation.isPending || !fullName.trim() || fullName === user?.fullName}
            className="btn-primary">
            {profileMutation.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
          </button>
        </div>
      </form>

      {/* ── Cambiar contraseña ─────────────────────────────── */}
      <form className="card p-5 flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); setPwdMsg(null); setPwdErr(null); pwdMutation.mutate() }}>
        <div>
          <h2 className="text-base font-semibold text-ink-primary">🔐 Cambiar contraseña</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Mínimo {MIN_LENGTH} caracteres. Evita contraseñas comunes. Al cambiarla se cerrarán tus sesiones en otros dispositivos.
          </p>
        </div>

        <div>
          <label className="label">Contraseña actual <span className="text-status-danger">*</span></label>
          <input type="password" autoComplete="current-password" className="input"
            value={currentPwd} onChange={e => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label">Nueva contraseña <span className="text-status-danger">*</span></label>
          <input type="password" autoComplete="new-password" minLength={MIN_LENGTH} className="input"
            value={newPwd} onChange={e => setNew(e.target.value)} />
          {newPwd.length > 0 && (() => {
            const c = validatePassword(newPwd)
            return !c.valid
              ? <p className="text-[11px] text-status-warning mt-1">{c.reason}</p>
              : <p className="text-[11px] text-status-success mt-1">✓ Contraseña válida</p>
          })()}
        </div>
        <div>
          <label className="label">Confirmar nueva contraseña <span className="text-status-danger">*</span></label>
          <input type="password" autoComplete="new-password" minLength={MIN_LENGTH} className="input"
            value={confirmPwd} onChange={e => setConfirm(e.target.value)} />
          {confirmPwd && newPwd && confirmPwd !== newPwd && (
            <p className="text-[11px] text-status-danger mt-1">Las contraseñas no coinciden.</p>
          )}
        </div>

        {pwdMsg && (
          <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <p className="text-sm text-status-success">{pwdMsg}</p>
            <button type="button" onClick={logout} className="btn-ghost btn-sm text-status-success">
              Cerrar sesión
            </button>
          </div>
        )}
        {pwdErr && <p className="field-error">{pwdErr}</p>}

        <div className="flex justify-end">
          <button type="submit"
            disabled={pwdMutation.isPending || !currentPwd || !newPwd || !confirmPwd}
            className="btn-primary">
            {pwdMutation.isPending ? <Spinner size="sm" /> : 'Actualizar contraseña'}
          </button>
        </div>
      </form>
    </div>
  )
}
