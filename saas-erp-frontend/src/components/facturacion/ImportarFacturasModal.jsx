import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { invoicingApi } from '@/api/invoicing'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN } from '@/utils/fmt'

/**
 * Wizard de importación de facturas EMITIDAS en otro sistema (migración de
 * cartera): sube los XML timbrados, revisa el preview (cliente por RFC,
 * duplicados) y captura por factura PPD el saldo pendiente real y las
 * parcialidades de REP ya emitidas allá — así los complementos que timbre
 * este ERP continúan la numeración ante el SAT.
 *
 * Modal SIEMPRE via createPortal(document.body) — ver gotcha .page-enter.
 */
export function ImportarFacturasModal({ onClose, onImported }) {
  const [step, setStep] = useState('files')            // files → preview → done
  const [files, setFiles] = useState([])
  const [preview, setPreview] = useState(null)
  const [adjustments, setAdjustments] = useState({})   // uuid → { balance, installments }
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  const buildFormData = () => {
    const fd = new FormData()
    files.forEach(f => fd.append('files', f))
    return fd
  }

  const parse = useMutation({
    mutationFn: () => invoicingApi.importParse(buildFormData()),
    onSuccess: (data) => {
      setPreview(data)
      // Prellenar ajustes: saldo = total, parcialidades = 0.
      const adj = {}
      for (const r of data.rows) {
        if (r.status === 'ok') adj[r.uuid] = { balance: String(r.total), installments: '0' }
      }
      setAdjustments(adj)
      setError(null)
      setStep('preview')
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const doImport = useMutation({
    mutationFn: () => {
      const fd = buildFormData()
      fd.append('adjustments', JSON.stringify(adjustments))
      return invoicingApi.importConfirm(fd)
    },
    onSuccess: (data) => { setResult(data); setError(null); setStep('done'); onImported() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function pickFiles(e) {
    const picked = Array.from(e.target.files || [])
    if (picked.length) { setFiles(picked); setError(null) }
    e.target.value = ''
  }

  function setAdj(uuid, field, value) {
    setAdjustments(prev => ({ ...prev, [uuid]: { ...prev[uuid], [field]: value } }))
  }

  const okRows  = preview?.rows.filter(r => r.status === 'ok') || []
  const ppdRows = okRows.filter(r => r.metodoPago === 'PPD')

  const STATUS = {
    created:   ['badge-green', 'Importada'],
    ok:        ['badge-green', 'Lista'],
    duplicate: ['badge-blue',  'Ya existía'],
    error:     ['badge-red',   'Error'],
  }
  const StatusChip = ({ s }) => {
    const [cls, label] = STATUS[s] || ['badge-gray', s]
    return <span className={cls}>{label}</span>
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-4xl p-6 flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">⬆️ Importar facturas de otro sistema</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {step === 'files' && (
          <>
            <p className="text-sm text-ink-secondary">
              Sube los <strong>XML timbrados</strong> de facturas que <strong>tú emitiste</strong> en tu
              sistema anterior (acepta un <strong>.zip</strong> con varios). Se registran ya timbradas
              —sin volver a timbrar— y entran a cartera para gestionar su cobranza aquí. El cliente se
              empareja por RFC y se crea si no existe. Los UUID ya registrados no se duplican.
            </p>
            <input ref={inputRef} type="file" multiple accept=".xml,.zip,.pdf" className="hidden" onChange={pickFiles} />
            <button type="button" onClick={() => inputRef.current?.click()}
              className="border-2 border-dashed border-line rounded-lg p-6 text-center text-sm text-ink-muted hover:border-brand-500/60 hover:text-ink-secondary">
              {files.length
                ? <>{files.length} archivo(s) seleccionado(s) — <span className="underline">cambiar</span></>
                : <>Haz clic para elegir archivos (XML o ZIP, hasta 50)</>}
            </button>
            {files.length > 0 && (
              <ul className="text-xs text-ink-secondary max-h-40 overflow-y-auto flex flex-col gap-1">
                {files.map((f, i) => <li key={i} className="truncate font-mono">{f.name}</li>)}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
              <button type="button" onClick={() => parse.mutate()} disabled={!files.length || parse.isPending}
                className="btn-primary">
                {parse.isPending ? <Spinner size="sm" /> : 'Revisar archivos'}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && preview && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="badge-green">Listas para importar: {preview.summary.ok}</span>
              {preview.summary.duplicates > 0 && <span className="badge-blue">Ya existían: {preview.summary.duplicates}</span>}
              {preview.summary.errors > 0 && <span className="badge-red">Con error: {preview.summary.errors}</span>}
            </div>

            <div className="overflow-x-auto">
              <table className="table w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left">Folio</th>
                    <th className="text-left">Cliente (RFC receptor)</th>
                    <th className="text-right">Total</th>
                    <th className="text-left">Pago</th>
                    <th className="text-left">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs">
                        {[r.serie, r.folio].filter(Boolean).join('-') || r.filename}
                        {r.invoiceDate && <p className="text-[10px] text-ink-muted">{r.invoiceDate}</p>}
                      </td>
                      <td className="text-xs">
                        {r.receptor?.name || r.receptor?.rfc || '—'}
                        {r.status === 'ok' && (
                          <p className={r.matchedPartner ? 'text-[10px] text-ink-muted' : 'text-[10px] text-status-warning'}>
                            {r.matchedPartner ? `→ ${r.matchedPartner.name}` : 'Cliente nuevo: se creará automáticamente'}
                          </p>
                        )}
                      </td>
                      <td className="text-right font-mono tabular-nums text-xs">
                        {r.total ? fmtMXN(r.total, r.currency) : '—'}
                      </td>
                      <td className="text-xs">{r.metodoPago || '—'}</td>
                      <td>
                        <StatusChip s={r.status} />
                        {r.status === 'duplicate' && r.duplicateOf && (
                          <p className="text-[10px] text-ink-muted">como {r.duplicateOf}</p>
                        )}
                        {r.error && <p className="text-[10px] text-status-danger max-w-[16rem]">{r.error}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {ppdRows.length > 0 && (
              <div className="border border-status-warning/40 bg-status-warning/10 rounded-lg p-3 flex flex-col gap-2">
                <p className="text-sm text-ink-primary font-medium">
                  Facturas PPD (pago en parcialidades) — captura su estado real
                </p>
                <p className="text-xs text-ink-secondary">
                  Si ya recibiste abonos en el sistema anterior, indica el <strong>saldo pendiente</strong> y
                  cuántos <strong>complementos de pago (REP)</strong> ya se emitieron allá. Los cobros que
                  registres aquí timbrarán el siguiente REP continuando esa numeración ante el SAT.
                </p>
                <div className="overflow-x-auto">
                  <table className="table w-full text-sm">
                    <thead>
                      <tr>
                        <th className="text-left">Folio</th>
                        <th className="text-right">Total</th>
                        <th className="text-right">Saldo pendiente</th>
                        <th className="text-right">REPs ya emitidos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ppdRows.map(r => (
                        <tr key={r.uuid}>
                          <td className="font-mono text-xs">{[r.serie, r.folio].filter(Boolean).join('-')}</td>
                          <td className="text-right font-mono tabular-nums text-xs">{fmtMXN(r.total, r.currency)}</td>
                          <td className="text-right">
                            <input type="number" min="0" max={r.total} step="0.01"
                              className="input w-32 text-right font-mono"
                              value={adjustments[r.uuid]?.balance ?? ''}
                              onChange={e => setAdj(r.uuid, 'balance', e.target.value)} />
                          </td>
                          <td className="text-right">
                            <input type="number" min="0" step="1"
                              className="input w-20 text-right font-mono"
                              value={adjustments[r.uuid]?.installments ?? ''}
                              onChange={e => setAdj(r.uuid, 'installments', e.target.value)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep('files')} className="btn-ghost">Regresar</button>
              <button type="button" onClick={() => doImport.mutate()}
                disabled={!okRows.length || doImport.isPending}
                className="btn-primary">
                {doImport.isPending ? <Spinner size="sm" /> : `Importar ${okRows.length} factura(s)`}
              </button>
            </div>
          </>
        )}

        {step === 'done' && result && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="badge-green">Importadas: {result.summary.created}</span>
              {result.summary.duplicates > 0 && <span className="badge-blue">Ya existían: {result.summary.duplicates}</span>}
              {result.summary.errors > 0 && <span className="badge-red">Errores: {result.summary.errors}</span>}
              {result.summary.customersCreated > 0 && (
                <span className="badge-purple">Clientes creados: {result.summary.customersCreated}</span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="table w-full text-sm">
                <thead>
                  <tr><th className="text-left">Folio</th><th className="text-left">Resultado</th><th className="text-left">Detalle</th></tr>
                </thead>
                <tbody>
                  {result.results.map((r, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs">{r.documentNumber || [r.serie, r.folio].filter(Boolean).join('-') || r.filename}</td>
                      <td><StatusChip s={r.status} /></td>
                      <td className="text-xs text-ink-muted">
                        {r.status === 'error' ? <span className="text-status-danger">{r.error}</span>
                          : r.customerCreated ? 'Cliente creado automáticamente'
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => {
                setStep('files'); setFiles([]); setPreview(null); setResult(null); setAdjustments({})
              }} className="btn-secondary">Importar más</button>
              <button type="button" onClick={onClose} className="btn-primary">Listo</button>
            </div>
          </>
        )}

        {error && <div className="alert-error text-sm">{error}</div>}
      </div>
    </div>,
    document.body
  )
}
