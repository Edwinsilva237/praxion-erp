import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { reportsApi } from '@/api/reports'
import { partnersApi } from '@/api/partners'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtNum  = (n) => new Intl.NumberFormat('es-MX').format(n || 0)
// Fechas de calendario sin desfase de zona horaria (ver utils/fmt fmtDateOnly).
const fmtDate = (d) => {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-').map(Number)
  if (s.length === 10 && y && m && day)
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const STATUS_META = {
  overdue:  { label: 'Vencido',           rowClass: 'bg-status-danger/[0.08] hover:bg-status-danger/[0.15]',  pillClass: 'bg-status-danger/15 text-status-danger' },
  due_soon: { label: 'Próximo a vencer',  rowClass: 'bg-status-warning/[0.08] hover:bg-status-warning/[0.15]', pillClass: 'bg-status-warning/15 text-status-warning' },
  current:  { label: 'Al corriente',      rowClass: 'hover:bg-surface-elevated/40',                            pillClass: 'bg-status-success/15 text-status-success' },
  no_due:   { label: 'Sin fecha pactada', rowClass: 'hover:bg-surface-elevated/40',                            pillClass: 'bg-surface-elevated/60 text-ink-muted' },
}

const STATUS_OPTS = [
  ['', 'Todos los estados'],
  ['overdue', 'Vencido'],
  ['due_soon', 'Próximo a vencer'],
  ['current', 'Al corriente'],
  ['no_due', 'Sin fecha pactada'],
]

const DOC_TYPE_LABEL = {
  invoice:     'Factura',
  remission:   'Remisión',
  credit_note: 'NC',
  advance:     'Anticipo',
}

export default function EstadoDeCuenta({ direction }) {
  const isReceivable = direction === 'cuentas-por-cobrar'
  const labels = isReceivable
    ? { title: 'Cuentas por cobrar', partnerCol: 'Cliente', partnerNounPlural: 'clientes', subtitle: 'Estado de cuenta de clientes. Click en una fila para ver el detalle y enviar por correo.' }
    : { title: 'Cuentas por pagar',  partnerCol: 'Proveedor', partnerNounPlural: 'proveedores', subtitle: 'Estado de cuenta de proveedores. Click en una fila para ver el detalle.' }

  const [partner, setPartner]           = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch]             = useState('')
  const [selectedPartnerId, setSelectedPartnerId] = useState(null)
  const [groupByPartner, setGroupByPartner] = useState(false)

  const filters = useMemo(() => {
    const f = {}
    if (partner?.id)   f.partnerId = partner.id
    if (statusFilter)  f.statusFilter = statusFilter
    if (search.trim()) f.search = search.trim()
    return f
  }, [partner, statusFilter, search])

  const { data, isLoading, error } = useQuery({
    queryKey: ['account-statement', direction, filters],
    queryFn:  () => reportsApi.getAccountStatement({ direction, filters }),
    keepPreviousData: true,
  })

  const searchPartners = async (q) => {
    const type = isReceivable ? 'customer' : 'supplier'
    const res = await partnersApi.list({ search: q, type, limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }

  const [exporting, setExporting] = useState(null)
  const [exportError, setExportError] = useState(null)

  async function exportAs(kind) {
    setExporting(kind); setExportError(null)
    try {
      const fn  = kind === 'excel' ? reportsApi.downloadAccountStatementExcel : reportsApi.downloadAccountStatementPdf
      const ext = kind === 'excel' ? 'xlsx' : 'pdf'
      const mime = kind === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf'
      const res = await fn({ direction, filters })
      const blob = new Blob([res.data], { type: mime })
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${direction}-${new Date().toISOString().slice(0,10)}.${ext}`
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

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="eyebrow">REPORTES</p>
          <h1 className="text-xl font-semibold text-ink-primary mt-1">{labels.title}</h1>
          <p className="text-sm text-ink-muted mt-1">{labels.subtitle}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => exportAs('pdf')} disabled={exporting !== null || isLoading}
            className="btn-primary" title="PDF ejecutivo de todo el estado de cuenta — para socios">
            {exporting === 'pdf' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            PDF general
          </button>
          <button onClick={() => exportAs('excel')} disabled={exporting !== null || isLoading}
            className="btn-secondary" title="Excel con todos los registros">
            {exporting === 'excel' ? <Spinner size="sm" /> : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            )}
            Excel
          </button>
        </div>
      </div>

      {exportError && <div className="alert-error text-sm">{exportError}</div>}

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard label="Pendiente total" value={fmtMXNf(data.summary.total_pending_amount)}
            sub={`${fmtNum(data.summary.total_pending_count)} docs`} />
          <KpiCard label="Vencido" value={fmtMXNf(data.summary.overdue.amount)}
            sub={`${fmtNum(data.summary.overdue.count)} docs`} tone="danger" />
          <KpiCard label={`Próx. vencer (${data.due_soon_days}d)`} value={fmtMXNf(data.summary.due_soon.amount)}
            sub={`${fmtNum(data.summary.due_soon.count)} docs`} tone="warning" />
          <KpiCard label="Al corriente" value={fmtMXNf(data.summary.current.amount)}
            sub={`${fmtNum(data.summary.current.count)} docs`} tone="success" />
          <KpiCard label="Saldo neto"
            value={fmtMXNf(data.summary.net_balance)}
            sub={data.summary.advances_available.amount > 0 || data.summary.credit_notes_available.amount > 0
              ? `tras ${fmtMXN(data.summary.advances_available.amount + data.summary.credit_notes_available.amount)} a favor`
              : 'sin saldos a favor'}
            tone={data.summary.net_balance > 0 ? 'danger' : 'success'} />
        </div>
      )}

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Número de documento, nombre, RFC..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="min-w-[200px]">
          <label className="label">{labels.partnerCol}</label>
          <Autocomplete value={partner} onChange={setPartner}
            onSearch={searchPartners}
            placeholder={`Filtrar por ${labels.partnerCol.toLowerCase()}...`} />
        </div>
        <div>
          <label className="label">Estado</label>
          <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-secondary pb-2">
          <input type="checkbox" className="w-4 h-4 accent-brand-500"
            checked={groupByPartner} onChange={e => setGroupByPartner(e.target.checked)} />
          Agrupar por {labels.partnerCol.toLowerCase()}
        </label>
        {(partner || statusFilter || search) && (
          <button onClick={() => { setPartner(null); setStatusFilter(''); setSearch('') }}
            className="btn-ghost btn-sm text-ink-muted">Limpiar</button>
        )}
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-status-danger">
            {error.response?.data?.error || error.message || 'Error al cargar el estado de cuenta.'}
          </div>
        ) : !data || data.documents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium text-status-success">✓ Sin documentos pendientes</p>
            <p className="text-sm text-ink-muted">
              {partner || statusFilter || search
                ? 'No hay coincidencias con los filtros aplicados.'
                : `Todos los ${labels.partnerNounPlural} están al corriente.`}
            </p>
          </div>
        ) : groupByPartner ? (
          <PartnersTable data={data} labels={labels} direction={direction}
            onOpenPartner={setSelectedPartnerId} />
        ) : (
          <DocumentsTable data={data} labels={labels} direction={direction}
            onOpenPartner={setSelectedPartnerId} />
        )}
      </div>

      {/* Modal detalle del partner */}
      {selectedPartnerId && (
        <PartnerStatementModal
          direction={direction}
          partnerId={selectedPartnerId}
          labels={labels}
          onClose={() => setSelectedPartnerId(null)}
        />
      )}
    </div>
  )
}

// ── KPI Card ────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, tone = 'neutral' }) {
  const toneClass = {
    danger:  'text-status-danger',
    warning: 'text-status-warning',
    success: 'text-status-success',
    neutral: 'text-ink-primary',
  }[tone]
  const bgClass = {
    danger:  'bg-status-danger/[0.05] border-status-danger/30',
    warning: 'bg-status-warning/[0.05] border-status-warning/30',
    success: 'bg-status-success/[0.05] border-status-success/30',
    neutral: '',
  }[tone]
  return (
    <div className={clsx('card p-3 border', bgClass)}>
      <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={clsx('text-xl font-semibold mt-0.5 tabular-nums', toneClass)}>{value}</p>
      {sub && <p className="text-[10px] text-ink-muted mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Tabla de documentos detallada ───────────────────────────────────────────
function DocumentsTable({ data, labels, direction, onOpenPartner }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Estado</th>
          <th>Documento</th>
          <th>{labels.partnerCol}</th>
          <th>Emisión</th>
          <th>Vence</th>
          <th className="text-right">Días</th>
          <th className="text-right">Total</th>
          <th className="text-right">Pagado</th>
          <th className="text-right">Pendiente</th>
        </tr>
      </thead>
      <tbody>
        {data.documents.map(d => {
          const meta = STATUS_META[d.aging_status] || STATUS_META.no_due
          return (
            <tr key={d.id}
              onClick={() => onOpenPartner(d.partner_id)}
              className={clsx('cursor-pointer transition-colors', meta.rowClass)}>
              <td>
                <span className={clsx('text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full', meta.pillClass)}>
                  {meta.label}
                </span>
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-surface-elevated/60 text-ink-secondary px-1.5 py-0.5 rounded-full">
                    {DOC_TYPE_LABEL[d.document_type] || d.document_type}
                  </span>
                  <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                </div>
              </td>
              <td>
                <p className="font-medium text-ink-primary">{d.partner_name}</p>
                {d.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{d.partner_rfc}</p>}
              </td>
              <td className="text-xs text-ink-secondary">{fmtDate(d.issue_date)}</td>
              <td className={clsx('text-xs',
                d.aging_status === 'overdue' ? 'text-status-danger font-semibold' : 'text-ink-secondary')}>
                {fmtDate(d.due_date)}
              </td>
              <td className={clsx('text-right text-xs tabular-nums',
                d.days_overdue == null ? 'text-ink-muted' :
                d.days_overdue > 0 ? 'text-status-danger font-semibold' :
                d.days_overdue >= -data.due_soon_days ? 'text-status-warning' : 'text-status-success')}>
                {d.days_overdue == null ? '—' :
                  d.days_overdue > 0 ? `+${d.days_overdue}d` :
                  d.days_overdue === 0 ? 'hoy' : `${d.days_overdue}d`}
              </td>
              <td className="text-right font-mono tabular-nums">{fmtMXN(d.amount_total)}</td>
              <td className="text-right font-mono tabular-nums text-status-success">{fmtMXN(d.amount_paid)}</td>
              <td className="text-right font-mono tabular-nums font-semibold">{fmtMXN(d.amount_pending)}</td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-line-strong font-semibold">
          <td colSpan={6} className="text-ink-primary">TOTAL ({data.documents.length} docs)</td>
          <td className="text-right tabular-nums">{fmtMXN(data.documents.reduce((s, d) => s + d.amount_total, 0))}</td>
          <td className="text-right tabular-nums">{fmtMXN(data.documents.reduce((s, d) => s + d.amount_paid, 0))}</td>
          <td className="text-right tabular-nums">{fmtMXN(data.summary.total_pending_amount)}</td>
        </tr>
      </tfoot>
    </table>
  )
}

// ── Tabla agrupada por partner ─────────────────────────────────────────────
function PartnersTable({ data, labels, direction, onOpenPartner }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{labels.partnerCol}</th>
          <th className="text-right"># docs</th>
          <th className="text-right">Vencido</th>
          <th className="text-right">Próx. vencer</th>
          <th className="text-right">Al corriente</th>
          <th className="text-right">Pendiente total</th>
          <th className="text-right">Días máx.</th>
        </tr>
      </thead>
      <tbody>
        {data.by_partner.map(p => (
          <tr key={p.partner_id}
            onClick={() => onOpenPartner(p.partner_id)}
            className={clsx('cursor-pointer transition-colors',
              p.overdue_amount > 0 ? 'bg-status-danger/[0.05] hover:bg-status-danger/[0.12]'
                                   : 'hover:bg-surface-elevated/40')}>
            <td>
              <p className="font-medium text-ink-primary">{p.partner_name}</p>
              {p.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{p.partner_rfc}</p>}
            </td>
            <td className="text-right tabular-nums">{fmtNum(p.docs_count)}</td>
            <td className={clsx('text-right tabular-nums',
              p.overdue_amount > 0 ? 'text-status-danger font-semibold' : 'text-ink-muted')}>
              {p.overdue_amount > 0 ? fmtMXN(p.overdue_amount) : '—'}
              {p.overdue_count > 0 && <span className="text-[10px] text-ink-muted ml-1">({p.overdue_count})</span>}
            </td>
            <td className={clsx('text-right tabular-nums',
              p.due_soon_amount > 0 ? 'text-status-warning font-semibold' : 'text-ink-muted')}>
              {p.due_soon_amount > 0 ? fmtMXN(p.due_soon_amount) : '—'}
            </td>
            <td className="text-right tabular-nums text-status-success">
              {p.current_amount > 0 ? fmtMXN(p.current_amount) : '—'}
            </td>
            <td className="text-right tabular-nums font-semibold">{fmtMXN(p.pending_amount)}</td>
            <td className="text-right tabular-nums">
              {p.max_days_overdue != null ? `${p.max_days_overdue}d` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-line-strong font-semibold">
          <td>TOTAL ({data.by_partner.length} {labels.partnerCol.toLowerCase()}s)</td>
          <td className="text-right tabular-nums">{fmtNum(data.by_partner.reduce((s, p) => s + p.docs_count, 0))}</td>
          <td className="text-right tabular-nums text-status-danger">{fmtMXN(data.summary.overdue.amount)}</td>
          <td className="text-right tabular-nums text-status-warning">{fmtMXN(data.summary.due_soon.amount)}</td>
          <td className="text-right tabular-nums text-status-success">{fmtMXN(data.summary.current.amount)}</td>
          <td className="text-right tabular-nums">{fmtMXN(data.summary.total_pending_amount)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  )
}

// ── Modal de detalle del partner ────────────────────────────────────────────
function PartnerStatementModal({ direction, partnerId, labels, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['partner-statement', direction, partnerId],
    queryFn:  () => reportsApi.getPartnerStatement({ direction, partnerId }),
  })

  const [downloading, setDownloading] = useState(false)
  const [showEmail, setShowEmail]     = useState(false)

  async function downloadPdf() {
    setDownloading(true)
    try {
      const res = await reportsApi.downloadPartnerStatementPdf({ direction, partnerId })
      const blob = new Blob([res.data], { type: 'application/pdf' })
      const url  = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `estado-cuenta-${data?.partner?.name || partnerId}-${new Date().toISOString().slice(0,10)}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="card w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 border-b border-line-subtle gap-4">
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{labels.partnerCol.toUpperCase()}</p>
            <h2 className="text-lg font-semibold text-ink-primary mt-1 truncate">
              {data?.partner?.name || 'Cargando...'}
            </h2>
            {data?.partner?.rfc && (
              <p className="text-xs text-ink-muted mt-0.5 font-mono">{data.partner.rfc}</p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={downloadPdf} disabled={downloading || isLoading}
              className="btn-secondary btn-sm">
              {downloading ? <Spinner size="sm" /> : '↓ PDF'}
            </button>
            {direction === 'cuentas-por-cobrar' && (
              <button onClick={() => setShowEmail(true)} disabled={isLoading}
                className="btn-primary btn-sm">
                ✉ Enviar
              </button>
            )}
            <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : !data ? (
            <p className="text-ink-muted">No se pudo cargar el detalle.</p>
          ) : (
            <PartnerStatementContent data={data} />
          )}
        </div>
      </div>

      {showEmail && data && (
        <EmailStatementModal
          direction={direction}
          partner={data.partner}
          contacts={data.contacts}
          onClose={() => setShowEmail(false)}
        />
      )}
    </div>,
    document.body
  )
}

function PartnerStatementContent({ data }) {
  const s = data.summary
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Pendiente" value={fmtMXNf(s.total_pending_amount)} sub={`${fmtNum(s.total_pending_count)} docs`} />
        <KpiCard label="Vencido"   value={fmtMXNf(s.overdue.amount)}  sub={`${fmtNum(s.overdue.count)} docs`} tone="danger" />
        <KpiCard label={`Próx. vencer (${data.due_soon_days}d)`} value={fmtMXNf(s.due_soon.amount)} sub={`${fmtNum(s.due_soon.count)} docs`} tone="warning" />
        <KpiCard label="Saldo neto" value={fmtMXNf(s.net_balance)}
          sub={s.advances_available.amount + s.credit_notes_available.amount > 0
            ? `${fmtMXN(s.advances_available.amount + s.credit_notes_available.amount)} a favor`
            : 'sin saldos a favor'}
          tone={s.net_balance > 0 ? 'danger' : 'success'} />
      </div>

      <div className="card p-0 overflow-hidden">
        <h3 className="text-sm font-semibold text-ink-primary p-4 border-b border-line-subtle">
          Documentos pendientes
        </h3>
        {data.documents.length === 0 ? (
          <p className="text-sm text-status-success p-4">✓ Sin documentos pendientes.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Documento</th>
                <th>Emisión</th>
                <th>Vence</th>
                <th className="text-right">Total</th>
                <th className="text-right">Pagado</th>
                <th className="text-right">Pendiente</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map(d => {
                const meta = STATUS_META[d.aging_status] || STATUS_META.no_due
                return (
                  <tr key={d.id} className={meta.rowClass}>
                    <td>
                      <span className={clsx('text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full', meta.pillClass)}>
                        {meta.label}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono font-semibold text-brand-300">{d.document_number}</span>
                      <span className="ml-2 text-[10px] text-ink-muted">{DOC_TYPE_LABEL[d.document_type] || d.document_type}</span>
                    </td>
                    <td className="text-xs">{fmtDate(d.issue_date)}</td>
                    <td className="text-xs">{fmtDate(d.due_date)}{d.days_overdue > 0 && <span className="text-[10px] text-status-danger ml-1">+{d.days_overdue}d</span>}</td>
                    <td className="text-right font-mono tabular-nums">{fmtMXN(d.amount_total)}</td>
                    <td className="text-right font-mono tabular-nums text-status-success">{fmtMXN(d.amount_paid)}</td>
                    <td className="text-right font-mono tabular-nums font-semibold">{fmtMXN(d.amount_pending)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {data.advances.length > 0 && (
        <div className="card p-4 bg-status-success/[0.05] border-status-success/30 border">
          <h3 className="text-sm font-semibold text-status-success mb-2">Saldo a favor — Anticipos</h3>
          {data.advances.map(a => (
            <div key={a.id} className="flex justify-between text-xs py-1 border-b border-line-subtle last:border-0">
              <span>{fmtDate(a.receipt_date)}{a.reference ? ` · ${a.reference}` : ''}</span>
              <span className="font-mono font-semibold text-status-success">+ {fmtMXN(a.amount_available)}</span>
            </div>
          ))}
        </div>
      )}

      {data.credit_notes.length > 0 && (
        <div className="card p-4 bg-status-success/[0.05] border-status-success/30 border">
          <h3 className="text-sm font-semibold text-status-success mb-2">Saldo a favor — Notas de crédito</h3>
          {data.credit_notes.map(c => (
            <div key={c.id} className="flex justify-between text-xs py-1 border-b border-line-subtle last:border-0">
              <span>{c.document_number} · {fmtDate(c.issue_date)}</span>
              <span className="font-mono font-semibold text-status-success">+ {fmtMXN(c.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Modal de envío por correo ──────────────────────────────────────────────
function EmailStatementModal({ direction, partner, contacts, onClose }) {
  // Pre-popula con los emails de los contactos del partner.
  const defaultEmails = (contacts || [])
    .filter(c => c.email)
    .map(c => c.email)
    .join(', ')

  const [to, setTo]           = useState(defaultEmails)
  const [cc, setCc]           = useState('')
  const [message, setMessage] = useState('')
  const [error, setError]     = useState(null)
  const [sent, setSent]       = useState(false)

  const mutation = useMutation({
    mutationFn: () => {
      const recipients = to.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      if (recipients.length === 0) throw new Error('Captura al menos un destinatario.')
      const ccList = cc.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      return reportsApi.emailPartnerStatement({
        direction, partnerId: partner.id,
        to: recipients,
        cc: ccList.length > 0 ? ccList : undefined,
        message: message.trim() || undefined,
      })
    },
    onSuccess: () => setSent(true),
    onError:   (e) => setError(e.response?.data?.error || e.message || 'No se pudo enviar.'),
  })

  function handleSubmit(e) { e.preventDefault(); setError(null); mutation.mutate() }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">✉ Enviar estado de cuenta</h2>
            <p className="text-xs text-ink-muted mt-0.5">{partner.name}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {sent ? (
          <div className="flex flex-col gap-3 py-4">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-status-success/15 text-status-success flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-ink-primary">Estado de cuenta enviado</p>
              <p className="text-xs text-ink-muted mt-1">{to}</p>
            </div>
            <button type="button" onClick={onClose} className="btn-primary">Cerrar</button>
          </div>
        ) : (
          <>
            <div>
              <label className="label">Para <span className="text-status-danger">*</span></label>
              <input className="input" value={to} onChange={e => setTo(e.target.value)}
                placeholder="correo1@ejemplo.com, correo2@..." />
              <p className="text-[10px] text-ink-muted mt-1">Separa con coma o punto y coma para múltiples.</p>
            </div>
            <div>
              <label className="label">CC <span className="text-ink-muted text-xs">(opcional)</span></label>
              <input className="input" value={cc} onChange={e => setCc(e.target.value)}
                placeholder="copias..." />
            </div>
            <div>
              <label className="label">Mensaje <span className="text-ink-muted text-xs">(opcional)</span></label>
              <textarea className="input" rows={3} value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Estimad@..., adjunto su estado de cuenta..." />
            </div>

            {error && <p className="field-error">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
              <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1">
                {mutation.isPending ? <Spinner size="sm" /> : 'Enviar por correo'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body
  )
}
