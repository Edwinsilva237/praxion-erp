import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import Spinner from '@/components/ui/Spinner'
import { fmtDateOnly } from '@/utils/fmt'
import clsx from 'clsx'

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const money = (n) => n == null ? '' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)

function rangeFromMonth(year, monthIdx) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fmt(new Date(year, monthIdx, 1)), to: fmt(new Date(year, monthIdx + 1, 1)) }
}

// Prioridad de la incidencia: danger bloquea el cierre, warn se revisa, info
// solo documenta. El orden de aparición en pantalla es éste.
const SEVERITY = {
  danger: { label: 'Bloquea el cierre', chip: 'bg-status-danger/15 text-status-danger border-status-danger/40',
            edge: 'border-l-status-danger', icon: '⛔' },
  warn:   { label: 'Por revisar',       chip: 'bg-status-warning/15 text-status-warning border-status-warning/40',
            edge: 'border-l-status-warning', icon: '⚠️' },
  info:   { label: 'Informativo',       chip: 'bg-surface-elevated text-ink-secondary border-line-subtle',
            edge: 'border-l-ink-muted', icon: 'ℹ️' },
}
const SEVERITY_ORDER = { danger: 0, warn: 1, info: 2 }
const SIDE_LABEL = { issued: 'Emitidos', received: 'Recibidos', both: 'Ambos lados' }

export default function CuadreFiscal() {
  const now = new Date()
  // Por defecto el mes anterior: el cuadre se hace sobre el mes que se declara.
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const [year, setYear]   = useState(prev.getFullYear())
  const [month, setMonth] = useState(prev.getMonth())
  const [expanded, setExpanded] = useState(() => new Set())
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)

  const { from, to } = rangeFromMonth(year, month)

  const { data, isLoading } = useQuery({
    queryKey: ['fiscal-reconciliation', from, to],
    queryFn:  () => reportsApi.getFiscalReconciliation({ from, to }),
    staleTime: 60_000,
  })

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  async function exportExcel() {
    setExporting(true); setExportError(null)
    try {
      const res = await reportsApi.downloadFiscalReconciliationExcel({ from, to })
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cuadre-fiscal-${MONTHS_ES[month].toLowerCase()}-${year}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      let msg = e.message
      if (e.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).error || msg } catch (_) {}
      } else if (e.response?.data?.error) msg = e.response.data.error
      setExportError(msg || 'No se pudo generar el archivo.')
    } finally {
      setExporting(false)
    }
  }

  const years = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 4; y--) years.push(y)

  const groups = [...(data?.groups || [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count)
  const iva = data?.iva
  const u = data?.universe

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <p className="eyebrow">REPORTES</p>
        <h1 className="page-title">Cuadre fiscal</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Todos los documentos con valor fiscal del periodo y lo que falta para cerrarlo: complementos
          de pago pendientes de los dos lados, notas de crédito sueltas, cancelaciones que pegan a un
          mes ya declarado y comprobantes sin XML. Mismos criterios de corte que el Reporte Contable.
        </p>
        <p className="text-sm text-ink-secondary mt-1">
          Periodo: <strong>{MONTHS_ES[month]} {year}</strong>
        </p>
      </div>

      <div className="card p-4 flex flex-wrap items-end gap-3 print:hidden">
        <div>
          <label className="label">Mes</label>
          <select className="select w-40" value={month} onChange={e => setMonth(Number(e.target.value))}>
            {MONTHS_ES.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Año</label>
          <select className="select w-28" value={year} onChange={e => setYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <button onClick={exportExcel} disabled={exporting} className="btn-secondary">
          {exporting ? <Spinner size="sm" /> : '📊'} Exportar Excel
        </button>
      </div>
      {exportError && <p className="field-error">{exportError}</p>}

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {/* ── IVA del periodo ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="IVA trasladado"  value={money(iva?.trasladado ?? 0)} small />
            <Kpi label="IVA acreditable" value={money(iva?.acreditable ?? 0)} small />
            <Kpi label="IVA en riesgo (sin REP)" value={money(iva?.en_riesgo ?? 0)} small
                 tone={iva?.en_riesgo > 0.005 ? 'text-status-danger' : undefined} />
            <Kpi label={iva?.neto >= 0 ? 'IVA a pagar' : 'IVA a favor'}
                 value={money(Math.abs(iva?.neto ?? 0))} small
                 tone={iva?.neto >= 0 ? 'text-status-warning' : 'text-status-success'} />
          </div>

          {iva?.en_riesgo > 0.005 && (
            <div className="rounded-lg border border-status-danger/50 bg-status-danger/10 px-4 py-3 text-sm">
              <strong className="text-status-danger">
                {money(iva.en_riesgo)} de IVA no son acreditables todavía
              </strong>
              <p className="text-ink-secondary mt-0.5">
                Corresponden a facturas PPD ya pagadas cuyo proveedor no ha mandado el complemento.
                Si declaras sin ellos, el {iva.neto_en_firme >= 0 ? 'IVA a pagar sube' : 'saldo a favor baja'} a{' '}
                <strong>{money(Math.abs(iva.neto_en_firme))}</strong>.
              </p>
            </div>
          )}

          {/* ── Universo del periodo ────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <UniverseCard title="CFDI emitidos" data={u?.issued}
              labels={['Facturas', 'Notas de crédito', 'Complementos de pago']}
              totalLabel="Ingreso neto facturado" />
            <UniverseCard title="CFDI recibidos" data={u?.received}
              labels={['Facturas de proveedor', 'Notas de crédito', 'Complementos recibidos']}
              totalLabel="Compra neta del periodo" />
          </div>

          {/* ── Incidencias ─────────────────────────────────────────────── */}
          {groups.length === 0 ? (
            <div className="card p-6 text-center">
              <p className="text-2xl">✅</p>
              <p className="text-sm font-medium text-status-success mt-2">
                El periodo cuadra: no hay incidencias fiscales pendientes.
              </p>
              <p className="text-xs text-ink-muted mt-1">
                Puedes generar el paquete contable de {MONTHS_ES[month]} {year} con confianza.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-ink-primary">
                {data.issues.total} incidencia{data.issues.total === 1 ? '' : 's'} en el periodo
                {data.issues.danger > 0 && (
                  <span className="text-status-danger font-normal"> · {data.issues.danger} bloquean el cierre</span>
                )}
              </h2>

              {groups.map(g => {
                const open = expanded.has(g.key)
                const sev = SEVERITY[g.severity]
                return (
                  <div key={g.key} className={clsx('card overflow-hidden border-l-[3px]', sev.edge)}>
                    <button onClick={() => toggle(g.key)}
                      className="w-full text-left px-4 py-3 hover:bg-surface-elevated/40 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-ink-muted text-xs w-4">{open ? '▾' : '▸'}</span>
                      <span className="w-5 text-center">{sev.icon}</span>
                      <span className="text-sm text-ink-primary flex-1 min-w-[180px]">{g.label}</span>
                      <span className={clsx('text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border', sev.chip)}>
                        {SIDE_LABEL[g.side]}
                      </span>
                      <span className="font-mono text-sm text-ink-primary tabular-nums">{g.count}</span>
                    </button>

                    {open && (
                      <div className="border-t border-line-subtle px-4 py-3 bg-surface-elevated/20">
                        <p className="text-xs text-ink-secondary mb-1">{g.meaning}</p>
                        <p className="text-xs text-ink-muted mb-3">
                          <strong className="text-ink-secondary">Qué hacer:</strong> {g.action}
                        </p>

                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-ink-muted uppercase tracking-wide border-b border-line-subtle">
                                <th className="text-left py-2 font-medium">Documento</th>
                                <th className="text-left py-2 font-medium">Fecha</th>
                                <th className="text-left py-2 font-medium">Contraparte</th>
                                <th className="text-right py-2 font-medium">Importe</th>
                                <th className="text-left py-2 font-medium pl-4">Detalle</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.rows.map((r, i) => (
                                <tr key={`${r.doc}-${i}`} className="border-b border-line-subtle/50 last:border-0 align-top">
                                  <td className="py-2 pr-3">
                                    <span className="font-mono text-xs text-brand-300 block">{r.doc}</span>
                                    {r.uuid && <span className="font-mono text-[10px] text-ink-muted block truncate max-w-[260px]">{r.uuid}</span>}
                                  </td>
                                  <td className="py-2 text-xs text-ink-muted whitespace-nowrap">
                                    {r.date ? fmtDateOnly(r.date) : '—'}
                                  </td>
                                  <td className="py-2 pr-3">
                                    <span className="block truncate max-w-[240px]">{r.partner}</span>
                                    {r.rfc && <span className="font-mono text-[10px] text-ink-muted">{r.rfc}</span>}
                                  </td>
                                  <td className="py-2 text-right font-mono tabular-nums whitespace-nowrap">
                                    {r.amount != null ? money(r.amount) : ''}
                                  </td>
                                  <td className="py-2 pl-4 text-xs text-ink-muted">{r.detail}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function UniverseCard({ title, data, labels, totalLabel }) {
  const money2 = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold text-ink-primary mb-3">{title}</h2>
      <dl className="flex flex-col gap-1.5 text-sm">
        <Line label={labels[0]} value={data?.invoices ?? 0} />
        <Line label={labels[1]} value={data?.credit_notes ?? 0} />
        <Line label={labels[2]} value={data?.complements ?? 0} />
        <Line label="Cancelados" value={data?.cancelled ?? 0}
              tone={data?.cancelled ? 'text-status-warning' : undefined} />
        <div className="border-t border-line-subtle mt-1 pt-1.5">
          <Line label={totalLabel} value={money2(data?.total_mxn)} bold />
        </div>
      </dl>
    </div>
  )
}

function Line({ label, value, tone, bold }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className={clsx('font-mono tabular-nums', bold ? 'font-semibold text-ink-primary' : tone || 'text-ink-primary')}>
        {value}
      </dd>
    </div>
  )
}

function Kpi({ label, value, tone, small }) {
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className={clsx('font-bold tabular-nums', small ? 'text-lg' : 'text-2xl', tone || 'text-ink-primary')}>
        {value}
      </p>
    </div>
  )
}
