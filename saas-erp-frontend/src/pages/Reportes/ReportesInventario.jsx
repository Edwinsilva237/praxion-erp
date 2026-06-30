import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)

const TABS = [
  { id: 'almacen',  label: 'Por almacén' },
  { id: 'tipo',     label: 'Por tipo' },
  { id: 'top',      label: 'Top artículos' },
  { id: 'detalle',  label: 'Detalle' },
  { id: 'alertas',  label: 'Alertas' },
]

export default function ReportesInventario() {
  const [tab, setTab] = useState('almacen')
  const [search, setSearch] = useState('')
  const [exporting, setExporting] = useState(null)
  const [exportError, setExportError] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['inventory-report'],
    queryFn:  () => reportsApi.getInventoryReport(),
    staleTime: 30_000,
  })

  async function exportAs(kind) {
    setExporting(kind); setExportError(null)
    try {
      const fn  = kind === 'excel' ? reportsApi.downloadInventoryExcel : reportsApi.downloadInventoryPdf
      const ext = kind === 'excel' ? 'xlsx' : 'pdf'
      const mime = kind === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf'
      const res  = await fn()
      const blob = new Blob([res.data], { type: mime })
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `reporte-inventario-${new Date().toISOString().slice(0, 10)}.${ext}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      let msg = e.message
      if (e.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).error || msg } catch (_) {}
      } else if (e.response?.data?.error) msg = e.response.data.error
      setExportError(msg || 'No se pudo generar el archivo.')
    } finally { setExporting(null) }
  }

  const totals = data?.totals
  const alertsCount = (totals?.zero_cost_count || 0) + (totals?.negative_count || 0)

  const detalle = useMemo(() => {
    if (!data?.items) return []
    const term = search.trim().toLowerCase()
    if (!term) return data.items
    return data.items.filter(i =>
      (i.name || '').toLowerCase().includes(term) ||
      (i.code || '').toLowerCase().includes(term) ||
      (i.warehouse_name || '').toLowerCase().includes(term))
  }, [data, search])

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <p className="eyebrow">REPORTES</p>
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Reporte de inventario</h1>
        <p className="text-sm text-ink-muted mt-1">
          Valor y existencias del inventario a la fecha actual (existencia × costo promedio).
        </p>
      </div>

      {/* Export */}
      <section className="card flex flex-wrap gap-3 items-center">
        <span className="text-xs text-ink-muted">
          {data ? `Corte: ${new Date(data.generated_at).toLocaleString('es-MX')}` : 'Cargando…'}
        </span>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => exportAs('pdf')} disabled={exporting !== null || isLoading}
            className="btn-primary" title="PDF con gráficos">
            {exporting === 'pdf' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            PDF con gráficos
          </button>
          <button onClick={() => exportAs('excel')} disabled={exporting !== null || isLoading}
            className="btn-secondary" title="Excel con el detalle completo">
            {exporting === 'excel' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            Excel
          </button>
        </div>
        {exportError && <div className="w-full alert-error text-sm">{exportError}</div>}
      </section>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !data ? (
        <div className="alert-error">No se pudo cargar el reporte.</div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Valor total" value={fmtMXNf(totals.total_value)} highlight />
            <Kpi label="Artículos" value={fmtNum(totals.distinct_items)} />
            <Kpi label="Almacenes" value={fmtNum(totals.warehouses)} />
            <Kpi label="Alertas" value={fmtNum(alertsCount)} tone={alertsCount ? 'warn' : 'muted'} />
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-1 border-b border-line-subtle">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={clsx('px-4 py-2 text-sm border-b-2 -mb-[1px] transition-colors',
                  tab === t.id ? 'border-brand-500 text-ink-primary font-medium'
                               : 'border-transparent text-ink-muted hover:text-ink-secondary')}>
                {t.label}
                {t.id === 'alertas' && alertsCount > 0 && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-status-warning/15 text-status-warning">{alertsCount}</span>
                )}
              </button>
            ))}
          </div>

          {tab === 'almacen' && <PorAlmacen data={data} />}
          {tab === 'tipo'    && <PorTipo data={data} />}
          {tab === 'top'     && <TopItems data={data} />}
          {tab === 'detalle' && <Detalle items={detalle} search={search} setSearch={setSearch} total={data.items.length} />}
          {tab === 'alertas' && <Alertas data={data} />}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, highlight, tone }) {
  const valTone = tone === 'warn' ? 'text-status-warning' : tone === 'muted' ? 'text-ink-muted' : 'text-ink-primary'
  return (
    <div className={clsx('card', highlight && 'border-brand-500/40')}>
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={clsx('text-xl font-bold tabular-nums mt-1', highlight ? 'text-brand-300' : valTone)}>{value}</p>
    </div>
  )
}

function Bar({ pct }) {
  const p = Math.min(100, Math.max(0, pct || 0))
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="w-16 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div className="h-full bg-brand-500" style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs tabular-nums w-9 text-right">{p.toFixed(0)}%</span>
    </div>
  )
}

function PorAlmacen({ data }) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="table">
        <thead><tr>
          <th>Almacén</th><th>Tipo</th><th className="text-right">Artículos</th>
          <th className="text-right">Valor</th><th className="text-right">% del total</th>
        </tr></thead>
        <tbody>
          {data.by_warehouse.map(w => (
            <tr key={w.warehouse_id}>
              <td className="text-ink-primary font-medium">{w.name}</td>
              <td className="text-ink-secondary">{w.label}</td>
              <td className="text-right tabular-nums">{fmtNum(w.items)}</td>
              <td className="text-right tabular-nums font-semibold">{fmtMXNf(w.value)}</td>
              <td className="text-right"><div className="flex justify-end"><Bar pct={w.pct} /></div></td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="border-t-2 border-line-strong font-semibold">
          <td colSpan={2}>TOTAL</td>
          <td className="text-right tabular-nums">{fmtNum(data.totals.distinct_items)}</td>
          <td className="text-right tabular-nums">{fmtMXNf(data.totals.total_value)}</td>
          <td className="text-right tabular-nums">100%</td>
        </tr></tfoot>
      </table>
    </div>
  )
}

function PorTipo({ data }) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="table">
        <thead><tr>
          <th>Tipo de almacén</th><th className="text-right">Artículos</th>
          <th className="text-right">Valor</th><th className="text-right">% del total</th>
        </tr></thead>
        <tbody>
          {data.by_warehouse_type.map(g => (
            <tr key={g.type}>
              <td className="text-ink-primary font-medium">{g.label}</td>
              <td className="text-right tabular-nums">{fmtNum(g.items)}</td>
              <td className="text-right tabular-nums font-semibold">{fmtMXNf(g.value)}</td>
              <td className="text-right"><div className="flex justify-end"><Bar pct={g.pct} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TopItems({ data }) {
  const top = data.top_items
  const max = Math.max(...top.map(i => i.value), 1)
  if (!top.length) return <div className="card text-center text-ink-muted py-8">Sin existencias.</div>
  return (
    <div className="card flex flex-col gap-2">
      {top.map((i, idx) => (
        <div key={idx} className="flex items-center gap-3">
          <div className="min-w-0 w-56">
            <p className="text-sm text-ink-primary truncate">{i.name}</p>
            <p className="text-[10px] text-ink-muted">{i.code} · {fmtNum(i.quantity, 0)} {i.unit || ''}</p>
          </div>
          <div className="flex-1 h-3 bg-surface-elevated rounded overflow-hidden">
            <div className="h-full bg-brand-500" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          <span className="text-sm font-semibold tabular-nums w-24 text-right">{fmtMXNf(i.value)}</span>
        </div>
      ))}
    </div>
  )
}

function Detalle({ items, search, setSearch, total }) {
  return (
    <div className="flex flex-col gap-3">
      <input className="input input-sm max-w-sm" placeholder="Buscar artículo / código / almacén…"
        value={search} onChange={e => setSearch(e.target.value)} />
      <div className="card p-0 overflow-x-auto">
        <table className="table">
          <thead><tr>
            <th>Código</th><th>Artículo</th><th>Almacén</th><th>Estado</th>
            <th className="text-right">Existencia</th><th className="text-right">Costo prom.</th><th className="text-right">Valor</th>
          </tr></thead>
          <tbody>
            {items.map((i, idx) => (
              <tr key={idx}>
                <td className="font-mono text-xs">{i.code || '—'}</td>
                <td className="text-ink-primary font-medium">{i.name}</td>
                <td className="text-ink-secondary text-xs">{i.warehouse_name}</td>
                <td className="text-xs">{i.status_label}</td>
                <td className={clsx('text-right tabular-nums', i.quantity < 0 && 'text-status-danger')}>{fmtNum(i.quantity, 2)} {i.unit}</td>
                <td className={clsx('text-right tabular-nums', i.avg_cost === 0 && 'text-status-warning')}>{fmtMXNf(i.avg_cost)}</td>
                <td className="text-right tabular-nums font-semibold">{fmtMXNf(i.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-muted">{items.length} de {total} renglones.</p>
    </div>
  )
}

function Alertas({ data }) {
  const { zero_cost, negative } = data.alerts
  if (!zero_cost.length && !negative.length) {
    return (
      <div className="card flex flex-col items-center text-center py-10">
        <div className="w-12 h-12 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center mb-3 border border-brand-500/30">
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <h3 className="text-base font-semibold text-ink-primary">Sin alertas</h3>
        <p className="text-sm text-ink-muted mt-1">Sin costos en $0 ni existencias negativas.</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {zero_cost.length > 0 && (
        <div>
          <div className="alert-warning text-sm mb-2">
            <strong>{zero_cost.length}</strong> renglón(es) con <strong>costo $0</strong> — existencias sin valuar (subvalúan el inventario).
          </div>
          <AlertTable rows={zero_cost} kind="zero" />
        </div>
      )}
      {negative.length > 0 && (
        <div>
          <div className="alert-error text-sm mb-2">
            <strong>{negative.length}</strong> renglón(es) con <strong>existencia negativa</strong> — revisar sobreventa o captura.
          </div>
          <AlertTable rows={negative} kind="neg" />
        </div>
      )}
    </div>
  )
}

function AlertTable({ rows, kind }) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="table">
        <thead><tr>
          <th>Código</th><th>Artículo</th><th>Almacén</th>
          <th className="text-right">Existencia</th><th className="text-right">Costo prom.</th>
        </tr></thead>
        <tbody>
          {rows.map((i, idx) => (
            <tr key={idx}>
              <td className="font-mono text-xs">{i.code || '—'}</td>
              <td className="text-ink-primary font-medium">{i.name}</td>
              <td className="text-ink-secondary text-xs">{i.warehouse_name}</td>
              <td className={clsx('text-right tabular-nums', kind === 'neg' && 'text-status-danger')}>{fmtNum(i.quantity, 2)} {i.unit}</td>
              <td className={clsx('text-right tabular-nums', kind === 'zero' && 'text-status-warning')}>{fmtMXNf(i.avg_cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
