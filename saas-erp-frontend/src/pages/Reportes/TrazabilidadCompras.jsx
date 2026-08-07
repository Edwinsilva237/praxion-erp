import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import { partnersApi } from '@/api/partners'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { fmtDateOnly } from '@/utils/fmt'
import clsx from 'clsx'

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const money = (n) => n == null ? '' : new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)

function rangeFromMonth(year, monthIdx) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fmt(new Date(year, monthIdx, 1)), to: fmt(new Date(year, monthIdx + 1, 1)) }
}

// Marca visual por tipo de evento del expediente.
const EVENT_STYLE = {
  oc:               { icon: '📋', tone: 'text-ink-secondary' },
  receipt:          { icon: '📦', tone: 'text-ink-secondary' },
  invoice:          { icon: '🧾', tone: 'text-brand-300' },
  remission_cxp:    { icon: '🧾', tone: 'text-status-warning' },
  return:           { icon: '↩️', tone: 'text-status-warning' },
  replacement:      { icon: '🔁', tone: 'text-status-info' },
  credit_note:      { icon: '💳', tone: 'text-status-info' },
  cancelled:        { icon: '🚫', tone: 'text-status-danger' },
  substituted:      { icon: '🔀', tone: 'text-status-danger' },
  substitutes:      { icon: '🔀', tone: 'text-status-info' },
  payment:          { icon: '💵', tone: 'text-status-success' },
  payment_reversed: { icon: '↺',  tone: 'text-status-danger' },
  rep_requested:    { icon: '✉️', tone: 'text-ink-muted' },
  rep:              { icon: '📑', tone: 'text-status-success' },
}

const REP_BADGE = {
  ok:              { label: 'REP completo',   variant: 'green' },
  missing:         { label: 'Falta REP',      variant: 'red'   },
  mismatch:        { label: 'REP no cuadra',  variant: 'amber' },
  pending_payment: { label: 'Sin pagos',      variant: 'gray'  },
  not_required:    { label: 'PUE',            variant: 'gray'  },
}

// Franja lateral: el estado del expediente se lee de un vistazo, sin depender
// solo del texto de los badges.
function edgeTone(c) {
  if (c.flags.cancelled) return 'border-l-ink-muted'
  if (['missing', 'mismatch'].includes(c.flags.rep_status)) return 'border-l-status-danger'
  if (!c.flags.paid || c.flags.has_nc) return 'border-l-status-warning'
  return 'border-l-status-success'
}

/**
 * Notas contables del expediente: explican en español qué implica cada
 * incidencia para el IVA y la cuenta por pagar. Es lo que evita que el contador
 * tenga que preguntar qué pasó con esta factura.
 */
function accountingNotes(c) {
  const notes = []
  const has = (t) => c.events.some(e => e.type === t)

  if (['missing', 'mismatch'].includes(c.flags.rep_status)) {
    notes.push({
      tone: 'danger',
      text: c.flags.rep_status === 'missing'
        ? `Factura en parcialidades ya pagada sin complemento de pago. Hasta recibirlo, su IVA de ${money(c.invoice.tax_mxn)} no es acreditable.`
        : `El complemento recibido no cuadra con lo pagado. Mientras no se corrija, el IVA de ${money(c.invoice.tax_mxn)} queda en revisión.`,
    })
  }
  if (c.flags.cancelled) {
    notes.push({
      tone: 'danger',
      text: has('substituted')
        ? 'Factura cancelada y sustituida: su IVA sale del acreditable y lo toma la factura sustituta.'
        : 'Factura cancelada: su IVA sale del acreditable del mes. Lo que se hubiera pagado queda como saldo a favor del proveedor.',
    })
  }
  if (c.flags.has_nc) {
    notes.push({
      tone: 'info',
      text: 'La nota de crédito reduce la cuenta por pagar como pago no-efectivo; su IVA se resta del acreditable y no cuenta como IVA pagado.',
    })
  }
  if (has('replacement')) {
    notes.push({
      tone: 'info',
      text: 'Reposición en especie: sin nota de crédito ni cancelación — la factura sigue vigente porque la mercancía se recibió completa.',
    })
  }
  if (c.invoice.type === 'remission') {
    notes.push({
      tone: 'warn',
      text: 'Cuenta por pagar sin CFDI: el gasto no es deducible ni genera IVA acreditable. Aparece para cuadrar el control interno contra el flujo de efectivo.',
    })
  }
  return notes
}

const NOTE_TONE = {
  danger: 'border-status-danger/60 bg-status-danger/10 text-status-danger',
  warn:   'border-status-warning/60 bg-status-warning/10 text-status-warning',
  info:   'border-status-info/60 bg-status-info/10 text-ink-secondary',
}

export default function TrazabilidadCompras() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [partnerId, setPartnerId] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)

  const { from, to } = rangeFromMonth(year, month)

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-traceability', from, to, partnerId],
    queryFn:  () => reportsApi.getPurchaseTraceability({ from, to, partnerId: partnerId || undefined }),
    staleTime: 60_000,
  })

  const { data: suppliers = [] } = useQuery({
    queryKey: ['partners', 'supplier'],
    queryFn: () => partnersApi.list({ role: 'supplier', limit: 200 }).then(r => r.data || r),
  })

  function toggle(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function exportExcel() {
    setExporting(true); setExportError(null)
    try {
      const res = await reportsApi.downloadPurchaseTraceabilityExcel({ from, to, partnerId: partnerId || undefined })
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trazabilidad-compras-${MONTHS_ES[month].toLowerCase()}-${year}.xlsx`
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
  const s = data?.summary

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <p className="eyebrow">REPORTES</p>
        <h1 className="page-title">Trazabilidad de compras</h1>
        <p className="text-sm text-ink-secondary mt-1">
          Expediente completo de cada factura: orden de compra, recepciones, devoluciones y su resolución
          fiscal, pagos y complementos (REP). Cada eslabón con su folio y UUID para conciliar en contabilidad.
        </p>
        <p className="text-sm text-ink-secondary mt-1">
          Periodo: <strong>{MONTHS_ES[month]} {year}</strong>
          {partnerId && suppliers.find(p => p.id === partnerId)
            ? <> · Proveedor: <strong>{suppliers.find(p => p.id === partnerId).name}</strong></>
            : null}
        </p>
      </div>

      {/* Filtros — se ocultan al imprimir: en papel el periodo ya va en el título. */}
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
        <div className="flex-1 min-w-[220px]">
          <label className="label">Proveedor</label>
          <select className="select w-full" value={partnerId} onChange={e => setPartnerId(e.target.value)}>
            <option value="">Todos los proveedores</option>
            {suppliers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button onClick={exportExcel} disabled={exporting} className="btn-secondary">
          {exporting ? <Spinner size="sm" /> : '📊'} Exportar Excel
        </button>
      </div>
      {exportError && <p className="field-error">{exportError}</p>}

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {/* Resumen */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Kpi label="Expedientes"      value={s?.chains ?? 0} />
            <Kpi label="Comprado neto"    value={money(s?.net_purchased_mxn ?? 0)} small />
            <Kpi label="Pagados"          value={s?.paid ?? 0}      tone="text-status-success" />
            <Kpi label="Con nota de crédito" value={s?.with_nc ?? 0} tone="text-status-info" />
            <Kpi label="REP pendiente"    value={s?.rep_missing ?? 0} tone={s?.rep_missing ? 'text-status-danger' : undefined} />
            <Kpi label="OCs sin factura"  value={s?.pending_ocs ?? 0} tone={s?.pending_ocs ? 'text-status-warning' : undefined} />
          </div>

          {/* Aviso de IVA en espera de complemento — lo primero que revisa el
              contador al cierre del mes. */}
          {s?.iva_pending_rep_mxn > 0.005 && (
            <div className="rounded-lg border border-status-danger/50 bg-status-danger/10 px-4 py-3 text-sm">
              <strong className="text-status-danger">IVA en espera de complemento de pago: {money(s.iva_pending_rep_mxn)}</strong>
              <p className="text-ink-secondary mt-0.5">
                Corresponde a {s.rep_missing} factura{s.rep_missing === 1 ? '' : 's'} en parcialidades ya pagada
                {s.rep_missing === 1 ? '' : 's'} cuyo REP no ha llegado o no cuadra. Ese IVA no es acreditable hasta resolverlo.
              </p>
            </div>
          )}

          {/* Expedientes */}
          <div className="flex flex-col gap-2">
            {(data?.chains || []).length === 0 && (
              <p className="card p-6 text-sm text-ink-muted text-center">
                Sin facturas de compra registradas en {MONTHS_ES[month]} {year}.
              </p>
            )}
            {(data?.chains || []).map(c => {
              const open = expanded.has(c.invoice.id)
              const rep = REP_BADGE[c.flags.rep_status]
              return (
                <div key={c.invoice.id} className={clsx('card overflow-hidden border-l-[3px]', edgeTone(c))}>
                  <button onClick={() => toggle(c.invoice.id)}
                    className="w-full text-left px-4 py-3 hover:bg-surface-elevated/40 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-ink-muted text-xs w-4">{open ? '▾' : '▸'}</span>
                    <span className="font-mono text-sm text-brand-300">{c.invoice.number}</span>
                    <span className="text-sm text-ink-primary flex-1 truncate min-w-[140px]">{c.partner.name}</span>
                    <span className="font-mono text-sm text-ink-primary tabular-nums">{money(c.invoice.total_mxn)}</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {c.flags.cancelled
                        ? <Badge variant="red" label="Cancelada" />
                        : <Badge variant={c.flags.paid ? 'green' : 'amber'} label={c.flags.paid ? 'Pagada' : 'Con saldo'} />}
                      {c.flags.has_nc && <Badge variant="blue" label="NC" />}
                      {rep && <Badge variant={rep.variant} label={rep.label} />}
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-line-subtle px-4 py-3 bg-surface-elevated/20">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted mb-3">
                        {c.partner.rfc && <span>RFC: <span className="font-mono text-ink-secondary">{c.partner.rfc}</span></span>}
                        {c.invoice.uuid && <span>UUID: <span className="font-mono text-ink-secondary">{c.invoice.uuid}</span></span>}
                        {c.invoice.metodo_pago && <span>Método SAT: <b className="text-ink-secondary">{c.invoice.metodo_pago}</b></span>}
                        {c.invoice.balance > 0.005 && <span>Saldo: <b className="text-status-warning">{money(c.invoice.balance)}</b></span>}
                      </div>

                      <ol className="flex flex-col gap-1.5">
                        {c.events.map((e, i) => {
                          const st = EVENT_STYLE[e.type] || { icon: '•', tone: 'text-ink-secondary' }
                          return (
                            <li key={i} className="flex items-start gap-2 text-sm">
                              <span className="w-5 shrink-0 text-center">{st.icon}</span>
                              <span className="text-ink-muted text-xs w-20 shrink-0 tabular-nums pt-0.5">
                                {e.date ? fmtDateOnly(e.date) : '—'}
                              </span>
                              <span className={clsx('shrink-0 w-44', st.tone)}>{e.label}</span>
                              <span className="font-mono text-xs text-ink-secondary shrink-0 w-32 truncate pt-0.5">{e.doc || ''}</span>
                              <span className="font-mono text-xs tabular-nums text-ink-primary shrink-0 w-24 text-right pt-0.5">
                                {e.amount != null ? money(e.amount) : ''}
                              </span>
                              <span className="text-xs text-ink-muted flex-1 min-w-0">
                                {e.uuid && <span className="font-mono block truncate">{e.uuid}</span>}
                                {e.detail}
                              </span>
                            </li>
                          )
                        })}
                      </ol>

                      {accountingNotes(c).map((n, i) => (
                        <p key={i} className={clsx('mt-2 rounded border-l-2 px-3 py-2 text-xs', NOTE_TONE[n.tone])}>
                          {n.text}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* OCs sin factura */}
          {(data?.pending_ocs || []).length > 0 && (
            <div className="card p-4">
              <h2 className="text-sm font-semibold text-ink-primary mb-1">Órdenes de compra sin factura</h2>
              <p className="text-xs text-ink-muted mb-3">
                OCs del periodo que aún no tienen comprobante ligado — expedientes abiertos.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-ink-muted uppercase tracking-wide border-b border-line-subtle">
                      <th className="text-left py-2 font-medium">OC</th>
                      <th className="text-left py-2 font-medium">Fecha</th>
                      <th className="text-left py-2 font-medium">Proveedor</th>
                      <th className="text-left py-2 font-medium">Recepciones</th>
                      <th className="text-right py-2 font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pending_ocs.map(o => (
                      <tr key={o.order_number} className="border-b border-line-subtle/50 last:border-0">
                        <td className="py-2 font-mono text-xs text-brand-300">{o.order_number}</td>
                        <td className="py-2 text-xs text-ink-muted">{fmtDateOnly(o.date)}</td>
                        <td className="py-2 truncate">{o.partner_name}</td>
                        <td className="py-2 font-mono text-xs text-ink-secondary">{o.receipts || '(sin recepción)'}</td>
                        <td className="py-2 text-right font-mono tabular-nums">{money(o.total_mxn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
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
