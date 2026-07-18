import { useState, useRef, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fiscalDistributionApi } from '@/api/fiscalDistribution'
import Spinner from '@/components/ui/Spinner'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const DOC_META = {
  csf:     { label: 'Constancia de Situación Fiscal (CSF)', icon: '📄' },
  opinion: { label: 'Opinión de Cumplimiento (art. 32-D)',  icon: '📑' },
}

function openBlob(blob) {
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  // Revocar después de un rato para no romper la pestaña recién abierta.
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// ── Tarjeta de un documento (subir / reemplazar / ver / quitar) ──────────────
function DocCard({ docType, doc, onChanged }) {
  const meta = DOC_META[docType]
  const fileRef = useRef(null)
  const [error, setError] = useState(null)

  const uploadMut = useMutation({
    mutationFn: (file) => fiscalDistributionApi.uploadDoc(docType, file),
    onSuccess: () => { setError(null); onChanged() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al subir'),
  })
  const deleteMut = useMutation({
    mutationFn: () => fiscalDistributionApi.deleteDoc(docType),
    onSuccess: () => { setError(null); onChanged() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al quitar'),
  })

  async function handleView() {
    try {
      const blob = await fiscalDistributionApi.downloadDoc(docType)
      openBlob(blob)
    } catch (e) { setError('No se pudo abrir el documento.') }
  }

  return (
    <div className={clsx('rounded-lg border p-3 flex flex-col gap-2',
      doc ? 'border-status-success/40 bg-status-success/5' : 'border-line-subtle bg-surface-elevated/30')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-primary flex items-center gap-1.5">
            <span>{meta.icon}</span>{meta.label}
          </p>
          {doc ? (
            <p className="text-[11px] text-ink-muted mt-0.5 truncate">
              ✓ {doc.filename} · {fmtDate(doc.created_at)}
            </p>
          ) : (
            <p className="text-[11px] text-status-warning mt-0.5">Sin cargar</p>
          )}
        </div>
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => fileRef.current?.click()} disabled={uploadMut.isPending}
          className="btn-secondary btn-sm">
          {uploadMut.isPending ? <Spinner size="sm" /> : (doc ? 'Reemplazar' : '📤 Subir PDF')}
        </button>
        {doc && (
          <>
            <button onClick={handleView} className="btn-ghost btn-sm text-brand-300">Ver</button>
            <button onClick={() => { if (window.confirm(`¿Quitar ${meta.label}?`)) deleteMut.mutate() }}
              disabled={deleteMut.isPending}
              className="btn-ghost btn-sm text-status-danger">Quitar</button>
          </>
        )}
      </div>

      <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f); if (fileRef.current) fileRef.current.value = '' }} />
    </div>
  )
}

// ── Modal de envío ───────────────────────────────────────────────────────────
function SendModal({ docs, onClose, onSent }) {
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState(null) // Set de partnerIds; null = aún cargando
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const { data: preview, isLoading } = useQuery({
    queryKey: ['fiscal-preview'],
    queryFn: () => fiscalDistributionApi.preview(),
  })

  // Al cargar el preview, seleccionar todos por defecto.
  useEffect(() => {
    if (preview && selected === null) {
      setSelected(new Set(preview.clients.map(c => c.id)))
    }
  }, [preview, selected])

  const selectedClients = useMemo(
    () => (preview?.clients || []).filter(c => selected?.has(c.id)),
    [preview, selected])
  const recipientCount = selectedClients.reduce((n, c) => n + c.emails.length, 0)

  const sendMut = useMutation({
    mutationFn: () => {
      const all = preview.clients.length === selectedClients.length
      return fiscalDistributionApi.send({
        message: message.trim() || undefined,
        partnerIds: all ? undefined : selectedClients.map(c => c.id),
      })
    },
    onSuccess: (res) => { setResult(res); onSent?.() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const allChecked = preview && selected && selected.size === preview.clients.length
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(preview.clients.map(c => c.id)))
  }

  const docLabels = [docs.csf && DOC_META.csf.label, docs.opinion && DOC_META.opinion.label].filter(Boolean)

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">📧 Enviar documentos a clientes</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">✕</button>
        </div>

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="bg-status-success/10 border border-status-success/40 rounded-lg p-4 text-center">
              <p className="text-2xl">✓</p>
              <p className="text-sm font-semibold text-status-success mt-1">
                Enviado a {result.clientCount} cliente(s) · {result.recipientCount} correo(s)
              </p>
              {result.failedCount > 0 && (
                <p className="text-xs text-status-warning mt-1">
                  {result.failedCount} correo(s) fallaron al encolar. Revisa el historial.
                </p>
              )}
            </div>
            <button onClick={onClose} className="btn-primary w-full">Cerrar</button>
          </div>
        ) : (
          <>
            <div className="bg-brand-500/10 border border-brand-100 rounded-lg p-3 text-xs text-brand-300">
              Se enviará <strong>un correo individual por cliente</strong> (no se cruzan entre sí), a todos sus
              contactos con email, con estos adjuntos:
              <ul className="mt-1 ml-4 list-disc">{docLabels.map(l => <li key={l}>{l}</li>)}</ul>
            </div>

            {isLoading || selected === null ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : preview.clients.length === 0 ? (
              <p className="text-sm text-status-warning bg-status-warning/10 border border-status-warning/40 rounded-lg p-3">
                No hay clientes activos con contactos de correo. Agrega un contacto con email a tus clientes.
              </p>
            ) : (
              <>
                <div>
                  <label className="label">Mensaje (opcional)</label>
                  <textarea className="input min-h-[70px]" value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="Si lo dejas vacío, se usa un mensaje estándar." />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="label mb-0">Clientes ({selectedClients.length}/{preview.clients.length})</label>
                    <button onClick={toggleAll} className="text-xs text-brand-300 hover:underline">
                      {allChecked ? 'Quitar todos' : 'Seleccionar todos'}
                    </button>
                  </div>
                  <div className="border border-line-subtle rounded-lg max-h-52 overflow-y-auto divide-y divide-line-subtle">
                    {preview.clients.map(c => (
                      <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface-elevated/50">
                        <input type="checkbox" className="w-4 h-4 accent-brand-600"
                          checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                        <span className="flex-1 min-w-0 truncate text-ink-primary">{c.name}</span>
                        <span className="text-[11px] text-ink-muted">{c.emails.length} correo(s)</span>
                      </label>
                    ))}
                  </div>
                  {preview.clientsWithoutEmail.length > 0 && (
                    <p className="text-[11px] text-ink-muted mt-1">
                      {preview.clientsWithoutEmail.length} cliente(s) sin correo quedan fuera.
                    </p>
                  )}
                </div>

                {error && <p className="field-error">{error}</p>}

                <div className="flex gap-2 pt-1">
                  <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
                  <button onClick={() => { setError(null); sendMut.mutate() }}
                    disabled={sendMut.isPending || recipientCount === 0}
                    className="btn-primary flex-1">
                    {sendMut.isPending ? <Spinner size="sm" /> : `Enviar (${recipientCount} correo${recipientCount === 1 ? '' : 's'})`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Detalle de un envío (destinatarios) ──────────────────────────────────────
function SendDetailModal({ sendId, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['fiscal-send', sendId],
    queryFn: () => fiscalDistributionApi.getSend(sendId),
  })
  const STATUS = {
    queued: { label: 'Encolado', cls: 'text-status-info' },
    sent:   { label: 'Enviado',  cls: 'text-status-success' },
    failed: { label: 'Falló',    cls: 'text-status-danger' },
  }
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Destinatarios del envío</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">✕</button>
        </div>
        {isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-[60vh] overflow-y-auto">
            {(data?.recipients || []).map(r => (
              <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="text-ink-primary truncate">{r.partner_name}</p>
                  <p className="text-[11px] text-ink-muted truncate">{r.email}</p>
                </div>
                <span className={clsx('text-[11px] font-medium', (STATUS[r.status] || {}).cls)}>
                  {(STATUS[r.status] || {}).label || r.status}
                </span>
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} className="btn-secondary w-full">Cerrar</button>
      </div>
    </div>,
    document.body
  )
}

// ── Sección principal ────────────────────────────────────────────────────────
export default function FiscalDocsDistribution() {
  const qc = useQueryClient()
  const [showSend, setShowSend] = useState(false)
  const [detailId, setDetailId] = useState(null)

  const { data: docs, isLoading } = useQuery({
    queryKey: ['fiscal-docs'],
    queryFn: () => fiscalDistributionApi.getDocs(),
  })
  const { data: sends = [] } = useQuery({
    queryKey: ['fiscal-sends'],
    queryFn: () => fiscalDistributionApi.listSends(),
  })

  const refreshDocs = () => qc.invalidateQueries({ queryKey: ['fiscal-docs'] })
  const hasAnyDoc = docs && (docs.csf || docs.opinion)

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-ink-primary">📨 Documentos fiscales para clientes</h2>
        <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
          Sube tu <strong>CSF</strong> y tu <strong>Opinión de Cumplimiento (32-D)</strong> descargadas del SAT, y
          envíalas por correo a tus clientes. Se manda un correo individual por cliente a todos sus contactos con email.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <DocCard docType="csf"     doc={docs?.csf}     onChanged={refreshDocs} />
            <DocCard docType="opinion" doc={docs?.opinion} onChanged={refreshDocs} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => setShowSend(true)} disabled={!hasAnyDoc}
              className="btn-primary btn-sm"
              title={!hasAnyDoc ? 'Sube al menos un documento primero' : ''}>
              📧 Enviar a clientes
            </button>
            {!hasAnyDoc && (
              <span className="text-[11px] text-ink-muted">Sube al menos un documento para poder enviar.</span>
            )}
          </div>

          {/* Historial */}
          {sends.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink-secondary mb-1.5">Historial de envíos</p>
              <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
                {sends.slice(0, 10).map(s => (
                  <button key={s.id} onClick={() => setDetailId(s.id)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left hover:bg-surface-elevated/50">
                    <div className="min-w-0">
                      <p className="text-ink-primary truncate">
                        {s.client_count} cliente(s) · {s.recipient_count} correo(s)
                        {s.status === 'partial' && <span className="text-status-warning"> · con fallos</span>}
                      </p>
                      <p className="text-[11px] text-ink-muted">
                        {fmtDate(s.created_at)}{s.sent_by_name ? ` · ${s.sent_by_name}` : ''}
                      </p>
                    </div>
                    <span className="text-[11px] text-brand-300 shrink-0">Ver ›</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {showSend && docs && (
        <SendModal
          docs={docs}
          onClose={() => setShowSend(false)}
          onSent={() => { qc.invalidateQueries({ queryKey: ['fiscal-sends'] }) }}
        />
      )}
      {detailId && <SendDetailModal sendId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}
