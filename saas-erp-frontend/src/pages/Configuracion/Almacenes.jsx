import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { warehousesApi } from '@/api/warehouses'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import WarehouseModal from '@/components/almacenes/WarehouseModal'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

// ── Catálogos ─────────────────────────────────────────────────────────────────
const TYPE_LABELS = {
  raw_material:     'Materia prima',
  packaging:        'Embalaje',
  wip:              'Producto en proceso',
  finished_product: 'Producto terminado',
  regrind:          'Material reciclado',
  resale:           'Almacén de reventa',
}

const TYPE_BADGE = {
  raw_material:     'amber',
  packaging:        'teal',
  wip:              'gray',
  finished_product: 'blue',
  regrind:          'purple',
  resale:           'teal',
}

const TYPE_DESCRIPTIONS = {
  raw_material:     'Captura manual y recibe compras de MP',
  packaging:        'Bolsas, etiquetas, fleje, cajas — se consumen al empacar',
  wip:              'Solo lectura — gestionado por producción',
  finished_product: 'Recibe del cierre de turno y sale por ventas',
  regrind:          'Material recuperado de mermas',
  resale:           'Productos comprados para reventa',
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return '0'
  return Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })
}

// ─────────────────────────────────────────────────────────────────────────────
//  Componente principal
// ─────────────────────────────────────────────────────────────────────────────
export default function Almacenes() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canCreate = isSuperAdmin || can?.('warehouses', 'create')
  const canUpdate = isSuperAdmin || can?.('warehouses', 'update')
  const canDelete = isSuperAdmin || can?.('warehouses', 'delete')
  const canManage = canCreate || canUpdate || canDelete

  const [filterType, setFilterType]       = useState('')
  const [showInactive, setShowInactive]   = useState(false)
  const [editing, setEditing]             = useState(null)   // null | warehouse | 'new'
  const [actionMenuOpen, setActionMenuOpen] = useState(null) // id | null
  const [serverError, setServerError]     = useState(null)
  const [successMsg, setSuccessMsg]       = useState(null)

  const { data: warehouses = [], isLoading } = useQuery({
    queryKey: ['warehouses-admin', showInactive],
    queryFn:  () => warehousesApi.list({ includeInactive: showInactive }),
  })

  // ── Filtro local por tipo ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!filterType) return warehouses
    return warehouses.filter(w => w.type === filterType)
  }, [warehouses, filterType])

  // ── Mutaciones ────────────────────────────────────────────────────────────
  const setDefaultMut = useMutation({
    mutationFn: (id) => warehousesApi.setDefault(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['warehouses-admin'] })
      qc.invalidateQueries({ queryKey: ['inv-warehouses'] })
      setSuccessMsg('Default actualizado.')
      setTimeout(() => setSuccessMsg(null), 3000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, isActive }) => warehousesApi.update(id, { is_active: isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['warehouses-admin'] })
      qc.invalidateQueries({ queryKey: ['inv-warehouses'] })
      setActionMenuOpen(null)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  const removeMut = useMutation({
    mutationFn: (id) => warehousesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['warehouses-admin'] })
      qc.invalidateQueries({ queryKey: ['inv-warehouses'] })
      setActionMenuOpen(null)
      setSuccessMsg('Almacén eliminado.')
      setTimeout(() => setSuccessMsg(null), 3000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleRemove(w) {
    setServerError(null)
    if (!confirm(`¿Eliminar el almacén "${w.name}"?\n\nSolo es posible si NO tiene stock ni movimientos. De lo contrario usa "Desactivar".`)) {
      return
    }
    removeMut.mutate(w.id)
  }

  function handleToggleActive(w) {
    setServerError(null)
    const action = w.is_active ? 'desactivar' : 'activar'
    if (!confirm(`¿${action[0].toUpperCase() + action.slice(1)} el almacén "${w.name}"?`)) return
    toggleActiveMut.mutate({ id: w.id, isActive: !w.is_active })
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Almacenes</h1>
          <p className="page-subtitle">Configuración de almacenes del sistema</p>
        </div>
        {canCreate && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo almacén
          </button>
        )}
      </div>

      {/* ── Mensajes ───────────────────────────────────────────────────── */}
      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span>
          <button onClick={() => setSuccessMsg(null)} className="text-green-400">✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span>
          <button onClick={() => setServerError(null)} className="text-red-400">✕</button>
        </div>
      )}

      {/* ── Banner explicativo ─────────────────────────────────────────── */}
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="font-semibold mb-1">Sobre los tipos de almacén</p>
        <p className="text-status-info">
          Los <strong>tipos</strong> son fijos del sistema y definen el comportamiento (qué procesos los
          usan automáticamente). Puedes crear varios almacenes del mismo tipo y elegir cuál es el{' '}
          <strong>default</strong> ⭐ — ese es el que reciben los hooks automáticos de producción.
          <strong> WIP es solo lectura</strong>: no aparece en ajustes ni recepciones, solo se mueve por
          producción.
        </p>
      </div>

      {/* ── Filtros ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          className="select w-52"
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
        >
          <option value="">Todos los tipos</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="w-4 h-4 accent-brand-600"
          />
          Mostrar inactivos
        </label>
      </div>

      {/* ── Tabla ─────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin almacenes para mostrar</p>
          {canCreate && (
            <button onClick={() => setEditing('new')} className="btn-primary btn-sm mt-3">
              + Crear primer almacén
            </button>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="w-8"></th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Resina</th>
                <th className="text-right">Items con stock</th>
                <th className="text-right">Movs. históricos</th>
                <th>Estado</th>
                {canManage && <th className="w-12"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(w => {
                const isWIP   = w.type === 'wip'
                const isInact = !w.is_active
                return (
                  <tr key={w.id} className={clsx(isInact && 'opacity-50')}>
                    <td>
                      {w.is_default && (
                        <span title="Almacén default — recibe automáticos de su tipo">
                          <svg className="w-4 h-4 text-amber-500" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>
                          </svg>
                        </span>
                      )}
                    </td>
                    <td>
                      <p className="text-sm font-medium text-ink-primary flex items-center gap-2">
                        {w.name}
                        {isWIP && (
                          <span title="Solo lectura — no admite ajustes ni recepciones">
                            <svg className="w-3.5 h-3.5 text-ink-muted" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
                            </svg>
                          </span>
                        )}
                      </p>
                      {w.description && (
                        <p className="text-xs text-ink-muted truncate max-w-md">{w.description}</p>
                      )}
                    </td>
                    <td>
                      <Badge variant={TYPE_BADGE[w.type]} label={TYPE_LABELS[w.type] || w.type} />
                      <p className="text-[10px] text-ink-muted mt-0.5">{TYPE_DESCRIPTIONS[w.type]}</p>
                    </td>
                    <td className="text-sm text-ink-secondary">
                      {w.resin_type || <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="text-right font-mono text-sm">{fmtNum(w.stock_items_count)}</td>
                    <td className="text-right font-mono text-xs text-ink-muted">{fmtNum(w.movements_count)}</td>
                    <td>
                      <Badge
                        variant={w.is_active ? 'green' : 'gray'}
                        label={w.is_active ? 'Activo' : 'Inactivo'}
                      />
                    </td>
                    {canManage && (
                      <td className="relative">
                        <button
                          onClick={() => setActionMenuOpen(actionMenuOpen === w.id ? null : w.id)}
                          className="btn-ghost btn-icon text-ink-muted"
                          aria-label="Acciones"
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                          </svg>
                        </button>
                        {actionMenuOpen === w.id && (
                          <>
                            <div
                              className="fixed inset-0 z-30"
                              onClick={() => setActionMenuOpen(null)}
                            />
                            <div className="absolute right-2 top-9 z-40 w-56 bg-surface-primary shadow-card rounded-xl border border-line-subtle py-1 text-sm">
                              {canUpdate && (
                                <button
                                  onClick={() => { setEditing(w); setActionMenuOpen(null) }}
                                  className="w-full text-left px-3 py-2 hover:bg-surface-elevated/40 text-ink-secondary"
                                >
                                  ✏️ Editar
                                </button>
                              )}
                              {canUpdate && !w.is_default && w.is_active && (
                                <button
                                  onClick={() => { setDefaultMut.mutate(w.id); setActionMenuOpen(null) }}
                                  className="w-full text-left px-3 py-2 hover:bg-surface-elevated/40 text-ink-secondary"
                                >
                                  ⭐ Marcar como default
                                </button>
                              )}
                              {canUpdate && (
                                <button
                                  onClick={() => handleToggleActive(w)}
                                  className={clsx(
                                    'w-full text-left px-3 py-2 hover:bg-surface-elevated/40',
                                    w.is_active ? 'text-status-warning' : 'text-status-success'
                                  )}
                                >
                                  {w.is_active ? '⏸ Desactivar' : '▶ Activar'}
                                </button>
                              )}
                              {canDelete && (
                                <>
                                  <div className="border-t border-line-subtle my-1" />
                                  <button
                                    onClick={() => { handleRemove(w); setActionMenuOpen(null) }}
                                    className="w-full text-left px-3 py-2 hover:bg-status-danger/10 text-status-danger"
                                  >
                                    🗑 Eliminar
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Leyenda ───────────────────────────────────────────────────── */}
      <div className="text-xs text-ink-muted flex gap-4 flex-wrap">
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3 text-amber-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>
          </svg>
          Default — recibe automáticos de producción
        </span>
        <span className="flex items-center gap-1">
          <svg className="w-3 h-3 text-ink-muted" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z"/>
          </svg>
          Solo lectura — gestionado por producción
        </span>
      </div>

      {/* ── Modal de edición/creación ─────────────────────────────────── */}
      {editing && (
        <WarehouseModal
          warehouse={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['warehouses-admin'] })
            qc.invalidateQueries({ queryKey: ['inv-warehouses'] })
            setEditing(null)
            setSuccessMsg(editing === 'new' ? 'Almacén creado.' : 'Almacén actualizado.')
            setTimeout(() => setSuccessMsg(null), 3000)
          }}
        />
      )}
    </div>
  )
}
