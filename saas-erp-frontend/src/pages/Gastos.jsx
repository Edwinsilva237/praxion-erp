import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { createPortal } from 'react-dom'
import { purchasesApi } from '@/api/purchases'
import { processConfigApi } from '@/api/processConfig'
import { partnersApi } from '@/api/partners'
import { bankAccountsApi } from '@/api/bankAccounts'
import { creditCardsApi } from '@/api/creditCards'
import { fmtMXN, fmtDateOnly } from '@/utils/fmt'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

// ── Semáforo CFDI ──────────────────────────────────────────────────────────
function CfdiBadge({ has }) {
  return has
    ? <span className="badge-green">Con factura</span>
    : <span className="badge-amber">Sin factura</span>
}

// ── Semáforo de pago ───────────────────────────────────────────────────────
function PagoBadge({ status }) {
  const map = {
    paid:    ['badge-green', 'Pagado'],
    partial: ['badge-blue',  'Pago parcial'],
    pending: ['badge-amber', 'Por pagar'],
    cancelled: ['badge-gray', 'Cancelado'],
  }
  const [cls, label] = map[status] || ['badge-gray', status || '—']
  return <span className={cls}>{label}</span>
}

// ── Forma de pago (mismo vocabulario que el módulo de pagos a proveedor) ─────
const METHOD_OPTS = [
  ['transfer',    'Transferencia'],
  ['cash',        'Efectivo'],
  ['check',       'Cheque'],
  ['credit_card', 'Tarjeta de crédito'],
]
const methodLabel = (m) => (METHOD_OPTS.find(([v]) => v === m)?.[1]) || null

// Rango de fechas (from/to) y etiqueta legible a partir de un mes 'YYYY-MM'.
function monthRange(m) {
  if (!m) return { from: undefined, to: undefined }
  const [y, mo] = m.split('-').map(Number)
  const last = new Date(y, mo, 0).getDate()
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }
}
function monthLabel(m) {
  if (!m) return 'histórico'
  return new Date(`${m}-01T00:00:00`).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })
}

// ── Modal: registrar gasto ─────────────────────────────────────────────────
function GastoModal({ categories, onClose, onSaved }) {
  const [supplierId, setSupplierId]   = useState('')
  const [categoryId, setCategoryId]   = useState('')
  const [hasCfdi, setHasCfdi]         = useState(true)
  const [docNumber, setDocNumber]     = useState('')
  const [uuid, setUuid]               = useState('')
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [subtotal, setSubtotal]       = useState('')
  const [tax, setTax]                 = useState('')
  const [paymentMethod, setPaymentMethod] = useState('transfer')
  const [markPaid, setMarkPaid]       = useState(false)
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentBankAccountId, setPaymentBankAccountId] = useState('')
  const [paymentCreditCardId, setPaymentCreditCardId] = useState('')
  const [notes, setNotes]             = useState('')
  const [error, setError]             = useState(null)
  // Fase 2: carga de CFDI/PDF
  const [parsing, setParsing]         = useState(false)
  const [parsedFrom, setParsedFrom]   = useState(null)   // { name, rfc, matched, method }
  const [xmlContent, setXmlContent]   = useState(null)
  const [sourceFile, setSourceFile]   = useState(null)   // archivo original → respaldo descargable
  const [currency, setCurrency]       = useState('MXN')
  const fileRef = useRef(null)

  async function handleFile(file) {
    if (!file) return
    setSourceFile(file)
    setParsing(true); setError(null)
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await purchasesApi.parseExpenseDocument(fd)
      if (r.subtotal != null) setSubtotal(String(r.subtotal))
      if (r.tax != null)      setTax(String(r.tax))
      if (r.uuid)             { setUuid(r.uuid); setHasCfdi(true) }
      const folio = [r.serie, r.folio].filter(Boolean).join('-')
      if (folio)              setDocNumber(folio)
      if (r.invoiceDate)      setInvoiceDate(r.invoiceDate)
      if (r.currency)         setCurrency(r.currency)
      if (r.matchedPartner)   setSupplierId(r.matchedPartner.id)
      setParsedFrom({ name: r.emisor?.name, rfc: r.emisor?.rfc, matched: !!r.matchedPartner, method: r.method })
      // Respaldo del XML (solo si el archivo es XML)
      setXmlContent((file.name || '').toLowerCase().endsWith('.xml') ? await file.text() : null)
    } catch (e) {
      setError(e.response?.data?.error || 'No se pudo leer el archivo. Captura los datos a mano.')
    } finally {
      setParsing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const { data: suppliersResp } = useQuery({
    queryKey: ['partners', 'suppliers'],
    queryFn:  () => partnersApi.list({ role: 'supplier' }),
    staleTime: 5 * 60 * 1000,
  })
  const suppliers = suppliersResp?.data || suppliersResp || []

  // Catálogos para asociar el pago (solo cuando se marca Pagado).
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    enabled:  markPaid, staleTime: 5 * 60 * 1000,
  })
  const { data: creditCards = [] } = useQuery({
    queryKey: ['credit-cards', 'active'],
    queryFn:  () => creditCardsApi.list(),
    enabled:  markPaid, staleTime: 5 * 60 * 1000,
  })

  const sub = parseFloat(subtotal) || 0
  const iva = parseFloat(tax) || 0
  const total = +(sub + iva).toFixed(2)

  const mut = useMutation({
    mutationFn: async () => {
      if (!supplierId) throw new Error('Selecciona el proveedor.')
      if (!categoryId) throw new Error('Selecciona la categoría de gasto.')
      if (total <= 0) throw new Error('Captura el monto del gasto.')
      if (markPaid && paymentMethod === 'check' && !paymentReference.trim()) {
        throw new Error('El número de cheque es requerido.')
      }
      const created = await purchasesApi.createExpense({
        supplierId,
        expenseCategoryId: categoryId,
        documentNumber: docNumber.trim() || undefined,
        uuidSat: hasCfdi ? (uuid.trim() || undefined) : undefined,
        invoiceDate,
        currency,
        subtotal: sub, tax: iva, total,
        xmlContent: xmlContent || undefined,
        paymentMethod,
        markPaid,
        paymentReference: markPaid ? (paymentReference.trim() || undefined) : undefined,
        paymentBankAccountId: markPaid && paymentMethod === 'transfer'    ? (paymentBankAccountId || undefined) : undefined,
        paymentCreditCardId:  markPaid && paymentMethod === 'credit_card' ? (paymentCreditCardId  || undefined) : undefined,
        notes: notes.trim() || undefined,
      })
      // Guarda el archivo original (XML/PDF) como respaldo descargable del gasto.
      // Best-effort: si la subida del respaldo falla, el gasto YA quedó creado.
      if (sourceFile && created?.id) {
        try {
          const fd = new FormData(); fd.append('file', sourceFile)
          await purchasesApi.addExpenseAttachment(created.id, fd)
        } catch { /* respaldo opcional: no bloquea el alta del gasto */ }
      }
      return created
    },
    onSuccess: () => { onSaved(); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={e => { e.preventDefault(); setError(null); mut.mutate() }}
        className="card w-full max-w-lg p-6 flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Registrar gasto</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Fase 2: cargar el CFDI/PDF y llenar el form solo */}
        <div className="border border-dashed border-line-strong rounded-xl p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-muted">¿Tienes el CFDI? Cárgalo y se llena solo.</span>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={parsing}
              className="btn-secondary text-xs whitespace-nowrap">
              {parsing ? <Spinner size="sm" /> : 'Cargar XML / PDF'}
            </button>
            <input ref={fileRef} type="file" accept=".xml,application/xml,text/xml,application/pdf"
              className="hidden" onChange={e => handleFile(e.target.files?.[0])} />
          </div>
          {parsedFrom && (
            <p className="text-[11px] text-ink-secondary leading-snug">
              {parsedFrom.method === 'ai' ? 'Leído del PDF con IA'
                : parsedFrom.method === 'text' ? 'Leído del PDF' : 'Leído del CFDI'}
              {' · Emisor: '}<strong>{parsedFrom.name || parsedFrom.rfc || '—'}</strong>
              {parsedFrom.rfc ? ` (${parsedFrom.rfc})` : ''}{' · '}
              {parsedFrom.matched
                ? 'proveedor encontrado'
                : <span className="text-amber-500">no está en tu catálogo — selecciónalo o créalo</span>}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Proveedor <span className="text-status-danger">*</span></label>
            <select className="select" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
              <option value="">— Selecciona —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Categoría <span className="text-status-danger">*</span></label>
            <select className="select" value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">— Selecciona —</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-brand-600"
            checked={hasCfdi} onChange={e => setHasCfdi(e.target.checked)} />
          <span className="text-ink-secondary">Ya tengo la factura (CFDI)</span>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{hasCfdi ? 'Folio / Núm. factura' : 'Referencia (opcional)'}</label>
            <input className="input" value={docNumber} onChange={e => setDocNumber(e.target.value)}
              placeholder={hasCfdi ? 'A-1234' : 'Opcional'} />
          </div>
          <div>
            <label className="label">Fecha</label>
            <input type="date" className="input" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
          </div>
        </div>

        {hasCfdi && (
          <div>
            <label className="label">UUID (folio fiscal) <span className="text-[10px] text-ink-muted">(opcional)</span></label>
            <input className="input font-mono text-xs" value={uuid} onChange={e => setUuid(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Subtotal</label>
            <input type="number" step="0.01" min="0" className="input" inputMode="decimal"
              value={subtotal} onChange={e => setSubtotal(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="label">IVA</label>
            <input type="number" step="0.01" min="0" className="input" inputMode="decimal"
              value={tax} onChange={e => setTax(e.target.value)} placeholder="0.00" />
          </div>
        </div>

        <div className="flex justify-end">
          <div className="bg-brand-500/10 border border-brand-100 rounded-xl px-4 py-2 flex items-center gap-3">
            <span className="text-sm text-ink-muted">Total</span>
            <span className="text-base font-bold text-brand-300 tabular-nums">{fmtMXN(total)}</span>
          </div>
        </div>

        {/* ── Estado del pago + liquidación inmediata ── */}
        <div className="border-t border-line-subtle pt-3 flex flex-col gap-3">
          <div>
            <label className="label">Estado del pago</label>
            {/* Toggle Por pagar / Pagado — mismo vocabulario y colores que el semáforo de la lista */}
            <div role="group" aria-label="Estado del pago"
              className="inline-flex rounded-lg border border-line-strong overflow-hidden">
              <button type="button" onClick={() => setMarkPaid(false)} aria-pressed={!markPaid}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2 text-sm transition-colors',
                  !markPaid
                    ? 'bg-status-warning/15 text-status-warning font-medium'
                    : 'text-ink-muted hover:bg-surface-elevated/50'
                )}>
                <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
                Por pagar
              </button>
              <button type="button" onClick={() => setMarkPaid(true)} aria-pressed={markPaid}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2 text-sm border-l border-line-strong transition-colors',
                  markPaid
                    ? 'bg-status-success/15 text-status-success font-medium'
                    : 'text-ink-muted hover:bg-surface-elevated/50'
                )}>
                <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                Pagado
              </button>
            </div>
            <p className="text-xs text-ink-muted mt-1.5">
              {markPaid
                ? 'Se liquida en el momento; no queda como “Por pagar”.'
                : 'Queda como cuenta por pagar pendiente de liquidar.'}
            </p>
          </div>

          {markPaid && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Forma de pago</label>
                <select className="select" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                  {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label">
                  Referencia
                  {paymentMethod === 'check'
                    ? <span className="text-status-danger"> *</span>
                    : <span className="text-ink-muted text-xs"> (opcional)</span>}
                </label>
                <input className="input" value={paymentReference} onChange={e => setPaymentReference(e.target.value)}
                  placeholder={paymentMethod === 'transfer' ? 'SPEI / folio' : paymentMethod === 'check' ? '# cheque' : 'Opcional'} />
              </div>

              {/* Transferencia → cuenta; Tarjeta → tarjeta (ambos opcionales) */}
              {paymentMethod === 'transfer' && (
                <div className="sm:col-span-2">
                  <label className="label">Cuenta bancaria <span className="text-ink-muted text-xs">(opcional)</span></label>
                  <select className="select" value={paymentBankAccountId}
                    onChange={e => setPaymentBankAccountId(e.target.value)}>
                    <option value="">— Sin especificar —</option>
                    {bankAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.bank_name}{a.alias ? ` · ${a.alias}` : ''} ({a.currency})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {paymentMethod === 'credit_card' && (
                <div className="sm:col-span-2">
                  <label className="label">Tarjeta <span className="text-ink-muted text-xs">(opcional)</span></label>
                  {creditCards.length === 0 ? (
                    <p className="text-xs text-ink-muted">
                      No hay tarjetas configuradas.{' '}
                      <a href="/configuracion/tarjetas-credito" target="_blank" rel="noopener" className="underline">Crear una</a>
                    </p>
                  ) : (
                    <select className="select" value={paymentCreditCardId}
                      onChange={e => setPaymentCreditCardId(e.target.value)}>
                      <option value="">— Sin especificar —</option>
                      {creditCards.map(c => (
                        <option key={c.id} value={c.id}>{c.alias}{c.last_four ? ` ••${c.last_four}` : ''}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="label">Notas</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Concepto / observaciones" />
        </div>

        <div className="flex items-start gap-2 bg-surface-elevated/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
          <p className="text-xs text-ink-secondary">
            Se genera la cuenta por pagar del proveedor. Si capturas el IVA, cuenta como IVA acreditable
            en tu resumen. Si aún no tienes la factura, regístralo sin CFDI y complétalo después.
          </p>
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mut.isPending} className="btn-primary flex-1">
            {mut.isPending ? <Spinner size="sm" /> : 'Registrar gasto'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Respaldo del CFDI (XML/PDF) del gasto: ver, descargar, adjuntar ──────────
function fileSizeLabel(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ExpenseAttachments({ expenseId, canEdit }) {
  const qc = useQueryClient()
  const fileRef = useRef(null)
  const [error, setError] = useState(null)
  const [downloadingId, setDownloadingId] = useState(null)

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['expense-attachments', expenseId],
    queryFn:  () => purchasesApi.listExpenseAttachments(expenseId),
  })

  const upload = useMutation({
    mutationFn: (file) => {
      const fd = new FormData(); fd.append('file', file)
      return purchasesApi.addExpenseAttachment(expenseId, fd)
    },
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['expense-attachments', expenseId] }) },
    onError: (e) => setError(e.response?.data?.error || 'No se pudo subir el archivo.'),
  })

  async function download(f) {
    setError(null); setDownloadingId(f.id)
    try {
      const blob = await purchasesApi.downloadExpenseAttachment(expenseId, f.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = f.filename || 'comprobante'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setError('No se pudo descargar el archivo.')
    } finally { setDownloadingId(null) }
  }

  const isXml = (f) => (f.mime_type || '').includes('xml') || (f.filename || '').toLowerCase().endsWith('.xml')

  return (
    <div className="border-t border-line-subtle pt-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="label mb-0">Comprobante (XML / PDF)</label>
        {canEdit && (
          <Can do="expenses:create">
            <button type="button" className="btn-ghost text-xs" disabled={upload.isPending}
              onClick={() => fileRef.current?.click()}>
              {upload.isPending ? <Spinner size="sm" /> : '+ Adjuntar'}
            </button>
            <input ref={fileRef} type="file" accept=".xml,application/xml,text/xml,application/pdf"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload.mutate(f); if (fileRef.current) fileRef.current.value = '' }} />
          </Can>
        )}
      </div>

      {isLoading ? (
        <Spinner size="sm" />
      ) : files.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Sin respaldo guardado.{canEdit ? ' Adjunta el XML o PDF del CFDI.' : ''}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {files.map(f => (
            <li key={f.id} className="flex items-center gap-2 bg-surface-elevated/40 rounded-lg px-3 py-2">
              <span className={isXml(f) ? 'badge-blue' : 'badge-gray'}>{isXml(f) ? 'XML' : 'PDF'}</span>
              <span className="flex-1 text-xs text-ink-secondary truncate" title={f.filename}>{f.filename}</span>
              <span className="text-[10px] text-ink-muted tabular-nums whitespace-nowrap">{fileSizeLabel(f.file_size_bytes)}</span>
              <button type="button" className="btn-ghost text-xs whitespace-nowrap" disabled={downloadingId === f.id}
                onClick={() => download(f)}>
                {downloadingId === f.id ? <Spinner size="sm" /> : 'Descargar'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="field-error text-xs">{error}</p>}
    </div>
  )
}

// ── Modal: detalle + editar + cancelar ──────────────────────────────────────
function GastoDetalleModal({ id, categories, onClose, onSaved }) {
  const qc = useQueryClient()
  const { data: exp, isLoading } = useQuery({
    queryKey: ['expense', id],
    queryFn:  () => purchasesApi.getExpense(id),
  })
  const { data: suppliersResp } = useQuery({
    queryKey: ['partners', 'suppliers'],
    queryFn:  () => partnersApi.list({ role: 'supplier' }),
    staleTime: 5 * 60 * 1000,
  })
  const suppliers = suppliersResp?.data || suppliersResp || []

  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [askCancel, setAskCancel] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [requestMsg, setRequestMsg] = useState(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [pickedReceipts, setPickedReceipts] = useState({}) // { receiptId: bool } selección (paso 1 manual, multi)
  const [linkReceiptId, setLinkReceiptId] = useState('')   // 1 sola recepción → paso 2 (líneas, parcial)
  const [checkedLines, setCheckedLines] = useState({})     // { lineId: bool }
  const [supOpen, setSupOpen] = useState(false)            // alta rápida de proveedor (gasto genérico)
  const [supForm, setSupForm] = useState({ name: '', rfc: '', type: 'supplier', recurrente: false })
  const [payOpen, setPayOpen] = useState(false)            // liquidar de contado
  const [payMethod, setPayMethod] = useState('cash')
  const [payRef, setPayRef] = useState('')
  const [payBankAccountId, setPayBankAccountId] = useState('')
  const [payCreditCardId, setPayCreditCardId] = useState('')

  // ¿El gasto trae total pero SIN desglose (subtotal/IVA en 0)? Pasa con facturas
  // que llegaron por correo como PDF y el parser sólo pudo leer el total. En ese
  // caso estimamos el desglose al 16% (editable) para no mostrar $0/$0.
  const breakdownMissing = exp && parseFloat(exp.total || 0) > 0
    && !parseFloat(exp.subtotal || 0) && !parseFloat(exp.tax || 0)

  useEffect(() => {
    if (exp && !form) {
      const stTotal = parseFloat(exp.total || 0)
      const estSub  = breakdownMissing ? +(stTotal / 1.16).toFixed(2) : null
      setForm({
        supplierId:        exp.partner_id || '',
        expenseCategoryId: exp.expense_category_id || '',
        invoiceDate:       (exp.invoice_date || '').slice(0, 10),
        documentNumber:    exp.invoice_number || '',
        hasCfdi:           !!exp.uuid_sat,
        uuid:              exp.uuid_sat || '',
        subtotal:          breakdownMissing ? estSub : (exp.subtotal ?? ''),
        tax:               breakdownMissing ? +(stTotal - estSub).toFixed(2) : (exp.tax ?? ''),
        currency:          exp.currency || 'MXN',
        notes:             exp.notes || '',
      })
    }
  }, [exp, form, breakdownMissing])

  const isCancelled = exp?.status === 'cancelled'
  // El backend bloquea editar monto / cancelar cuando hay pago aplicado.
  const isPaid = ['paid', 'partial'].includes(exp?.ap_status)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        supplierId:        form.supplierId || undefined,
        expenseCategoryId: form.expenseCategoryId || undefined,
        invoiceDate:       form.invoiceDate || undefined,
        documentNumber:    form.documentNumber.trim() || undefined,
        uuidSat:           form.hasCfdi ? (form.uuid.trim() || undefined) : '',
        notes:             form.notes.trim(),
      }
      // Montos y moneda solo si NO está pagado (el backend igual lo rechazaría
      // con 409: cambiar la moneda recalcula total_mxn y la cuenta por pagar).
      if (!isPaid) {
        body.subtotal = parseFloat(form.subtotal) || 0
        body.tax      = parseFloat(form.tax) || 0
        body.currency = form.currency
      }
      return purchasesApi.updateExpense(id, body)
    },
    onSuccess: () => { onSaved(); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const cancel = useMutation({
    mutationFn: () => purchasesApi.cancelExpense(id, cancelReason.trim() || undefined),
    onSuccess: () => { onSaved(); onClose() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const requestInv = useMutation({
    mutationFn: () => purchasesApi.requestExpenseInvoice(id),
    onSuccess: (r) => {
      setRequestMsg(`Solicitud enviada a ${(r.sentTo || []).join(', ') || 'el proveedor'}.`)
      qc.invalidateQueries({ queryKey: ['expense', id] })
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  // Liquidar de contado: registra el pago por el total y deja la CXP en "Pagado".
  // Solo cuando el gasto tiene CXP propia (proveedor de catálogo) y sigue pendiente.
  // Catálogos para asociar el pago (transfer→cuenta, tarjeta→credit_card). Solo al abrir.
  const { data: bankAccounts = [] } = useQuery({
    queryKey: ['bank-accounts', 'active'],
    queryFn:  () => bankAccountsApi.list(),
    enabled:  payOpen, staleTime: 5 * 60 * 1000,
  })
  const { data: creditCards = [] } = useQuery({
    queryKey: ['credit-cards', 'active'],
    queryFn:  () => creditCardsApi.list(),
    enabled:  payOpen, staleTime: 5 * 60 * 1000,
  })

  const pay = useMutation({
    mutationFn: () => {
      if (payMethod === 'check' && !payRef.trim()) throw new Error('El número de cheque es requerido.')
      return purchasesApi.payExpense(id, {
        method: payMethod,
        reference: payRef.trim() || undefined,
        bankAccountId: payMethod === 'transfer'    ? (payBankAccountId || undefined) : undefined,
        creditCardId:  payMethod === 'credit_card' ? (payCreditCardId  || undefined) : undefined,
      })
    },
    onSuccess: () => {
      setPayOpen(false); setPayRef('')
      qc.invalidateQueries({ queryKey: ['expense', id] })
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expenses-summary'] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      onSaved()
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })
  const canPay = exp && exp.is_expense !== false && exp.status !== 'cancelled'
    && !!exp.ap_id && exp.ap_status === 'pending'

  // Un gasto pagado SÍ se puede vincular: su CXP y pago viajan con el registro al
  // convertirse en factura de compra (backend lo permite).
  const canLink = exp && exp.is_expense !== false && exp.status !== 'cancelled'
    && !!exp.partner_id

  // Sugerencia: ¿este gasto cuadra con una recepción pendiente? (no liga sola).
  const { data: suggestion } = useQuery({
    queryKey: ['expense-receipt-suggestion', id],
    queryFn:  () => purchasesApi.expenseReceiptSuggestion(id),
    enabled:  !!canLink,
  })

  // Conceptos del CFDI (parseados del XML guardado) para previsualizar.
  const { data: conceptosData } = useQuery({
    queryKey: ['expense-conceptos', id],
    queryFn:  () => purchasesApi.expenseConceptos(id),
    enabled:  !!id && !!exp?.uuid_sat,
  })
  const conceptos = conceptosData?.lines || []

  // Recepciones pendientes de factura del proveedor (para elegir manualmente).
  const { data: pendingReceipts } = useQuery({
    queryKey: ['pending-invoice-receipts', exp?.partner_id],
    queryFn:  () => purchasesApi.listPendingInvoiceReceipts(exp.partner_id),
    enabled:  linkOpen && !!exp?.partner_id,
  })

  // Paso 2: detalle de la recepción elegida (sus líneas) para conciliar.
  const { data: receiptDetail } = useQuery({
    queryKey: ['receipt-detail', linkReceiptId],
    queryFn:  () => purchasesApi.getReceipt(linkReceiptId),
    enabled:  !!linkReceiptId,
  })
  // Pre-marca todas las líneas pendientes al cargar la recepción.
  useEffect(() => {
    if (receiptDetail?.lines) {
      const init = {}
      for (const ln of receiptDetail.lines) if (ln.invoice_pending) init[ln.id] = true
      setCheckedLines(init)
    }
  }, [receiptDetail])

  const linkReceipt = useMutation({
    mutationFn: ({ receiptId, lineIds, receipts }) =>
      purchasesApi.linkExpenseToReceipt(id, { receiptId, receiptLineIds: lineIds, receipts }),
    onSuccess: () => {
      // El gasto se volvió factura de compra → sale del listado de Gastos.
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expenses-summary'] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      onSaved(); onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  // Gasto genérico (emisor no catalogado): crear el proveedor con los datos del CFDI.
  const isGeneric = exp && exp.is_expense !== false && exp.status !== 'cancelled' && !exp.partner_id
  const createSupplier = useMutation({
    mutationFn: () => purchasesApi.createSupplierFromExpense(id, {
      name: supForm.name.trim() || undefined,
      rfc:  supForm.rfc.trim() || undefined,
      partnerType: supForm.type,
      isOccasional: !supForm.recurrente,   // eventual por default; recurrente → formal
    }),
    onSuccess: () => {
      setSupOpen(false)
      qc.invalidateQueries({ queryKey: ['expense', id] })
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['partners'] })
      qc.invalidateQueries({ queryKey: ['cxp'] })
      onSaved()
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  // Re-leer el XML guardado: recupera nombre/RFC del emisor (y totales si sigue
  // genérico) que la ingesta por PDF pudo perder ("Proveedor (correo)").
  const hasXml = !!conceptosData?.hasXml
  const rereadXml = useMutation({
    mutationFn: () => purchasesApi.rereadExpenseXml(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['expense', id] })
      qc.invalidateQueries({ queryKey: ['expenses'] })
      qc.invalidateQueries({ queryKey: ['expenses-summary'] })
      qc.invalidateQueries({ queryKey: ['expense-conceptos', id] })
      setError(res?.updated === false
        ? 'El XML ya coincide con los datos actuales (sin cambios).'
        : null)
      onSaved()
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const sub = parseFloat(form?.subtotal) || 0
  const iva = parseFloat(form?.tax) || 0
  const total = +(sub + iva).toFixed(2)

  // Conciliación del paso 2: subtotal del gasto vs líneas marcadas de la recepción.
  const expSubtotal = parseFloat(exp?.subtotal || 0)
  const coveredSubtotal = +(receiptDetail?.lines || [])
    .filter(l => checkedLines[l.id]).reduce((s, l) => s + parseFloat(l.subtotal || 0), 0).toFixed(2)
  const reconDiff = +(expSubtotal - coveredSubtotal).toFixed(2)
  const reconOk = Math.abs(reconDiff) < 0.01
  const checkedCount = Object.values(checkedLines).filter(Boolean).length
  const resetLink = () => { setLinkOpen(false); setLinkReceiptId(''); setPickedReceipts({}); setCheckedLines({}) }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Detalle del gasto</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {isLoading || !form ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : (
          <>
            {/* Estado (semáforos) */}
            <div className="flex flex-wrap gap-2">
              <CfdiBadge has={exp.has_cfdi} />
              <PagoBadge status={exp.ap_status || exp.status} />
              {exp.is_overdue && <span className="badge-red">Vencido</span>}
              {isCancelled && <span className="badge-gray">Cancelado</span>}
            </div>

            {isCancelled && (
              <div className="alert-warning text-xs">Este gasto está cancelado (solo lectura).</div>
            )}
            {isPaid && !isCancelled && (
              <div className="bg-surface-elevated/40 rounded-lg px-3 py-2 text-xs text-ink-secondary">
                Gasto con pago aplicado: el monto no se puede editar. Reversa el pago primero (desde Cuentas por pagar).
              </div>
            )}

            {/* Gasto genérico: el emisor no está en el catálogo → crear el proveedor
                con los datos que ya trae el CFDI (RFC + razón social) y vincularlo. */}
            {isGeneric && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex flex-col gap-2">
                <p className="text-xs text-ink-secondary">
                  <strong>Proveedor sin identificar.</strong> El emisor de este gasto no está en tu
                  catálogo{exp.generic_supplier
                    ? <> (<span className="text-ink-primary">{exp.generic_supplier}</span>{exp.rfc_emisor ? ` · ${exp.rfc_emisor}` : ''})</>
                    : ''}. Dálo de alta como <strong>proveedor eventual</strong> para poder vincularlo a
                  recepciones y pedir su factura (no aparece en el catálogo hasta marcarlo como recurrente).
                </p>
                {!supOpen ? (
                  <div className="flex flex-wrap gap-2">
                    {hasXml && (
                      <Can do="expenses:create">
                        <button type="button" className="btn-secondary text-xs"
                          disabled={rereadXml.isPending}
                          onClick={() => { setError(null); rereadXml.mutate() }}
                          title="Re-lee el XML guardado y recupera el nombre y RFC del emisor">
                          {rereadXml.isPending ? <Spinner size="sm" /> : 'Volver a leer del XML'}
                        </button>
                      </Can>
                    )}
                    <Can do="business_partners:create">
                      <button type="button" className="btn-primary text-xs"
                        onClick={() => {
                          setError(null)
                          const cleanName = (exp.generic_supplier && exp.generic_supplier !== 'Proveedor (correo)')
                            ? exp.generic_supplier : ''
                          setSupForm({ name: cleanName, rfc: exp.rfc_emisor || '', type: 'supplier', recurrente: false })
                          setSupOpen(true)
                        }}>
                        Crear proveedor con estos datos
                      </button>
                    </Can>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="label">Razón social</label>
                        <input className="input" value={supForm.name}
                          onChange={e => setSupForm(f => ({ ...f, name: e.target.value }))} />
                      </div>
                      <div>
                        <label className="label">RFC</label>
                        <input className="input uppercase" value={supForm.rfc}
                          onChange={e => setSupForm(f => ({ ...f, rfc: e.target.value.toUpperCase() }))} />
                      </div>
                    </div>
                    <div>
                      <label className="label">Tipo</label>
                      <select className="select" value={supForm.type}
                        onChange={e => setSupForm(f => ({ ...f, type: e.target.value }))}>
                        <option value="supplier">Proveedor</option>
                        <option value="both">Cliente y proveedor</option>
                      </select>
                    </div>
                    <label className="flex items-start gap-2 text-xs cursor-pointer">
                      <input type="checkbox" className="w-4 h-4 mt-0.5 accent-brand-600"
                        checked={supForm.recurrente}
                        onChange={e => setSupForm(f => ({ ...f, recurrente: e.target.checked }))} />
                      <span className="text-ink-secondary">
                        Es un proveedor <strong>recurrente</strong> — agrégalo al catálogo.
                        <span className="block text-ink-muted">Déjalo sin marcar para una compra de una sola vez (proveedor eventual).</span>
                      </span>
                    </label>
                    <div className="flex gap-2">
                      <button type="button" className="btn-ghost text-xs" onClick={() => setSupOpen(false)}>Cancelar</button>
                      <button type="button" className="btn-primary text-xs"
                        disabled={!supForm.name.trim() || createSupplier.isPending}
                        onClick={() => { setError(null); createSupplier.mutate() }}>
                        {createSupplier.isPending ? <Spinner size="sm" /> : 'Crear y vincular'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Marcar como pagado (de contado) — liquida la CXP en un paso, sin ir
                a Cuentas por pagar. Solo si el gasto tiene CXP propia y sigue pendiente. */}
            {canPay && (
              <Can do="expenses:create">
                <div className="bg-status-success/10 border border-status-success/30 rounded-lg p-3 flex flex-col gap-2">
                  {!payOpen ? (
                    <>
                      <p className="text-xs text-ink-secondary">
                        ¿Ya lo pagaste? Márcalo como <strong>pagado de contado</strong> y se liquida
                        en el momento (no queda como cuenta por pagar).
                      </p>
                      <button type="button" className="btn-secondary text-xs self-start"
                        onClick={() => { setError(null); setPayOpen(true) }}>
                        Marcar como pagado
                      </button>
                    </>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-ink-secondary">
                        Se registra un pago por <strong>{fmtMXN(exp.total)}</strong> y el gasto queda <strong>Pagado</strong>.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="label">Forma de pago</label>
                          <select className="select" value={payMethod}
                            onChange={e => setPayMethod(e.target.value)}>
                            {METHOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="label">
                            {payMethod === 'check' ? 'Número de cheque' : 'Referencia (opcional)'}
                          </label>
                          <input className="input" value={payRef}
                            onChange={e => setPayRef(e.target.value)}
                            placeholder={payMethod === 'transfer' ? 'SPEI / folio' : payMethod === 'check' ? '# cheque' : 'Opcional'} />
                        </div>
                      </div>

                      {/* Transferencia → ¿de qué cuenta sale? (opcional) */}
                      {payMethod === 'transfer' && (
                        <div>
                          <label className="label">Cuenta bancaria <span className="text-ink-muted text-xs">(opcional)</span></label>
                          <select className="select" value={payBankAccountId}
                            onChange={e => setPayBankAccountId(e.target.value)}>
                            <option value="">— Sin especificar —</option>
                            {bankAccounts.map(a => (
                              <option key={a.id} value={a.id}>
                                {a.bank_name}{a.alias ? ` · ${a.alias}` : ''} ({a.currency})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Tarjeta de crédito → ¿a qué tarjeta se cargó? (opcional) */}
                      {payMethod === 'credit_card' && (
                        <div>
                          <label className="label">Tarjeta <span className="text-ink-muted text-xs">(opcional)</span></label>
                          {creditCards.length === 0 ? (
                            <p className="text-xs text-ink-muted">
                              No hay tarjetas configuradas.{' '}
                              <a href="/configuracion/tarjetas-credito" target="_blank" rel="noopener" className="underline">
                                Crear una
                              </a>
                            </p>
                          ) : (
                            <select className="select" value={payCreditCardId}
                              onChange={e => setPayCreditCardId(e.target.value)}>
                              <option value="">— Sin especificar —</option>
                              {creditCards.map(c => (
                                <option key={c.id} value={c.id}>
                                  {c.alias}{c.last_four ? ` ••${c.last_four}` : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}

                      <div className="flex gap-2">
                        <button type="button" className="btn-ghost text-xs"
                          onClick={() => { setPayOpen(false); setPayRef('') }}>Cancelar</button>
                        <button type="button" className="btn-primary text-xs"
                          disabled={pay.isPending}
                          onClick={() => { setError(null); pay.mutate() }}>
                          {pay.isPending ? <Spinner size="sm" /> : 'Confirmar pago'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </Can>
            )}

            {/* Solicitar factura al proveedor (gasto sin CFDI) */}
            {!isCancelled && !exp.has_cfdi && exp.partner_id && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex flex-col gap-2">
                <p className="text-xs text-ink-secondary">
                  {exp.invoice_requested_at
                    ? `Factura solicitada al proveedor el ${fmtDateOnly(exp.invoice_requested_at)}.`
                    : 'Este gasto no tiene factura. Pídesela al proveedor por correo.'}
                </p>
                {requestMsg
                  ? <p className="text-xs text-brand-300">{requestMsg}</p>
                  : (
                    <Can do="expenses:create">
                      <button type="button" className="btn-secondary text-xs self-start"
                        disabled={requestInv.isPending}
                        onClick={() => { setError(null); requestInv.mutate() }}>
                        {requestInv.isPending
                          ? <Spinner size="sm" />
                          : (exp.invoice_requested_at ? 'Volver a solicitar' : 'Solicitar factura')}
                      </button>
                    </Can>
                  )}
              </div>
            )}

            {/* Conceptos del CFDI (previsualización, parseados del XML guardado). */}
            {conceptos.length > 0 && (
              <div>
                <p className="text-xs font-medium text-ink-secondary mb-1">Conceptos de la factura</p>
                <div className="border border-line-subtle rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-elevated/50">
                      <tr className="text-ink-muted">
                        <th className="text-left font-medium px-2 py-1">Descripción</th>
                        <th className="text-right font-medium px-2 py-1">Cant.</th>
                        <th className="text-right font-medium px-2 py-1">P. unit.</th>
                        <th className="text-right font-medium px-2 py-1">Importe</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-subtle">
                      {conceptos.map((l, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1 text-ink-secondary">{l.description}</td>
                          <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{l.quantity} {l.unit}</td>
                          <td className="px-2 py-1 text-right font-mono">{fmtMXN(l.unitPrice)}</td>
                          <td className="px-2 py-1 text-right font-mono font-medium">{fmtMXN(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Vincular a una recepción → factura de compra (mercancía). NO se liga
                sola (irreversible): se SUGIERE, eliges líneas, concilias y confirmas. */}
            {canLink && (
              <Can do="expenses:create">
                <div className="bg-brand-500/10 border border-brand-100 rounded-lg p-3 flex flex-col gap-2">
                  {!linkReceiptId ? (
                    /* ── Paso 1: elegir la recepción ── */
                    suggestion?.suggestion && !linkOpen ? (
                      <>
                        <p className="text-xs text-ink-secondary">
                          Parece la factura de la recepción <strong>{suggestion.suggestion.receipt_number}</strong>
                          {' '}({fmtMXN(suggestion.suggestion.total_mxn)} · {fmtDateOnly(suggestion.suggestion.received_date)}).
                          Si es de <strong>mercancía</strong>, vincúlala → factura de compra (toca inventario, evita doble CXP).
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" className="btn-primary text-xs"
                            onClick={() => { setError(null); setLinkReceiptId(suggestion.suggestion.id) }}>
                            Revisar y vincular a {suggestion.suggestion.receipt_number}
                          </button>
                          <button type="button" className="btn-ghost text-xs" onClick={() => setLinkOpen(true)}>
                            Elegir otra
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-ink-secondary">
                          ¿Es una factura de <strong>mercancía</strong>? Vincúlala a su recepción → factura de compra
                          (toca inventario vía la recepción y evita doble cuenta por pagar).
                        </p>
                        {!linkOpen ? (
                          <button type="button" className="btn-secondary text-xs self-start"
                            onClick={() => { setError(null); setLinkOpen(true) }}>
                            Vincular a recepción
                          </button>
                        ) : pendingReceipts === undefined ? (
                          <Spinner size="sm" />
                        ) : pendingReceipts.length === 0 ? (
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-ink-muted">Este proveedor no tiene recepciones pendientes de factura.</p>
                            <button type="button" className="btn-ghost text-xs" onClick={resetLink}>Cerrar</button>
                          </div>
                        ) : (() => {
                          const pickedIds = Object.keys(pickedReceipts).filter(k => pickedReceipts[k])
                          const togglePick = (rid) => setPickedReceipts(s => ({ ...s, [rid]: !s[rid] }))
                          return (
                          <div className="flex flex-col gap-2">
                            <p className="text-[11px] text-ink-muted">
                              Marca una o <strong>varias</strong> recepciones que cubre esta factura.
                              Con una sola podrás elegir líneas (parcial); con varias se vinculan completas.
                            </p>
                            <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
                              {pendingReceipts.map(r => (
                                <label key={r.id} className="flex items-center gap-2 text-xs cursor-pointer">
                                  <input type="checkbox" className="w-4 h-4 accent-brand-600"
                                    checked={!!pickedReceipts[r.id]} onChange={() => togglePick(r.id)} />
                                  <span className="flex-1 text-ink-secondary truncate">
                                    {r.receipt_number} · {fmtDateOnly(r.received_date)}
                                  </span>
                                  <span className="tabular-nums text-ink-primary">{fmtMXN(r.total_mxn)}</span>
                                </label>
                              ))}
                            </div>
                            <div className="flex gap-2">
                              <button type="button" className="btn-ghost text-xs" onClick={resetLink}>Cancelar</button>
                              <button type="button" className="btn-primary text-xs"
                                disabled={pickedIds.length === 0 || linkReceipt.isPending}
                                onClick={() => {
                                  setError(null)
                                  if (pickedIds.length === 1) setLinkReceiptId(pickedIds[0])
                                  else linkReceipt.mutate({ receipts: pickedIds.map(rid => ({ receiptId: rid })) })
                                }}>
                                {linkReceipt.isPending ? <Spinner size="sm" />
                                  : pickedIds.length > 1 ? `Vincular ${pickedIds.length} recepciones`
                                  : 'Continuar'}
                              </button>
                            </div>
                          </div>
                          )
                        })()}
                      </>
                    )
                  ) : receiptDetail === undefined ? (
                    <Spinner size="sm" />
                  ) : (
                    /* ── Paso 2: elegir líneas + conciliar + confirmar ── */
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-ink-secondary">
                        Marca qué líneas de <strong>{receiptDetail.receipt_number}</strong> cubre esta factura:
                      </p>
                      <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
                        {receiptDetail.lines.map(ln => ln.invoice_pending ? (
                          <label key={ln.id} className="flex items-center gap-2 text-xs cursor-pointer">
                            <input type="checkbox" className="w-4 h-4 accent-brand-600"
                              checked={!!checkedLines[ln.id]}
                              onChange={e => setCheckedLines(c => ({ ...c, [ln.id]: e.target.checked }))} />
                            <span className="flex-1 text-ink-secondary truncate">
                              {ln.item_name || ln.description || 'Línea'} · {ln.quantity_received} {ln.item_unit || ln.unit || ''}
                            </span>
                            <span className="tabular-nums text-ink-primary">{fmtMXN(ln.subtotal)}</span>
                          </label>
                        ) : (
                          <div key={ln.id} className="flex items-center gap-2 text-xs text-ink-muted opacity-60">
                            <span className="w-4 text-center">—</span>
                            <span className="flex-1 truncate">{ln.item_name || ln.description || 'Línea'}</span>
                            <span className="whitespace-nowrap">Ya facturada{ln.invoiced_number ? ` · ${ln.invoiced_number}` : ''}</span>
                          </div>
                        ))}
                      </div>
                      {/* Conciliación: subtotal de la factura vs líneas marcadas */}
                      <div className={`rounded-lg px-3 py-2 text-xs flex flex-col gap-0.5 ${reconOk ? 'bg-status-success/10' : 'bg-amber-500/10'}`}>
                        <div className="flex justify-between"><span className="text-ink-muted">Factura (subtotal)</span><span className="tabular-nums">{fmtMXN(expSubtotal)}</span></div>
                        <div className="flex justify-between"><span className="text-ink-muted">Líneas marcadas</span><span className="tabular-nums">{fmtMXN(coveredSubtotal)}</span></div>
                        <div className="flex justify-between font-medium">
                          <span>{reconOk ? '✓ Cuadra' : 'Diferencia'}</span>
                          <span className={`tabular-nums ${reconOk ? 'text-status-success' : 'text-amber-400'}`}>{fmtMXN(reconDiff)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" className="btn-ghost text-xs"
                          onClick={() => { setLinkReceiptId(''); setCheckedLines({}) }}>Atrás</button>
                        <button type="button" className="btn-primary text-xs"
                          disabled={checkedCount === 0 || linkReceipt.isPending}
                          onClick={() => { setError(null); linkReceipt.mutate({ receiptId: linkReceiptId, lineIds: Object.keys(checkedLines).filter(k => checkedLines[k]) }) }}>
                          {linkReceipt.isPending ? <Spinner size="sm" /> : 'Confirmar vínculo'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </Can>
            )}

            <fieldset disabled={isCancelled} className="flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Proveedor</label>
                  <select className="select" value={form.supplierId} onChange={e => set('supplierId', e.target.value)}>
                    <option value="">— Selecciona —</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Categoría</label>
                  <select className="select" value={form.expenseCategoryId} onChange={e => set('expenseCategoryId', e.target.value)}>
                    <option value="">— Selecciona —</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-brand-600"
                  checked={form.hasCfdi} onChange={e => set('hasCfdi', e.target.checked)} />
                <span className="text-ink-secondary">Tengo la factura (CFDI)</span>
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">{form.hasCfdi ? 'Folio / Núm. factura' : 'Referencia'}</label>
                  <input className="input" value={form.documentNumber} onChange={e => set('documentNumber', e.target.value)} />
                </div>
                <div>
                  <label className="label">Fecha</label>
                  <input type="date" className="input" value={form.invoiceDate} onChange={e => set('invoiceDate', e.target.value)} />
                </div>
              </div>

              {form.hasCfdi && (
                <div>
                  <label className="label">UUID (folio fiscal)</label>
                  <input className="input font-mono text-xs" value={form.uuid} onChange={e => set('uuid', e.target.value)}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                </div>
              )}

              {breakdownMissing && !isPaid && (
                <div className="alert-warning text-xs">
                  Esta factura llegó <strong>sin desglose</strong> (total {fmtMXN(exp.total)}). Estimamos el
                  Subtotal e IVA al <strong>16%</strong> — verifícalos y ajústalos si la factura usa otra
                  tasa, luego <strong>Guardar cambios</strong>.
                </div>
              )}

              <div className="sm:max-w-[calc(50%-0.375rem)]">
                <label className="label">Moneda</label>
                <select className="select" value={form.currency} disabled={isPaid}
                  onChange={e => set('currency', e.target.value)}>
                  <option value="MXN">MXN — Pesos</option>
                  <option value="USD">USD — Dólares</option>
                </select>
                {form.currency === 'USD' && (
                  <p className="text-[10px] text-ink-muted mt-1">
                    El total en pesos se calcula con el tipo de cambio de la fecha del documento.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Subtotal</label>
                  <input type="number" step="0.01" min="0" className="input" inputMode="decimal" disabled={isPaid}
                    value={form.subtotal} onChange={e => set('subtotal', e.target.value)} />
                </div>
                <div>
                  <label className="label">IVA</label>
                  <input type="number" step="0.01" min="0" className="input" inputMode="decimal" disabled={isPaid}
                    value={form.tax} onChange={e => set('tax', e.target.value)} />
                </div>
              </div>

              <div className="flex justify-end">
                <div className="bg-brand-500/10 border border-brand-100 rounded-xl px-4 py-2 flex items-center gap-3">
                  <span className="text-sm text-ink-muted">Total</span>
                  <span className="text-base font-bold text-brand-300 tabular-nums">{fmtMXN(total)}</span>
                </div>
              </div>

              <div>
                <label className="label">Notas</label>
                <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
              </div>
            </fieldset>

            {/* Respaldo del CFDI (XML/PDF): lo guarda el buzón de correo y la carga
                manual; aquí se consulta, descarga y se puede adjuntar más. */}
            <ExpenseAttachments expenseId={id} canEdit={!isCancelled} />

            {error && <p className="field-error">{error}</p>}

            {/* Confirmación de cancelación */}
            {askCancel && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 flex flex-col gap-2">
                <p className="text-xs text-ink-secondary">
                  Se cancelará el gasto y su cuenta por pagar. No se borra (queda como “Cancelado”).
                </p>
                <input className="input" placeholder="Motivo (opcional)" value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)} />
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setAskCancel(false)}>No</button>
                  <button className="btn-danger flex-1" disabled={cancel.isPending}
                    onClick={() => { setError(null); cancel.mutate() }}>
                    {cancel.isPending ? <Spinner size="sm" /> : 'Sí, cancelar gasto'}
                  </button>
                </div>
              </div>
            )}

            {!isCancelled && !askCancel && (
              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <Can do="expenses:create">
                  <button className="btn-ghost text-status-danger sm:mr-auto" disabled={isPaid}
                    title={isPaid ? 'Reversa el pago antes de cancelar' : undefined}
                    onClick={() => setAskCancel(true)}>
                    Cancelar gasto
                  </button>
                </Can>
                <button className="btn-secondary" onClick={onClose}>Cerrar</button>
                <Can do="expenses:create">
                  <button className="btn-primary" disabled={save.isPending}
                    onClick={() => { setError(null); save.mutate() }}>
                    {save.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
                  </button>
                </Can>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Página ─────────────────────────────────────────────────────────────────
// ── Modal: buzón de facturas (correo entrante) ──────────────────────────────
function InboxModal({ onClose }) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [askRotate, setAskRotate] = useState(false)
  const [error, setError] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['expense-inbox'],
    queryFn:  () => purchasesApi.getExpenseInbox(),
  })

  const rotate = useMutation({
    mutationFn: () => purchasesApi.rotateExpenseInbox(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['expense-inbox'] }); setAskRotate(false) },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.address)
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard bloqueado: el usuario puede seleccionar a mano */ }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">📧 Buzón de facturas</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <p className="text-sm text-ink-secondary">
          Pide a tus proveedores que envíen sus facturas (CFDI <strong>XML</strong> o <strong>PDF</strong>)
          a esta dirección, o reenvíalas tú. Se registran como gastos automáticamente, emparejando al
          proveedor por su RFC.
        </p>

        {isLoading ? <Spinner /> : data && (
          <>
            <div className="flex flex-col gap-2">
              <label className="label">Tu dirección</label>
              <div className="flex items-stretch gap-2">
                <code className="input flex-1 font-mono text-sm flex items-center break-all">
                  {data.address}
                </code>
                <button type="button" onClick={copy} className="btn-secondary whitespace-nowrap">
                  {copied ? '✓ Copiado' : 'Copiar'}
                </button>
              </div>
            </div>

            {!data.active && (
              <div className="alert-warning text-xs">
                El buzón aún <strong>no está activo</strong>: falta terminar la configuración del
                correo entrante en el servidor. La dirección ya es tuya, pero todavía no recibe correos.
              </div>
            )}

            <div className="border-t border-line pt-3 flex flex-col gap-2">
              <p className="text-xs text-ink-muted">
                Si esta dirección recibe spam o se filtró, puedes generar una nueva.
                <strong> La anterior dejará de funcionar.</strong>
              </p>
              <Can do="settings:update">
                {!askRotate ? (
                  <button type="button" onClick={() => { setError(null); setAskRotate(true) }}
                    className="btn-ghost text-sm self-start text-danger">
                    Generar dirección nueva
                  </button>
                ) : (
                  <div className="flex flex-col gap-2 bg-surface-2 rounded-lg p-3">
                    <p className="text-sm text-ink-primary">
                      ¿Generar una dirección nueva? Tendrás que avisar a los proveedores que usaban la anterior.
                    </p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => rotate.mutate()} disabled={rotate.isPending}
                        className="btn-danger text-sm">
                        {rotate.isPending ? <Spinner size="sm" /> : 'Sí, generar nueva'}
                      </button>
                      <button type="button" onClick={() => setAskRotate(false)} className="btn-ghost text-sm">
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </Can>
            </div>
          </>
        )}

        {error && <div className="alert-error text-sm">{error}</div>}
      </div>
    </div>,
    document.body
  )
}

export default function Gastos() {
  const qc = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [showInbox, setShowInbox] = useState(false)
  const [detailId, setDetailId]   = useState(null)
  const [filterCat, setFilterCat] = useState('')
  const [filterCfdi, setFilterCfdi] = useState('')
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [page, setPage] = useState(1)
  const [msg, setMsg] = useState(null)
  const PAGE = 20

  const { from, to } = monthRange(month)

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories', 'active'],
    queryFn:  () => processConfigApi.listExpenseCategories({ isActive: true }),
  })

  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')

  // Cualquier cambio de filtro/orden vuelve a la página 1.
  useEffect(() => { setPage(1) }, [filterCat, filterCfdi, month, sortBy, sortDir])

  const { data: resp, isLoading } = useQuery({
    queryKey: ['expenses', filterCat, filterCfdi, from, to, sortBy, sortDir, page],
    queryFn:  () => purchasesApi.listExpenses({
      categoryId: filterCat || undefined,
      hasCfdi: filterCfdi || undefined,
      from, to,
      sortBy, sortDir,
      page, limit: PAGE,
    }),
  })
  const expenses = resp?.data || []
  const total = resp?.total || 0

  const { data: summary } = useQuery({
    queryKey: ['expenses-summary', filterCat, filterCfdi, from, to],
    queryFn:  () => purchasesApi.expensesSummary({
      categoryId: filterCat || undefined,
      hasCfdi: filterCfdi || undefined,
      from, to,
    }),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['expenses'] })
    qc.invalidateQueries({ queryKey: ['expenses-summary'] })
    qc.invalidateQueries({ queryKey: ['expense'] })
    qc.invalidateQueries({ queryKey: ['cxp'] })
    setMsg('Gasto guardado.'); setTimeout(() => setMsg(null), 2500)
  }

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Gastos</h1>
          <p className="page-subtitle">
            Gastos de proveedor: fletes, servicios, luz, renta, combustible, etc. Su IVA cuenta como acreditable.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Can do="expenses:read">
            <button onClick={() => setShowInbox(true)} className="btn-secondary w-full sm:w-auto">
              📧 Buzón de facturas
            </button>
          </Can>
          <Can do="expenses:create">
            <button onClick={() => setShowModal(true)} className="btn-primary w-full sm:w-auto">
              + Registrar gasto
            </button>
          </Can>
        </div>
      </div>

      {msg && <div className="alert-success text-sm">{msg}</div>}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
        <div className="min-w-[9rem]">
          <label className="label">Mes</label>
          <input type="month" className="input w-full" value={month} onChange={e => setMonth(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className="label">Categoría</label>
          <select className="select w-full" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
            <option value="">Todas</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[10rem]">
          <label className="label">Factura</label>
          <select className="select w-full" value={filterCfdi} onChange={e => setFilterCfdi(e.target.value)}>
            <option value="">Todas</option>
            <option value="yes">Con factura</option>
            <option value="no">Sin factura</option>
          </select>
        </div>
      </div>

      {/* Resumen: ¿en qué se va el dinero? */}
      {summary && summary.count > 0 && (
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <p className="text-xs text-ink-muted capitalize">Total · {monthLabel(month)}</p>
              <p className="text-2xl font-bold text-ink-primary tabular-nums">{fmtMXN(summary.total_mxn)}</p>
              <p className="text-[11px] text-ink-muted">{summary.count} gasto(s){!month && ' · todo el historial'}</p>
            </div>
            {summary.sin_cfdi_mxn > 0 && (
              <span className="badge-amber">Sin factura: {fmtMXN(summary.sin_cfdi_mxn)}</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {summary.by_category.map(c => {
              const pct = summary.total_mxn > 0 ? (c.total_mxn / summary.total_mxn) * 100 : 0
              return (
                <button key={c.category_id || 'none'} type="button"
                  onClick={() => setFilterCat(c.category_id || '')}
                  className="flex items-center gap-2 text-left hover:bg-surface-elevated/40 rounded px-1 -mx-1">
                  <span className="text-xs text-ink-secondary w-36 sm:w-44 truncate shrink-0">{c.category_name}</span>
                  <div className="flex-1 h-2 bg-surface-elevated/60 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500/60 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-mono tabular-nums text-ink-primary w-20 sm:w-24 text-right shrink-0">{fmtMXN(c.total_mxn)}</span>
                  <span className="text-[10px] text-ink-muted w-8 text-right shrink-0">{pct.toFixed(0)}%</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Lista */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : expenses.length === 0 ? (
        <div className="card py-12 text-center text-sm text-ink-muted">
          Sin gastos registrados. Crea el primero con “Registrar gasto”.
        </div>
      ) : (
        <>
          {/* Móvil: tarjetas */}
          <div className="flex flex-col gap-3 md:hidden">
            {expenses.map(e => (
              <div key={e.id} onClick={() => setDetailId(e.id)}
                className="card p-4 flex flex-col gap-2 cursor-pointer active:bg-surface-elevated/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink-primary break-words">{e.partner_name || e.generic_supplier || '—'}</p>
                    <p className="text-xs text-ink-muted">{e.expense_category_name || 'Sin categoría'} · {fmtDateOnly(e.invoice_date)}</p>
                  </div>
                  <span className="text-base font-bold text-ink-primary whitespace-nowrap shrink-0 tabular-nums">{fmtMXN(e.total_mxn || e.total)}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <CfdiBadge has={e.has_cfdi} />
                  <PagoBadge status={e.ap_status || e.status} />
                  {methodLabel(e.payment_method) && <span className="badge-gray">{methodLabel(e.payment_method)}</span>}
                  {e.is_overdue && <span className="badge-red">Vencido</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Escritorio: tabla */}
          <div className="card p-0 overflow-x-auto hidden md:block">
            <table className="table min-w-[640px]">
              <thead>
                <tr>
                  <SortableHeader sortKey="proveedor" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Proveedor</SortableHeader>
                  <th>Categoría</th>
                  <SortableHeader sortKey="fecha"     sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Fecha</SortableHeader>
                  <SortableHeader sortKey="total"     sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right">Total</SortableHeader>
                  <th>Factura</th>
                  <th>Pago</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(e => (
                  <tr key={e.id} onClick={() => setDetailId(e.id)}
                    className="cursor-pointer hover:bg-surface-elevated/40">
                    <td className="font-medium text-ink-primary">{e.partner_name || e.generic_supplier || '—'}</td>
                    <td className="text-ink-secondary">{e.expense_category_name || '—'}</td>
                    <td className="text-ink-secondary">{fmtDateOnly(e.invoice_date)}</td>
                    <td className="text-right font-mono tabular-nums">{fmtMXN(e.total_mxn || e.total)}</td>
                    <td><CfdiBadge has={e.has_cfdi} /></td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <PagoBadge status={e.ap_status || e.status} />
                        {e.is_overdue && <span className="badge-red">Vencido</span>}
                      </div>
                      {methodLabel(e.payment_method) && (
                        <span className="text-[10px] text-ink-muted">{methodLabel(e.payment_method)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {total > PAGE && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                Mostrando {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} de {total}
              </p>
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                  className="btn-secondary btn-sm disabled:opacity-40">← Anterior</button>
                <button disabled={page * PAGE >= total} onClick={() => setPage(p => p + 1)}
                  className="btn-secondary btn-sm disabled:opacity-40">Siguiente →</button>
              </div>
            </div>
          )}
        </>
      )}

      {showModal && (
        <GastoModal categories={categories} onClose={() => setShowModal(false)} onSaved={handleSaved} />
      )}
      {detailId && (
        <GastoDetalleModal id={detailId} categories={categories}
          onClose={() => setDetailId(null)} onSaved={handleSaved} />
      )}
      {showInbox && <InboxModal onClose={() => setShowInbox(false)} />}
    </div>
  )
}
