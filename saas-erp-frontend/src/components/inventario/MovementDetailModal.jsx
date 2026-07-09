import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { MOVEMENT_LABELS, MOVEMENT_BADGE } from '@/config/inventoryLabels'

const fmtMXN = (n) => (n == null ? '—' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 6 }).format(n))
const fmtNum = (n) => new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 }).format(n || 0)
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

const STATUS_LABEL = { available: 'Disponible', wip: 'En proceso', blocked: 'Bloqueado', reserved: 'Reservado' }

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-muted shrink-0">{label}</span>
      <span className="text-sm text-ink-primary text-right min-w-0 break-words">{children ?? '—'}</span>
    </div>
  )
}

/**
 * Detalle de un MOVIMIENTO del kardex + su documento origen (remisión, recepción,
 * ajuste, turno, etc.) para trazabilidad. Solo lectura.
 */
export default function MovementDetailModal({ movementId, onClose }) {
  const { data: m, isLoading } = useQuery({
    queryKey: ['movement-detail', movementId],
    queryFn:  () => inventoryApi.getMovement(movementId),
    enabled:  !!movementId,
    staleTime: 30000,
  })

  const qty = m ? parseFloat(m.quantity) : 0
  const isIn = qty >= 0
  const value = m ? (m.total_cost != null ? parseFloat(m.total_cost) : Math.abs(qty) * parseFloat(m.unit_cost || 0)) : 0
  const src = m?.source

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-lg p-0 max-h-[90vh] flex flex-col">
        {isLoading || !m ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <>
            <div className="px-6 pt-5 pb-3 border-b border-line-subtle">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow">MOVIMIENTO DE KARDEX</p>
                  <h2 className="text-base font-semibold text-ink-primary mt-0.5 break-words">
                    {m.item_name}{m.item_sku ? <span className="text-ink-muted font-mono text-xs"> · {m.item_sku}</span> : null}
                  </h2>
                  <p className="text-xs text-ink-muted mt-0.5">{fmtDate(m.created_at)}</p>
                </div>
                <Badge variant={MOVEMENT_BADGE[m.movement_type] || MOVEMENT_BADGE.default}
                  label={MOVEMENT_LABELS[m.movement_type] || m.movement_type} />
              </div>
              <div className={`mt-3 text-2xl font-bold tabular-nums ${isIn ? 'text-status-success' : 'text-status-danger'}`}>
                {isIn ? '+' : ''}{fmtNum(m.quantity)} <span className="text-sm font-normal text-ink-muted">{m.unit}</span>
                <span className="text-sm font-normal text-ink-muted ml-2">({isIn ? 'entrada' : 'salida'})</span>
              </div>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              {/* Documento origen — lo más importante para trazabilidad */}
              <div className="rounded-xl border border-brand-500/30 bg-brand-500/5 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-300 mb-1">Documento origen</p>
                <p className="text-sm font-semibold text-ink-primary">{src?.label || '—'}</p>
                {src?.partner && <p className="text-xs text-ink-secondary mt-0.5">{src.partner}</p>}
                {src?.date && <p className="text-[11px] text-ink-muted mt-0.5">{fmtDate(src.date)}</p>}
                {src?.note && <p className="text-xs text-ink-muted mt-1 italic">"{src.note}"</p>}
              </div>

              <div className="mt-3">
                <Row label="Almacén">{m.warehouse_name}</Row>
                <Row label="Estado resultante">{STATUS_LABEL[m.status_to] || m.status_to || '—'}</Row>
                <Row label="Costo unitario">{fmtMXN(m.unit_cost)}</Row>
                <Row label="Valor del movimiento">{fmtMXN(value)}</Row>
                <Row label="Saldo después">{fmtNum(m.balance_after)} {m.unit}</Row>
                {m.created_by_name && <Row label="Registrado por">{m.created_by_name}</Row>}
                {m.notes && <Row label="Notas">{m.notes}</Row>}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-line-subtle">
              <button onClick={onClose} className="btn-secondary w-full">Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
