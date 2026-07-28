import { useState, useMemo, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { invoicingApi } from '@/api/invoicing'
import { partnersApi } from '@/api/partners'
import { useDebounced } from '@/hooks/useDebounced'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import CollapsibleFilters from '@/components/ui/CollapsibleFilters'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'
import { downloadBlob } from '@/utils/downloadBlob'

const PAGE_SIZE = 25

const STATUS = {
  stamped:   { label: 'Timbrada',  variant: 'green' },
  cancelled: { label: 'Cancelada', variant: 'red'   },
  draft:     { label: 'Borrador',  variant: 'gray'  },
}

/**
 * Notas de crédito (CFDI tipo E) emitidas — pantalla propia, separada de
 * Facturación. Cada NC liga a su factura origen (related_invoice_id) y se
 * pueden descargar XML/PDF directo. La EMISIÓN sigue donde el contexto vive:
 * el detalle de la factura (botón "Nota de crédito") o una devolución de venta.
 */
export default function NotasCredito() {
  const [partner, setPartner] = useState(null)
  const [search, setSearch]   = useState('')
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')
  const [page, setPage]       = useState(1)
  const [error, setError]     = useState(null)
  const [busyId, setBusyId]   = useState(null)

  const searchDebounced = useDebounced(search, 300)
  useEffect(() => { setPage(1) }, [partner, from, to, searchDebounced])

  const queryParams = useMemo(() => {
    const p = { cfdiType: 'E', page, limit: PAGE_SIZE }
    if (partner?.id) p.partnerId = partner.id
    if (from)        p.from      = from
    if (to)          p.to        = to
    if (searchDebounced.trim()) p.search = searchDebounced.trim()
    return p
  }, [partner, from, to, searchDebounced, page])

  const { data, isLoading } = useQuery({
    queryKey: ['credit-notes', queryParams],
    queryFn:  () => invoicingApi.list(queryParams),
    keepPreviousData: true,
  })
  const rows  = data?.data || []
  const total = data?.total || 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const download = async (cn, kind) => {
    setError(null); setBusyId(cn.id + kind)
    try {
      const r = kind === 'xml'
        ? await invoicingApi.downloadNcXml(cn.id)
        : await invoicingApi.downloadNcPdf(cn.id)
      await downloadBlob(r.data, `${cn.document_number}.${kind}`)
    } catch (e) {
      setError(e.response?.data?.error || `No se pudo descargar el ${kind.toUpperCase()}.`)
    } finally { setBusyId(null) }
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <h1 className="page-title text-xl font-semibold text-ink-primary">Notas de crédito</h1>
        <p className="page-subtitle text-xs text-ink-muted mt-0.5">
          CFDI tipo E emitidos (devoluciones, descuentos, correcciones). Se emiten desde el
          detalle de la factura o desde una devolución de venta.
        </p>
      </div>

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      <CollapsibleFilters>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input className="input" placeholder="Buscar folio, UUID, cliente..."
            value={search} onChange={e => setSearch(e.target.value)} />
          <Autocomplete value={partner} onChange={setPartner} onSearch={searchPartners}
            placeholder="Cliente..." />
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} />
        </div>
      </CollapsibleFilters>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 py-16 text-center">
          <p className="font-medium text-ink-secondary">Sin notas de crédito</p>
          <p className="text-sm text-ink-muted">
            Emite una desde el detalle de una factura timbrada o desde una devolución de venta.
          </p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th><th>Cliente</th><th>Factura origen</th><th>Fecha</th>
                <th>Estado</th><th className="text-right">Total</th><th className="text-right">Descargar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(cn => (
                <tr key={cn.id}>
                  <td className="font-mono text-xs text-brand-300">
                    {cn.document_number}
                    {cn.cfdi_uuid && (
                      <span className="block text-[10px] text-ink-muted truncate max-w-[220px]">{cn.cfdi_uuid}</span>
                    )}
                  </td>
                  <td className="text-sm">{cn.partner_name}</td>
                  <td className="font-mono text-xs">
                    {cn.related_invoice_id ? (
                      <Link to={`/facturacion/${cn.related_invoice_id}`}
                        className="text-brand-300 hover:underline">
                        {cn.related_invoice_number || 'Ver factura'}
                      </Link>
                    ) : <span className="text-ink-muted">—</span>}
                  </td>
                  <td className="text-sm text-ink-secondary">{fmtDateOnly(cn.issue_date)}</td>
                  <td><Badge {...(STATUS[cn.status] || STATUS.draft)} /></td>
                  <td className="text-right font-mono text-sm">{fmtMXN(cn.total)}</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost text-xs" disabled={busyId === cn.id + 'pdf'}
                      onClick={() => download(cn, 'pdf')}>
                      {busyId === cn.id + 'pdf' ? <Spinner size="sm" /> : 'PDF'}
                    </button>
                    <button className="btn-ghost text-xs" disabled={busyId === cn.id + 'xml'}
                      onClick={() => download(cn, 'xml')}>
                      {busyId === cn.id + 'xml' ? <Spinner size="sm" /> : 'XML'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Anterior</button>
          <span className="text-ink-muted">Página {page} de {pages}</span>
          <button className="btn-secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Siguiente</button>
        </div>
      )}
    </div>
  )
}
