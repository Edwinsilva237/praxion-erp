import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { reportsApi } from '@/api/reports'
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

// Para rango libre: la UI muestra "Hasta" como fecha inclusiva, pero el backend
// usa `to` exclusivo. Le sumamos un día a `toInclusive` antes de enviarlo.
function rangeFromCustom(fromStr, toInclusiveStr) {
  const [ty, tm, td] = toInclusiveStr.split('-').map(Number)
  const toExcl = new Date(ty, tm - 1, td + 1)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fromStr, to: fmt(toExcl) }
}

const ALL_TABS = [
  { id: 'resumen',     label: 'Resumen' },
  { id: 'clientes',    label: 'Por cliente' },
  { id: 'productos',   label: 'Por producto' },
  { id: 'metros',      label: 'Por metro lineal', needsMeters: true },
  { id: 'utilidades',  label: 'Utilidades' },
  { id: 'alertas',     label: 'Alertas de margen' },
]

export default function ReportesVentas() {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const firstOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

  const [mode, setMode]   = useState('month')           // 'month' | 'range'
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [customFrom, setCustomFrom] = useState(firstOfMonthStr)
  const [customTo, setCustomTo]     = useState(todayStr) // inclusivo en UI
  const [tab, setTab]     = useState('resumen')
  const [detailModal, setDetailModal] = useState(null) // { type, id, name }

  // Valida que en rango libre `from` <= `to`; si no, deshabilita la consulta.
  const rangeValid = mode === 'month' || (customFrom && customTo && customFrom <= customTo)
  const { from, to } = mode === 'month'
    ? rangeFromMonth(year, month)
    : (rangeValid ? rangeFromCustom(customFrom, customTo) : { from: '', to: '' })

  const { data, isLoading } = useQuery({
    queryKey: ['sales-report', from, to],
    queryFn:  () => reportsApi.getSalesReport({ from, to }),
    staleTime: 60_000,
    enabled:  rangeValid,
  })

  // El tab "Por metro lineal" solo aplica si hay productos con metros vendidos
  // (productos con length_mm definida, típicamente esquineros u otros lineales).
  const hasMeterProducts = (data?.by_product || []).some(p =>
    p.type === 'corner_protector' || (p.meters != null && p.meters > 0)
  )
  const TABS = ALL_TABS.filter(t => !t.needsMeters || hasMeterProducts)

  const [exporting, setExporting] = useState(null)     // 'excel' | 'pdf' | null
  const [exportError, setExportError] = useState(null)

  async function exportAs(kind) {
    setExporting(kind); setExportError(null)
    try {
      const fn  = kind === 'excel' ? reportsApi.downloadSalesExcel : reportsApi.downloadSalesPdf
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
        ? `reporte-ventas-${MONTHS_ES[month].toLowerCase()}-${year}.${ext}`
        : `reporte-ventas-${customFrom}_a_${customTo}.${ext}`
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
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Reporte de ventas</h1>
        <p className="text-sm text-ink-muted mt-1">
          Análisis comercial del periodo: por cliente, producto, metros lineales (esquineros),
          utilidad estimada y alertas de margen.
        </p>
      </div>

      {/* Selector de periodo + botones de export */}
      <section className="card flex flex-wrap gap-3 items-end">
        {/* Toggle modo */}
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
              <input
                type="date"
                className="input"
                value={customFrom}
                max={customTo || undefined}
                onChange={e => setCustomFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Hasta</label>
              <input
                type="date"
                className="input"
                value={customTo}
                min={customFrom || undefined}
                onChange={e => setCustomTo(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="flex gap-2 ml-auto">
          <button onClick={() => exportAs('pdf')} disabled={exporting !== null || isLoading || !rangeValid}
            className="btn-primary"
            title="PDF ejecutivo con la marca de tu empresa — ideal para socios">
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
            title="Excel multi-hoja con todos los datos crudos para análisis">
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

      {/* Contenido del tab */}
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
          {tab === 'clientes'   && <ClientesTab data={data} onRowClick={(c) => setDetailModal({ type: 'customer', id: c.partner_id, name: c.partner_name })} />}
          {tab === 'productos'  && <ProductosTab data={data} onRowClick={(p) => setDetailModal({ type: 'product', id: p.product_id, name: p.name })} />}
          {tab === 'metros'     && <MetrosTab data={data} />}
          {tab === 'utilidades' && <UtilidadesTab data={data} />}
          {tab === 'alertas'    && <AlertasTab data={data} />}
        </>
      )}

      {detailModal && (
        <DetailModal
          type={detailModal.type}
          id={detailModal.id}
          name={detailModal.name}
          from={from}
          to={to}
          onClose={() => setDetailModal(null)}
        />
      )}

      <p className="text-[10px] text-ink-muted">
        Costo unitario: promedio ponderado de las últimas {data?.cost_window_days || 60} días de
        entradas (compra/producción) por producto. Si un producto no tuvo entradas en ese rango,
        su utilidad se muestra como "n/d".
      </p>
    </div>
  )
}

// ── Resumen ─────────────────────────────────────────────────────────────────
function ResumenTab({ data }) {
  const cur = data.totals_current
  // Mismo método/total que el dashboard (Facturado con IVA + Sin factura).
  const snap = data.sales_snapshot || { total: cur.revenue, invoiced: 0, invoiced_subtotal: 0, invoiced_iva: 0, uninvoiced: 0 }
  const prevTotal = data.sales_snapshot_prev?.total || 0
  const dRev = snap.total - prevTotal
  const dPct = prevTotal > 0 ? (dRev / prevTotal) * 100 : null

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* KPI: ventas y comparativa — mismo método que el dashboard */}
      <div className="card md:col-span-2">
        <p className="eyebrow">VENTAS DEL PERIODO</p>
        <div className="text-3xl font-bold text-ink-primary mt-1 tabular-nums">{fmtMXNf(snap.total)}</div>
        <p className="text-[11px] text-ink-muted mt-1 tabular-nums">
          Facturado {fmtMXN(snap.invoiced)} <span className="opacity-70">(subtotal {fmtMXN(snap.invoiced_subtotal)} · IVA {fmtMXN(snap.invoiced_iva)})</span>
          {' · '}Sin factura {fmtMXN(snap.uninvoiced)}
        </p>
        {prevTotal > 0 && (
          <p className={clsx('text-xs mt-1',
            dRev > 0 ? 'text-status-success' : dRev < 0 ? 'text-status-danger' : 'text-ink-muted')}>
            {dRev > 0 ? '▲' : dRev < 0 ? '▼' : '='} {fmtMXN(Math.abs(dRev))}
            {dPct != null && ` (${dPct > 0 ? '+' : ''}${dPct.toFixed(1)}%)`} vs periodo anterior
          </p>
        )}
        <div className="grid grid-cols-3 gap-4 mt-5 pt-4 border-t border-line-subtle">
          <KpiMini label="Operaciones"  value={cur.deliveries} />
          <KpiMini label="Clientes" value={cur.customers} />
          <KpiMini label="Margen est." value={fmtPct(cur.margin_pct)}
            tone={cur.margin_pct > 20 ? 'success' : cur.margin_pct > 0 ? 'neutral' : 'danger'} />
        </div>
        <p className="text-[10px] text-ink-muted mt-2">
          Listas por cliente/producto y margen son sin IVA y suman {fmtMXN(cur.revenue)} (total sin IVA).
          {!cur.cost_complete && ' Algunos productos no tienen costo histórico — el margen real puede ser mayor.'}
        </p>
      </div>

      {/* Top 5 clientes */}
      <div className="card">
        <p className="eyebrow mb-3">TOP 5 CLIENTES</p>
        {data.top_customers.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin ventas en el periodo.</p>
        ) : (
          <div className="space-y-2.5">
            {data.top_customers.map((c, i) => (
              <div key={c.partner_id} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded bg-brand-500/15 text-brand-300 text-xs font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-primary truncate">{c.partner_name}</p>
                  <p className="text-[10px] text-ink-muted">{c.deliveries} entregas</p>
                </div>
                <span className="text-sm font-semibold text-ink-primary tabular-nums">{fmtMXN(c.revenue)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tendencia semanal */}
      <div className="card md:col-span-3">
        <p className="eyebrow mb-3">TENDENCIA SEMANAL</p>
        {data.weekly_trend.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin datos en el periodo.</p>
        ) : (
          <WeeklyChart data={data.weekly_trend} />
        )}
      </div>
    </div>
  )
}

function WeeklyChart({ data }) {
  const max = Math.max(...data.map(w => w.revenue), 1)
  return (
    <div className="flex items-end gap-2 h-40">
      {data.map((w, i) => {
        const h = (w.revenue / max) * 100
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <div className="text-[10px] text-ink-muted tabular-nums">
              {w.revenue > 0 ? fmtMXN(w.revenue) : ''}
            </div>
            <div className="w-full bg-brand-500/80 rounded-t" style={{ height: `${h}%`, minHeight: w.revenue > 0 ? '4px' : '0' }} />
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

// ── Por cliente ─────────────────────────────────────────────────────────────
function ClientesTab({ data, onRowClick }) {
  if (data.by_customer.length === 0) {
    return <div className="card text-center text-ink-muted py-8">Sin ventas en el periodo.</div>
  }
  const total = data.totals_current?.revenue || 0
  return (
    <>
      <p className="text-xs text-ink-muted -mt-2">
        Click en una fila para ver el detalle de facturas y remisiones.
      </p>
      <div className="card p-0 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>RFC</th>
              <th className="text-right">En factura</th>
              <th className="text-right">Sin factura</th>
              <th className="text-right">Total</th>
              <th className="text-right">% total</th>
              <th className="text-right">Entregas</th>
              <th className="text-right">Margen</th>
            </tr>
          </thead>
          <tbody>
            {data.by_customer.map(c => (
              <tr key={c.partner_id} onClick={() => onRowClick(c)} className="cursor-pointer">
                <td className="text-ink-primary font-medium">{c.partner_name}</td>
                <td className="font-mono text-xs">{c.partner_rfc || '—'}</td>
                <td className="text-right tabular-nums">{fmtMXN(c.invoiced_revenue)}</td>
                <td className="text-right tabular-nums">{fmtMXN(c.uninvoiced_revenue)}</td>
                <td className="text-right tabular-nums font-semibold">{fmtMXN(c.revenue)}</td>
                <td className="text-right tabular-nums">
                  <PctBar pct={c.pct_of_total} />
                </td>
                <td className="text-right tabular-nums">{c.deliveries}</td>
                <td className={clsx('text-right tabular-nums',
                  c.margin_pct > 20 ? 'text-status-success' : c.margin_pct >= 0 ? 'text-ink-secondary' : 'text-status-danger')}>
                  {fmtPct(c.margin_pct)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong font-semibold">
              <td colSpan={2} className="text-ink-primary">TOTAL</td>
              <td className="text-right tabular-nums">{fmtMXN(data.by_customer.reduce((s, c) => s + c.invoiced_revenue, 0))}</td>
              <td className="text-right tabular-nums">{fmtMXN(data.by_customer.reduce((s, c) => s + c.uninvoiced_revenue, 0))}</td>
              <td className="text-right tabular-nums">{fmtMXN(total)}</td>
              <td className="text-right tabular-nums">100%</td>
              <td className="text-right tabular-nums">{data.totals_current?.deliveries || 0}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

// Barrita visual con el porcentaje. Útil para escanear cuál cliente/producto pesa más.
function PctBar({ pct }) {
  const p = Math.min(100, Math.max(0, pct || 0))
  return (
    <div className="flex items-center justify-end gap-2 min-w-[80px]">
      <div className="w-12 h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div className="h-full bg-brand-500" style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs tabular-nums w-9 text-right">{p.toFixed(1)}%</span>
    </div>
  )
}

// ── Por producto ────────────────────────────────────────────────────────────
function ProductosTab({ data, onRowClick }) {
  if (data.by_product.length === 0) {
    return <div className="card text-center text-ink-muted py-8">Sin ventas en el periodo.</div>
  }
  const total = data.totals_current?.revenue || 0
  return (
    <>
      <p className="text-xs text-ink-muted -mt-2">
        Click en una fila para ver las facturas y remisiones donde aparece el producto.
      </p>
      <div className="card p-0 overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Producto</th>
              <th className="text-right">Cantidad</th>
              <th className="text-right">En factura</th>
              <th className="text-right">Sin factura</th>
              <th className="text-right">Total</th>
              <th className="text-right">% total</th>
              <th className="text-right">Margen</th>
            </tr>
          </thead>
          <tbody>
            {data.by_product.map(p => (
              <tr key={p.product_id} onClick={() => onRowClick(p)} className="cursor-pointer">
                <td className="font-mono text-xs">{p.sku}</td>
                <td className="text-ink-primary font-medium">
                  {p.name}
                  {(p.kind_name || p.type === 'resale') && (
                    <span className="ml-2 text-[10px] text-ink-muted">
                      · {p.kind_name || (p.type === 'resale' ? 'Reventa' : '')}
                    </span>
                  )}
                </td>
                <td className="text-right tabular-nums">{fmtNum(p.qty_sold)} {p.sale_unit || ''}</td>
                <td className="text-right tabular-nums">{fmtMXN(p.invoiced_revenue)}</td>
                <td className="text-right tabular-nums">{fmtMXN(p.uninvoiced_revenue)}</td>
                <td className="text-right tabular-nums font-semibold">{fmtMXN(p.revenue)}</td>
                <td className="text-right tabular-nums">
                  <PctBar pct={p.pct_of_total} />
                </td>
                <td className={clsx('text-right tabular-nums',
                  p.margin_pct == null ? 'text-ink-muted' :
                  p.margin_pct > 20 ? 'text-status-success' :
                  p.margin_pct >= 0 ? 'text-ink-secondary' : 'text-status-danger')}>
                  {fmtPct(p.margin_pct)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong font-semibold">
              <td colSpan={3} className="text-ink-primary">TOTAL</td>
              <td className="text-right tabular-nums">{fmtMXN(data.by_product.reduce((s, p) => s + p.invoiced_revenue, 0))}</td>
              <td className="text-right tabular-nums">{fmtMXN(data.by_product.reduce((s, p) => s + p.uninvoiced_revenue, 0))}</td>
              <td className="text-right tabular-nums">{fmtMXN(total)}</td>
              <td className="text-right tabular-nums">100%</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

// ── Por metro lineal ────────────────────────────────────────────────────────
function MetrosTab({ data }) {
  // Mostrar TODOS los productos con metros (corner_protector + cualquier otro
  // con length_mm definido). Los que falten datos quedan marcados.
  const esquineros = data.by_product.filter(p =>
    p.type === 'corner_protector' || (p.meters != null && p.meters > 0) || p.missing_length
  )
  if (esquineros.length === 0) {
    return (
      <div className="card text-center text-ink-muted py-8">
        Sin ventas de productos con metros lineales en el periodo.
      </div>
    )
  }
  const conMetros   = esquineros.filter(p => p.meters != null)
  const sinMetros   = esquineros.filter(p => p.missing_length)
  const totalMetros = conMetros.reduce((s, p) => s + (p.meters || 0), 0)
  const totalRevenue = conMetros.reduce((s, p) => s + p.revenue, 0)
  const avgPerMeter = totalMetros > 0 ? totalRevenue / totalMetros : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard label="Metros lineales totales" value={`${fmtNum(totalMetros, 1)} m`} />
        <KpiCard label="Ventas en esquineros" value={fmtMXN(totalRevenue)} />
        <KpiCard label="Precio promedio / metro" value={fmtMXNf(avgPerMeter)} />
      </div>

      {sinMetros.length > 0 && (
        <div className="alert-warning text-sm">
          <strong>{sinMetros.length} producto{sinMetros.length === 1 ? '' : 's'}</strong> se vendi{sinMetros.length === 1 ? 'ó' : 'eron'} pero no tienen{' '}
          <code className="font-mono text-xs">length_mm</code> en su catálogo, así que no se pueden contar en metros lineales.
          {' '}Captura la longitud en <em>Productos</em> para que aparezcan en este reporte.
          {' '}Los montos sí aparecen abajo como referencia.
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Producto</th>
              <th className="text-right">Long. unit.</th>
              <th className="text-right">Piezas vendidas</th>
              <th className="text-right">Metros lineales</th>
              <th className="text-right">Ventas</th>
              <th className="text-right">Precio / metro</th>
            </tr>
          </thead>
          <tbody>
            {esquineros.map(p => (
              <tr key={p.product_id} className={p.missing_length ? 'opacity-60' : ''}>
                <td className="font-mono text-xs">{p.sku}</td>
                <td className="text-ink-primary font-medium">
                  {p.name}
                  {p.missing_length && (
                    <span className="ml-2 text-[10px] text-status-warning">⚠ falta longitud</span>
                  )}
                </td>
                <td className="text-right tabular-nums">{p.length_mm ? `${fmtNum(p.length_mm)} mm` : '—'}</td>
                <td className="text-right tabular-nums">{fmtNum(p.qty_base)}</td>
                <td className="text-right tabular-nums">{p.meters != null ? `${fmtNum(p.meters, 1)} m` : '—'}</td>
                <td className="text-right tabular-nums">{fmtMXN(p.revenue)}</td>
                <td className="text-right tabular-nums">{p.price_per_meter ? fmtMXNf(p.price_per_meter) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function KpiCard({ label, value }) {
  return (
    <div className="card-sm">
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="text-xl font-semibold text-ink-primary mt-1 tabular-nums">{value}</p>
    </div>
  )
}

// ── Utilidades ──────────────────────────────────────────────────────────────
function UtilidadesTab({ data }) {
  const cur = data.totals_current
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <KpiCard label="Ventas" value={fmtMXN(cur.revenue)} />
        <KpiCard label="Costo estimado" value={fmtMXN(cur.estimated_cost)} />
        <KpiCard label="Utilidad bruta" value={fmtMXN(cur.estimated_margin)} />
        <KpiCard label="Margen" value={fmtPct(cur.margin_pct)} />
      </div>
      <p className="text-xs text-ink-muted">
        Utilidad bruta = Ventas − Costo de producción/compra. <strong>Antes de</strong> gastos
        operativos (renta, sueldos administrativos, etc).
      </p>

      <div className="card p-0 overflow-hidden">
        <h3 className="text-sm font-semibold text-ink-primary p-4 border-b border-line-subtle">
          Utilidad por cliente
        </h3>
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th className="text-right">Ventas</th>
              <th className="text-right">Costo est.</th>
              <th className="text-right">Utilidad</th>
              <th className="text-right">Margen</th>
            </tr>
          </thead>
          <tbody>
            {data.by_customer.map(c => (
              <tr key={c.partner_id}>
                <td className="text-ink-primary font-medium">{c.partner_name}</td>
                <td className="text-right tabular-nums">{fmtMXN(c.revenue)}</td>
                <td className="text-right tabular-nums">{fmtMXN(c.estimated_cost)}</td>
                <td className="text-right tabular-nums">{fmtMXN(c.estimated_margin)}</td>
                <td className={clsx('text-right tabular-nums',
                  c.margin_pct > 20 ? 'text-status-success' :
                  c.margin_pct >= 0 ? 'text-ink-secondary' : 'text-status-danger')}>
                  {fmtPct(c.margin_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Alertas de margen negativo ──────────────────────────────────────────────
function AlertasTab({ data }) {
  if (data.negative_margins.length === 0) {
    return (
      <div className="card flex flex-col items-center text-center py-10">
        <div className="w-12 h-12 rounded-full bg-brand-500/15 text-brand-300 flex items-center justify-center mb-3 border border-brand-500/30">
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        </div>
        <h3 className="text-base font-semibold text-ink-primary">Sin alertas</h3>
        <p className="text-sm text-ink-muted mt-1">Todos los productos del periodo se vendieron por encima de su costo.</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="alert-warning">
        <strong>{data.negative_margins.length} producto{data.negative_margins.length === 1 ? '' : 's'}</strong>
        {' '}se vendi{data.negative_margins.length === 1 ? 'ó' : 'eron'} por debajo del costo en este periodo.
        Revisa precios de venta o renegocia con proveedores.
      </div>
      <div className="card p-0 overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Producto</th>
              <th className="text-right">Precio venta</th>
              <th className="text-right">Costo</th>
              <th className="text-right">Cantidad</th>
              <th className="text-right">Pérdida</th>
            </tr>
          </thead>
          <tbody>
            {data.negative_margins.map(p => (
              <tr key={p.product_id}>
                <td className="font-mono text-xs">{p.sku}</td>
                <td className="text-ink-primary font-medium">{p.name}</td>
                <td className="text-right tabular-nums">{fmtMXNf(p.avg_price)}</td>
                <td className="text-right tabular-nums">{fmtMXNf(p.unit_cost)}</td>
                <td className="text-right tabular-nums">{fmtNum(p.qty_base)}</td>
                <td className="text-right tabular-nums text-status-danger font-semibold">−{fmtMXN(p.loss)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Modal de detalle (facturas + remisiones del cliente/producto) ───────────
function DetailModal({ type, id, name, from, to, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['sales-detail', type, id, from, to],
    queryFn:  () => reportsApi.getSalesDetail({ type, id, from, to }),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm p-4"
         onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col p-0" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-line-subtle">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{type === 'customer' ? 'CLIENTE' : 'PRODUCTO'}</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-1 truncate">{name}</h2>
            <p className="text-xs text-ink-muted mt-1">Periodo {from} al {to}</p>
          </div>
          <button onClick={onClose}
            className="btn-icon text-ink-muted hover:text-ink-primary hover:bg-white/[0.04] rounded-md shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : !data ? (
            <p className="text-ink-muted">No se pudo cargar el detalle.</p>
          ) : (
            <div className="flex flex-col gap-6">
              {/* Facturas */}
              <section>
                <h3 className="text-sm font-semibold text-ink-primary mb-2">
                  Facturas timbradas <span className="text-ink-muted font-normal">({data.invoices.length})</span>
                </h3>
                {data.invoices.length === 0 ? (
                  <p className="text-sm text-ink-muted py-3">Sin facturas en este periodo.</p>
                ) : (
                  <div className="border border-line-subtle rounded-md overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Folio</th>
                          <th>UUID</th>
                          <th>Fecha</th>
                          {type === 'product' && <th>Cliente</th>}
                          {type === 'product' && <th className="text-right">Cantidad</th>}
                          <th className="text-right">{type === 'product' ? 'Subtotal' : 'Total'}</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.invoices.map(inv => (
                          <tr key={inv.id}>
                            <td className="font-medium">{inv.document_number}</td>
                            <td className="font-mono text-[10px] text-ink-muted">{(inv.cfdi_uuid || '').slice(0, 8)}…</td>
                            <td className="text-xs">{inv.stamp_date ? new Date(inv.stamp_date).toLocaleDateString('es-MX') : '—'}</td>
                            {type === 'product' && <td>{inv.partner_name}</td>}
                            {type === 'product' && <td className="text-right tabular-nums">{fmtNum(inv.qty)}</td>}
                            <td className="text-right tabular-nums">{fmtMXN(inv.subtotal || inv.total_mxn)}</td>
                            <td>
                              <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-semibold',
                                inv.status === 'stamped' ? 'bg-status-success/15 text-status-success' :
                                inv.status === 'cancelled' ? 'bg-status-danger/15 text-status-danger' :
                                'bg-white/[0.05] text-ink-muted')}>
                                {inv.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Remisiones */}
              <section>
                <h3 className="text-sm font-semibold text-ink-primary mb-2">
                  Remisiones <span className="text-ink-muted font-normal">({data.deliveries.length})</span>
                </h3>
                {data.deliveries.length === 0 ? (
                  <p className="text-sm text-ink-muted py-3">Sin remisiones en este periodo.</p>
                ) : (
                  <div className="border border-line-subtle rounded-md overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Folio</th>
                          <th>Fecha entrega</th>
                          {type === 'product' && <th>Cliente</th>}
                          {type === 'product' && <th className="text-right">Cantidad</th>}
                          <th className="text-right">{type === 'product' ? 'Subtotal' : 'Total'}</th>
                          <th>Facturada</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.deliveries.map(dn => (
                          <tr key={dn.id}>
                            <td className="font-medium">{dn.document_number}</td>
                            <td className="text-xs">
                              {dn.delivered_at
                                ? new Date(dn.delivered_at).toLocaleDateString('es-MX')
                                : new Date(dn.issue_date).toLocaleDateString('es-MX')}
                            </td>
                            {type === 'product' && <td>{dn.partner_name}</td>}
                            {type === 'product' && <td className="text-right tabular-nums">{fmtNum(dn.qty)}</td>}
                            <td className="text-right tabular-nums">{fmtMXN(dn.subtotal || dn.total_mxn)}</td>
                            <td>
                              {dn.has_invoice ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-status-success/15 text-status-success">
                                  Sí
                                </span>
                              ) : dn.no_invoice ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-white/[0.05] text-ink-muted">
                                  No facturable
                                </span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-status-warning/15 text-status-warning">
                                  Pendiente
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-line-subtle flex justify-end">
          <button onClick={onClose} className="btn-secondary">Cerrar</button>
        </div>
      </div>
    </div>
  )
}
