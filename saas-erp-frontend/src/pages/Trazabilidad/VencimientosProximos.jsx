import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { lotsApi } from '@/api/lots'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const IconRefresh = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
)
const IconBox    = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
)
const IconLeaf   = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
  </svg>
)
const IconAlert  = () => (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
  </svg>
)

function daysUntil(dateStr) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const exp = new Date(dateStr)
  exp.setHours(0, 0, 0, 0)
  return Math.round((exp - today) / (1000 * 60 * 60 * 24))
}

function urgencyConfig(days) {
  if (days <= 0)  return { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    text: 'text-red-700',    label: 'Vence hoy',      dot: 'bg-red-500' }
  if (days === 1) return { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    text: 'text-red-700',    label: 'Vence mañana',   dot: 'bg-red-500' }
  if (days <= 3)  return { bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700', text: 'text-amber-700', label: `${days} días`,   dot: 'bg-amber-400' }
  return               { bg: 'bg-yellow-50', border: 'border-yellow-200', badge: 'bg-yellow-100 text-yellow-700', text: 'text-yellow-700', label: `${days} días`, dot: 'bg-yellow-400' }
}

function LotRow({ lot, type }) {
  const days = daysUntil(lot.expiry_date)
  const u    = urgencyConfig(days)
  const name = type === 'rm' ? lot.raw_material_name : lot.product_name
  const expiryFmt = new Date(lot.expiry_date).toLocaleDateString('es-MX', {
    day: 'numeric', month: 'short', year: 'numeric',
  })

  return (
    <div className={clsx('flex items-center gap-3 px-4 py-3 border rounded-xl', u.bg, u.border)}>
      <div className={clsx('w-2 h-2 rounded-full shrink-0', u.dot)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink-primary truncate">{name}</p>
        <p className="text-xs text-ink-muted mt-0.5">
          Lote <span className="font-mono">{lot.lot_number}</span>
          {' · '}Vence: {expiryFmt}
          {lot.quantity_remaining != null && (
            <> · Disp: <span className="font-medium">{parseFloat(lot.quantity_remaining)}</span></>
          )}
        </p>
      </div>
      <span className={clsx('shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full', u.badge)}>
        {u.label}
      </span>
    </div>
  )
}

function Section({ title, icon, lots, type, empty }) {
  if (lots.length === 0) return null
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-ink-muted">{icon}</span>
        <h2 className="text-sm font-semibold text-ink-primary">{title}</h2>
        <span className="text-xs font-medium px-2 py-0.5 bg-surface-elevated/60 border border-line-subtle rounded-full text-ink-secondary">
          {lots.length} lote{lots.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="space-y-2">
        {lots.map(lot => <LotRow key={lot.id} lot={lot} type={type} />)}
      </div>
    </div>
  )
}

export default function VencimientosProximos() {
  const [days, setDays] = useState('')
  const queryClient = useQueryClient()

  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['expiring-lots', days],
    queryFn: () => lotsApi.getExpiring(days ? { days } : {}),
    refetchInterval: 60_000,
  })

  const checkMutation = useMutation({
    mutationFn: () => lotsApi.runExpirationCheck(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['expiring-lots'] }),
  })

  const rmLots  = data?.rawMaterialLots || []
  const ptLots  = data?.productLots     || []
  const total   = rmLots.length + ptLots.length
  const critical = [...rmLots, ...ptLots].filter(l => daysUntil(l.expiry_date) <= 1).length

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Vencimientos próximos</h1>
          <p className="page-subtitle">
            {isLoading ? 'Cargando…' : (
              <>
                {total === 0
                  ? `Sin lotes próximos a vencer en ${data?.daysAhead ?? '…'} días`
                  : `${total} lote${total !== 1 ? 's' : ''} por vencer`}
                {critical > 0 && (
                  <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 bg-red-100 text-red-700 rounded-full">
                    <IconAlert /> {critical} crítico{critical !== 1 ? 's' : ''}
                  </span>
                )}
                {lastUpdated && <span className="ml-2 text-ink-muted text-xs">· act. {lastUpdated}</span>}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Filtro días */}
          <select
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="select text-sm py-1.5 pr-8">
            <option value="">Umbral del sistema</option>
            <option value="1">Hoy y mañana</option>
            <option value="3">3 días</option>
            <option value="7">7 días</option>
            <option value="14">14 días</option>
            <option value="30">30 días</option>
          </select>

          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['expiring-lots'] })}
            className="btn-secondary btn-sm inline-flex items-center gap-1.5"
            title="Actualizar">
            <IconRefresh /> Actualizar
          </button>

          <button
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            className="btn-secondary btn-sm inline-flex items-center gap-1.5"
            title="Marcar lotes vencidos y generar alertas">
            {checkMutation.isPending ? <Spinner className="w-4 h-4" /> : <IconAlert />}
            Marcar expirados
          </button>
        </div>
      </div>

      {checkMutation.isSuccess && (
        <div className="mb-4 px-4 py-3 bg-status-success/10 border border-status-success/40 rounded-xl text-sm text-status-success">
          ✓ Verificación completada. Los lotes vencidos fueron marcados.
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : error ? (
        <div className="px-4 py-3 bg-status-danger/10 border border-status-danger/40 rounded-xl text-sm text-status-danger">
          Error cargando lotes: {error?.response?.data?.error || error.message}
        </div>
      ) : total === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin vencimientos próximos</p>
          <p>No hay lotes activos que venzan en los próximos {data?.daysAhead ?? '–'} días.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <Section
            title="Productos terminados"
            icon={<IconBox />}
            lots={ptLots}
            type="pt"
          />
          <Section
            title="Materias primas"
            icon={<IconLeaf />}
            lots={rmLots}
            type="rm"
          />
        </div>
      )}

      {/* Leyenda de colores */}
      {total > 0 && (
        <div className="flex gap-4 flex-wrap mt-6 pt-4 border-t border-line-subtle">
          {[
            { dot: 'bg-red-500',    label: 'Vence hoy o mañana' },
            { dot: 'bg-amber-400',  label: '2–3 días' },
            { dot: 'bg-yellow-400', label: '4+ días' },
          ].map(({ dot, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <div className={clsx('w-2.5 h-2.5 rounded-full', dot)} />
              <span className="text-xs text-ink-muted">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
