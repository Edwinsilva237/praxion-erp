import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import clsx from 'clsx'

const fmtMoney = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtPct = (n) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`

function VarBadge({ value, pct }) {
  const isAlert = Math.abs(pct ?? 0) > 10
  const isOver  = (value ?? 0) > 0
  return (
    <div className={clsx('flex items-center gap-1', isAlert && (isOver ? 'text-status-danger' : 'text-status-success'))}>
      {isAlert && <span title="Varianza > 10%">⚠</span>}
      <span className="font-mono text-sm">{fmtMoney(value)}</span>
      <span className="text-xs text-ink-muted">({fmtPct(pct)})</span>
    </div>
  )
}

export default function VarianceReport() {
  const [searchParams] = useSearchParams()
  const now = new Date()

  const [year, setYear]   = useState(() => parseInt(searchParams.get('year')  || now.getFullYear()))
  const [month, setMonth] = useState(() => parseInt(searchParams.get('month') || (now.getMonth() + 1)))

  const { data: report, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['overhead-variance', year, month],
    queryFn:  () => overheadApi.getVarianceReport({ year, month }),
  })

  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  const alertCount = (report?.items || []).filter(i => i.hasAlert).length

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reporte de varianza</h1>
          <p className="page-subtitle">Diferencia entre gastos estimados y reales del período</p>
        </div>
      </div>

      {/* Selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Año</label>
          <select className="select w-24" value={year} onChange={e => setYear(parseInt(e.target.value))}>
            {[now.getFullYear() - 1, now.getFullYear()].map(y => (
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
        <button onClick={() => refetch()} className="btn-ghost btn-sm">↻ Actualizar</button>
      </div>

      {isLoading && <div className="flex justify-center py-16"><Spinner /></div>}

      {isError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
          {error?.response?.data?.error || error?.message}
        </div>
      )}

      {report && (
        <>
          {/* Totales */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Estimado total',  value: fmtMoney(report.totals?.estimated),    sub: null },
              { label: 'Real total',      value: fmtMoney(report.totals?.real),          sub: null },
              { label: 'Varianza total',  value: fmtMoney(report.totals?.variance),      sub: fmtPct(report.totals?.variancePct) },
              { label: 'Alertas (>10%)', value: alertCount,                              sub: alertCount > 0 ? 'rubros con desviación' : 'ninguna', isCount: true },
            ].map((c) => (
              <div key={c.label} className="bg-surface-elevated rounded-xl border border-line-subtle p-4">
                <p className="text-xs text-ink-muted">{c.label}</p>
                <p className={clsx('text-xl font-semibold mt-1', c.isCount && alertCount > 0 && 'text-status-warning')}>
                  {c.value}
                </p>
                {c.sub && <p className="text-xs text-ink-muted">{c.sub}</p>}
              </div>
            ))}
          </div>

          {/* Tabla de ítems */}
          {(report.items?.length > 0) && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-ink-primary">Por rubro</h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Gasto</th>
                      <th>Base prorrateo</th>
                      <th className="text-right">Estimado</th>
                      <th className="text-right">Real</th>
                      <th className="text-right">Varianza</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map(item => (
                      <tr key={item.itemId} className={clsx(item.hasAlert && 'bg-status-warning/5')}>
                        <td className="font-medium text-sm">{item.name}</td>
                        <td className="text-sm text-ink-secondary">{item.allocationBase}</td>
                        <td className="text-right font-mono text-sm text-ink-muted">{fmtMoney(item.estimated)}</td>
                        <td className="text-right font-mono text-sm">{fmtMoney(item.real)}</td>
                        <td className="text-right">
                          <VarBadge value={item.variance} pct={item.variancePct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Tabla de productos/órdenes */}
          {(report.products?.length > 0) && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-ink-primary">Impacto por producto</h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Orden / SKU</th>
                      <th className="text-right">Costo unit. estimado</th>
                      <th className="text-right">Costo unit. recosteado</th>
                      <th className="text-right">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.products.map(p => (
                      <tr key={p.orderId}>
                        <td>
                          <p className="font-medium text-sm">{p.sku || p.orderId}</p>
                          <p className="text-xs font-mono text-ink-muted">{p.orderId}</p>
                        </td>
                        <td className="text-right font-mono text-sm text-ink-muted">{fmtMoney(p.estimatedUnitCost)}</td>
                        <td className="text-right font-mono text-sm">{fmtMoney(p.recostedUnitCost)}</td>
                        <td className="text-right">
                          <VarBadge value={p.delta} pct={p.deltaPct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Tabla de volumen */}
          {(report.volumeVariance?.length > 0) && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-ink-primary">Varianza de base de prorrateo</h2>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Base</th>
                      <th className="text-right">Planificado</th>
                      <th className="text-right">Real</th>
                      <th className="text-right">Varianza</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.volumeVariance.map(v => (
                      <tr key={v.base}>
                        <td className="text-sm">{v.base}</td>
                        <td className="text-right font-mono text-sm text-ink-muted">{v.planned ?? '—'}</td>
                        <td className="text-right font-mono text-sm">{v.actual ?? '—'}</td>
                        <td className="text-right">
                          <VarBadge value={v.variance} pct={v.variancePct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Sin datos */}
          {!report.items?.length && !report.products?.length && (
            <div className="empty-state">
              <p className="font-medium text-ink-secondary">Sin datos de varianza para {MONTHS[month-1]} {year}</p>
              <p className="text-sm text-ink-muted mt-1">Ejecuta el cierre de mes primero.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
