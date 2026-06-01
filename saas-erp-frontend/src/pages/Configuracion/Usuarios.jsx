import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { rolesApi } from '@/api/roles'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const PAGE_SIZE = 25

// ── Modal: invitar usuario nuevo ────────────────────────────────────────────
function InvitarModal({ roles, onClose, onSaved }) {
  const qc = useQueryClient()
  const [email, setEmail]       = useState('')
  const [fullName, setFullName] = useState('')
  const [roleIds, setRoleIds]   = useState([])
  const [error, setError]       = useState(null)
  // Si el correo de invitación no se pudo enviar, guardamos la respuesta para
  // mostrar las credenciales y que el admin las comparta a mano.
  const [failResult, setFailResult] = useState(null)

  const mutation = useMutation({
    mutationFn: () => {
      if (!email.trim() || !fullName.trim()) throw new Error('Email y nombre son requeridos.')
      return usersApi.invite({
        email:    email.trim(),
        fullName: fullName.trim(),
        roleIds,
      })
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] })
      if (r?.emailSent === false) {
        // El usuario se creó pero el correo no salió → mostramos credenciales.
        setFailResult(r)
      } else {
        onSaved?.(r)
        onClose()
      }
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al invitar'),
  })

  function toggleRole(id) {
    setRoleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // El correo no se pudo enviar: mostramos las credenciales para compartir a mano.
  if (failResult) {
    const c = failResult.credentials || {}
    return createPortal(
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
        <div className="card w-full max-w-md p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-primary">Usuario creado ✓</h2>
            <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2.5 text-sm text-status-warning">
            ⚠ El correo de invitación <strong>no se pudo enviar</strong>. Comparte estas credenciales
            con el usuario para que pueda entrar:
          </div>
          <div className="bg-surface-elevated/60 border border-line-subtle rounded-lg p-4 flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-ink-muted">Email</span>
              <code className="text-ink-primary font-mono break-all">{c.email}</code>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-ink-muted">Contraseña temporal</span>
              <code className="text-ink-primary font-mono break-all">{c.tempPassword}</code>
            </div>
          </div>
          <button type="button"
            onClick={() => navigator.clipboard?.writeText(`Email: ${c.email}\nContraseña temporal: ${c.tempPassword}`)}
            className="btn-secondary btn-sm self-start">Copiar credenciales</button>
          <p className="text-xs text-ink-muted">
            El usuario debe cambiar su contraseña al iniciar sesión. Revisa la configuración de correo
            (SMTP) para que las próximas invitaciones se envíen automáticamente.
          </p>
          {failResult.emailError && (
            <p className="text-[11px] text-ink-muted">Detalle técnico: {failResult.emailError}</p>
          )}
          <button type="button" onClick={onClose} className="btn-primary w-full justify-center">
            Entendido, cerrar
          </button>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Invitar usuario</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Se enviará un correo con la contraseña temporal.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label">Nombre completo <span className="text-status-danger">*</span></label>
          <input className="input" value={fullName} onChange={e => setFullName(e.target.value)}
            placeholder="Juan Pérez" autoFocus />
        </div>

        <div>
          <label className="label">Email <span className="text-status-danger">*</span></label>
          <input type="email" className="input" value={email}
            onChange={e => setEmail(e.target.value.toLowerCase())}
            placeholder="usuario@empresa.com" />
        </div>

        <div>
          <label className="label">Roles asignados</label>
          {!roles?.length ? (
            <p className="text-xs text-ink-muted italic">Cargando roles...</p>
          ) : (
            <div className="border border-line-subtle rounded-xl p-2 max-h-44 overflow-y-auto flex flex-col gap-1">
              {roles.map(r => (
                <label key={r.id}
                  className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-elevated/40 rounded-lg cursor-pointer">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 accent-brand-600"
                    checked={roleIds.includes(r.id)}
                    onChange={() => toggleRole(r.id)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-primary">{r.name}</p>
                    {r.description && (
                      <p className="text-[11px] text-ink-muted">{r.description}</p>
                    )}
                  </div>
                  {r.is_system && (
                    <span className="text-[9px] font-bold bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">SISTEMA</span>
                  )}
                </label>
              ))}
            </div>
          )}
          <p className="text-[11px] text-ink-muted mt-1">
            Si no eliges ninguno, se asignará el rol <strong>member</strong> por defecto.
          </p>
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !email.trim() || !fullName.trim()}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Enviar invitación'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Modal: editar usuario (nombre + activo + roles) ────────────────────────
function EditarModal({ user, roles, onClose }) {
  const qc = useQueryClient()
  const [fullName, setFullName] = useState(user.full_name || '')
  const [isActive, setIsActive] = useState(user.is_active)
  // Solo precargamos los roles que existen en la lista actual del tenant. Si el
  // usuario tenía asignado un rol "fantasma" (ya eliminado, o de otro tenant),
  // queda fuera para evitar el rechazo del backend al guardar.
  const validRoleIds = useMemo(() => new Set((roles || []).map(r => r.id)), [roles])
  const [roleIds, setRoleIds]   = useState(() =>
    (user.roles || []).map(r => r.id).filter(id => validRoleIds.has(id))
  )
  // Rol principal: gana cuando hay conflicto de mobile_tabs/home_route entre
  // varios roles. Si el usuario solo tiene un rol no es necesario elegirlo.
  const [primaryRoleId, setPrimaryRoleId] = useState(() => {
    const initial = user.primary_role_id
    return initial && validRoleIds.has(initial) ? initial : ''
  })
  const [error, setError]       = useState(null)

  // Si el primary deja de estar entre los seleccionados, lo limpiamos.
  // Y si queda exactamente un rol, lo elegimos automáticamente como principal.
  useEffect(() => {
    if (primaryRoleId && !roleIds.includes(primaryRoleId)) setPrimaryRoleId('')
    if (!primaryRoleId && roleIds.length === 1) setPrimaryRoleId(roleIds[0])
  }, [roleIds, primaryRoleId])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!fullName.trim()) throw new Error('El nombre es requerido.')
      // Actualiza nombre + activo
      await usersApi.update(user.id, { fullName: fullName.trim(), isActive })
      // Actualiza roles (reemplaza la lista). Dedup + filtro de "fantasmas".
      const clean = [...new Set(roleIds)].filter(id => validRoleIds.has(id))
      const primary = primaryRoleId && clean.includes(primaryRoleId) ? primaryRoleId : null
      await usersApi.setRoles(user.id, clean, primary)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['user', user.id] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  function toggleRole(id) {
    setRoleIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Editar usuario</h2>
            <p className="text-xs text-ink-muted mt-0.5 font-mono">{user.email}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label">Nombre completo <span className="text-status-danger">*</span></label>
          <input className="input" value={fullName} onChange={e => setFullName(e.target.value)} />
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-brand-600"
            checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          <span>Usuario activo (puede iniciar sesión)</span>
        </label>

        <div>
          <label className="label">Roles asignados</label>
          {!roles?.length ? (
            <p className="text-xs text-ink-muted italic">Cargando roles...</p>
          ) : (
            <div className="border border-line-subtle rounded-xl p-2 max-h-44 overflow-y-auto flex flex-col gap-1">
              {roles.map(r => (
                <label key={r.id}
                  className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface-elevated/40 rounded-lg cursor-pointer">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 accent-brand-600"
                    checked={roleIds.includes(r.id)}
                    onChange={() => toggleRole(r.id)} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-primary">{r.name}</p>
                    {r.description && (
                      <p className="text-[11px] text-ink-muted">{r.description}</p>
                    )}
                  </div>
                  {r.is_system && (
                    <span className="text-[9px] font-bold bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">SISTEMA</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Rol principal — solo cuando hay 2+ roles seleccionados */}
        {roleIds.length >= 2 && (
          <div>
            <label className="label">Rol principal</label>
            <p className="text-[11px] text-ink-muted mb-1.5">
              Cuando los roles tienen pantalla de inicio o accesos móvil distintos,
              gana el rol que marques aquí.
            </p>
            <select className="select"
              value={primaryRoleId}
              onChange={e => setPrimaryRoleId(e.target.value)}>
              <option value="">— Sin elegir (toma el rol más reciente con valor) —</option>
              {roles
                .filter(r => roleIds.includes(r.id))
                .map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
            </select>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !fullName.trim()}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Página principal ───────────────────────────────────────────────────────
export default function Usuarios() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage]     = useState(1)
  const [showInvite, setShowInvite] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [msg, setMsg] = useState(null)

  const queryParams = useMemo(() => ({
    page, limit: PAGE_SIZE,
    ...(search.trim() && { search: search.trim() }),
  }), [search, page])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['users', queryParams],
    queryFn:  () => usersApi.list(queryParams),
    keepPreviousData: true,
  })
  const users = data?.data || []
  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn:  () => rolesApi.list(),
    staleTime: 60_000,
  })

  const deactivateMutation = useMutation({
    mutationFn: (id) => usersApi.deactivate(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setMsg(r.message || 'Usuario desactivado.')
    },
    onError: (e) => alert(e.response?.data?.error || e.message || 'Error'),
  })

  function handleDeactivate(user) {
    if (!window.confirm(`¿Desactivar a ${user.email}? Ya no podrá iniciar sesión.`)) return
    deactivateMutation.mutate(user.id)
  }

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Usuarios</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Personas con acceso al sistema. Invita nuevos, asigna roles, activa/desactiva cuentas.
          </p>
        </div>
        <Can do="users:create">
          <button onClick={() => setShowInvite(true)} className="btn-primary">
            + Invitar usuario
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-success">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-success">✕</button>
        </div>
      )}

      {/* Buscador */}
      <div className="card p-4">
        <input className="input" placeholder="Buscar por email o nombre..."
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !users.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium text-ink-secondary">
              {search ? 'Sin resultados' : 'Sin usuarios registrados'}
            </p>
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Estado</th>
                  <th>Último acceso</th>
                  <th className="text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={clsx(!u.is_active && 'opacity-60')}>
                    <td>
                      <p className="font-medium text-ink-primary">{u.full_name}</p>
                      <p className="text-[10px] text-ink-muted font-mono">
                        Alta: {fmtDate(u.created_at)}
                      </p>
                    </td>
                    <td className="font-mono text-xs text-ink-secondary">{u.email}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {(u.roles || []).length === 0 ? (
                          <span className="text-[11px] text-ink-muted italic">— sin rol —</span>
                        ) : (
                          u.roles.map((r, i) => (
                            <span key={i}
                              className="text-[10px] font-bold uppercase tracking-wide bg-brand-500/15 text-brand-300 px-1.5 py-0.5 rounded-full">
                              {typeof r === 'string' ? r : r.name}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <Badge
                        variant={u.is_active ? 'green' : 'gray'}
                        label={u.is_active ? 'Activo' : 'Inactivo'} />
                    </td>
                    <td className="text-xs text-ink-muted">
                      {u.last_login_at
                        ? fmtDate(u.last_login_at)
                        : <span className="text-ink-muted italic">Nunca</span>}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button onClick={() => setEditingUser(u)}
                        className="btn-ghost btn-sm text-brand-300">
                        Editar
                      </button>
                      {u.is_active && (
                        <button onClick={() => handleDeactivate(u)}
                          disabled={deactivateMutation.isPending}
                          className="btn-ghost btn-sm text-status-danger">
                          Desactivar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="border-t border-line-subtle px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-ink-muted">
                  Mostrando {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} de {total}
                  {isFetching && <span className="ml-2 italic text-ink-muted">Actualizando…</span>}
                </p>
                <div className="flex gap-1">
                  <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">Anterior</button>
                  <span className="text-sm self-center px-2 text-ink-secondary">{page} / {totalPages}</span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">Siguiente</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showInvite && (
        <InvitarModal
          roles={roles}
          onClose={() => setShowInvite(false)}
          onSaved={() => setMsg('Invitación enviada por correo. El usuario debe revisar su bandeja.')}
        />
      )}

      {editingUser && (
        <EditarModal
          user={editingUser}
          roles={roles}
          onClose={() => setEditingUser(null)}
        />
      )}
    </div>
  )
}
