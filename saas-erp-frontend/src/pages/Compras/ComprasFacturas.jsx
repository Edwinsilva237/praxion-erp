import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { purchasesApi } from '@/api/purchases'
import { partnersApi } from '@/api/partners'
import { PagoProveedorModal } from '@/components/finanzas/PagoProveedorModal'
import { FacturaProveedorDetallePanel } from '@/components/compras/FacturaProveedorDetallePanel'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

const fmtMXN  = (n) => n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`
// Fechas de calendario sin desfase de zona horaria (ver utils/fmt fmtDateOnly).
const fmtDate = (d) => {
  if (!d) return '—'
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-').map(Number)
  if (s.length === 10 && y && m && day)
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
}

const RECON_LABEL = { reconciled: 'Conciliada', with_diff: 'Con diferencia', pending: 'Pendiente' }
const RECON_COLOR = { reconciled: 'green', with_diff: 'amber', pending: 'gray' }

// ── Modal: alta rápida de proveedor (con prefill del XML) ──────────────────
function AltaProveedorRapidoModal({ prefill, onClose, onCreated }) {
  const [name, setName]         = useState(prefill?.name || '')
  const [rfc, setRfc]           = useState(prefill?.rfc || '')
  const [taxName, setTaxName]   = useState(prefill?.name || '')
  const [taxRegimeCode, setRegime] = useState(prefill?.regime || '')
  const [zipCode, setZip]       = useState(prefill?.zipCode || '')
  const [error, setError]       = useState(null)

  const mutation = useMutation({
    mutationFn: () => partnersApi.create({
      type: 'supplier',
      name: name.trim(),
      taxName: taxName.trim() || name.trim(),
      rfc: rfc.trim().toUpperCase() || null,
      taxRegimeCode: taxRegimeCode.trim() || null,
      zipCode: zipCode.trim() || null,
    }),
    onSuccess: (partner) => {
      onCreated(partner)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear proveedor'),
  })

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('El nombre es requerido.'); return }
    mutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Alta rápida de proveedor</h2>
            <p className="text-xs text-ink-muted mt-0.5">Datos extraídos del CFDI — edita lo necesario</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div>
          <label className="label">Nombre comercial <span className="text-status-danger">*</span></label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
            placeholder="Como aparece en el catálogo" autoFocus />
        </div>

        <div>
          <label className="label">Razón social</label>
          <input className="input" value={taxName} onChange={e => setTaxName(e.target.value)}
            placeholder="Como aparece en el CFDI" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">RFC</label>
            <input className="input font-mono uppercase" value={rfc}
              onChange={e => setRfc(e.target.value.toUpperCase())}
              maxLength={13} placeholder="XAXX010101000" />
          </div>
          <div>
            <label className="label">Régimen fiscal</label>
            <input className="input font-mono" value={taxRegimeCode}
              onChange={e => setRegime(e.target.value)}
              maxLength={3} placeholder="601" />
          </div>
        </div>

        <div>
          <label className="label">Código postal fiscal</label>
          <input className="input" value={zipCode} onChange={e => setZip(e.target.value)}
            maxLength={5} placeholder="01000" />
        </div>

        <p className="text-[11px] text-ink-muted">
          Podrás completar los datos restantes (contactos, datos bancarios, dirección) después en Socios de negocio.
        </p>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !name.trim()}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Crear proveedor'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

// ── Paso 0: Elegir método de captura ──────────────────────────────────────────
function StepChooseMethod({ onPick, onClose }) {
  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => onPick('xml')}
        className="group flex items-center gap-4 p-4 rounded-xl border-2 border-line-subtle hover:border-brand-500/40 hover:bg-brand-500/10 transition-all text-left"
      >
        <div className="w-11 h-11 rounded-xl bg-brand-500/15 group-hover:bg-brand-200 flex items-center justify-center shrink-0">
          <svg className="w-5 h-5 text-brand-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-ink-primary">Cargar XML (CFDI) o PDF</p>
          <p className="text-xs text-ink-muted mt-0.5">Auto-llenado desde el CFDI 4.0 (XML) o extracción de datos de una factura en PDF</p>
        </div>
        <svg className="w-4 h-4 text-ink-muted group-hover:text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
        </svg>
      </button>

      <button
        onClick={() => onPick('manual')}
        className="group flex items-center gap-4 p-4 rounded-xl border-2 border-line-subtle hover:border-status-warning/40 hover:bg-status-warning/10 transition-all text-left"
      >
        <div className="w-11 h-11 rounded-xl bg-status-warning/15 group-hover:bg-amber-200 flex items-center justify-center shrink-0">
          <svg className="w-5 h-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-ink-primary">Captura manual</p>
          <p className="text-xs text-ink-muted mt-0.5">Para facturas/remisiones sin XML o cuando el CFDI no se puede procesar</p>
        </div>
        <svg className="w-4 h-4 text-ink-muted group-hover:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
        </svg>
      </button>

      <button onClick={onClose} className="btn-secondary mt-2">Cancelar</button>
    </div>
  )
}

// ── Paso 1a: Captura manual ──────────────────────────────────────────────────
function StepManualEntry({ onCaptured, onBack, onClose }) {
  const [partner, setPartner]   = useState(null)
  const [docType, setDocType]   = useState('invoice')   // 'invoice' | 'remission'
  const [serie, setSerie]       = useState('')
  const [folio, setFolio]       = useState('')
  const [uuid, setUuid]         = useState('')
  const [rfcEmisor, setRfc]     = useState('')
  const [invoiceDate, setDate]  = useState(() => new Date().toISOString().split('T')[0])
  const [currency, setCurrency] = useState('MXN')
  const [subtotal, setSubtotal] = useState('')
  const [applyTax, setApplyTax] = useState(true)
  const [taxOverride, setTaxOverride] = useState('')   // permitir IVA manual
  const [error, setError]       = useState(null)

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  // Auto-llenar RFC al elegir proveedor
  function handlePartnerChange(p) {
    setPartner(p)
    if (p?.sub && !rfcEmisor) setRfc(p.sub)
  }

  const sub = parseFloat(subtotal) || 0
  const tax = taxOverride !== '' ? (parseFloat(taxOverride) || 0)
            : applyTax ? +(sub * 0.16).toFixed(2)
            : 0
  const total = +(sub + tax).toFixed(2)

  function handleContinue() {
    setError(null)
    if (!partner?.id) { setError('Selecciona un proveedor.'); return }
    if (!folio.trim()) { setError('El folio es requerido.'); return }
    if (!invoiceDate) { setError('La fecha es requerida.'); return }
    if (sub <= 0) { setError('Captura un subtotal válido.'); return }

    const documentNumber = [serie, folio].filter(Boolean).join('-')
    onCaptured({
      matchedPartner: { id: partner.id, name: partner.label, rfc: partner.sub || rfcEmisor || null },
      emisor:      { name: partner.label, rfc: rfcEmisor || partner.sub || null },
      uuid:        uuid.trim() || null,
      serie:       serie.trim() || null,
      folio:       folio.trim(),
      invoiceDate, currency,
      subtotal:    sub,
      tax,
      total,
      lines:       [],
      // Pasamos también el tipo de documento — el StepReconcile lo respeta
      documentType: docType,
      documentNumber,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="label">Proveedor <span className="text-status-danger">*</span></label>
        <Autocomplete value={partner} onChange={handlePartnerChange}
          onSearch={searchPartners} placeholder="Buscar proveedor..." />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Tipo de documento</label>
          <select className="select" value={docType} onChange={e => setDocType(e.target.value)}>
            <option value="invoice">Factura</option>
            <option value="remission">Remisión / Nota</option>
          </select>
        </div>
        <div>
          <label className="label">Fecha emisión <span className="text-status-danger">*</span></label>
          <input type="date" className="input" value={invoiceDate}
            onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Serie</label>
          <input className="input" value={serie} onChange={e => setSerie(e.target.value)}
            placeholder="A" maxLength={10} />
        </div>
        <div className="col-span-2">
          <label className="label">Folio <span className="text-status-danger">*</span></label>
          <input className="input" value={folio} onChange={e => setFolio(e.target.value)}
            placeholder="1042" maxLength={20} />
        </div>
      </div>

      {docType === 'invoice' && (
        <>
          <div>
            <label className="label">UUID SAT <span className="text-ink-muted text-xs">(opcional si la factura no se timbró todavía)</span></label>
            <input className="input font-mono text-xs" value={uuid} onChange={e => setUuid(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000" maxLength={36} />
          </div>
          <div>
            <label className="label">RFC emisor</label>
            <input className="input font-mono uppercase" value={rfcEmisor}
              onChange={e => setRfc(e.target.value.toUpperCase())}
              placeholder="XAXX010101000" maxLength={13} />
          </div>
        </>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Moneda</label>
          <select className="select" value={currency} onChange={e => setCurrency(e.target.value)}>
            <option value="MXN">MXN</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div>
          <label className="label">Subtotal <span className="text-status-danger">*</span></label>
          <input type="number" step="0.01" min="0" inputMode="decimal" className="input"
            value={subtotal} onChange={e => setSubtotal(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className="label">
            IVA
            <span className="text-ink-muted text-xs"> (16% auto)</span>
          </label>
          <input type="number" step="0.01" min="0" inputMode="decimal" className="input"
            value={taxOverride !== '' ? taxOverride : (applyTax ? tax.toFixed(2) : '0.00')}
            onChange={e => setTaxOverride(e.target.value)}
            placeholder="0.00" />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink-secondary">
        <input type="checkbox" className="w-4 h-4 accent-brand-600"
          checked={applyTax}
          onChange={e => { setApplyTax(e.target.checked); setTaxOverride('') }} />
        Aplicar IVA 16% automáticamente
      </label>

      <div className="bg-surface-elevated/40 rounded-xl p-3 flex items-center justify-between">
        <span className="text-sm font-medium text-ink-secondary">Total</span>
        <span className="text-lg font-mono font-bold text-ink-primary">{fmtMXN(total)}</span>
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="flex gap-2">
        <button onClick={onBack} className="btn-secondary flex-1">← Atrás</button>
        <button onClick={handleContinue} className="btn-primary flex-1">
          Continuar →
        </button>
      </div>
    </div>
  )
}

// ── Paso 1: Subir XML ─────────────────────────────────────────────────────────
function StepUploadXML({ onParsed, onBack, onClose }) {
  const [dragging, setDragging]   = useState(false)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)

  async function parseFile(file) {
    if (!file) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.xml') && !lower.endsWith('.pdf')) {
      setError('Solo se aceptan archivos XML (CFDI) o PDF (factura).'); return
    }
    setLoading(true); setError(null)
    try {
      // Vía axios (purchasesApi) — NO fetch nativo con URL relativa (rompía en prod).
      // /parse-document acepta XML (CFDI) y PDF (factura escaneada → extracción por
      // IA, igual que el CSF). Devuelve los datos + el proveedor por RFC.
      const form = new FormData()
      form.append('file', file)
      const data = await purchasesApi.parseDocument(form)
      // Pasamos también el archivo original para guardarlo como respaldo al crear.
      onParsed(data, file)
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Error al procesar el documento')
    } finally { setLoading(false) }
  }

  function handleDrop(e) {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    parseFile(file)
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={clsx(
          'border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer',
          dragging ? 'border-brand-500/40 bg-brand-500/10' : 'border-line-subtle hover:border-brand-500/40 hover:bg-surface-elevated/40'
        )}
        onClick={() => document.getElementById('xml-input').click()}
      >
        <input id="xml-input" type="file" accept=".xml,.pdf" className="hidden"
          onChange={e => parseFile(e.target.files[0])} />
        {loading ? (
          <div className="flex flex-col items-center gap-2">
            <Spinner />
            <p className="text-sm text-ink-muted">Procesando documento...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <svg className="w-10 h-10 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-ink-secondary">Arrastra el XML o PDF aquí o haz clic para seleccionar</p>
            <p className="text-xs text-ink-muted">CFDI 4.0 (.xml) o factura en PDF (.pdf) — del PDF extraemos los datos automáticamente</p>
          </div>
        )}
      </div>
      {error && <p className="field-error text-center">{error}</p>}
      <div className="flex gap-2">
        <button onClick={onBack} className="btn-secondary flex-1">← Atrás</button>
        <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
      </div>
    </div>
  )
}

// ── Paso 2: Conciliación ──────────────────────────────────────────────────────
function StepReconcile({ parsed, originalFile, onClose, onSaved }) {
  const qc = useQueryClient()
  const [partner, setPartner]         = useState(parsed.matchedPartner
    ? { id: parsed.matchedPartner.id, label: parsed.matchedPartner.name, sub: parsed.matchedPartner.rfc }
    : null)
  const [selectedReceipts, setSelRec] = useState([])
  const [validatedLines, setValidatedLines] = useState(() => new Set())
  const [docType, setDocType]         = useState(parsed.documentType || 'invoice')
  const [notes, setNotes]             = useState('')
  const [error, setError]             = useState(null)
  const [showQuickAlta, setShowQuickAlta] = useState(false)

  // Solo ofrecemos el "Dar de alta" cuando el XML trae nombre o RFC del
  // emisor y aún no hay proveedor seleccionado (matched o manual).
  const canQuickAdd = !partner && !!(parsed.emisor?.rfc || parsed.emisor?.name)

  // Detalle de cada recepción seleccionada (líneas) — fetch en paralelo
  const receiptDetailQueries = useQueries({
    queries: selectedReceipts.map(rid => ({
      queryKey: ['receipt-detail', rid],
      queryFn:  () => purchasesApi.getReceipt(rid),
      staleTime: 60_000,
    })),
  })

  const allReceiptLines = useMemo(() => {
    const all = []
    receiptDetailQueries.forEach((q, idx) => {
      const r = q.data
      if (!r?.lines) return
      r.lines.forEach(l => all.push({
        ...l,
        _key: `${r.id}::${l.id}`,
        _receiptId: r.id,
        _receiptNumber: r.receipt_number,
        // Línea facturable: aún sin factura REAL activa (mig 202). Las líneas ya
        // cubiertas por una factura real se muestran como informativas, no se
        // pueden volver a facturar.
        _pending: l.invoice_pending !== false,
      }))
    })
    return all
  }, [receiptDetailQueries.map(q => q.data?.id).join('|')])

  // Solo las líneas PENDIENTES (sin factura real) entran a la factura. Los checks
  // de la tabla SELECCIONAN qué líneas cubre esta factura — facturación parcial por
  // línea completa (mig 202). Por defecto se marcan TODAS las pendientes (= toda la
  // recepción, el caso común); el usuario desmarca las que no van en esta factura.
  const pendingLines = useMemo(
    () => allReceiptLines.filter(l => l._pending),
    [allReceiptLines]
  )
  const pendingKeysSig = pendingLines.map(l => l._key).join('|')

  const loadingReceiptDetails = receiptDetailQueries.some(q => q.isLoading)
  const allPendingSelected = pendingLines.length > 0
    && pendingLines.every(l => validatedLines.has(l._key))

  function toggleLine(key) {
    setValidatedLines(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }
  function toggleAllLines() {
    setValidatedLines(prev => {
      if (allPendingSelected) return new Set()
      return new Set(pendingLines.map(l => l._key))
    })
  }

  // Siembra por defecto: cuando las líneas de una recepción recién seleccionada
  // terminan de cargar, marcamos TODAS sus líneas pendientes. Un ref recuerda qué
  // recepciones ya sembramos para no re-marcar lo que el usuario desmarcó a mano.
  const seededRef = useRef(new Set())
  const loadedReceiptIds = receiptDetailQueries.filter(q => q.data?.id).map(q => q.data.id)
  const loadedSig = loadedReceiptIds.join('|')
  useEffect(() => {
    // Al deseleccionar una recepción, olvidamos su siembra para re-sembrar si vuelve.
    for (const rid of [...seededRef.current]) {
      if (!selectedReceipts.includes(rid)) seededRef.current.delete(rid)
    }
    setValidatedLines(prev => {
      const next = new Set(prev)
      const pendingKeys = new Set(pendingLines.map(l => l._key))
      // Poda: quita checks de líneas que ya no están / ya no son facturables.
      for (const k of [...next]) if (!pendingKeys.has(k)) next.delete(k)
      // Siembra: recepciones recién cargadas marcan sus líneas pendientes.
      for (const rid of loadedReceiptIds) {
        if (seededRef.current.has(rid)) continue
        seededRef.current.add(rid)
        pendingLines.filter(l => l._receiptId === rid).forEach(l => next.add(l._key))
      }
      return next.size === prev.size && [...next].every(k => prev.has(k)) ? prev : next
    })
  }, [loadedSig, pendingKeysSig, selectedReceipts.join('|')])

  // Recepciones pendientes del proveedor. SIEMPRE fresco al abrir: el staleTime
  // global (1 min) hacía que al confirmar recepciones y abrir el modal enseguida
  // se mostrara la lista cacheada vieja (faltaban las recién confirmadas) hasta
  // que venciera el min o cambiara el foco. staleTime:0 + refetchOnMount:'always'
  // garantiza que cada vez que se abre el selector se consulte la lista actual.
  const { data: pendingReceiptsRaw, isLoading: loadingRec } = useQuery({
    queryKey: ['receipts-pending', partner?.id],
    queryFn: () => purchasesApi.listPendingInvoiceReceipts(partner?.id),
    enabled: true,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const pendingReceipts = Array.isArray(pendingReceiptsRaw) ? pendingReceiptsRaw : []

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  function toggleReceipt(id) {
    setSelRec(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // Líneas que ESTA factura va a cubrir (las marcadas). Facturación parcial: el
  // valor a conciliar es el de las líneas elegidas, no el de toda la recepción.
  const selectedLines = useMemo(
    () => allReceiptLines.filter(l => l._pending && validatedLines.has(l._key)),
    [allReceiptLines, validatedLines]
  )
  const totalReceipts = selectedLines.reduce((s, l) => s + parseFloat(l.subtotal || 0), 0)
  const selectedLineIds = selectedLines.map(l => l.id)
  // ¿Es factura parcial? (hay líneas pendientes que NO entran en esta factura)
  const isPartial = pendingLines.length > 0 && selectedLines.length < pendingLines.length

  // Conciliar SIN IVA contra SIN IVA: subtotal de la factura vs subtotal de las
  // líneas seleccionadas (su valor de mercancía, sin IVA).
  const invoiceSubtotal = parseFloat(parsed.subtotal) || (parseFloat(parsed.total || 0) - parseFloat(parsed.tax || 0))
  const diff = parseFloat((invoiceSubtotal - totalReceipts).toFixed(2))
  const reconStatus = selectedLines.length === 0 ? 'pending'
                    : Math.abs(diff) < 0.01 ? 'reconciled' : 'with_diff'

  const folio = parsed.documentNumber
             || [parsed.serie, parsed.folio].filter(Boolean).join('-')
             || parsed.uuid?.slice(-8)
             || 'SIN-FOLIO'

  const mutation = useMutation({
    mutationFn: () => purchasesApi.createInvoice({
      supplierId:    partner?.id || null,
      genericSupplier: !partner ? (parsed.emisor?.name || null) : null,
      documentType:  docType,
      documentNumber: folio,
      // Si el usuario marca remisión, ignoramos los datos fiscales aunque el
      // XML los traiga — la remisión no es CFDI.
      uuidSat:       docType === 'remission' ? null : (parsed.uuid || null),
      serie:         parsed.serie || null,
      folio:         parsed.folio || null,
      rfcEmisor:     docType === 'remission' ? null : (parsed.emisor?.rfc || null),
      invoiceDate:   parsed.invoiceDate,
      currency:      parsed.currency || 'MXN',
      subtotal:      parsed.subtotal,
      tax:           parsed.tax,
      total:         parsed.total,
      receiptIds:    selectedReceipts,
      // Facturación PARCIAL por línea (mig 202): si NO se marcaron todas las
      // líneas pendientes, mandamos los IDs exactos. Si se marcaron todas,
      // omitimos receiptLineIds → el backend factura la recepción completa.
      receiptLineIds: isPartial ? selectedLineIds : undefined,
      xmlContent:    null, // no guardamos el XML completo por ahora
      notes:         notes || null,
    }),
    onSuccess: async (invoice) => {
      // Guardar el XML/PDF original como respaldo adjunto de la factura. Best-effort:
      // si falla, la factura ya quedó creada (se puede adjuntar luego desde el detalle).
      if (originalFile && invoice?.id) {
        try {
          const fd = new FormData()
          fd.append('file', originalFile)
          await purchasesApi.addInvoiceAttachment(invoice.id, fd)
        } catch { /* el respaldo es opcional; no bloquea el alta */ }
      }
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] })
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['receipts-pending'] })
      onSaved(invoice)
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || 'Error al guardar'),
  })

  return (
    <div className="flex flex-col gap-5">

      {/* Tipo de documento */}
      <div>
        <label className="label">Tipo de documento <span className="text-status-danger">*</span></label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setDocType('invoice')}
            className={clsx(
              'p-3 rounded-xl border-2 text-left transition-colors',
              docType === 'invoice'
                ? 'border-brand-500/40 bg-brand-500/10 ring-2 ring-brand-100'
                : 'border-line-subtle hover:border-line-strong'
            )}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold">Factura (CFDI)</span>
              {docType === 'invoice' && <span className="text-brand-300 text-xs">✓</span>}
            </div>
            <p className="text-[11px] text-ink-muted">Comprobante fiscal con sustento para deducción</p>
          </button>
          <button type="button" onClick={() => setDocType('remission')}
            className={clsx(
              'p-3 rounded-xl border-2 text-left transition-colors',
              docType === 'remission'
                ? 'border-purple-400 bg-purple-500/10 ring-2 ring-purple-100'
                : 'border-line-subtle hover:border-line-strong'
            )}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold">Remisión / Nota</span>
              {docType === 'remission' && <span className="text-purple-300 text-xs">✓</span>}
            </div>
            <p className="text-[11px] text-ink-muted">Documento no fiscal — sin CFDI ni deducible</p>
          </button>
        </div>
        {docType === 'remission' && parsed.uuid && (
          <p className="text-[11px] text-status-warning mt-2">
            ⚠ El XML trae UUID SAT pero estás marcando como remisión. El UUID se ignorará al guardar.
          </p>
        )}
      </div>

      {/* Datos del XML */}
      <div className="bg-status-success/10 border border-status-success/40 rounded-xl p-4">
        <p className="text-xs font-semibold text-status-success uppercase tracking-wide mb-3">
          {parsed.method === 'xml' ? '✓ XML procesado' : '✓ Captura manual'}
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div className="text-ink-muted">Emisor</div>
          <div className="font-medium text-ink-primary">{parsed.emisor?.name || '—'}</div>
          <div className="text-ink-muted">RFC</div>
          <div className="font-mono text-ink-secondary">{parsed.emisor?.rfc || '—'}</div>
          <div className="text-ink-muted">Folio</div>
          <div className="font-mono text-ink-secondary">{folio}</div>
          <div className="text-ink-muted">Fecha</div>
          <div className="text-ink-secondary">{fmtDate(parsed.invoiceDate)}</div>
          <div className="text-ink-muted">Subtotal</div>
          <div className="font-mono text-ink-secondary">{fmtMXN(parsed.subtotal)}</div>
          <div className="text-ink-muted">IVA</div>
          <div className="font-mono text-ink-secondary">{fmtMXN(parsed.tax)}</div>
          <div className="text-ink-muted font-semibold">Total</div>
          <div className="font-mono font-bold text-ink-primary">{fmtMXN(parsed.total)}</div>
        </div>
        {parsed.uuid && <p className="text-[10px] text-status-success mt-2 font-mono">UUID: {parsed.uuid}</p>}
      </div>

      {/* Proveedor */}
      <div>
        <label className="label">
          Proveedor en sistema
          {partner && parsed.matchedPartner && partner.id === parsed.matchedPartner.id
            ? <span className="ml-2 text-xs text-status-success font-normal">✓ encontrado por RFC</span>
            : partner
              ? <span className="ml-2 text-xs text-status-info font-normal">✎ seleccionado manualmente</span>
              : <span className="ml-2 text-xs text-status-warning font-normal">⚠ RFC no encontrado — selecciona o da de alta</span>
          }
        </label>
        <div className="flex gap-2">
          <div className="flex-1">
            <Autocomplete value={partner} onChange={p => { setPartner(p); setSelRec([]) }}
              onSearch={searchPartners} placeholder="Buscar proveedor..." />
          </div>
          {canQuickAdd && (
            <button type="button" onClick={() => setShowQuickAlta(true)}
              className="btn-secondary whitespace-nowrap"
              title="Crear el proveedor con los datos del CFDI">
              + Dar de alta
            </button>
          )}
        </div>
        {canQuickAdd && (
          <p className="text-[11px] text-status-warning mt-1">
            Datos del XML: <strong>{parsed.emisor?.name || '(sin nombre)'}</strong>
            {parsed.emisor?.rfc && <> · RFC <span className="font-mono">{parsed.emisor.rfc}</span></>}
            {parsed.emisor?.regime && <> · Régimen {parsed.emisor.regime}</>}
          </p>
        )}
      </div>

      {/* Conceptos del XML */}
      {parsed.lines?.length > 0 && (
        <div>
          <p className="label">Conceptos del XML</p>
          <div className="border border-line-subtle rounded-xl overflow-hidden">
            <table className="table text-xs">
              <thead><tr><th>Descripción</th><th className="text-right">Cant.</th><th className="text-right">Precio unit.</th><th className="text-right">Importe</th></tr></thead>
              <tbody>
                {parsed.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="text-ink-secondary">{l.description}</td>
                    <td className="text-right font-mono">{l.quantity} {l.unit}</td>
                    <td className="text-right font-mono">{fmtMXN(l.unitPrice)}</td>
                    <td className="text-right font-mono font-medium">{fmtMXN(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recepciones a conciliar */}
      <div>
        <p className="label">Recepciones a conciliar</p>
        {loadingRec ? (
          <div className="flex justify-center py-4"><Spinner size="sm" /></div>
        ) : pendingReceipts.length === 0 ? (
          <div className="border border-dashed border-line-subtle rounded-xl p-4 text-center">
            <p className="text-sm text-ink-muted">
              {partner ? 'No hay recepciones confirmadas pendientes de este proveedor' : 'Selecciona un proveedor para ver sus recepciones'}
            </p>
          </div>
        ) : (
          <div className="border border-line-subtle rounded-xl overflow-hidden">
            <table className="table text-sm">
              <thead>
                <tr>
                  <th className="w-10"></th>
                  <th>Recepción</th>
                  <th>Fecha</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {pendingReceipts.map(r => (
                  <tr key={r.id} className={clsx('cursor-pointer', selectedReceipts.includes(r.id) && 'bg-brand-500/10')}
                    onClick={() => toggleReceipt(r.id)}>
                    <td>
                      <input type="checkbox" className="w-4 h-4 accent-brand-600" readOnly
                        checked={selectedReceipts.includes(r.id)} />
                    </td>
                    <td className="font-mono font-medium text-brand-300">
                      {r.receipt_number}
                      {r.has_remission && (
                        <span className="ml-2 inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-status-info/15 text-status-info align-middle"
                          title="Ya tiene una CXP sin factura (remisión). Al registrar esta factura, esa CXP se reemplaza automáticamente.">
                          ↻ CXP s/f
                        </span>
                      )}
                    </td>
                    <td className="text-ink-muted">{fmtDate(r.received_date)}</td>
                    <td className="text-right font-mono">{fmtMXN(r.total_mxn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Resultado de conciliación */}
      {selectedLines.length > 0 && (
        <div className={clsx(
          'rounded-xl p-4 flex flex-col gap-2',
          reconStatus === 'reconciled' ? 'bg-status-success/10 border border-status-success/40' : 'bg-status-warning/10 border border-status-warning/40'
        )}>
          <p className={clsx('text-xs font-semibold uppercase tracking-wide',
            reconStatus === 'reconciled' ? 'text-status-success' : 'text-status-warning')}>
            {reconStatus === 'reconciled' ? '✓ Conciliación exacta' : '⚠ Diferencia detectada'}
          </p>
          <div className="grid grid-cols-2 gap-1 text-sm">
            <span className="text-ink-secondary">Subtotal factura (sin IVA)</span>
            <span className="text-right font-mono font-semibold">{fmtMXN(invoiceSubtotal)}</span>
            <span className="text-ink-secondary">
              {isPartial ? `Líneas seleccionadas (${selectedLines.length}/${pendingLines.length})` : 'Recepciones'} (sin IVA)
            </span>
            <span className="text-right font-mono">{fmtMXN(totalReceipts)}</span>
            {reconStatus !== 'reconciled' && (
              <>
                <span className="font-semibold text-status-warning">Diferencia</span>
                <span className={clsx('text-right font-mono font-bold', diff > 0 ? 'text-status-danger' : 'text-status-success')}>
                  {diff > 0 ? '+' : ''}{fmtMXN(diff)}
                </span>
              </>
            )}
          </div>
          {isPartial && (
            <p className="text-xs text-status-info">
              ◑ Facturación parcial: las líneas no marcadas quedan pendientes y se pueden facturar después con otra factura.
            </p>
          )}
          {reconStatus !== 'reconciled' && (
            <p className="text-xs text-status-warning">La factura se guardará con estado "Con diferencia". Puedes agregar más recepciones o líneas después.</p>
          )}
        </div>
      )}

      {/* Líneas a facturar (selección por línea = facturación parcial) */}
      {selectedReceipts.length > 0 && (
        <div className="border border-line-subtle rounded-xl">
          <div className="px-4 py-3 border-b border-line-subtle flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-ink-secondary">Líneas a facturar</p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                Marca los productos que cubre esta factura. Desmarca los que se facturarán por separado.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={clsx(
                'text-xs font-semibold tabular-nums',
                allPendingSelected ? 'text-status-success'
                  : selectedLines.length > 0 ? 'text-status-warning'
                  : 'text-ink-muted'
              )}>
                {selectedLines.length} / {pendingLines.length}
              </span>
              {pendingLines.length > 0 && (
                <button type="button" onClick={toggleAllLines}
                  className="btn-ghost btn-sm text-xs">
                  {allPendingSelected ? 'Desmarcar' : 'Marcar todas'}
                </button>
              )}
            </div>
          </div>

          {loadingReceiptDetails ? (
            <div className="flex justify-center py-6"><Spinner size="sm" /></div>
          ) : allReceiptLines.length === 0 ? (
            <p className="px-4 py-4 text-xs text-ink-muted italic text-center">
              Las recepciones seleccionadas no tienen líneas registradas.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th className="w-8"></th>
                    <th>Recepción</th>
                    <th>Descripción</th>
                    <th className="text-right">Cantidad</th>
                    <th className="text-right">P. Unit.</th>
                    <th className="text-right">Importe</th>
                  </tr>
                </thead>
                <tbody>
                  {allReceiptLines.map(l => {
                    const pending = l._pending
                    const checked = pending && validatedLines.has(l._key)
                    return (
                      <tr key={l._key}
                        onClick={() => pending && toggleLine(l._key)}
                        className={clsx(
                          pending ? 'cursor-pointer' : 'opacity-55',
                          checked ? 'bg-status-success/10/60'
                            : pending ? 'hover:bg-surface-elevated/40' : '')}>
                        <td>
                          {pending ? (
                            <input type="checkbox" className="w-4 h-4 accent-green-600"
                              checked={checked} readOnly />
                          ) : (
                            <span className="text-status-success text-xs" title="Ya facturada">✓</span>
                          )}
                        </td>
                        <td className="font-mono text-[10px] text-ink-muted">
                          {l._receiptNumber}
                        </td>
                        <td className="text-ink-secondary">
                          {l.item_name || l.description}
                          {l.item_name && l.description && l.description !== l.item_name && (
                            <span className="block text-[10px] text-ink-muted">{l.description}</span>
                          )}
                          {!pending && (
                            <span className="block text-[10px] text-status-success">
                              Ya facturada{l.invoiced_number ? ` · ${l.invoiced_number}` : ''}
                            </span>
                          )}
                        </td>
                        <td className="text-right font-mono">
                          {Number(l.quantity_received).toLocaleString('es-MX', { maximumFractionDigits: 4 })}
                          <span className="text-ink-muted text-[10px] ml-1">{l.unit}</span>
                        </td>
                        <td className="text-right font-mono text-ink-secondary">{fmtMXN(l.unit_price)}</td>
                        <td className="text-right font-mono font-medium">{fmtMXN(l.subtotal)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="label">Notas</label>
        <input className="input" placeholder="Observaciones opcionales..." value={notes} onChange={e => setNotes(e.target.value)} />
      </div>

      {error && <p className="field-error">{error}</p>}

      <div className="flex gap-2">
        <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
        <button
          onClick={() => mutation.mutate()}
          disabled={
            mutation.isPending
            || !partner
            || (selectedReceipts.length > 0 && selectedLines.length === 0)
          }
          className="btn-primary flex-1"
          title={
            selectedReceipts.length > 0 && selectedLines.length === 0
              ? 'Marca al menos una línea para facturar'
              : ''
          }
        >
          {mutation.isPending ? <Spinner size="sm" />
            : selectedReceipts.length > 0 && selectedLines.length === 0
              ? 'Marca al menos una línea'
              : isPartial
                ? `Guardar factura (${selectedLines.length} líneas)`
                : 'Guardar factura'}
        </button>
      </div>

      {showQuickAlta && (
        <AltaProveedorRapidoModal
          prefill={{
            name:   parsed.emisor?.name,
            rfc:    parsed.emisor?.rfc,
            regime: parsed.emisor?.regime,
          }}
          onClose={() => setShowQuickAlta(false)}
          onCreated={(newPartner) => {
            setPartner({ id: newPartner.id, label: newPartner.name, sub: newPartner.rfc || '' })
            setSelRec([])
          }}
        />
      )}
    </div>
  )
}

// ── Modal principal ───────────────────────────────────────────────────────────
function NuevaFacturaModal({ onClose, onSaved }) {
  // step: 0=elegir, 1=xml/manual, 2=conciliación
  const [step, setStep]     = useState(0)
  const [method, setMethod] = useState(null)   // 'xml' | 'manual'
  const [parsed, setParsed] = useState(null)
  const [originalFile, setOriginalFile] = useState(null)  // XML/PDF de respaldo

  const titleByStep = {
    0: 'Nueva factura de proveedor',
    1: method === 'xml' ? 'Cargar XML o PDF del proveedor' : 'Captura manual',
    2: 'Conciliar con recepciones',
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">{titleByStep[step]}</h2>
            {step > 0 && (
              <div className="flex items-center gap-2 mt-1">
                {[1, 2].map(s => (
                  <div key={s} className={clsx('flex items-center gap-1')}>
                    <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold',
                      step >= s ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-ink-muted')}>
                      {s}
                    </div>
                    <span className={clsx('text-xs', step >= s ? 'text-brand-300' : 'text-ink-muted')}>
                      {s === 1 ? (method === 'xml' ? 'XML' : 'Datos') : 'Conciliación'}
                    </span>
                    {s < 2 && <div className="w-6 h-px bg-surface-elevated mx-1" />}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {step === 0 && (
          <StepChooseMethod
            onPick={(m) => { setMethod(m); setStep(1) }}
            onClose={onClose}
          />
        )}
        {step === 1 && method === 'xml' && (
          <StepUploadXML
            onParsed={(data, file) => { setParsed(data); setOriginalFile(file || null); setStep(2) }}
            onBack={() => setStep(0)}
            onClose={onClose}
          />
        )}
        {step === 1 && method === 'manual' && (
          <StepManualEntry
            onCaptured={(data) => { setParsed(data); setOriginalFile(null); setStep(2) }}
            onBack={() => setStep(0)}
            onClose={onClose}
          />
        )}
        {step === 2 && parsed && (
          <StepReconcile
            parsed={parsed}
            originalFile={originalFile}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
// ── Ciclo del documento (Recibido → Conciliado → Pagado) ──────────────────
function CycleSteps({ inv }) {
  const isCancelled = inv.status === 'cancelled'
  const reconciled  = inv.reconciliation_status === 'reconciled'
  const paid        = inv.status === 'paid' || parseFloat(inv.balance || 0) <= 0.01

  if (isCancelled) {
    return (
      <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-status-danger/15 text-status-danger">
        Cancelado
      </span>
    )
  }

  const allDone = reconciled && paid
  const steps = [
    { label: 'Recibido',   done: true,       icon: '📄' },
    { label: 'Conciliado', done: reconciled, icon: '🔗' },
    { label: 'Pagado',     done: paid,       icon: '💰' },
  ]

  return (
    <div className="flex items-center gap-1" title={allDone ? 'Ciclo completo' : 'Ciclo en proceso'}>
      {steps.map((s, i) => (
        <span key={s.label}
          title={s.label}
          className={clsx(
            'w-5 h-5 rounded-full flex items-center justify-center text-[9px] border',
            s.done
              ? 'bg-status-success/15 border-status-success/40 text-status-success'
              : 'bg-surface-elevated/40 border-line-subtle text-ink-muted'
          )}>
          {s.done ? '✓' : s.icon}
        </span>
      ))}
      {allDone && (
        <span className="ml-1 text-[10px] font-bold text-status-success">100%</span>
      )}
    </div>
  )
}

const STATUS_OPTS = [
  ['',          'Todos los estados'],
  ['pending',   'Pendiente'],
  ['partial',   'Parcial'],
  ['paid',      'Pagado'],
  ['cancelled', 'Cancelado'],
]

const TYPE_OPTS = [
  ['',          'Todos los tipos'],
  ['invoice',   'Factura'],
  ['remission', 'Remisión'],
]

export default function ComprasFacturas() {
  const [showNew, setShowNew]           = useState(false)
  const [detailId, setDetailId]         = useState(null)  // ver detalle del comprobante
  const [success, setSuccess]           = useState(null)  // { ap_id, partner_id, total, is_cash }
  const [showPagoModal, setShowPagoModal] = useState(false)
  const [pagoPrefill, setPagoPrefill]     = useState(null) // { apId, partnerId }
  const [page, setPage]                 = useState(1)
  const [typeFilter, setTypeFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [partner, setPartner]           = useState(null)
  const [search, setSearch]             = useState('')
  const [from, setFrom]                 = useState('')
  const [to, setTo]                     = useState('')

  const queryParams = useMemo(() => {
    const p = { page, limit: 25 }
    if (typeFilter)   p.type       = typeFilter
    if (statusFilter) p.status     = statusFilter
    if (partner?.id)  p.supplierId = partner.id
    if (from)         p.from       = from
    if (to)           p.to         = to
    return p
  }, [typeFilter, statusFilter, partner, from, to, page])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['purchase-invoices', queryParams],
    queryFn:  () => purchasesApi.listInvoices(queryParams),
    keepPreviousData: true,
  })

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, role: 'supplier', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const docs = useMemo(() => {
    const list = data?.data || []
    if (!search.trim()) return list
    const q = search.trim().toLowerCase()
    return list.filter(d =>
      (d.invoice_number    || '').toLowerCase().includes(q) ||
      (d.partner_name      || '').toLowerCase().includes(q) ||
      (d.partner_rfc       || '').toLowerCase().includes(q) ||
      (d.uuid_sat          || '').toLowerCase().includes(q)
    )
  }, [data, search])

  const total = data?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / 25))

  // KPIs sobre la página actual
  const summary = useMemo(() => {
    const arr = data?.data || []
    return {
      count:      arr.length,
      total:      arr.reduce((s, d) => s + parseFloat(d.total_mxn || 0), 0),
      paid:       arr.reduce((s, d) => s + parseFloat(d.ap_amount_paid || 0), 0),
      pending:    arr.reduce((s, d) => s + parseFloat(d.balance || 0), 0),
      overdue:    arr.filter(d => d.is_overdue).length,
      invoices:   arr.filter(d => d.type === 'invoice').length,
      remissions: arr.filter(d => d.type === 'remission').length,
    }
  }, [data])

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Facturas y remisiones</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Documentos recibidos del proveedor (CFDI y remisiones) y su ciclo: conciliación con recepciones y pago.
          </p>
        </div>
        <Can do="purchases:create">
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo documento
          </button>
        </Can>
      </div>

      {success && (
        success.is_cash ? (
          <div className="bg-status-success/10 border-2 border-status-success/40 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">💰</span>
              <div>
                <p className="text-sm font-semibold text-status-success">
                  Proveedor de contado · Documento {success.document_number} por {fmtMXN(success.total)}
                </p>
                <p className="text-xs text-status-success">
                  Este proveedor cobra al momento. ¿Registrar el pago ahora?
                </p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => {
                  setPagoPrefill({ apId: success.ap_id, partnerId: success.partner_id })
                  setShowPagoModal(true)
                  setSuccess(null)
                }}
                className="btn-primary btn-sm"
              >
                Pagar ahora
              </button>
              <button onClick={() => setSuccess(null)} className="btn-ghost btn-sm text-status-success">
                Después
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 flex items-center justify-between">
            <p className="text-sm text-status-success">
              Documento {success.document_number} registrado correctamente.
            </p>
            <button onClick={() => setSuccess(null)} className="text-green-400 text-xs">✕</button>
          </div>
        )
      )}

      {/* KPIs */}
      {!isLoading && data?.data?.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Documentos</p>
            <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.count}</p>
            <p className="text-[10px] text-ink-muted mt-0.5">
              {summary.invoices} factura{summary.invoices !== 1 ? 's' : ''} ·{' '}
              {summary.remissions} remisión{summary.remissions !== 1 ? 'es' : ''}
            </p>
          </div>
          <div className="card p-3">
            <p className="text-[10px] text-ink-muted uppercase tracking-wide">Total recibido</p>
            <p className="text-lg font-mono font-semibold text-ink-primary mt-0.5">{fmtMXN(summary.total)}</p>
          </div>
          <div className="card p-3 bg-status-success/10/40">
            <p className="text-[10px] text-green-500 uppercase tracking-wide">Pagado</p>
            <p className="text-lg font-mono font-semibold text-status-success mt-0.5">{fmtMXN(summary.paid)}</p>
          </div>
          <div className={clsx('card p-3', summary.overdue > 0 ? 'bg-status-danger/10/40' : 'bg-status-warning/10/40')}>
            <p className={clsx('text-[10px] uppercase tracking-wide',
              summary.overdue > 0 ? 'text-status-danger' : 'text-amber-500')}>
              Pendiente {summary.overdue > 0 && `· ${summary.overdue} vencido${summary.overdue !== 1 ? 's' : ''}`}
            </p>
            <p className={clsx('text-lg font-mono font-semibold mt-0.5',
              summary.overdue > 0 ? 'text-status-danger' : 'text-status-warning')}>
              {fmtMXN(summary.pending)}
            </p>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Folio, proveedor, RFC, UUID..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {/* Filtros adicionales — ocultos en móvil (allí solo se busca) */}
        <div className="hidden sm:contents">
          <div className="min-w-[200px]">
            <label className="label">Proveedor</label>
            <Autocomplete value={partner}
              onChange={(p) => { setPartner(p); setPage(1) }}
              onSearch={searchPartners}
              placeholder="Filtrar por proveedor..." />
          </div>
          <div>
            <label className="label">Tipo</label>
            <select className="select" value={typeFilter}
              onChange={e => { setTypeFilter(e.target.value); setPage(1) }}>
              {TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Estado</label>
            <select className="select" value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
              {STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Desde</label>
            <input type="date" className="input" value={from}
              onChange={e => { setFrom(e.target.value); setPage(1) }} />
          </div>
          <div>
            <label className="label">Hasta</label>
            <input type="date" className="input" value={to}
              onChange={e => { setTo(e.target.value); setPage(1) }} />
          </div>
          {(typeFilter || statusFilter || from || to || search || partner) && (
            <button onClick={() => { setTypeFilter(''); setStatusFilter(''); setFrom(''); setTo(''); setSearch(''); setPartner(null); setPage(1) }}
              className="btn-ghost btn-sm text-ink-muted">
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {/* Tabla */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !docs.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="font-medium text-ink-secondary">
              {search || typeFilter || statusFilter || from || to || partner
                ? 'Sin resultados para los filtros aplicados'
                : 'Sin documentos registrados'}
            </p>
            <p className="text-sm text-ink-muted">
              Carga el XML del CFDI o captura los datos manualmente.
            </p>
            <Can do="purchases:create">
              <button onClick={() => setShowNew(true)} className="btn-primary btn-sm">
                + Nuevo documento
              </button>
            </Can>
          </div>
        ) : (
          <>
            <table className="table hidden sm:table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Documento</th>
                  <th>Proveedor</th>
                  <th>Fecha</th>
                  <th>Vencimiento</th>
                  <th>Ciclo</th>
                  <th title="Evidencias adjuntas">📎</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Pendiente</th>
                </tr>
              </thead>
              <tbody>
                {docs.map(inv => {
                  const isRemission = inv.type === 'remission'
                  return (
                  <tr key={inv.id}
                    onClick={() => setDetailId(inv.id)}
                    className={clsx('cursor-pointer hover:bg-surface-elevated/40', inv.is_overdue && 'bg-status-danger/10/30')}>
                    <td>
                      <span className={clsx(
                        'text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                        isRemission
                          ? 'bg-purple-500/15 text-purple-300'
                          : 'bg-emerald-100 text-emerald-700'
                      )}>
                        {isRemission ? 'Remisión' : 'Factura'}
                      </span>
                    </td>
                    <td className="font-mono text-sm font-medium text-brand-300">
                      {inv.invoice_number}
                      {inv.uuid_sat && (
                        <span className="block text-[10px] text-ink-muted font-normal">
                          UUID: {inv.uuid_sat.slice(0,8)}...
                        </span>
                      )}
                    </td>
                    <td className="text-ink-secondary">
                      <p className="font-medium">{inv.partner_name || inv.generic_supplier || <span className="text-ink-muted">—</span>}</p>
                      {inv.partner_rfc && <p className="text-[10px] text-ink-muted font-mono">{inv.partner_rfc}</p>}
                    </td>
                    <td className="text-ink-muted text-sm">{fmtDate(inv.invoice_date)}</td>
                    <td className={clsx('text-sm',
                      inv.is_overdue ? 'text-status-danger font-semibold' : 'text-ink-muted')}>
                      {fmtDate(inv.due_date)}
                    </td>
                    <td><CycleSteps inv={inv} /></td>
                    <td>
                      {inv.attachment_count > 0 ? (
                        <span
                          title={`${inv.attachment_count} evidencia${inv.attachment_count !== 1 ? 's' : ''}`}
                          className="inline-flex items-center gap-1 text-[10px] font-bold bg-status-info/15 text-status-info px-1.5 py-0.5 rounded-full"
                        >
                          📎 {inv.attachment_count}
                        </span>
                      ) : (
                        <span className="text-[10px] text-ink-muted" title="Sin evidencias">—</span>
                      )}
                    </td>
                    <td className="text-right font-mono text-sm font-semibold">{fmtMXN(inv.total_mxn)}</td>
                    <td className={clsx('text-right font-mono text-sm font-semibold',
                      parseFloat(inv.balance || 0) <= 0.01 ? 'text-status-success'
                        : (inv.is_overdue ? 'text-status-danger' : 'text-status-warning'))}>
                      {fmtMXN(inv.balance)}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Móvil: tarjetas (la tabla de 9 columnas se salía a los lados) */}
            <div className="sm:hidden divide-y divide-line-subtle">
              {docs.map(inv => {
                const isRemission = inv.type === 'remission'
                const paid = parseFloat(inv.balance || 0) <= 0.01
                return (
                  <div key={inv.id} onClick={() => setDetailId(inv.id)}
                    className={clsx('p-3 flex flex-col gap-2 cursor-pointer active:bg-surface-elevated/40', inv.is_overdue && 'bg-status-danger/10/30')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={clsx('text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                            isRemission ? 'bg-purple-500/15 text-purple-300' : 'bg-emerald-100 text-emerald-700')}>
                            {isRemission ? 'Remisión' : 'Factura'}
                          </span>
                          <span className="font-mono text-sm font-medium text-brand-300">{inv.invoice_number}</span>
                          {inv.attachment_count > 0 && (
                            <span className="text-[10px] font-bold bg-status-info/15 text-status-info px-1.5 py-0.5 rounded-full">📎 {inv.attachment_count}</span>
                          )}
                        </div>
                        <p className="text-xs text-ink-secondary mt-0.5 font-medium truncate">
                          {inv.partner_name || inv.generic_supplier || '—'}
                        </p>
                        <p className="text-[10px] text-ink-muted">
                          Emitida {fmtDate(inv.invoice_date)} · Vence{' '}
                          <span className={clsx(inv.is_overdue && 'text-status-danger font-semibold')}>{fmtDate(inv.due_date)}</span>
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono text-sm font-semibold text-ink-primary">{fmtMXN(inv.total_mxn)}</p>
                        <p className={clsx('font-mono text-[11px] font-semibold',
                          paid ? 'text-status-success' : (inv.is_overdue ? 'text-status-danger' : 'text-status-warning'))}>
                          Saldo {fmtMXN(inv.balance)}
                        </p>
                      </div>
                    </div>
                    <CycleSteps inv={inv} />
                  </div>
                )
              })}
            </div>

            {totalPages > 1 && (
              <div className="border-t border-line-subtle px-4 py-3 flex items-center justify-between">
                <p className="text-xs text-ink-muted">
                  Mostrando {(page - 1) * 25 + 1}–{Math.min(page * 25, total)} de {total}
                  {isFetching && <span className="ml-2 italic text-ink-muted">Actualizando…</span>}
                </p>
                <div className="flex gap-1">
                  <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Anterior
                  </button>
                  <span className="text-sm self-center px-2 text-ink-secondary">{page} / {totalPages}</span>
                  <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
                    className="btn-ghost btn-sm disabled:opacity-30">
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {detailId && (
        <FacturaProveedorDetallePanel
          invoiceId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}

      {showNew && (
        <NuevaFacturaModal
          onClose={() => setShowNew(false)}
          onSaved={(invoice) => {
            setSuccess({
              ap_id:           invoice?.ap_id || null,
              partner_id:      invoice?.partner_id || null,
              document_number: invoice?.invoice_number || '',
              total:           parseFloat(invoice?.total_mxn || invoice?.total || 0),
              is_cash:         invoice?.partner_credit_type === 'cash' && !!invoice?.ap_id,
            })
            setShowNew(false)
          }}
        />
      )}

      {showPagoModal && pagoPrefill && (
        <PagoProveedorModal
          initialPartnerId={pagoPrefill.partnerId}
          initialApId={pagoPrefill.apId}
          onClose={() => { setShowPagoModal(false); setPagoPrefill(null) }}
          onSaved={() => {
            setShowPagoModal(false); setPagoPrefill(null)
          }}
        />
      )}
    </div>
  )
}
