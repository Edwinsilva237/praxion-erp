import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import { processConfigApi } from '@/api/processConfig'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)
const fmtPct  = (n) => n == null ? '—' : `${(n).toFixed(1)}%`

function rangeFromMonth(year, monthIdx) {
  const from = new Date(year, monthIdx, 1)
  const to   = new Date(year, monthIdx + 1, 1)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fmt(from), to: fmt(to) }
}

function rangeFromCustom(fromStr, toInclusiveStr) {
  const [ty, tm, td] = toInclusiveStr.split('-').map(Number)
  const toExcl = new Date(ty, tm - 1, td + 1)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fromStr, to: fmt(toExcl) }
}

const ALL_TABS = [
  { id: 'resumen',     label: 'Resumen' },
  { id: 'productos',   label: 'Por producto' },
  { id: 'operadores',  label: 'Por operador' },
  { id: 'mermas',      label: 'Mermas y scrap' },
  { id: 'costos',      label: 'Costos' },
  { id: 'eficiencia',  label: 'Eficiencia',  needsTheoretical: true },
]

export default function ReportesProduccion() {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const firstOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

  const [mode, setMode]   = useState('month')
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [customFrom, setCustomFrom] = useState(firstOfMonthStr)
  const [customTo, setCustomTo]     = useState(todayStr)
  const [tab, setTab]     = useState('resumen')

  const rangeValid = mode === 'month' || (customFrom && customTo && customFrom <= customTo)
  const { from, to } = mode === 'month'
    ? rangeFromMonth(year, month)
    : (rangeValid ? rangeFromCustom(customFrom, customTo) : { from: '', to: '' })

  const { data, isLoading } = useQuery({
    queryKey: ['production-report', from, to],
    queryFn:  () => reportsApi.getProductionReport({ from, to }),
    staleTime: 60_000,
    enabled:  rangeValid,
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300_000,
  })
  const isMicro = tenantConfig?.operation_mode === 'micro'

  // Filtrar tabs según el modo de operación y disponibilidad de datos
  const hasTheoretical = data?.efficiency?.summary?.orders > 0
  const TABS = ALL_TABS.filter(t => {
    if (isMicro && (t.id === 'eficiencia' || t.id === 'costos')) return false
    if (t.needsTheoretical && !hasTheoretical) return false
    return true
  })

  const [exporting, setExporting] = useState(null)
  const [exportError, setExportError] = useState(null)

  async function exportAs(kind) {
    setExporting(kind); setExportError(null)
    try {
      const fn  = kind === 'excel' ? reportsApi.downloadProductionExcel : reportsApi.downloadProductionPdf
      const ext = kind === 'excel' ? 'xlsx' : 'pdf'
      const mime = kind === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf'
      const res  = await fn({ from, to })
      const blob = new Blob([res.data], { type: mime })
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = mode === 'month'
        ? `reporte-produccion-${MONTHS_ES[month].toLowerCase()}-${year}.${ext}`
        : `reporte-produccion-${customFrom}_a_${customTo}.${ext}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      let msg = e.message
      if (e.response?.data instanceof Blob) {
        try { msg = JSON.parse(await e.response.data.text()).error || msg } catch (_) {}
      } else if (e.response?.data?.error) msg = e.response.data.error
      setExportError(msg || 'No se pudo generar el archivo.')
    } finally {
      setExporting(null)
    }
  }

  const years = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 4; y--) years.push(y)

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <p className="eyebrow">REPORTES</p>
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Reporte de producción</h1>
        <p className="text-sm text-ink-muted mt-1">
          Producción del periodo por producto, operador, mermas, costos y eficiencia
          (teórico vs real).
        </p>
      </div>

      {/* Selector de periodo + botones de export */}
      <section className="card flex flex-wrap gap-3 items-end">
        <div className="inline-flex rounded-md border border-line-subtle bg-bg-secondary p-0.5 self-end">
          <button
            type="button"
            onClick={() => setMode('month')}
            className={clsx(
              'px-3 py-1.5 text-xs rounded transition-colors',
              mode === 'month'
                ? 'bg-brand-500/15 text-ink-primary font-medium'
                : 'text-ink-muted hover:text-ink-secondary'
            )}>
            Mes calendario
          </button>
          <button
            type="button"
            onClick={() => setMode('range')}
            className={clsx(
              'px-3 py-1.5 text-xs rounded transition-colors',
              mode === 'range'
                ? 'bg-brand-500/15 text-ink-primary font-medium'
                : 'text-ink-muted hover:text-ink-secondary'
            )}>
            Rango libre
          </button>
        </div>

        {mode === 'month' ? (
          <>
            <div>
              <label className="label">Mes</label>
              <select className="select min-w-[140px]" value={month} onChange={e => setMonth(Number(e.target.value))}>
                {MONTHS_ES.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Año</label>
              <select className="select min-w-[100px]" value={year} onChange={e => setYear(Number(e.target.value))}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="label">Desde</label>
              <input type="date" className="input"
                value={customFrom}
                max={customTo || undefined}
                onChange={e => setCustomFrom(e.target.value)} />
            </div>
            <div>
              <label className="label">Hasta</label>
              <input type="date" className="input"
                value={customTo}
                min={customFrom || undefined}
                onChange={e => setCustomTo(e.target.value)} />
            </div>
          </>
        )}

        <div className="flex gap-2 ml-auto">
          <button onClick={() => exportAs('pdf')} disabled={exporting !== null || isLoading || !rangeValid}
            className="btn-primary"
            title="PDF ejecutivo con la marca de tu empresa">
            {exporting === 'pdf' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            PDF para socios
          </button>
          <button onClick={() => exportAs('excel')} disabled={exporting !== null || isLoading || !rangeValid}
            className="btn-secondary"
            title="Excel multi-hoja con todos los datos crudos">
            {exporting === 'excel' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            Excel
          </button>
        </div>

        <div className="w-full text-xs text-ink-muted">
          {rangeValid ? (
            mode === 'month' ? (
              <>Periodo: <strong className="text-ink-secondary font-mono">{from}</strong> al{' '}
                <strong className="text-ink-secondary font-mono">{to}</strong> (exclusivo)</>
            ) : (
              <>Periodo: del <strong className="text-ink-secondary font-mono">{customFrom}</strong> al{' '}
                <strong className="text-ink-secondary font-mono">{customTo}</strong> (ambos inclusivos)</>
            )
          ) : (
            <span className="text-status-warning">La fecha "Desde" debe ser igual o anterior a "Hasta".</span>
          )}
        </div>

        {exportError && (
          <div className="w-full alert-error text-sm">{exportError}</div>
        )}
      </section>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-line-subtle">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx(
              'px-4 py-2 text-sm border-b-2 -mb-[1px] transition-colors',
              tab === t.id
                ? 'border-brand-500 text-ink-primary font-medium'
                : 'border-transparent text-ink-muted hover:text-ink-secondary'
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {!rangeValid ? (
        <div className="card text-center text-ink-muted py-10">
          Ajusta el rango de fechas para ver el reporte.
        </div>
      ) : isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !data ? (
        <div className="alert-error">No se pudo cargar el reporte.</div>
      ) : (
        <>
          {tab === 'resumen'    && <ResumenTab data={data} />}
          {tab === 'productos'  && <ProductosTab data={data} />}
          {tab === 'operadores' && <OperadoresTab data={data} />}
          {tab === 'mermas'     && <MermasTab data={data} />}
          {tab === 'costos'     && <CostosTab data={data} />}
          {tab === 'eficiencia' && <EficienciaTab data={data} />}
        </>
      )}
    </div>
  )
}

// ── Resumen ─────────────────────────────────────────────────────────────────
function ResumenTab({ data }) {
  const cur = data.totals_current
  const prev = data.totals_previous
  const dUnits = cur.pt_units - prev.pt_units
  const dPct = prev.pt_units > 0 ? (dUnits / prev.pt_units) * 100 : null

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="card md:col-span-2">
        <p className="eyebrow">PRODUCCIÓN DEL PERIODO</p>
        <div className="text-3xl font-bold text-ink-primary mt-1 tabular-nums">
          {fmtNum(cur.pt_units)} <span className="text-base font-normal text-ink-muted">piezas</span>
        </div>
        {prev.pt_units > 0 && (
          <p className={clsx('text-xs mt-1',
            dUnits > 0 ? 'text-status-success' : dUnits < 0 ? 'text-status-danger' : 'text-ink-muted')}>
            {dUnits > 0 ? '▲' : dUnits < 0 ? '▼' : '='} {fmtNum(Math.abs(dUnits))} piezas
            {dPct != null && ` (${dPct > 0 ? '+' : ''}${dPct.toFixed(1)}%)`} vs periodo anterior
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-4 border-t border-line-subtle">
          <KpiMini label="Turnos"          value={fmtNum(cur.shifts)} />
          <KpiMini label="Órdenes compl."  value={fmtNum(cur.orders_completed)} />
          <KpiMini label="Operadores"      value={fmtNum(cur.operators)} />
          <KpiMini label="Horas"           value={fmtNum(cur.hours, 1)} />
        </div>
      </div>

      <div className="card">
        <p className="eyebrow mb-3">EFICIENCIA</p>
        <div className="space-y-3">
          <Stat label="MP consumida"      value={`${fmtNum(cur.mp_kg, 2)} kg`} />
          <Stat label="PT producido"      value={`${fmtNum(cur.pt_kg, 2)} kg`} />
          <Stat label="Scrap"             value={`${fmtNum(cur.scrap_kg, 2)} kg`}
            tone={cur.scrap_kg > 0 ? 'warning' : 'neutral'} />
          <Stat label="Rendimiento (yield)" value={fmtPct(cur.yield_pct)}
            tone={cur.yield_pct > 90 ? 'success' : cur.yield_pct < 80 ? 'danger' : 'neutral'} />
        </div>
      </div>

      <div className="card md:col-span-3">
        <p className="eyebrow mb-3">TENDENCIA SEMANAL</p>
        {data.weekly_trend.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin datos en el periodo.</p>
        ) : (
          <WeeklyChart data={data.weekly_trend} />
        )}
      </div>

      <div className="card md:col-span-3">
        <p className="eyebrow mb-3">COSTOS DEL PERIODO</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiMini label="Costo total"          value={fmtMXN(cur.total_cost)} />
          <KpiMini label="Costo unitario"       value={fmtMXNf(cur.unit_cost)} />
          <KpiMini label="Costo / metro lineal"
            value={cur.avg_cost_per_meter != null ? fmtMXNf(cur.avg_cost_per_meter) : '—'} />
          <KpiMini label="Piezas / hora"
            value={cur.hours > 0 ? fmtNum(cur.pt_units / cur.hours, 1) : '—'} />
        </div>
        {cur.meters > 0 && (
          <p className="text-[10px] text-ink-muted mt-2">
            {fmtNum(cur.meters, 2)} metros lineales producidos en el periodo (productos con longitud definida).
          </p>
        )}
      </div>
    </div>
  )
}

function WeeklyChart({ data }) {
  const max = Math.max(...data.map(w => w.pt_units || 0), 1)
  return (
    <div className="flex items-end gap-2 h-40">
      {data.map((w, i) => {
        const h = (w.pt_units / max) * 100
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="text-[10px] text-ink-muted tabular-nums">
              {w.pt_units > 0 ? fmtNum(w.pt_units) : ''}
            </div>
            <div className="w-full bg-brand-500/80 rounded-t" style={{ height: `${h}%`, minHeight: w.pt_units > 0 ? '4px' : '0' }} />
            <div className="text-[10px] text-ink-muted tabular-nums">
              {new Date(w.week_start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function KpiMini({ label, value, tone = 'neutral' }) {
  const toneClass = { success: 'text-status-success', danger: 'text-status-danger', neutral: 'text-ink-primary' }[tone]
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`text-base font-semibold ${toneClass} tabular-nums`}>{value}</p>
    </div>
  )
}

function Stat({ label, value, tone = 'neutral' }) {
  const toneClass = {
    success: 'text-status-success',
    danger:  'text-status-danger',
    warning: 'text-status-warning',
    neutral: 'text-ink-primary',
  }[tone]
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className={clsx('text-sm font-mono tabular-nums font-semibold', toneClass)}>{value}</span>
    </div>
  )
}

// ── Por producto ────────────────────────────────────────────────────────────
function ProductosTab({ data }) {
  if (data.by_product.length === 0) {
    return <div className="card text-center text-ink-muted py-8">Sin producción en el periodo.</div>
  }
  // Mostrar columnas específicas solo si algún producto las usa
  const showMeters    = data.by_product.some(p => p.meters > 0)
  const showResinType = data.by_product.some(p => p.resin_type)
  const showKindLabel = data.by_product.some(p => p.kind_name)

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>MP</th>
            <th className="text-right">Turnos</th>
            <th className="text-right">Piezas</th>
            <th className="text-right">PT (kg)</th>
            <th className="text-right">Scrap (kg)</th>
            <th className="text-right">Rendimiento</th>
            {showMeters && <th className="text-right">Metros</th>}
            <th className="text-right">Costo unit.</th>
            {showMeters && <th className="text-right">$ / metro</th>}
            <th className="text-right">Precio venta</th>
            <th className="text-right">Margen fab.</th>
          </tr>
        </thead>
        <tbody>
          {data.by_product.map(p => (
            <tr key={p.product_id}>
              <td className="font-mono text-xs">{p.sku}</td>
              <td className="text-ink-primary font-medium">
                {p.name}
                {showKindLabel && p.kind_name && (
                  <span className="ml-2 text-[10px] text-ink-muted">· {p.kind_name}</span>
                )}
              </td>
              <td className="text-xs text-ink-secondary">
                {p.raw_material || '—'}
                {showResinType && p.resin_type && <span className="ml-1 text-[10px] text-ink-muted">({p.resin_type})</span>}
              </td>
              <td className="text-right tabular-nums">{fmtNum(p.shifts)}</td>
              <td className="text-right tabular-nums font-semibold">{fmtNum(p.pt_units)}</td>
              <td className="text-right tabular-nums">{fmtNum(p.pt_kg, 2)}</td>
              <td className="text-right tabular-nums text-status-warning">
                {fmtNum(p.scrap_kg, 2)}
                <span className="text-[10px] text-ink-muted ml-1">({fmtPct(p.scrap_pct)})</span>
              </td>
              <td className={clsx('text-right tabular-nums',
                p.yield_pct > 90 ? 'text-status-success' :
                p.yield_pct < 80 ? 'text-status-danger' : 'text-ink-secondary')}>
                {fmtPct(p.yield_pct)}
              </td>
              {showMeters && (
                <td className="text-right tabular-nums">
                  {p.meters != null ? `${fmtNum(p.meters, 2)} m` : '—'}
                </td>
              )}
              <td className="text-right tabular-nums">{p.unit_cost ? fmtMXNf(p.unit_cost) : '—'}</td>
              {showMeters && (
                <td className="text-right tabular-nums">
                  {p.cost_per_meter != null ? fmtMXNf(p.cost_per_meter) : '—'}
                </td>
              )}
              <td className="text-right tabular-nums">{p.avg_sale_price ? fmtMXNf(p.avg_sale_price) : '—'}</td>
              <td className={clsx('text-right tabular-nums font-semibold',
                p.margin_pct == null ? 'text-ink-muted' :
                p.margin_pct > 20 ? 'text-status-success' :
                p.margin_pct >= 0 ? 'text-ink-secondary' : 'text-status-danger')}>
                {fmtPct(p.margin_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Por operador ────────────────────────────────────────────────────────────
function OperadoresTab({ data }) {
  if (data.by_operator.length === 0) {
    return <div className="card text-center text-ink-muted py-8">Sin turnos en el periodo.</div>
  }
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Operador</th>
            <th className="text-right">Turnos</th>
            <th className="text-right">Órdenes</th>
            <th className="text-right">Piezas</th>
            <th className="text-right">Horas</th>
            <th className="text-right">Pzs / hora</th>
            <th className="text-right">PT (kg)</th>
            <th className="text-right">Scrap (kg)</th>
            <th className="text-right">Scrap %</th>
            <th className="text-right">Yield %</th>
          </tr>
        </thead>
        <tbody>
          {data.by_operator.map(op => (
            <tr key={op.operator_id}>
              <td className="text-ink-primary font-medium">{op.operator_name}</td>
              <td className="text-right tabular-nums">{fmtNum(op.shifts)}</td>
              <td className="text-right tabular-nums">{fmtNum(op.orders)}</td>
              <td className="text-right tabular-nums font-semibold">{fmtNum(op.pt_units)}</td>
              <td className="text-right tabular-nums">{fmtNum(op.hours, 1)}</td>
              <td className="text-right tabular-nums">{fmtNum(op.units_per_hour, 1)}</td>
              <td className="text-right tabular-nums">{fmtNum(op.pt_kg, 2)}</td>
              <td className="text-right tabular-nums">{fmtNum(op.scrap_kg, 2)}</td>
              <td className={clsx('text-right tabular-nums',
                op.scrap_pct > 10 ? 'text-status-danger' :
                op.scrap_pct > 5 ? 'text-status-warning' : 'text-ink-secondary')}>
                {fmtPct(op.scrap_pct)}
              </td>
              <td className={clsx('text-right tabular-nums',
                op.yield_pct > 90 ? 'text-status-success' :
                op.yield_pct < 80 ? 'text-status-danger' : 'text-ink-secondary')}>
                {fmtPct(op.yield_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Mermas y scrap ─────────────────────────────────────────────────────────
function MermasTab({ data }) {
  const { by_product, by_operator } = data.scrap_analysis
  if (by_product.length === 0 && by_operator.length === 0) {
    return <div className="card text-center text-ink-muted py-8">
      ✓ Sin mermas significativas en el periodo.
    </div>
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="card p-0 overflow-hidden">
        <h3 className="text-sm font-semibold text-ink-primary p-4 border-b border-line-subtle">
          Productos con más merma
        </h3>
        {by_product.length === 0 ? (
          <p className="text-sm text-ink-muted p-4">Sin datos.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th className="text-right">PT (kg)</th>
                <th className="text-right">Scrap (kg)</th>
                <th className="text-right">MP consumida (kg)</th>
                <th className="text-right">Scrap %</th>
              </tr>
            </thead>
            <tbody>
              {by_product.map(p => (
                <tr key={p.product_id}>
                  <td className="font-mono text-xs">{p.sku}</td>
                  <td className="text-ink-primary font-medium">{p.name}</td>
                  <td className="text-right tabular-nums">{fmtNum(p.pt_kg, 2)}</td>
                  <td className="text-right tabular-nums">{fmtNum(p.scrap_kg, 2)}</td>
                  <td className="text-right tabular-nums">{fmtNum(p.mp_kg, 2)}</td>
                  <td className={clsx('text-right tabular-nums font-semibold',
                    p.scrap_pct > 10 ? 'text-status-danger' :
                    p.scrap_pct > 5 ? 'text-status-warning' : 'text-ink-secondary')}>
                    {fmtPct(p.scrap_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card p-0 overflow-hidden">
        <h3 className="text-sm font-semibold text-ink-primary p-4 border-b border-line-subtle">
          Operadores con mayor % de merma
        </h3>
        {by_operator.length === 0 ? (
          <p className="text-sm text-ink-muted p-4">Sin datos.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Operador</th>
                <th className="text-right">Turnos</th>
                <th className="text-right">PT (kg)</th>
                <th className="text-right">Scrap (kg)</th>
                <th className="text-right">MP consumida (kg)</th>
                <th className="text-right">Scrap %</th>
              </tr>
            </thead>
            <tbody>
              {by_operator.map(op => (
                <tr key={op.operator_id}>
                  <td className="text-ink-primary font-medium">{op.operator_name}</td>
                  <td className="text-right tabular-nums">{fmtNum(op.shifts)}</td>
                  <td className="text-right tabular-nums">{fmtNum(op.pt_kg, 2)}</td>
                  <td className="text-right tabular-nums">{fmtNum(op.scrap_kg, 2)}</td>
                  <td className="text-right tabular-nums">{fmtNum(op.mp_kg, 2)}</td>
                  <td className={clsx('text-right tabular-nums font-semibold',
                    op.scrap_pct > 10 ? 'text-status-danger' :
                    op.scrap_pct > 5 ? 'text-status-warning' : 'text-ink-secondary')}>
                    {fmtPct(op.scrap_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Costos ──────────────────────────────────────────────────────────────────
const KIND_LABELS  = { raw_material: 'Materia prima', packaging: 'Embalaje', additive: 'Aditivos' }
const KIND_COLORS  = { raw_material: 'text-status-warning', packaging: 'text-teal-500', additive: 'text-purple-500' }

function CostosTab({ data }) {
  const { by_material, by_kind = [] } = data.cost_analysis
  const total = by_material.reduce((s, r) => s + r.total_cost, 0)
  if (by_material.length === 0) {
    return <div className="card text-center text-ink-muted py-8">Sin consumos de materiales en el periodo.</div>
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <p className="eyebrow">COSTO TOTAL DE MATERIALES</p>
        <div className="text-3xl font-bold text-ink-primary mt-1 tabular-nums">{fmtMXNf(total)}</div>
        <p className="text-xs text-ink-muted mt-1">
          Suma del costo acreditado al consumir materiales en producción.
        </p>
      </div>

      {/* Desglose por tipo: MP / Embalaje / Aditivos */}
      {by_kind.length > 1 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {by_kind.map(k => {
            const pct = total > 0 ? (k.total_cost / total) * 100 : 0
            return (
              <div key={k.kind} className="card">
                <p className={clsx('text-xs uppercase tracking-wide font-semibold', KIND_COLORS[k.kind] || 'text-ink-muted')}>
                  {KIND_LABELS[k.kind] || k.kind}
                </p>
                <p className="text-xl font-bold text-ink-primary mt-1 tabular-nums">{fmtMXN(k.total_cost)}</p>
                <p className="text-xs text-ink-muted mt-1">
                  {fmtNum(k.kg_consumed, 2)} kg · {k.items_count} ítem(s) · {pct.toFixed(1)}% del total
                </p>
              </div>
            )
          })}
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Material</th>
              <th>Categoría</th>
              {by_material.some(r => r.resin_type) && <th>Resina</th>}
              {by_material.some(r => r.material_type) && <th>Tipo</th>}
              <th className="text-right">Costo / kg actual</th>
              <th className="text-right">Kg consumidos</th>
              <th className="text-right">Costo total</th>
              <th className="text-right">% del total</th>
            </tr>
          </thead>
          <tbody>
            {by_material.map(r => (
              <tr key={r.raw_material_id}>
                <td className="text-ink-primary font-medium">{r.raw_material_name}</td>
                <td className={clsx('text-xs font-medium', KIND_COLORS[r.item_kind] || 'text-ink-muted')}>
                  {KIND_LABELS[r.item_kind] || 'Materia prima'}
                </td>
                {by_material.some(x => x.resin_type) && (
                  <td className="text-xs">{r.resin_type || '—'}</td>
                )}
                {by_material.some(x => x.material_type) && (
                  <td className="text-xs">
                    {r.material_type === 'virgin' ? 'Virgen' :
                     r.material_type === 'regrind' ? 'Reciclado' : (r.material_type || '—')}
                  </td>
                )}
                <td className="text-right tabular-nums">{fmtMXNf(r.cost_per_kg)}</td>
                <td className="text-right tabular-nums">{fmtNum(r.kg_consumed, 2)}</td>
                <td className="text-right tabular-nums font-semibold">{fmtMXN(r.total_cost)}</td>
                <td className="text-right tabular-nums">
                  {total > 0 ? `${((r.total_cost / total) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Eficiencia (teórico vs real) ───────────────────────────────────────────
function EficienciaTab({ data }) {
  const { summary, by_order } = data.efficiency
  if (summary.orders === 0) {
    return <div className="card text-center text-ink-muted py-8">
      Sin órdenes completadas con datos teóricos en el periodo.
    </div>
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Órdenes con datos"        value={fmtNum(summary.orders)} />
        <KpiCard label="Desviación promedio (abs)" value={fmtPct(summary.avg_abs_deviation_pct)} />
        <KpiCard label="Excedieron lo teórico"    value={fmtNum(summary.over_theoretical_count)}
          tone={summary.over_theoretical_count > 0 ? 'warning' : 'neutral'} />
        <KpiCard label="Ahorraron MP"             value={fmtNum(summary.under_theoretical_count)}
          tone="success" />
      </div>

      <p className="text-xs text-ink-muted">
        Desviación firmada promedio: <strong className={summary.avg_signed_deviation_pct > 0 ? 'text-status-danger' : 'text-status-success'}>
          {fmtPct(summary.avg_signed_deviation_pct)}
        </strong> · Positivo = consumió más MP de lo teórico (peor).
      </p>

      <div className="card p-0 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Orden</th>
              <th>Producto</th>
              <th className="text-right">Piezas</th>
              <th className="text-right">Teórico (kg)</th>
              <th className="text-right">Real (kg)</th>
              <th className="text-right">Δ kg</th>
              <th className="text-right">Δ %</th>
              <th>Completada</th>
            </tr>
          </thead>
          <tbody>
            {by_order.map(r => (
              <tr key={r.order_id}>
                <td className="font-mono text-xs">{r.order_number}</td>
                <td className="text-ink-primary font-medium">
                  <span className="text-[10px] font-mono text-ink-muted mr-2">{r.product_sku}</span>
                  {r.product_name}
                </td>
                <td className="text-right tabular-nums">{fmtNum(r.quantity_units)}</td>
                <td className="text-right tabular-nums">{fmtNum(r.theoretical_mp_kg, 2)}</td>
                <td className="text-right tabular-nums">{fmtNum(r.real_mp_kg, 2)}</td>
                <td className={clsx('text-right tabular-nums',
                  r.deviation_kg > 0 ? 'text-status-danger' :
                  r.deviation_kg < 0 ? 'text-status-success' : 'text-ink-secondary')}>
                  {r.deviation_kg > 0 ? '+' : ''}{fmtNum(r.deviation_kg, 2)}
                </td>
                <td className={clsx('text-right tabular-nums font-semibold',
                  Math.abs(r.deviation_pct) > 10 ? 'text-status-danger' :
                  Math.abs(r.deviation_pct) > 5 ? 'text-status-warning' : 'text-ink-secondary')}>
                  {r.deviation_pct > 0 ? '+' : ''}{r.deviation_pct.toFixed(1)}%
                </td>
                <td className="text-xs text-ink-secondary">
                  {r.completed_at ? new Date(r.completed_at).toLocaleDateString('es-MX') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function KpiCard({ label, value, tone = 'neutral' }) {
  const toneClass = {
    success: 'text-status-success',
    danger:  'text-status-danger',
    warning: 'text-status-warning',
    neutral: 'text-ink-primary',
  }[tone]
  return (
    <div className="card-sm">
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`text-xl font-semibold ${toneClass} mt-1 tabular-nums`}>{value}</p>
    </div>
  )
}
