import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { communicationsApi } from '@/api/communications'
import Spinner from '@/components/ui/Spinner'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Sugerencias por defecto si el tenant aún no configuró sus propias categorías.
const DEFAULT_CATEGORIES = ['Vacaciones / cierre', 'Ajuste de precios', 'Personal (alta/baja)', 'General']

function fmtBytes(n) {
  if (!n) return '0 KB'
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
function openBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.target = '_blank'; a.rel = 'noopener'
  if (filename) a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

// Estado del batch de envío (barra de progreso en el historial).
const SEND_STATUS = {
  queued:    { label: 'En cola',   cls: 'text-status-info' },
  sending:   { label: 'Enviando',  cls: 'text-status-info' },
  completed: { label: 'Enviado',   cls: 'text-status-success' },
  partial:   { label: 'Con fallos', cls: 'text-status-warning' },
}
const isInProgress = (s) => s?.status === 'queued' || s?.status === 'sending'

// ── Lista de audiencia (clientes o proveedores) con búsqueda + seleccionar todos ──
function AudienceList({ title, items, selected, onToggle, onSelectAll, emptyLabel }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(
    () => items.filter(i => i.name.toLowerCase().includes(q.trim().toLowerCase())),
    [items, q])
  const allSel = items.length > 0 && items.every(i => selected.has(i.id))

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="label mb-0">{title} ({[...selected].length}/{items.length})</label>
        {items.length > 0 && (
          <button type="button" onClick={() => onSelectAll(!allSel)} className="text-xs text-brand-300 hover:underline">
            {allSel ? 'Quitar todos' : 'Seleccionar todos'}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-ink-muted bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2">
          {emptyLabel}
        </p>
      ) : (
        <>
          {items.length > 6 && (
            <input className="input input-sm mb-1" placeholder="Buscar…" value={q} onChange={e => setQ(e.target.value)} />
          )}
          <div className="border border-line-subtle rounded-lg max-h-44 overflow-y-auto divide-y divide-line-subtle">
            {filtered.map(i => (
              <label key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface-elevated/50">
                <input type="checkbox" className="w-4 h-4 accent-brand-600"
                  checked={selected.has(i.id)} onChange={() => onToggle(i.id)} />
                <span className="flex-1 min-w-0 truncate text-ink-primary">{i.name}</span>
                <span className="text-[11px] text-ink-muted">{i.emails.length} correo(s)</span>
              </label>
            ))}
            {filtered.length === 0 && <p className="text-[11px] text-ink-muted px-3 py-2">Sin coincidencias.</p>}
          </div>
        </>
      )}
    </div>
  )
}

// ── Modal de composición ────────────────────────────────────────────────────
function ComposerModal({ onClose, onSent }) {
  const [subject, setSubject]   = useState('')
  const [category, setCategory] = useState('')
  const [message, setMessage]   = useState('')
  const [manualRaw, setManualRaw] = useState('')
  const [files, setFiles]       = useState([])
  const [selClients, setSelClients]     = useState(new Set())
  const [selSuppliers, setSelSuppliers] = useState(new Set())
  const [error, setError]   = useState(null)
  const [result, setResult] = useState(null)
  const [saveTplOpen, setSaveTplOpen] = useState(false)
  const [tplName, setTplName] = useState('')

  const qc = useQueryClient()
  const { data: rec, isLoading } = useQuery({
    queryKey: ['comm-recipients'],
    queryFn: () => communicationsApi.getRecipients(),
  })
  const { data: templates = [] } = useQuery({
    queryKey: ['comm-templates'],
    queryFn: () => communicationsApi.listTemplates(),
  })
  const { data: categories = [] } = useQuery({
    queryKey: ['comm-categories', 'active'],
    queryFn: () => communicationsApi.listCategories(true),
  })

  // Sugerencias del datalist: las categorías del tenant + las por defecto que falten.
  const catSuggestions = useMemo(() => {
    const tenant = categories.map(c => c.name)
    const lower = new Set(tenant.map(n => n.toLowerCase()))
    return [...tenant, ...DEFAULT_CATEGORIES.filter(d => !lower.has(d.toLowerCase()))]
  }, [categories])

  const manualEmails = useMemo(() => {
    const seen = new Set(); const out = []
    for (const t of manualRaw.split(/[\s,;]+/)) {
      const e = t.trim().toLowerCase()
      if (e && EMAIL_RE.test(e) && !seen.has(e)) { seen.add(e); out.push(e) }
    }
    return out
  }, [manualRaw])
  const manualHasInvalid = useMemo(
    () => manualRaw.split(/[\s,;]+/).some(t => t.trim() && !EMAIL_RE.test(t.trim())), [manualRaw])

  const clients   = rec?.clients   || []
  const suppliers = rec?.suppliers || []
  const emailsOf = (list, sel) => list.filter(i => sel.has(i.id)).reduce((n, i) => n + i.emails.length, 0)
  const approxCount = emailsOf(clients, selClients) + emailsOf(suppliers, selSuppliers) + manualEmails.length
  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const tooBig = totalBytes > 20 * 1024 * 1024

  function toggle(setter) {
    return (id) => setter(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function selectAll(list, setter) {
    return (all) => setter(all ? new Set(list.map(i => i.id)) : new Set())
  }
  function addFiles(fileList) {
    const incoming = Array.from(fileList || [])
    setFiles(prev => [...prev, ...incoming].slice(0, 10))
  }
  function loadTemplate(id) {
    const t = templates.find(x => x.id === id)
    if (!t) return
    setSubject(t.subject || ''); setMessage(t.message || ''); setCategory(t.category || '')
  }

  const saveTplMut = useMutation({
    mutationFn: () => communicationsApi.createTemplate({
      name: tplName.trim(), subject: subject.trim(), message: message.trim(), category: category.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['comm-templates'] })
      setSaveTplOpen(false); setTplName('')
    },
    onError: (e) => setError(e.response?.data?.error || 'No se pudo guardar la plantilla'),
  })

  const sendMut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('subject', subject.trim())
      if (message.trim())  fd.append('message', message.trim())
      if (category.trim()) fd.append('category', category.trim())
      fd.append('clientIds',   JSON.stringify([...selClients]))
      fd.append('supplierIds', JSON.stringify([...selSuppliers]))
      if (manualEmails.length) fd.append('manualEmails', manualEmails.join(','))
      files.forEach(f => fd.append('files', f))
      return communicationsApi.send(fd)
    },
    onSuccess: (res) => { setResult(res); onSent?.() },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  const canSend = subject.trim() && approxCount > 0 && !tooBig

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">📣 Nuevo comunicado</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">✕</button>
        </div>

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="bg-status-success/10 border border-status-success/40 rounded-lg p-4 text-center">
              <p className="text-2xl">✓</p>
              <p className="text-sm font-semibold text-status-success mt-1">
                {result.queued ? 'Enviando en segundo plano' : 'Enviado'} · {result.recipientCount} correo(s)
              </p>
              <p className="text-xs text-ink-muted mt-0.5">
                {result.clientCount} cliente(s) · {result.supplierCount} proveedor(es)
                {result.manualCount > 0 && ` · ${result.manualCount} manual(es)`}
              </p>
              {result.queued && (
                <p className="text-[11px] text-ink-muted mt-1">
                  Puedes cerrar esta ventana. El progreso aparece en el historial.
                </p>
              )}
              {result.failedCount > 0 && (
                <p className="text-xs text-status-warning mt-1">{result.failedCount} correo(s) fallaron. Revisa el historial.</p>
              )}
            </div>
            <button onClick={onClose} className="btn-primary w-full">Cerrar</button>
          </div>
        ) : isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <>
            {/* Cargar plantilla */}
            {templates.length > 0 && (
              <div>
                <label className="label">Cargar plantilla</label>
                <select className="input" defaultValue="" onChange={e => { loadTemplate(e.target.value); e.target.value = '' }}>
                  <option value="" disabled>Elige una plantilla guardada…</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="label">Asunto *</label>
              <input className="input" value={subject} onChange={e => setSubject(e.target.value)}
                placeholder="Ej: Cierre por vacaciones del 15 al 30 de diciembre" />
            </div>

            <div>
              <label className="label">Categoría (opcional)</label>
              <input className="input" list="comm-cats" value={category} onChange={e => setCategory(e.target.value)}
                placeholder="Vacaciones, precios, personal…" />
              <datalist id="comm-cats">{catSuggestions.map(c => <option key={c} value={c} />)}</datalist>
            </div>

            <div>
              <label className="label">Mensaje</label>
              <textarea className="input min-h-[90px]" value={message} onChange={e => setMessage(e.target.value)}
                placeholder="Escribe el aviso. Se envía con el logo y color de tu marca." />
            </div>

            {/* Guardar como plantilla */}
            <div>
              {saveTplOpen ? (
                <div className="flex items-center gap-2">
                  <input className="input input-sm flex-1" placeholder="Nombre de la plantilla" value={tplName}
                    onChange={e => setTplName(e.target.value)} />
                  <button onClick={() => saveTplMut.mutate()} disabled={!tplName.trim() || saveTplMut.isPending}
                    className="btn-primary btn-sm">Guardar</button>
                  <button onClick={() => { setSaveTplOpen(false); setTplName('') }} className="btn-secondary btn-sm">✕</button>
                </div>
              ) : (
                <button onClick={() => setSaveTplOpen(true)} disabled={!subject.trim() && !message.trim()}
                  className="text-xs text-brand-300 hover:underline disabled:opacity-40 disabled:no-underline">
                  💾 Guardar como plantilla
                </button>
              )}
            </div>

            {/* Adjuntos */}
            <div>
              <label className="label">Adjuntos (opcional, hasta 10)</label>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="btn-secondary btn-sm cursor-pointer">
                  + Agregar archivos
                  <input type="file" multiple className="hidden"
                    onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
                </label>
                {files.length > 0 && (
                  <span className={clsx('text-[11px]', tooBig ? 'text-status-danger' : 'text-ink-muted')}>
                    {files.length} archivo(s) · {fmtBytes(totalBytes)} {tooBig && '(supera 20 MB)'}
                  </span>
                )}
              </div>
              {files.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 text-xs bg-surface-elevated/40 border border-line-subtle rounded px-2.5 py-1.5">
                      <span className="truncate text-ink-primary">{f.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-ink-muted">{fmtBytes(f.size)}</span>
                        <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                          className="text-status-danger hover:underline">Quitar</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Audiencia */}
            <div className="bg-brand-500/10 border border-brand-100 rounded-lg p-3 text-[11px] text-brand-300">
              Se envía <strong>un correo individual por destinatario</strong> (no se cruzan entre sí).
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <AudienceList title="Clientes" items={clients} selected={selClients}
                onToggle={toggle(setSelClients)} onSelectAll={selectAll(clients, setSelClients)}
                emptyLabel="Sin clientes con correo. Puedes usar correos manuales." />
              <AudienceList title="Proveedores" items={suppliers} selected={selSuppliers}
                onToggle={toggle(setSelSuppliers)} onSelectAll={selectAll(suppliers, setSelSuppliers)}
                emptyLabel="Sin proveedores con correo. Puedes usar correos manuales." />
            </div>

            <div>
              <label className="label">Para — correos manuales (opcional)</label>
              <textarea className="input min-h-[48px]" value={manualRaw} onChange={e => setManualRaw(e.target.value)}
                placeholder="correo1@dominio.com, correo2@dominio.com" />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px] text-ink-muted">
                  Separa por coma, espacio o salto de línea.{manualEmails.length > 0 && ` ${manualEmails.length} válido(s).`}
                </span>
                {manualHasInvalid && <span className="text-[11px] text-status-warning">Hay correos inválidos (se ignoran).</span>}
              </div>
            </div>

            {error && <p className="field-error">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
              <button onClick={() => { setError(null); sendMut.mutate() }}
                disabled={sendMut.isPending || !canSend}
                className="btn-primary flex-1">
                {sendMut.isPending ? <Spinner size="sm" /> : `Enviar${approxCount > 0 ? ` (~${approxCount})` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Gestión de categorías ────────────────────────────────────────────────────
function CategoriesModal({ onClose }) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')

  const { data: cats = [], isLoading } = useQuery({
    queryKey: ['comm-categories', 'all'],
    queryFn: () => communicationsApi.listCategories(false),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['comm-categories'] })
  const onErr = (e) => setError(e.response?.data?.error || 'Error')

  const createMut = useMutation({
    mutationFn: () => communicationsApi.createCategory({ name: newName.trim(), sortOrder: cats.length }),
    onSuccess: () => { setNewName(''); setError(null); invalidate() }, onError: onErr,
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => communicationsApi.updateCategory(id, data),
    onSuccess: () => { setEditId(null); setError(null); invalidate() }, onError: onErr,
  })
  const deleteMut = useMutation({
    mutationFn: (id) => communicationsApi.deleteCategory(id),
    onSuccess: invalidate, onError: onErr,
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6 flex flex-col gap-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">🏷️ Categorías</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">✕</button>
        </div>
        <p className="text-[11px] text-ink-muted">
          Las categorías clasifican tus comunicados y alimentan el selector al componer. No cambian el correo.
        </p>

        <div className="flex items-center gap-2">
          <input className="input input-sm flex-1" placeholder="Nueva categoría" value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) createMut.mutate() }} />
          <button onClick={() => createMut.mutate()} disabled={!newName.trim() || createMut.isPending}
            className="btn-primary btn-sm">Agregar</button>
        </div>
        {error && <p className="field-error">{error}</p>}

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : cats.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-6">Sin categorías. Se usan las sugeridas por defecto.</p>
        ) : (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
            {cats.map(c => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                {editId === c.id ? (
                  <>
                    <input className="input input-sm flex-1" value={editName} onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && editName.trim()) updateMut.mutate({ id: c.id, data: { name: editName.trim() } }) }} autoFocus />
                    <button onClick={() => updateMut.mutate({ id: c.id, data: { name: editName.trim() } })}
                      disabled={!editName.trim()} className="text-brand-300 text-xs hover:underline">Guardar</button>
                    <button onClick={() => setEditId(null)} className="text-ink-muted text-xs hover:underline">✕</button>
                  </>
                ) : (
                  <>
                    <span className={clsx('flex-1 min-w-0 truncate', c.is_active ? 'text-ink-primary' : 'text-ink-muted line-through')}>
                      {c.name}
                    </span>
                    <button onClick={() => updateMut.mutate({ id: c.id, data: { isActive: !c.is_active } })}
                      className="text-[11px] text-ink-muted hover:text-ink-primary" title={c.is_active ? 'Ocultar' : 'Mostrar'}>
                      {c.is_active ? '👁️' : '🚫'}
                    </button>
                    <button onClick={() => { setEditId(c.id); setEditName(c.name) }}
                      className="text-[11px] text-brand-300 hover:underline">Editar</button>
                    <button onClick={() => deleteMut.mutate(c.id)}
                      className="text-[11px] text-status-danger hover:underline">Borrar</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} className="btn-secondary w-full mt-1">Cerrar</button>
      </div>
    </div>,
    document.body
  )
}

// ── Detalle de un envío ─────────────────────────────────────────────────────
const R_STATUS = {
  queued: { label: 'En cola',  cls: 'text-status-info' },
  sent:   { label: 'Enviado',  cls: 'text-status-success' },
  failed: { label: 'Falló',    cls: 'text-status-danger' },
}
const T_LABEL = { customer: 'Cliente', supplier: 'Proveedor', manual: 'Manual' }

function SendDetailModal({ sendId, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['comm-send', sendId],
    queryFn: () => communicationsApi.getSend(sendId),
    // Refrescar mientras el envío esté en curso (barra de progreso viva).
    refetchInterval: (q) => isInProgress(q.state.data) ? 2500 : false,
  })
  async function download(att) {
    const blob = await communicationsApi.downloadAttachment(sendId, att.id)
    openBlob(blob, att.filename)
  }
  const pct = data && data.recipient_count
    ? Math.round((Number(data.sent_count || 0) / data.recipient_count) * 100) : 0
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary truncate">{data?.subject || 'Comunicado'}</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary shrink-0">✕</button>
        </div>
        {isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : (
          <>
            {isInProgress(data) && (
              <div>
                <div className="flex items-center justify-between text-[11px] text-ink-muted mb-1">
                  <span>Enviando en segundo plano…</span>
                  <span>{data.sent_count || 0}/{data.recipient_count}</span>
                </div>
                <div className="h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {data?.message && (
              <p className="text-sm text-ink-secondary whitespace-pre-wrap bg-surface-elevated/40 border border-line-subtle rounded-lg p-3">{data.message}</p>
            )}
            {data?.attachments?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-secondary mb-1">Adjuntos</p>
                <div className="flex flex-col gap-1">
                  {data.attachments.map(a => (
                    <button key={a.id} onClick={() => download(a)}
                      className="flex items-center justify-between gap-2 text-xs text-brand-300 hover:underline bg-surface-elevated/40 border border-line-subtle rounded px-2.5 py-1.5">
                      <span className="truncate">{a.filename}</span>
                      <span className="text-ink-muted shrink-0">{fmtBytes(a.file_size_bytes)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs font-semibold text-ink-secondary">Destinatarios ({data?.recipients?.length || 0})</p>
            <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-[50vh] overflow-y-auto">
              {(data?.recipients || []).map(r => (
                <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="text-ink-primary truncate">{r.partner_name || T_LABEL[r.partner_type] || '—'}</p>
                    <p className="text-[11px] text-ink-muted truncate">{r.email} · {T_LABEL[r.partner_type] || r.partner_type}</p>
                  </div>
                  <span className={clsx('text-[11px] font-medium shrink-0', (R_STATUS[r.status] || {}).cls)}>
                    {(R_STATUS[r.status] || {}).label || r.status}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        <button onClick={onClose} className="btn-secondary w-full">Cerrar</button>
      </div>
    </div>,
    document.body
  )
}

// ── Fila del historial con progreso ──────────────────────────────────────────
function SendRow({ s, onClick }) {
  const st = SEND_STATUS[s.status] || {}
  const inProgress = isInProgress(s)
  const pct = s.recipient_count ? Math.round((Number(s.sent_count || 0) / s.recipient_count) * 100) : 0
  return (
    <button onClick={onClick}
      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-left hover:bg-surface-elevated/50">
      <div className="min-w-0 flex-1">
        <p className="text-ink-primary truncate font-medium">{s.subject}</p>
        <p className="text-[11px] text-ink-muted truncate">
          {fmtDate(s.created_at)} · {s.recipient_count} correo(s)
          {s.attachment_count > 0 && ` · ${s.attachment_count} adjunto(s)`}
          {s.category && ` · ${s.category}`}
        </p>
        {inProgress && (
          <div className="mt-1.5 h-1 bg-surface-elevated rounded-full overflow-hidden max-w-[220px]">
            <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {inProgress
          ? <span className="text-[11px] text-status-info">{s.sent_count || 0}/{s.recipient_count}</span>
          : Number(s.failed_count) > 0 && <span className="text-[11px] text-status-warning">{s.failed_count} falló</span>}
        <span className={clsx('text-[11px]', st.cls || 'text-ink-muted')}>{st.label || s.status}</span>
        <span className="text-[11px] text-brand-300">Ver ›</span>
      </div>
    </button>
  )
}

// ── Página ──────────────────────────────────────────────────────────────────
export default function Comunicados() {
  const qc = useQueryClient()
  const [showComposer, setShowComposer] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [filterCat, setFilterCat] = useState('')

  const { data: sends = [], isLoading } = useQuery({
    queryKey: ['comm-sends', filterCat],
    queryFn: () => communicationsApi.listSends(filterCat || undefined),
    // Mientras algún envío esté en curso, refrescar para animar la barra.
    refetchInterval: (q) => (q.state.data || []).some(isInProgress) ? 2500 : false,
  })
  const { data: categories = [] } = useQuery({
    queryKey: ['comm-categories', 'all'],
    queryFn: () => communicationsApi.listCategories(false),
  })

  // Categorías disponibles para filtrar = configuradas + las ya usadas en envíos.
  const filterOptions = useMemo(() => {
    const set = new Set(categories.map(c => c.name))
    for (const s of sends) if (s.category) set.add(s.category)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [categories, sends])

  return (
    <div className="page-enter max-w-3xl mx-auto flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">📣 Comunicados</h1>
          <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">
            Envía avisos por correo a tus clientes y proveedores (vacaciones, ajustes de precios, cambios de
            personal…), con archivos adjuntos. Sale con el logo y color de tu marca.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowCategories(true)} className="btn-secondary btn-sm">🏷️ Categorías</button>
          <button onClick={() => setShowComposer(true)} className="btn-primary btn-sm">📣 Nuevo comunicado</button>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-semibold text-ink-secondary">Historial de comunicados</p>
          {filterOptions.length > 0 && (
            <select className="input input-sm w-auto" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
              <option value="">Todas las categorías</option>
              {filterOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : sends.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-8">
            {filterCat ? 'Sin comunicados en esta categoría.' : 'Aún no has enviado comunicados.'}
          </p>
        ) : (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle">
            {sends.map(s => <SendRow key={s.id} s={s} onClick={() => setDetailId(s.id)} />)}
          </div>
        )}
      </div>

      {showComposer && (
        <ComposerModal
          onClose={() => setShowComposer(false)}
          onSent={() => { qc.invalidateQueries({ queryKey: ['comm-sends'] }) }}
        />
      )}
      {showCategories && <CategoriesModal onClose={() => setShowCategories(false)} />}
      {detailId && <SendDetailModal sendId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}
