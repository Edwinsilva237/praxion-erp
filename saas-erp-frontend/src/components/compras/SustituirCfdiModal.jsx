import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'
import clsx from 'clsx'

/**
 * Sustituye el CFDI de una factura de compra: el proveedor la canceló ante el
 * SAT y emitió una sustitución. Dos rutas para el CFDI nuevo:
 *  - "Ya está en el sistema": gastos sueltos del mismo proveedor (así caen los
 *    del buzón de correo), ordenados por cercanía de monto.
 *  - "Subir XML": se parsea aquí y se registra ligado a las mismas recepciones.
 * El backend hace todo en una transacción (cancelar vieja + CxP, traspasar
 * recepciones, alta/reclasificación de la nueva).
 */
export function SustituirCfdiModal({ invoice, onClose, onDone }) {
  const qc = useQueryClient()
  const [tab, setTab]           = useState('sistema')   // 'sistema' | 'xml'
  const [selectedId, setSel]    = useState(null)
  const [parsed, setParsed]     = useState(null)        // datos extraídos del XML
  const [files, setFiles]       = useState([])          // respaldo a adjuntar a la nueva
  const [reason, setReason]     = useState('')
  const [error, setError]       = useState(null)
  const [busy, setBusy]         = useState(false)       // parseando o sustituyendo
  const [result, setResult]     = useState(null)        // éxito → resumen

  const { data: candidates = [], isLoading: loadingCand } = useQuery({
    queryKey: ['substitute-candidates', invoice.id],
    queryFn:  () => purchasesApi.substituteCandidates(invoice.id),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  async function parseFile(file) {
    if (!file) return
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await purchasesApi.parseDocument(form)
      if (!data?.total) throw new Error('No se pudieron extraer los montos del documento.')
      setParsed(data)
      setFiles([file])
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al procesar el documento')
    } finally { setBusy(false) }
  }

  const parsedRfc  = (parsed?.emisor?.rfc || '').toUpperCase().replace(/\s+/g, '')
  const partnerRfc = (invoice.partner_rfc || invoice.rfc_emisor || '').toUpperCase().replace(/\s+/g, '')
  const rfcMismatch = !!(parsedRfc && partnerRfc && parsedRfc !== partnerRfc)
  const sameUuid    = !!(parsed?.uuid && invoice.uuid_sat && parsed.uuid === invoice.uuid_sat)

  const canSubmit = !busy && (
    tab === 'sistema' ? !!selectedId
                      : (!!parsed && !rfcMismatch && !sameUuid)
  )

  async function handleSubmit() {
    setBusy(true); setError(null)
    try {
      let body
      if (tab === 'sistema') {
        body = { newExpenseId: selectedId, reason: reason.trim() || null }
      } else {
        const folio = [parsed.serie, parsed.folio].filter(Boolean).join('-')
                   || parsed.uuid?.slice(-8) || 'SIN-FOLIO'
        body = {
          reason: reason.trim() || null,
          invoice: {
            documentNumber: folio,
            uuidSat:      parsed.uuid || null,
            serie:        parsed.serie || null,
            folio:        parsed.folio || null,
            rfcEmisor:    parsed.emisor?.rfc || null,
            invoiceDate:  parsed.invoiceDate || null,
            currency:     parsed.currency || 'MXN',
            subtotal:     parsed.subtotal || 0,
            tax:          parsed.tax || 0,
            total:        parsed.total || 0,
            metodoPagoSat: parsed.metodoPago || null,
          },
        }
      }
      const res = await purchasesApi.substituteInvoice(invoice.id, body)

      // Respaldo del XML en la factura nueva (best-effort, como en el alta normal).
      if (tab === 'xml' && files.length && res?.new?.id) {
        for (const f of files) {
          try {
            const fd = new FormData()
            fd.append('file', f)
            await purchasesApi.addInvoiceAttachment(res.new.id, fd)
          } catch { /* opcional; se puede adjuntar después desde el detalle */ }
        }
      }

      qc.invalidateQueries({ queryKey: ['purchase-invoices'] })
      qc.invalidateQueries({ queryKey: ['purchase-invoice-detail'] })
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['receipts-pending'] })
      qc.invalidateQueries({ queryKey: ['accounts-payable'] })
      qc.invalidateQueries({ queryKey: ['expenses'] })
      setResult(res)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'No se pudo sustituir el CFDI')
    } finally { setBusy(false) }
  }

  // ── Éxito: resumen y cerrar ──
  if (result) {
    return createPortal(
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
        <div className="card w-full max-w-md p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
            <h3 className="text-base font-semibold text-ink-primary">CFDI sustituido</h3>
          </div>
          <div className="bg-surface-elevated/60 border border-line-subtle rounded-lg px-3 py-2 text-sm flex flex-col gap-1">
            <p><span className="text-ink-muted">Cancelada:</span>{' '}
              <span className="font-mono">{result.old.invoice_number}</span></p>
            <p><span className="text-ink-muted">Sustituta:</span>{' '}
              <span className="font-mono font-semibold text-brand-300">{result.new.invoice_number}</span></p>
            <p className="text-xs text-ink-muted">
              {result.receiptIds?.length
                ? `${result.receiptIds.length} recepción(es) traspasada(s) y CxP regenerada.`
                : 'Sin recepciones ligadas; CxP regenerada.'}
            </p>
          </div>
          <button onClick={() => { onDone?.(result); onClose() }} className="btn-primary">Listo</button>
        </div>
      </div>,
      document.body
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-5 max-h-[92vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-ink-primary">
              Sustituir CFDI — {invoice.invoice_number}
            </h3>
            <p className="text-xs text-ink-muted mt-0.5">
              Para cuando el proveedor canceló esta factura ante el SAT y emitió una sustitución.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0" disabled={busy}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
          <p className="text-xs text-status-warning">
            Esta factura se <strong>cancelará</strong> en el sistema (junto con su CxP) y sus
            recepciones pasarán al CFDI sustituto. El inventario y el costeo no se tocan.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line-subtle">
          {[['sistema', 'Ya está en el sistema'], ['xml', 'Subir XML']].map(([key, label]) => (
            <button key={key} type="button" onClick={() => { setTab(key); setError(null) }}
              className={clsx(
                'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === key ? 'border-brand-600 text-brand-300' : 'border-transparent text-ink-muted hover:text-ink-secondary'
              )}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'sistema' ? (
          loadingCand ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : candidates.length === 0 ? (
            <div className="text-center py-6 flex flex-col gap-2">
              <p className="text-sm text-ink-muted">
                No hay CFDI de <strong>{invoice.partner_name}</strong> sin vincular en el sistema.
              </p>
              <p className="text-xs text-ink-muted">
                Si tienes el XML de la sustitución, súbelo en la pestaña &quot;Subir XML&quot;.
              </p>
            </div>
          ) : (
            <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-64 overflow-y-auto">
              {candidates.map(c => (
                <label key={c.id}
                  className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-surface-elevated/40">
                  <input type="radio" name="cand" className="mt-1 accent-brand-600"
                    checked={selectedId === c.id} onChange={() => setSel(c.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono font-semibold text-ink-primary">{c.invoice_number}</span>
                      {c.references_old_uuid && (
                        <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-status-success/15 text-status-success">
                          Sustitución detectada
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">
                      {fmtDateOnly(c.invoice_date)} · {fmtMXN(c.total, c.currency)}
                      {c.uuid_sat && <span className="font-mono"> · …{c.uuid_sat.slice(-12)}</span>}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3">
            {!parsed ? (
              <label className={clsx(
                'border-2 border-dashed border-line-subtle rounded-xl p-8 text-center cursor-pointer',
                'hover:border-brand-500/40 hover:bg-surface-elevated/40 transition-colors flex flex-col items-center gap-2',
                busy && 'opacity-50 pointer-events-none'
              )}>
                <input type="file" accept=".xml,.pdf,.zip" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; parseFile(f) }} />
                {busy ? <Spinner /> : (
                  <>
                    <svg className="w-8 h-8 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    <p className="text-sm font-medium text-ink-secondary">Sube el XML de la sustitución</p>
                    <p className="text-xs text-ink-muted">CFDI 4.0 (.xml), PDF o .zip del proveedor</p>
                  </>
                )}
              </label>
            ) : (
              <div className="border border-line-subtle rounded-xl p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">CFDI sustituto</p>
                  <button type="button" onClick={() => { setParsed(null); setFiles([]) }}
                    className="text-xs text-ink-muted hover:text-ink-secondary">Cambiar archivo</button>
                </div>
                <p className="text-sm font-medium text-ink-primary">
                  {parsed.emisor?.name || '—'} <span className="text-ink-muted font-normal">({parsed.emisor?.rfc || 'sin RFC'})</span>
                </p>
                <p className="text-xs text-ink-muted">
                  Folio: {[parsed.serie, parsed.folio].filter(Boolean).join('-') || '—'}
                  {' · '}{fmtDateOnly(parsed.invoiceDate)}
                  {' · '}<span className="font-semibold text-ink-secondary">{fmtMXN(parsed.total, parsed.currency)}</span>
                </p>
                {parsed.uuid && <p className="text-[11px] font-mono text-ink-muted break-all">UUID: {parsed.uuid}</p>}
                {rfcMismatch && (
                  <p className="text-xs text-status-danger">
                    El RFC del XML no coincide con el del proveedor ({partnerRfc}). Verifica el archivo.
                  </p>
                )}
                {sameUuid && (
                  <p className="text-xs text-status-danger">
                    Este XML es el mismo CFDI que estás sustituyendo (mismo UUID).
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="label">Motivo (opcional)</label>
          <input className="input" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Ej. error en precio unitario; el proveedor re-facturó" />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={busy}>Cancelar</button>
          <button onClick={handleSubmit} className="btn-primary flex-1" disabled={!canSubmit}>
            {busy ? <Spinner size="sm" /> : 'Sustituir'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default SustituirCfdiModal
