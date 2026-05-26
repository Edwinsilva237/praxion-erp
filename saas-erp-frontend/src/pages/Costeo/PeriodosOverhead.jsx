import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import HelpTip from '@/components/ui/HelpTip'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const FREQ_LABELS = {
  monthly:  'Mensual',
  biweekly: 'Quincenal',
  annual:   'Anual',
  event:    'Por evento',
}

const fmtMoney = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function EditAmountCell({ period, canManage }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(period.estimated_amount ?? 0)
  const [error, setError] = useState(null)

  const mut = useMutation({
    mutationFn: () => overheadApi.updatePeriod(period.id, { estimated_amount: parseFloat(value) || 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['overhead-periods'] })
      setEditing(false)
      setError(null)
    },
    onError: (err) => setError(err.response?.data?.error || err.message),
  })

  if (!canManage || period.is_finalized) {
    return <span className="font-mono text-sm">{fmtMoney(period.estimated_amount)}</span>
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setValue(period.estimated_amount ?? 0); setEditing(true) }}
        className="font-mono text-sm hover:underline text-brand-400"
      >
        {fmtMoney(period.estimated_amount)}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="number" min={0} step="0.01"
        className="input input-sm w-28 text-right"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') mut.mutate(); if (e.key === 'Escape') setEditing(false) }}
        autoFocus
      />
      <button onClick={() => mut.mutate()} disabled={mut.isPending} className="btn-primary btn-xs">
        {mut.isPending ? <Spinner className="w-3 h-3" /> : '✓'}
      </button>
      <button onClick={() => setEditing(false)} className="btn-ghost btn-xs text-ink-muted">✕</button>
      {error && <span className="text-xs text-status-danger">{error}</span>}
    </div>
  )
}

export default function PeriodosOverhead() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('overhead', 'update')

  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [serverError, setServerError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const { data: periods = [], isLoading } = useQuery({
    queryKey: ['overhead-periods', year, month],
    queryFn:  () => overheadApi.listPeriods({ year, month }),
  })

  const ensureMut = useMutation({
    mutationFn: () => overheadApi.ensurePeriods({ year, month }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['overhead-periods'] })
      setSuccessMsg(`${data.created} período(s) creado(s), ${data.existing} ya existían.`)
      setTimeout(() => setSuccessMsg(null), 4000)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  const finalized = periods.filter(p => p.is_finalized).length
  const pending   = periods.length - finalized

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Períodos del mes</h1>
          <p className="page-subtitle">Capturas el estimado de cada gasto a inicio del mes; el real va en "Cierre de mes"</p>
        </div>
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="font-medium mb-1">¿Cómo lo uso?</p>
        <ol className="list-decimal list-inside leading-relaxed space-y-0.5">
          <li>Elige el mes y haz clic en <strong>"Crear períodos del mes"</strong> — el sistema genera un renglón por cada gasto activo del catálogo.</li>
          <li>Ajusta el <strong>estimado</strong> de cada renglón si difiere del default. Los turnos producidos en el mes irán absorbiendo este monto.</li>
          <li>Al final del mes ve a <Link to="/costeo/cierre" className="underline hover:no-underline">Cierre de mes</Link> para capturar los <strong>reales</strong>.</li>
        </ol>
      </div>

      {/* Selector de mes */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Año</label>
          <select className="select w-24" value={year} onChange={e => setYear(parseInt(e.target.value))}>
            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Mes</label>
          <select className="select w-36" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
            {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
        </div>
        {canManage && (
          <button
            onClick={() => ensureMut.mutate()}
            disabled={ensureMut.isPending}
            className="btn-secondary btn-sm"
          >
            {ensureMut.isPending ? <Spinner className="w-3 h-3" /> : null}
            Crear períodos del mes
          </button>
        )}
      </div>

      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span><button onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span><button onClick={() => setServerError(null)}>✕</button>
        </div>
      )}

      {/* Resumen */}
      {periods.length > 0 && (
        <div className="flex items-center gap-4 text-sm text-ink-secondary">
          <span>{periods.length} gasto(s)</span>
          <span className="text-status-success">{finalized} finalizado(s)</span>
          <span className="text-status-warning">{pending} pendiente(s)</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : periods.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin períodos para {MONTHS[month-1]} {year}</p>
          <p className="text-sm text-ink-muted mt-1">
            {canManage
              ? 'Usa el botón "Crear períodos del mes" para generarlos desde los gastos activos.'
              : 'No hay períodos configurados para este mes.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Gasto</th>
                <th>Frecuencia</th>
                <th className="text-right">
                  <span className="inline-flex items-center gap-1">
                    Estimado
                    <HelpTip
                      title="Estimado"
                      body="Monto aproximado que esperas gastar este período. Cada turno producido absorbe su parte proporcional según la base de prorrateo del gasto."
                    />
                  </span>
                </th>
                <th className="text-right">
                  <span className="inline-flex items-center gap-1">
                    Real
                    <HelpTip
                      title="Real"
                      body="Monto exacto que terminaste gastando. Se captura en 'Cierre de mes' al cerrar el período; el sistema usa este valor para recostear las órdenes producidas."
                    />
                  </span>
                </th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    Estado
                    <HelpTip
                      title="Estado del período"
                      body={
                        <ul className="list-disc list-inside space-y-0.5">
                          <li><strong>Abierto</strong>: aceptando turnos y se puede editar el estimado.</li>
                          <li><strong>Finalizado</strong>: el mes se cerró; ya no se puede modificar.</li>
                        </ul>
                      }
                    />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {periods.map(p => (
                <tr key={p.id} className={clsx(p.is_finalized && 'opacity-70')}>
                  <td>
                    <p className="font-medium text-sm">{p.item_name || p.overhead_item_id}</p>
                    {p.item_code && <p className="text-xs font-mono text-ink-muted">{p.item_code}</p>}
                  </td>
                  <td>
                    <Badge
                      variant={p.capture_frequency === 'event' ? 'amber' : 'blue'}
                      label={FREQ_LABELS[p.capture_frequency] || p.capture_frequency || '—'}
                    />
                  </td>
                  <td className="text-right">
                    <EditAmountCell period={p} canManage={canManage} />
                  </td>
                  <td className="text-right font-mono text-sm">
                    {p.is_finalized ? fmtMoney(p.real_amount) : <span className="text-ink-muted text-xs">—</span>}
                  </td>
                  <td>
                    <Badge
                      variant={p.is_finalized ? 'green' : 'gray'}
                      label={p.is_finalized ? 'Finalizado' : 'Abierto'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
