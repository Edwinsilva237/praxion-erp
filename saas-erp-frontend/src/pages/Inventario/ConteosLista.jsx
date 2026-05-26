import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { countsApi } from '@/api/counts'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import CountFormModal from '@/components/inventario/CountFormModal'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const TYPE_OPTS = [
  ['',            'Todos los tipos'],
  ['cyclic',      'Cíclico'],
  ['month_close', 'Cierre de mes'],
]
const STATUS_OPTS = [
  ['',            'Todos los estados'],
  ['in_capture',  'En captura'],
  ['reconciling', 'Conciliando'],
  ['applied',     'Aplicado'],
  ['cancelled',   'Cancelado'],
]

const STATUS_BADGE = {
  in_capture:  { color: 'bg-status-info/15 text-status-info',     label: 'En captura' },
  reconciling: { color: 'bg-status-warning/15 text-status-warning',   label: 'Conciliando' },
  applied:     { color: 'bg-status-success/15 text-status-success',   label: 'Aplicado' },
  cancelled:   { color: 'bg-surface-elevated/60 text-ink-muted',     label: 'Cancelado' },
}

const TYPE_LABEL = {
  cyclic:      { icon: '🔄', label: 'Cíclico' },
  month_close: { icon: '📅', label: 'Cierre de mes' },
}

export default function ConteosLista() {
  const navigate = useNavigate()
  const [showFormModal, setShowFormModal] = useState(false)

  const [typeFilter, setTypeFilter]         = useState('')
  const [statusFilter, setStatusFilter]     = useState('')
  const [warehouseFilter, setWarehouseFilter] = useState('')
  const [page, setPage] = useState(1)

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['counts', typeFilter, statusFilter, warehouseFilter, page],
    queryFn:  () => countsApi.list({
      count_type:   typeFilter      || undefined,
      status:       statusFilter    || undefined,
      warehouse_id: warehouseFilter || undefined,
      page, limit: 20,
    }),
    keepPreviousData: true,
  })

  const items = data?.data || []
  const total = data?.total || 0

  return (
    <div className="page-container">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-ink-primary">Conteos físicos</h1>
          <p className="text-sm text-ink-muted mt-1">
            Conteos cíclicos y cierres de mes con conciliación automática.
          </p>
        </div>
        <Can do="inventory:create">
          <button
            onClick={() => setShowFormModal(true)}
            className="btn-primary"
          >
            + Nuevo conteo
          </button>
        </Can>
      </div>

      {/* Filtros */}
      <div className="bg-surface-primary border border-line-subtle rounded-xl p-3 mb-4 flex flex-wrap gap-2">
        <select className="select select-sm" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1) }}>
          {TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="select select-sm" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
          {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="select select-sm" value={warehouseFilter} onChange={e => { setWarehouseFilter(e.target.value); setPage(1) }}>
          <option value="">Todos los almacenes</option>
          {warehouses.filter(w => w.is_active).map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </div>

      {/* Tabla */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin conteos registrados</p>
          <p className="text-sm text-ink-muted">
            Inicia un conteo cíclico cuando quieras verificar las existencias físicas
            contra el sistema, o un cierre de mes al final de cada periodo contable.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Tipo</th>
                <th>Almacén</th>
                <th>Iniciado</th>
                <th>Estado</th>
                <th className="text-right">Capturadas</th>
                <th className="text-right">Diferencias</th>
                <th className="text-right">Impacto</th>
                <th>Iniciado por</th>
              </tr>
            </thead>
            <tbody>
              {items.map(c => {
                const typeCfg   = TYPE_LABEL[c.count_type]   || {}
                const statusCfg = STATUS_BADGE[c.status]     || { color: 'bg-surface-elevated/60 text-ink-muted', label: c.status }
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/inventario/conteos/${c.id}`)}
                    className="cursor-pointer hover:bg-surface-elevated/40 transition-colors"
                  >
                    <td className="font-mono text-sm font-semibold">
                      {c.count_number}
                      {c.adjustment_number && (
                        <span className="block text-[10px] text-ink-muted font-normal mt-0.5">
                          → {c.adjustment_number}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="text-sm">
                        {typeCfg.icon} {typeCfg.label}
                      </span>
                    </td>
                    <td className="text-sm text-ink-secondary">
                      {c.warehouse_name || (c.count_type === 'month_close' ? 'Todos' : '—')}
                    </td>
                    <td className="text-xs text-ink-muted">
                      {fmtDate(c.started_at)}
                    </td>
                    <td>
                      <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide', statusCfg.color)}>
                        {statusCfg.label}
                      </span>
                    </td>
                    <td className="text-right text-sm text-ink-secondary tabular-nums">
                      {c.captured_lines}/{c.total_lines}
                    </td>
                    <td className="text-right text-sm text-ink-secondary tabular-nums">
                      {c.status === 'applied' || c.status === 'reconciling' ? c.diff_lines : '—'}
                    </td>
                    <td className={clsx(
                      'text-right text-sm tabular-nums font-medium',
                      parseFloat(c.total_diff_value) > 0 ? 'text-status-success' :
                      parseFloat(c.total_diff_value) < 0 ? 'text-status-danger' : 'text-ink-muted'
                    )}>
                      {c.status === 'applied' || c.status === 'reconciling'
                        ? fmtMXN(c.total_diff_value)
                        : '—'}
                    </td>
                    <td className="text-xs text-ink-muted">{c.started_by_name || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginación */}
      {total > 20 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <span className="text-ink-muted">
            Mostrando {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} de {total}
          </span>
          <div className="flex gap-2">
            <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-secondary btn-sm disabled:opacity-40">
              ← Anterior
            </button>
            <button disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)} className="btn-secondary btn-sm disabled:opacity-40">
              Siguiente →
            </button>
          </div>
        </div>
      )}

      {/* Modal de creación */}
      {showFormModal && (
        <CountFormModal onClose={() => setShowFormModal(false)} />
      )}
    </div>
  )
}
