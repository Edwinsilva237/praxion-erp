import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { rolesApi } from '@/api/roles'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import { fmtDate } from '@/utils/fmt'
import {
  RESOURCE_LABELS, PROCESS_GROUPS, ROLE_TEMPLATES,
  templatePermissionIds, roleSummary,
} from '@/config/permissionsMeta'
import { MOBILE_TABS, MAX_MOBILE_TABS } from '@/config/mobileTabs'
import { groupedByScreen, buttonsSharingPermission } from '@/config/buttonCatalog'
import { NAV_SECTIONS } from '@/config/sidebarNav'
import clsx from 'clsx'

const EDITOR_TABS = [
  { key: 'permisos',     label: 'Permisos',       description: 'Matriz técnica de resource:action' },
  { key: 'botones',      label: 'Botones',        description: 'Vista por pantalla — qué botones puede usar' },
  { key: 'sidebar',      label: 'Menú lateral',   description: 'Qué items del menú lateral puede ver' },
  { key: 'inicio',       label: 'Inicio y móvil', description: 'Ventana de inicio + barra inferior del móvil' },
]

// Rutas curadas para la "ventana de inicio" del rol. Si en el futuro agregas
// más áreas con dashboard propio, súmalas aquí.
const HOME_ROUTE_OPTIONS = [
  { value: '',                       label: 'Default (panel de inicio automático)' },
  { value: '/',                      label: 'Inicio (dashboard general)' },
  { value: '/ventas',                label: 'Ventas — pedidos' },
  { value: '/remisiones',            label: 'Ventas — remisiones' },
  { value: '/facturacion',           label: 'Facturación' },
  { value: '/cxc',                   label: 'Pagos recibidos (CxC)' },
  { value: '/cxp',                   label: 'Pagos emitidos (CxP)' },
  { value: '/compras/ordenes',       label: 'Compras — órdenes' },
  { value: '/compras/recepciones',   label: 'Compras — recepciones' },
  { value: '/produccion/captura',    label: 'Producción — captura' },
  { value: '/produccion/ordenes',    label: 'Producción — órdenes' },
  { value: '/produccion/programacion', label: 'Producción — programación' },
  { value: '/inventario',            label: 'Inventario — stock y kardex' },
  { value: '/caja-chica',            label: 'Caja chica' },
  { value: '/reportes/ventas',       label: 'Reportes — Ventas' },
  { value: '/reportes/produccion',   label: 'Reportes — Producción' },
]

// ── Modal: editor de rol (crear / editar) ─────────────────────────────────
function RolEditorModal({ role, onClose }) {
  const qc = useQueryClient()
  const isNew = !role?.id
  const [name, setName]               = useState(role?.name || '')
  const [description, setDescription] = useState(role?.description || '')
  const [permIds, setPermIds]         = useState(() =>
    new Set((role?.permissions || []).map(p => p.id))
  )
  const [mobileTabs, setMobileTabs]   = useState(() =>
    Array.isArray(role?.mobile_tabs) ? role.mobile_tabs : []
  )
  const [homeRoute, setHomeRoute]     = useState(role?.home_route || '')
  const [error, setError]             = useState(null)
  const [activeTab, setActiveTab]     = useState('permisos')

  // Catálogo completo de permisos del sistema
  const { data: allPerms = [], isLoading: loadingPerms } = useQuery({
    queryKey: ['permissions-all'],
    queryFn:  () => rolesApi.listAllPermissions(),
    staleTime: 5 * 60 * 1000,
  })

  // Agrupar permisos por PROCESO de negocio (no por recurso técnico).
  // El orden y agrupación viene de PROCESS_GROUPS en permissionsMeta.
  const groupedByProcess = useMemo(() => {
    const byResource = {}
    for (const p of allPerms) {
      if (!byResource[p.resource]) byResource[p.resource] = []
      byResource[p.resource].push(p)
    }
    // Mantener orden read → create → update → approve/manage/delete
    const actionOrder = { read: 0, create: 1, update: 2, approve: 3, manage: 4, assign: 5, adjust: 6, delete: 9 }
    Object.values(byResource).forEach(arr =>
      arr.sort((a, b) => (actionOrder[a.action] ?? 7) - (actionOrder[b.action] ?? 7))
    )
    return PROCESS_GROUPS.map(g => ({
      ...g,
      resources: g.resources
        .filter(r => byResource[r])
        .map(r => ({ resource: r, label: RESOURCE_LABELS[r] || r, perms: byResource[r] })),
    })).filter(g => g.resources.length > 0)
  }, [allPerms])

  function togglePerm(id) {
    setPermIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleResource(perms) {
    const allOn = perms.every(p => permIds.has(p.id))
    setPermIds(prev => {
      const next = new Set(prev)
      perms.forEach(p => allOn ? next.delete(p.id) : next.add(p.id))
      return next
    })
  }
  function toggleGroup(groupPerms) {
    const allOn = groupPerms.every(p => permIds.has(p.id))
    setPermIds(prev => {
      const next = new Set(prev)
      groupPerms.forEach(p => allOn ? next.delete(p.id) : next.add(p.id))
      return next
    })
  }
  function applyTemplate(tpl) {
    const ids = templatePermissionIds(tpl, allPerms)
    setPermIds(new Set(ids))
    if (!name.trim()) setName(tpl.key)
    if (!description.trim()) setDescription(tpl.description)
  }

  // Mapa "resource:action" → permission.id, usado por la vista por botones
  // para resolver qué permiso encender/apagar al togglear cada fila.
  const permIdByKey = useMemo(() => {
    const m = {}
    for (const p of allPerms) m[`${p.resource}:${p.action}`] = p.id
    return m
  }, [allPerms])

  // Set de "resource:action" actualmente marcados, usado para filtrar las
  // pantallas del catálogo de botones — si el rol no tiene "sales:read" no
  // mostramos el grupo "Comercial · Pedidos" porque sería ruido.
  const accessSet = useMemo(() => {
    const s = new Set()
    for (const p of allPerms) {
      if (permIds.has(p.id)) s.add(`${p.resource}:${p.action}`)
    }
    return s
  }, [allPerms, permIds])

  const buttonScreens = useMemo(() => groupedByScreen(accessSet), [accessSet])

  function toggleMobileTab(key) {
    setMobileTabs(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      if (prev.length >= MAX_MOBILE_TABS) return prev   // tope alcanzado
      return [...prev, key]
    })
  }
  function moveMobileTab(key, delta) {
    setMobileTabs(prev => {
      const i = prev.indexOf(key)
      const j = i + delta
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const mutation = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error('El nombre es requerido.')
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        permissionIds: [...permIds],
        mobileTabs: mobileTabs.length ? mobileTabs : null,
        homeRoute:  homeRoute || null,
      }
      return isNew ? rolesApi.create(body) : rolesApi.update(role.id, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] })
      qc.invalidateQueries({ queryKey: ['role', role?.id] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  const isSystem = role?.is_system
  const readOnly = isSystem  // los roles de sistema no se editan

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {isNew ? 'Nuevo rol' : `Editar rol · ${role.name}`}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {readOnly
                ? 'Este es un rol de sistema — solo lectura.'
                : 'Define el nombre y la matriz de permisos que tendrán los usuarios con este rol.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Nombre <span className="text-status-danger">*</span></label>
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              disabled={readOnly} placeholder="ventas, contador, repartidor..." />
          </div>
          <div>
            <label className="label">Descripción</label>
            <input className="input" value={description} onChange={e => setDescription(e.target.value)}
              disabled={readOnly} placeholder="Opcional" />
          </div>
        </div>

        {/* Plantillas sugeridas — solo al crear */}
        {isNew && !readOnly && allPerms.length > 0 && (
          <div className="bg-brand-500/10 border border-brand-100 rounded-xl p-3">
            <p className="text-xs font-semibold text-brand-300 mb-2">
              💡 Plantillas sugeridas (puedes ajustar después)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_TEMPLATES.map(tpl => (
                <button key={tpl.key} type="button"
                  onClick={() => applyTemplate(tpl)}
                  title={tpl.description}
                  className="text-xs bg-surface-primary border border-brand-500/40 hover:bg-brand-500/15 text-brand-300 px-2 py-1 rounded-lg transition-colors">
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Navegación entre pestañas ───────────────────────────────── */}
        <div
          role="tablist"
          style={{ minHeight: '48px' }}
          className="flex gap-1 p-1 rounded-lg border-2 border-brand-500/40 bg-black/30 overflow-x-auto sticky top-0 z-10">
          {EDITOR_TABS.map(t => (
            <button key={t.key} type="button"
              role="tab"
              aria-selected={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
              title={t.description}
              className={clsx(
                'flex-1 px-4 py-2 text-sm font-semibold rounded-md transition-colors whitespace-nowrap min-w-fit',
                activeTab === t.key
                  ? 'bg-brand-500 text-white shadow-md'
                  : 'text-ink-secondary hover:text-ink-primary hover:bg-white/[0.04]'
              )}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Pestaña 1: Permisos ─────────────────────────────────────── */}
        {activeTab === 'permisos' && <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">Permisos asignados</label>
            <span className="text-xs text-ink-muted">{permIds.size} de {allPerms.length}</span>
          </div>
          {loadingPerms ? (
            <div className="flex justify-center py-6"><Spinner size="sm" /></div>
          ) : (
            <div className="border border-line-subtle rounded-xl divide-y divide-line-subtle max-h-[55vh] overflow-y-auto">
              {groupedByProcess.map(group => {
                const groupPerms = group.resources.flatMap(r => r.perms)
                const gAllOn = groupPerms.every(p => permIds.has(p.id))
                const gSomeOn = groupPerms.some(p => permIds.has(p.id))
                return (
                  <div key={group.key} className="p-3 bg-surface-elevated/40/40">
                    {/* Header del proceso */}
                    <div className="flex items-center justify-between mb-2">
                      <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
                        <input type="checkbox"
                          className="mt-0.5 w-4 h-4 accent-brand-600"
                          checked={gAllOn}
                          ref={el => { if (el) el.indeterminate = !gAllOn && gSomeOn }}
                          onChange={() => toggleGroup(groupPerms)}
                          disabled={readOnly} />
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-ink-primary">{group.label}</p>
                          <p className="text-[11px] text-ink-muted">{group.description}</p>
                        </div>
                      </label>
                      <span className="text-[10px] text-ink-muted shrink-0 ml-2">
                        {groupPerms.filter(p => permIds.has(p.id)).length} / {groupPerms.length}
                      </span>
                    </div>

                    {/* Cada recurso del proceso */}
                    <div className="flex flex-col gap-2 pl-6">
                      {group.resources.map(({ resource, label, perms }) => {
                        const rAllOn = perms.every(p => permIds.has(p.id))
                        const rSomeOn = perms.some(p => permIds.has(p.id))
                        return (
                          <div key={resource} className="bg-surface-primary border border-line-subtle rounded-lg p-2">
                            <label className="flex items-center gap-2 cursor-pointer mb-1.5">
                              <input type="checkbox"
                                className="w-4 h-4 accent-brand-600"
                                checked={rAllOn}
                                ref={el => { if (el) el.indeterminate = !rAllOn && rSomeOn }}
                                onChange={() => toggleResource(perms)}
                                disabled={readOnly} />
                              <span className="text-xs font-semibold text-ink-primary">{label}</span>
                              <span className="text-[10px] text-ink-muted font-mono">
                                ({resource})
                              </span>
                            </label>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1 pl-6">
                              {perms.map(p => (
                                <label key={p.id}
                                  className="flex items-start gap-1.5 text-xs text-ink-secondary cursor-pointer hover:bg-surface-elevated/40 rounded px-1 py-0.5">
                                  <input type="checkbox"
                                    className="mt-0.5 w-3.5 h-3.5 accent-brand-600"
                                    checked={permIds.has(p.id)}
                                    onChange={() => togglePerm(p.id)}
                                    disabled={readOnly} />
                                  <span>
                                    {p.description || p.action}
                                    <span className="ml-1 text-[10px] text-ink-muted font-mono">
                                      ({p.action})
                                    </span>
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>}

        {/* ── Pestaña 2: Botones controlables ─────────────────────────── */}
        {activeTab === 'botones' && <div>
          <label className="label mb-1">Botones controlables</label>
          <p className="text-[11px] text-ink-muted mb-2">
            Vista resumida — equivalente a marcar/desmarcar los permisos de arriba,
            pero pensada por pantalla. Solo aparecen las pantallas a las que el
            rol tiene acceso de lectura. Si dos botones comparten permiso, se
            prenden o apagan juntos.
          </p>
          <div className="border border-line-subtle rounded-xl divide-y divide-line-subtle max-h-60 overflow-y-auto">
            {buttonScreens.length === 0 && (
              <div className="p-4 text-center text-xs text-ink-muted">
                Marca primero algún permiso de <em>lectura</em> arriba para que aparezcan los botones de esa pantalla.
              </div>
            )}
            {buttonScreens.map(({ screen, buttons }) => (
              <div key={screen} className="p-3">
                <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
                  {screen}
                </p>
                <div className="flex flex-col gap-1.5">
                  {buttons.map(btn => {
                    const id      = permIdByKey[btn.permission]
                    const enabled = id ? permIds.has(id) : false
                    const shared  = buttonsSharingPermission(btn)
                    const missing = !id
                    return (
                      <label key={btn.key}
                        className={clsx('flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-elevated/40',
                          missing && 'opacity-50 cursor-not-allowed')}>
                        <input type="checkbox"
                          className="mt-0.5 w-4 h-4 accent-brand-600"
                          checked={enabled}
                          disabled={readOnly || missing}
                          onChange={() => id && togglePerm(id)} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-ink-primary">{btn.label}</p>
                          <p className="text-[10px] text-ink-muted font-mono mt-0.5">
                            Permiso: {btn.permission}
                            {missing && ' · (no existe en BD aún)'}
                          </p>
                          {shared.length > 0 && (
                            <p className="text-[10px] text-ink-muted mt-0.5">
                              Comparte interruptor con: {shared.map(s => s.label).join(', ')}
                            </p>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>}

        {/* ── Pestaña 3: Menú lateral ─────────────────────────────────── */}
        {activeTab === 'sidebar' && <div>
          <label className="label mb-1">Items del menú lateral</label>
          <p className="text-[11px] text-ink-muted mb-2">
            Vista del menú lateral tal cual lo verá el usuario. Marcar un item activa
            el permiso de lectura que lo controla. Es equivalente a marcar el permiso en la
            pestaña "Permisos", solo que presentado por sección del menú.
          </p>
          <div className="border border-line-subtle rounded-xl divide-y divide-line-subtle max-h-[55vh] overflow-y-auto">
            {NAV_SECTIONS.map((section, si) => {
              const sectionItems = section.items
              const sectionPermCount = sectionItems.filter(it => it.permission && permIdByKey[it.permission] && permIds.has(permIdByKey[it.permission])).length
              const sectionTotalWithPerm = sectionItems.filter(it => it.permission).length
              return (
                <div key={si} className="p-3">
                  {section.label ? (
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
                        {section.label}
                      </p>
                      {sectionTotalWithPerm > 0 && (
                        <span className="text-[10px] text-ink-muted">
                          {sectionPermCount} / {sectionTotalWithPerm}
                        </span>
                      )}
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1">
                    {sectionItems.map(it => {
                      const isChild = it.label.startsWith('└')
                      const cleanLabel = isChild ? it.label.replace(/^└\s*/, '') : it.label
                      if (!it.permission) {
                        // Item siempre visible (Inicio) — no se controla por permiso.
                        return (
                          <div key={it.to}
                            className={clsx('flex items-center gap-2 px-2 py-1 text-xs text-ink-muted',
                              isChild && 'pl-8')}>
                            <span className="w-4 h-4 inline-block" />
                            <span>{cleanLabel}</span>
                            <span className="text-[10px] italic ml-auto">siempre visible</span>
                          </div>
                        )
                      }
                      const permId = permIdByKey[it.permission]
                      const enabled = permId ? permIds.has(permId) : false
                      const missing = !permId
                      return (
                        <label key={it.to}
                          className={clsx(
                            'flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-elevated/40 cursor-pointer',
                            isChild && 'pl-8',
                            missing && 'opacity-50 cursor-not-allowed')}>
                          <input type="checkbox"
                            className="w-4 h-4 accent-brand-600"
                            checked={enabled}
                            disabled={readOnly || missing}
                            onChange={() => permId && togglePerm(permId)} />
                          <span className="text-sm text-ink-primary">{cleanLabel}</span>
                          <span className="text-[10px] text-ink-muted font-mono ml-auto">
                            {it.permission}{missing && ' · (no existe)'}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>}

        {/* ── Pestaña 4: Inicio y accesos rápidos móvil ───────────────── */}
        {activeTab === 'inicio' && <div className="flex flex-col gap-5">
        <div>
          <label className="label">Ventana de inicio del rol</label>
          <p className="text-[11px] text-ink-muted mb-2">
            A qué pantalla aterriza el usuario al entrar. Si dejas el default,
            el sistema decide según permisos (operadores van a captura, el resto al dashboard).
          </p>
          <select className="select" value={homeRoute}
            disabled={readOnly}
            onChange={e => setHomeRoute(e.target.value)}>
            {HOME_ROUTE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* ── Accesos rápidos del móvil ───────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">Accesos rápidos en móvil</label>
            <span className="text-xs text-ink-muted">
              {mobileTabs.length} de {MAX_MOBILE_TABS}
            </span>
          </div>
          <p className="text-[11px] text-ink-muted mb-2">
            Hasta {MAX_MOBILE_TABS} pestañas que aparecen en la barra inferior del celular.
            Si no eliges ninguna, el sistema arma la barra automáticamente según permisos.
          </p>
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
            {MOBILE_TABS.map(tab => {
              const selectedIdx = mobileTabs.indexOf(tab.key)
              const isSelected  = selectedIdx >= 0
              const atCap       = !isSelected && mobileTabs.length >= MAX_MOBILE_TABS
              return (
                <div key={tab.key}
                  className={clsx('flex items-center gap-2 px-2 py-1.5',
                    atCap && 'opacity-50')}>
                  <label className="flex items-center gap-2 flex-1 cursor-pointer min-w-0">
                    <input type="checkbox"
                      className="w-4 h-4 accent-brand-600"
                      checked={isSelected}
                      disabled={readOnly || atCap}
                      onChange={() => toggleMobileTab(tab.key)} />
                    <span className="text-xs text-ink-primary truncate">{tab.label}</span>
                    <span className="text-[10px] text-ink-muted font-mono truncate">{tab.to}</span>
                  </label>
                  {isSelected && !readOnly && (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px] text-brand-300 font-mono bg-brand-500/15 px-1.5 py-0.5 rounded">
                        #{selectedIdx + 1}
                      </span>
                      <button type="button" onClick={() => moveMobileTab(tab.key, -1)}
                        disabled={selectedIdx === 0}
                        className="text-ink-muted hover:text-ink-primary disabled:opacity-30 px-1"
                        title="Subir">▲</button>
                      <button type="button" onClick={() => moveMobileTab(tab.key, 1)}
                        disabled={selectedIdx === mobileTabs.length - 1}
                        className="text-ink-muted hover:text-ink-primary disabled:opacity-30 px-1"
                        title="Bajar">▼</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        </div>}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">
            {readOnly ? 'Cerrar' : 'Cancelar'}
          </button>
          {!readOnly && (
            <button type="submit" disabled={mutation.isPending || !name.trim()}
              className="btn-primary flex-1">
              {mutation.isPending ? <Spinner size="sm" /> : (isNew ? 'Crear rol' : 'Guardar cambios')}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Página principal ───────────────────────────────────────────────────────
export default function Roles() {
  const qc = useQueryClient()
  const [showEditor, setShowEditor] = useState(false)
  const [editingRole, setEditingRole] = useState(null)
  const [msg, setMsg] = useState(null)

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn:  () => rolesApi.list(),
  })

  // Detalle de cada rol (permisos) — en paralelo, para mostrar resumen visual.
  const roleDetails = useQueries({
    queries: roles.map(r => ({
      queryKey: ['role', r.id],
      queryFn:  () => rolesApi.get(r.id),
      staleTime: 60_000,
    })),
  })
  const detailById = useMemo(() => {
    const map = {}
    roleDetails.forEach(q => {
      if (q.data?.id) map[q.data.id] = q.data
    })
    return map
  }, [roleDetails.map(q => q.data?.id).join('|')])

  const deleteMutation = useMutation({
    mutationFn: (id) => rolesApi.delete(id),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['roles'] })
      setMsg(r.message || 'Rol eliminado.')
    },
    onError: (e) => alert(e.response?.data?.error || e.message || 'Error'),
  })

  async function openEditor(roleId) {
    if (roleId) {
      // Cargar detalle con permisos
      const role = await rolesApi.get(roleId)
      setEditingRole(role)
    } else {
      setEditingRole(null)
    }
    setShowEditor(true)
  }

  function handleDelete(role) {
    if (!window.confirm(`¿Eliminar el rol "${role.name}"? Los usuarios que lo tengan perderán esos permisos.`)) return
    deleteMutation.mutate(role.id)
  }

  return (
    <div className="page-enter flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Roles y permisos</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Define qué puede hacer cada usuario. Los roles de sistema no se editan.
          </p>
        </div>
        <Can do="roles:create">
          <button onClick={() => openEditor(null)} className="btn-primary">
            + Nuevo rol
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-success">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-success">✕</button>
        </div>
      )}

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !roles.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium text-ink-secondary">Sin roles configurados</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-line-subtle">
            {roles.map(r => {
              const detail = detailById[r.id]
              const summary = detail ? roleSummary(detail.permissions) : null
              return (
                <div key={r.id} className="p-4 hover:bg-surface-elevated/40/60 transition-colors flex gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-ink-primary">{r.name}</span>
                      {r.is_system ? (
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                          Sistema
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold uppercase tracking-wide bg-brand-500/15 text-brand-300 px-1.5 py-0.5 rounded-full">
                          Propio
                        </span>
                      )}
                      <span className="text-[10px] text-ink-muted">
                        {r.permission_count || 0} permisos
                      </span>
                    </div>
                    {r.description && (
                      <p className="text-xs text-ink-secondary mt-1">{r.description}</p>
                    )}
                    {summary && (
                      <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed">
                        <span className="font-semibold text-ink-secondary">Puede:</span> {summary}
                      </p>
                    )}
                    <p className="text-[10px] text-ink-muted mt-1">Creado {fmtDate(r.created_at)}</p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button onClick={() => openEditor(r.id)}
                      className="btn-ghost btn-sm text-brand-300">
                      {r.is_system ? 'Ver' : 'Editar'}
                    </button>
                    {!r.is_system && (
                      <button onClick={() => handleDelete(r)}
                        disabled={deleteMutation.isPending}
                        className="btn-ghost btn-sm text-status-danger">
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showEditor && (
        <RolEditorModal
          role={editingRole}
          onClose={() => { setShowEditor(false); setEditingRole(null) }}
        />
      )}
    </div>
  )
}
