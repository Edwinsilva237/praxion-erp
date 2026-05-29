import { useState, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoicingApi } from '@/api/invoicing'
import { salesApi } from '@/api/sales'
import { partnersApi } from '@/api/partners'
import Spinner from '@/components/ui/Spinner'
import SatCatalogSelect from '@/components/fiscal/SatCatalogSelect'
import OccasionalInvoiceSection, { EMPTY_OC_LINE } from '@/components/facturacion/OccasionalInvoiceSection'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const PAYMENT_METHOD_OPTS = [
  ['PUE', 'PUE — Pago en una sola exhibición'],
  ['PPD', 'PPD — Pago en parcialidades / diferido'],
]

const PAYMENT_FORM_OPTS = [
  ['01', '01 — Efectivo'],
  ['02', '02 — Cheque nominativo'],
  ['03', '03 — Transferencia electrónica'],
  ['04', '04 — Tarjeta de crédito'],
  ['28', '28 — Tarjeta de débito'],
  ['99', '99 — Por definir'],
]

// Subset frecuente del catálogo SAT. Si el usuario necesita otro, puede capturarlo libre.
const CFDI_USE_OPTS = [
  ['G01', 'G01 — Adquisición de mercancías'],
  ['G02', 'G02 — Devoluciones, descuentos o bonificaciones'],
  ['G03', 'G03 — Gastos en general'],
  ['I01', 'I01 — Construcciones'],
  ['I04', 'I04 — Equipo de cómputo y accesorios'],
  ['I08', 'I08 — Otra maquinaria y equipo'],
  ['P01', 'P01 — Por definir'],
  ['S01', 'S01 — Sin efectos fiscales'],
  ['CP01','CP01 — Pagos'],
]

export function FacturaFormModal({ onClose, onCreated }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState('from-remissions')  // 'from-remissions' | 'direct' | 'ocasional'

  // Estado del modo "factura ocasional" (cliente + líneas capturados a mano).
  const [ocPublico, setOcPublico] = useState(false)
  const [ocReceptor, setOcReceptor] = useState({
    rfc: '', taxName: '', taxRegimeCode: '', zipCode: '',
  })
  const [ocLines, setOcLines] = useState([{ ...EMPTY_OC_LINE }])
  const [ocRetentions, setOcRetentions] = useState([])

  // Selecciones
  const [selectedNoteIds, setSelectedNoteIds] = useState([])
  // Split por líneas: cuando hay UNA remisión seleccionada, el operador puede
  // elegir un subset de sus líneas. Mapa id_linea_remision → boolean.
  const [selectedLineIds, setSelectedLineIds] = useState({})
  const [salesOrderId, setSalesOrderId]       = useState('')

  // Datos fiscales (con prefill desde el cliente)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paymentForm, setPaymentForm]     = useState('')
  const [useCfdi, setUseCfdi]             = useState('')
  const [poNumber, setPoNumber]           = useState('')
  const [poTouched, setPoTouched]         = useState(false)
  const [notes, setNotes]                 = useState('')
  const [overrideTouched, setOverrideTouched] = useState(false)
  const [error, setError]                 = useState(null)

  // Catálogos
  const { data: notesData } = useQuery({
    queryKey: ['delivery-notes', 'invoiceable'],
    // El backend con invoiceable=true ya filtra: status=delivered, sin factura activa, no_invoice=false
    queryFn: () => salesApi.listDeliveryNotes({ invoiceable: true, limit: 200, type: 'sale' }),
    enabled: mode === 'from-remissions',
  })
  const eligibleNotes = notesData?.data || []

  const { data: ordersData } = useQuery({
    queryKey: ['sales-orders', 'direct-invoice'],
    queryFn: () => salesApi.listOrders({ status: 'confirmed', limit: 100 }),
    enabled: mode === 'direct',
  })
  const eligibleOrders = useMemo(() => {
    return (ordersData?.data || []).filter(o => o.direct_invoice === true)
  }, [ordersData])

  // ── Cliente derivado de la selección actual ─────────────────────────────
  const inferredPartnerId = useMemo(() => {
    if (mode === 'from-remissions' && selectedNoteIds.length > 0) {
      const first = eligibleNotes.find(n => n.id === selectedNoteIds[0])
      return first?.partner_id || null
    }
    if (mode === 'direct' && salesOrderId) {
      const found = eligibleOrders.find(o => o.id === salesOrderId)
      return found?.partner_id || null
    }
    return null
  }, [mode, selectedNoteIds, salesOrderId, eligibleNotes, eligibleOrders])

  // Cargar perfil completo del cliente al inferirlo
  const { data: partnerProfile, isLoading: partnerLoading } = useQuery({
    queryKey: ['partner', inferredPartnerId],
    queryFn:  () => partnersApi.get(inferredPartnerId),
    enabled:  !!inferredPartnerId,
  })

  // Precargar uso CFDI / método / forma cuando carga el perfil del cliente.
  // Solo lo hacemos si el usuario no ha tocado manualmente los campos.
  useEffect(() => {
    if (!partnerProfile || overrideTouched) return
    setPaymentMethod(partnerProfile.payment_method || 'PUE')
    setPaymentForm(partnerProfile.payment_form     || '99')
    setUseCfdi(partnerProfile.cfdi_use             || 'G01')
  }, [partnerProfile, overrideTouched])

  // Precargar OC del cliente desde el documento origen (pedido o remisión asociada).
  // Si los documentos seleccionados comparten OC, se usa esa. Si difieren, se
  // toma la del primero — el usuario puede editar/limpiar manualmente.
  const inheritedPoNumber = useMemo(() => {
    if (mode === 'from-remissions') {
      for (const id of selectedNoteIds) {
        const n = eligibleNotes.find(x => x.id === id)
        if (n?.sales_order_po) return n.sales_order_po
      }
    }
    if (mode === 'direct' && salesOrderId) {
      const o = eligibleOrders.find(x => x.id === salesOrderId)
      if (o?.po_number) return o.po_number
    }
    return ''
  }, [mode, selectedNoteIds, salesOrderId, eligibleNotes, eligibleOrders])

  useEffect(() => {
    if (poTouched) return
    setPoNumber(inheritedPoNumber)
  }, [inheritedPoNumber, poTouched])

  // Detectar si la mezcla actual es válida (todas las remisiones del mismo cliente)
  const mixedClients = useMemo(() => {
    if (mode !== 'from-remissions' || selectedNoteIds.length < 2) return false
    const partnerIds = new Set(
      selectedNoteIds.map(id => eligibleNotes.find(n => n.id === id)?.partner_id).filter(Boolean)
    )
    return partnerIds.size > 1
  }, [mode, selectedNoteIds, eligibleNotes])

  const mixedCurrency = useMemo(() => {
    if (mode !== 'from-remissions' || selectedNoteIds.length < 2) return false
    const cur = new Set(
      selectedNoteIds.map(id => eligibleNotes.find(n => n.id === id)?.currency).filter(Boolean)
    )
    return cur.size > 1
  }, [mode, selectedNoteIds, eligibleNotes])

  // Reset al cambiar de modo
  useEffect(() => {
    setSelectedNoteIds([])
    setSelectedLineIds({})
    setSalesOrderId('')
    setPaymentMethod(''); setPaymentForm(''); setUseCfdi('')
    setPoNumber(''); setPoTouched(false)
    setOverrideTouched(false)
    setError(null)
  }, [mode])

  // Defaults fiscales para la factura ocasional (no hay cliente de dónde precargar).
  useEffect(() => {
    if (mode !== 'ocasional') return
    setUseCfdi(prev => prev || (ocPublico ? 'S01' : 'G03'))
    setPaymentMethod(prev => prev || 'PUE')
    setPaymentForm(prev => prev || '99')
  }, [mode, ocPublico])

  // Cuando hay exactamente una remisión seleccionada, cargar su detalle para
  // permitir split por líneas.
  const isSingleNote = mode === 'from-remissions' && selectedNoteIds.length === 1
  const { data: singleNote } = useQuery({
    queryKey: ['delivery-note', selectedNoteIds[0]],
    queryFn:  () => salesApi.getDeliveryNote(selectedNoteIds[0]),
    enabled:  isSingleNote,
  })

  // Líneas pendientes de facturar (no en factura activa)
  const pendingLines = useMemo(() => {
    if (!singleNote?.lines) return []
    return singleNote.lines.filter(l => !l.invoice_id)
  }, [singleNote])

  // Al cargar las líneas pendientes, seleccionar todas por default
  useEffect(() => {
    if (!pendingLines.length) { setSelectedLineIds({}); return }
    setSelectedLineIds(prev => {
      const next = { ...prev }
      for (const l of pendingLines) {
        if (next[l.id] === undefined) next[l.id] = true
      }
      // Eliminar líneas que ya no aparecen
      for (const k of Object.keys(next)) {
        if (!pendingLines.find(l => l.id === k)) delete next[k]
      }
      return next
    })
  }, [pendingLines.map(l => l.id).join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset selección de líneas al cambiar las remisiones seleccionadas
  useEffect(() => {
    if (selectedNoteIds.length !== 1) setSelectedLineIds({})
  }, [selectedNoteIds])

  const checkedLineIds = useMemo(
    () => Object.entries(selectedLineIds).filter(([, v]) => v).map(([k]) => k),
    [selectedLineIds]
  )

  function toggleLine(id) {
    setSelectedLineIds(s => ({ ...s, [id]: !s[id] }))
  }

  const isPartialSplit = isSingleNote && pendingLines.length > 0 && checkedLineIds.length < pendingLines.length

  // Total previsto cuando hay split: suma solo de líneas seleccionadas
  const splitTotal = useMemo(() => {
    if (!isSingleNote || !singleNote?.lines) return null
    let subtotal = 0
    for (const l of singleNote.lines) {
      if (!selectedLineIds[l.id]) continue
      const q = parseFloat(l.quantity_delivered || 0)
      const p = parseFloat(l.unit_price || 0)
      const d = parseFloat(l.discount_pct || 0)
      subtotal += q * p * (1 - d / 100)
    }
    const factor = singleNote.currency === 'USD' ? parseFloat(singleNote.exchange_rate_value || 1) : 1
    return {
      subtotal: subtotal * factor,
      tax:      subtotal * factor * 0.16,
      total:    subtotal * factor * 1.16,
      currency: singleNote.currency,
    }
  }, [isSingleNote, singleNote, selectedLineIds])

  // Totales en preview (multi-remisión)
  const previewTotal = useMemo(() => {
    if (mode !== 'from-remissions') return null
    let total = 0, currency = 'MXN'
    for (const id of selectedNoteIds) {
      const n = eligibleNotes.find(x => x.id === id)
      if (n) { total += parseFloat(n.total_mxn || 0); currency = n.currency }
    }
    return { total, currency }
  }, [mode, selectedNoteIds, eligibleNotes])

  // Mutations
  const fromRemissionsMutation = useMutation({
    mutationFn: () => invoicingApi.fromRemissions({
      deliveryNoteIds: selectedNoteIds,
      // Split por línea: solo aplica cuando hay una sola remisión seleccionada.
      // Se manda siempre que sea single para que el backend valide explícitamente
      // las líneas elegidas (aunque sean todas).
      deliveryNoteLineIds: isSingleNote ? checkedLineIds : undefined,
      paymentMethod:   paymentMethod || undefined,
      paymentForm:     paymentForm   || undefined,
      useCfdi:         useCfdi       || undefined,
      poNumber:        poNumber.trim() || undefined,
      notes:           notes.trim()   || undefined,
    }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['delivery-notes'] })
      qc.invalidateQueries({ queryKey: ['cxc'] })
      onCreated?.(inv); onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la factura'),
  })

  const directMutation = useMutation({
    mutationFn: () => invoicingApi.direct({
      salesOrderId,
      paymentMethod: paymentMethod || undefined,
      paymentForm:   paymentForm   || undefined,
      useCfdi:       useCfdi       || undefined,
      poNumber:      poNumber.trim() || undefined,
      notes:         notes.trim()   || undefined,
    }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['sales-orders'] })
      qc.invalidateQueries({ queryKey: ['cxc'] })
      onCreated?.(inv); onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la factura'),
  })

  // Totales en vivo del modo ocasional (el backend recalcula al guardar).
  const ocTotals = useMemo(() => {
    let subtotal = 0, tax = 0, taxableBase = 0
    for (const l of ocLines) {
      const qty = parseFloat(l.quantity) || 0
      const price = parseFloat(l.unitPrice) || 0
      const disc = parseFloat(l.discountPct) || 0
      const lineSub = qty * price * (1 - disc / 100)
      const causes = l.objetoImp !== '01' && l.objetoImp !== '03' && l.taxFactor !== 'Exento'
      subtotal += lineSub
      tax += causes ? lineSub * (parseFloat(l.taxRate) || 0) / 100 : 0
      if (l.objetoImp === '02') taxableBase += lineSub
    }
    const withheld = ocRetentions.reduce(
      (s, r) => s + taxableBase * (parseFloat(r.rate) || 0) / 100, 0)
    return { subtotal, tax, withheld, total: subtotal + tax - withheld }
  }, [ocLines, ocRetentions])

  const occasionalMutation = useMutation({
    mutationFn: () => invoicingApi.occasional({
      receptor: {
        publicoEnGeneral: ocPublico,
        rfc:           ocReceptor.rfc.trim() || undefined,
        taxName:       ocReceptor.taxName.trim() || undefined,
        taxRegimeCode: ocReceptor.taxRegimeCode || undefined,
        zipCode:       ocReceptor.zipCode.trim() || undefined,
      },
      lines: ocLines.map(l => ({
        description: l.description.trim(),
        satProductCode: l.satProductCode,
        satUnitCode: l.satUnitCode,
        unit: l.unit,
        quantity: parseFloat(l.quantity),
        unitPrice: parseFloat(l.unitPrice),
        discountPct: parseFloat(l.discountPct) || 0,
        objetoImp: l.objetoImp,
        taxFactor: l.taxFactor,
        taxRate: l.taxRate,
      })),
      retentions: ocRetentions
        .filter(r => parseFloat(r.rate) > 0)
        .map(r => ({ taxType: r.taxType, rate: parseFloat(r.rate) })),
      paymentMethod: paymentMethod || undefined,
      paymentForm:   paymentForm   || undefined,
      useCfdi:       useCfdi       || undefined,
      poNumber:      poNumber.trim() || undefined,
      notes:         notes.trim()   || undefined,
    }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['invoices'] })
      qc.invalidateQueries({ queryKey: ['cxc'] })
      onCreated?.(inv); onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al crear la factura ocasional'),
  })

  function handleSubmit(e) {
    e.preventDefault(); setError(null)

    if (mode === 'ocasional') {
      if (!ocPublico) {
        if (!ocReceptor.rfc.trim())     { setError('Captura el RFC del receptor o marca "Público en general".'); return }
        if (!ocReceptor.taxName.trim()) { setError('Captura la razón social del receptor.'); return }
        if (!ocReceptor.taxRegimeCode)  { setError('Selecciona el régimen fiscal del receptor.'); return }
        if (!ocReceptor.zipCode.trim()) { setError('Captura el código postal del receptor.'); return }
      }
      const validLines = ocLines.filter(l => l.description.trim())
      if (validLines.length === 0) { setError('Captura al menos un concepto con descripción.'); return }
      for (const [i, l] of ocLines.entries()) {
        if (!l.description.trim()) continue
        if (!(parseFloat(l.quantity) > 0))  { setError(`El concepto ${i + 1} necesita cantidad > 0.`); return }
        if (!(parseFloat(l.unitPrice) > 0)) { setError(`El concepto ${i + 1} necesita precio > 0.`); return }
        if (!l.satProductCode) { setError(`El concepto ${i + 1} necesita clave de producto SAT.`); return }
        if (!l.satUnitCode)    { setError(`El concepto ${i + 1} necesita clave de unidad SAT.`); return }
      }
      occasionalMutation.mutate()
      return
    }

    // Validación de OC obligatoria si el cliente lo requiere
    if (partnerProfile?.requires_po && !poNumber.trim()) {
      setError('Este cliente requiere número de OC. Captúralo antes de generar la factura.')
      return
    }
    if (mode === 'from-remissions') {
      if (selectedNoteIds.length === 0) { setError('Selecciona al menos una remisión.'); return }
      if (mixedClients)  { setError('Todas las remisiones deben ser del mismo cliente.'); return }
      if (mixedCurrency) { setError('Todas las remisiones deben estar en la misma moneda.'); return }
      if (isSingleNote && checkedLineIds.length === 0) {
        setError('Selecciona al menos una línea para facturar.'); return
      }
      fromRemissionsMutation.mutate()
    } else {
      if (!salesOrderId) { setError('Selecciona un pedido.'); return }
      directMutation.mutate()
    }
  }

  function toggleNote(id) {
    setSelectedNoteIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const pending = fromRemissionsMutation.isPending || directMutation.isPending || occasionalMutation.isPending

  // Agrupar remisiones elegibles por cliente para mejor visual
  const groupedNotes = useMemo(() => {
    const groups = new Map()
    for (const n of eligibleNotes) {
      const key = n.partner_id
      if (!groups.has(key)) groups.set(key, { partner_name: n.partner_name, items: [] })
      groups.get(key).items.push(n)
    }
    return Array.from(groups.values())
  }, [eligibleNotes])

  const requiresPo        = partnerProfile?.requires_po
  const billingNotes      = partnerProfile?.billing_notes

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={handleSubmit}
        className="card w-full max-w-3xl p-6 max-h-[92vh] overflow-y-auto flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-500/15 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-teal-300" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-primary">Nueva factura</h2>
              <p className="text-xs text-ink-muted mt-0.5">CFDI 4.0 — queda en borrador hasta que se timbre</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Selector de modo */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: 'from-remissions', label: 'Desde remisión(es)', desc: 'Una o varias del mismo cliente' },
            { value: 'direct',          label: 'Factura directa',     desc: 'Pedido con direct_invoice' },
            { value: 'ocasional',       label: 'Factura ocasional',   desc: 'Cliente y productos a mano' },
          ].map(opt => (
            <button key={opt.value} type="button"
              onClick={() => setMode(opt.value)}
              className={clsx(
                'flex flex-col gap-1 rounded-xl px-3 py-2.5 border-2 transition-colors text-left',
                mode === opt.value
                  ? 'border-teal-500 bg-teal-500/10'
                  : 'border-line-subtle bg-surface-primary hover:border-line-strong'
              )}>
              <span className="text-sm font-semibold text-ink-primary">{opt.label}</span>
              <span className="text-[11px] text-ink-muted">{opt.desc}</span>
            </button>
          ))}
        </div>

        {/* Selección de documento origen */}
        {mode === 'ocasional' ? (
          <OccasionalInvoiceSection
            publico={ocPublico} setPublico={setOcPublico}
            receptor={ocReceptor} setReceptor={setOcReceptor}
            lines={ocLines} setLines={setOcLines}
            retentions={ocRetentions} setRetentions={setOcRetentions}
          />
        ) : mode === 'from-remissions' ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label mb-0">Remisiones a facturar <span className="text-status-danger">*</span></label>
              {selectedNoteIds.length > 0 && (
                <span className="text-[11px] text-teal-300 font-semibold">
                  {selectedNoteIds.length} seleccionada{selectedNoteIds.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            {eligibleNotes.length === 0 && notesData ? (
              <p className="text-xs text-ink-muted italic py-2">
                No hay remisiones entregadas sin facturar.
              </p>
            ) : (
              <div className="border border-line-subtle rounded-xl max-h-72 overflow-y-auto divide-y divide-line-subtle">
                {groupedNotes.map(group => (
                  <div key={group.partner_name}>
                    <div className="bg-surface-elevated/40 px-3 py-1.5 text-[10px] font-semibold text-ink-muted uppercase tracking-wide sticky top-0">
                      {group.partner_name}
                    </div>
                    {group.items.map(n => (
                      <label key={n.id}
                        className={clsx(
                          'flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-teal-500/10/50 transition-colors',
                          selectedNoteIds.includes(n.id) && 'bg-teal-500/10'
                        )}>
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-teal-600 rounded shrink-0"
                          checked={selectedNoteIds.includes(n.id)}
                          onChange={() => toggleNote(n.id)}
                        />
                        <div className="flex-1 min-w-0 flex items-center gap-3">
                          <span className="font-mono font-semibold text-purple-300 text-sm">{n.document_number}</span>
                          <span className="text-xs text-ink-muted">{fmtDate(n.delivered_at || n.issue_date)}</span>
                          <span className="ml-auto font-mono font-medium text-ink-primary text-sm">
                            {fmtMXN(n.total_mxn, n.currency)}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {mixedClients && (
              <p className="text-xs text-status-danger mt-2">
                Hay remisiones de clientes distintos en tu selección. Solo se puede consolidar remisiones del mismo cliente.
              </p>
            )}
            {mixedCurrency && (
              <p className="text-xs text-status-danger mt-2">
                Hay remisiones en monedas distintas. No se pueden consolidar.
              </p>
            )}
            {previewTotal && previewTotal.total > 0 && !isSingleNote && (
              <div className="mt-2 flex items-center justify-between bg-teal-500/10/60 border border-teal-500/40 rounded-lg px-3 py-2">
                <span className="text-xs text-teal-300">Total a facturar</span>
                <span className="text-sm font-mono font-bold text-teal-300">
                  {fmtMXN(previewTotal.total, previewTotal.currency)}
                </span>
              </div>
            )}

            {/* Split por línea: solo cuando hay UNA remisión seleccionada */}
            {isSingleNote && singleNote && (
              <div className="mt-3 border border-line-subtle rounded-xl p-3 bg-surface-primary">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-ink-secondary">
                    Líneas a facturar de {singleNote.document_number}
                  </p>
                  <span className="text-[11px] text-teal-300 font-semibold">
                    {checkedLineIds.length} de {pendingLines.length} pendiente{pendingLines.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {pendingLines.length === 0 ? (
                  <p className="text-xs text-ink-muted italic py-2">
                    Esta remisión ya tiene todas sus líneas facturadas.
                  </p>
                ) : (
                  <div className="divide-y divide-line-subtle">
                    {singleNote.lines.map(l => {
                      const alreadyInvoiced = !!l.invoice_id
                      const checked = !!selectedLineIds[l.id]
                      const imp = parseFloat(l.quantity_delivered) * parseFloat(l.unit_price) *
                                  (1 - parseFloat(l.discount_pct || 0) / 100)
                      return (
                        <label key={l.id}
                          className={clsx(
                            'flex items-center gap-2 py-1.5 px-1',
                            alreadyInvoiced && 'opacity-50 cursor-not-allowed',
                            !alreadyInvoiced && 'cursor-pointer hover:bg-surface-elevated/40'
                          )}>
                          <input type="checkbox"
                            className="w-4 h-4 accent-teal-600 shrink-0"
                            checked={checked && !alreadyInvoiced}
                            disabled={alreadyInvoiced}
                            onChange={() => toggleLine(l.id)} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-ink-primary truncate">{l.product_name}</p>
                            <p className="text-[11px] text-ink-muted">
                              {parseFloat(l.quantity_delivered).toFixed(2)} {l.unit} · {fmtMXN(imp, singleNote.currency)}
                              {alreadyInvoiced && (
                                <> · <span className="text-teal-300">facturada en {l.invoice_number}{l.invoice_use_cfdi ? ` (${l.invoice_use_cfdi})` : ''}</span></>
                              )}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
                {splitTotal && (
                  <div className="mt-2 flex items-center justify-between bg-teal-500/10/60 border border-teal-500/40 rounded-lg px-3 py-2">
                    <span className="text-xs text-teal-300">
                      Total {isPartialSplit ? '(split parcial)' : 'a facturar'}
                    </span>
                    <span className="text-sm font-mono font-bold text-teal-300">
                      {fmtMXN(splitTotal.total, splitTotal.currency)}
                    </span>
                  </div>
                )}
                {isPartialSplit && (
                  <p className="text-[11px] text-status-warning mt-2">
                    Las líneas no seleccionadas quedan pendientes — podrás facturarlas en otra factura con su propio uso CFDI.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="label">Pedido (factura directa) <span className="text-status-danger">*</span></label>
            <select className="select" value={salesOrderId}
              onChange={e => setSalesOrderId(e.target.value)}>
              <option value="">— Selecciona un pedido —</option>
              {eligibleOrders.map(o => (
                <option key={o.id} value={o.id}>
                  {o.order_number} · {o.partner_name} · {fmtDate(o.created_at)} · {fmtMXN(o.total_mxn, o.currency)}
                </option>
              ))}
            </select>
            {ordersData && eligibleOrders.length === 0 && (
              <p className="text-xs text-ink-muted mt-1.5 italic">
                No hay pedidos confirmados con el flag <code>direct_invoice</code> activo.
              </p>
            )}
          </div>
        )}

        {/* Banner destacado de notas de facturación del cliente.
            Solo aparece cuando el cliente tiene billing_notes — es la
            principal razón para mover este bloque arriba. */}
        {inferredPartnerId && billingNotes && (
          <div className="bg-status-warning/10 border-2 border-status-warning/40 rounded-xl px-4 py-3">
            <p className="text-[10px] text-status-warning uppercase tracking-wide font-bold mb-1 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
              </svg>
              Notas de facturación · {partnerProfile?.name}
              <span className="font-normal normal-case text-amber-500 text-[10px]">(guía interna — no aparece en el CFDI)</span>
            </p>
            <p className="text-sm text-status-warning whitespace-pre-line font-medium">
              {billingNotes}
            </p>
          </div>
        )}

        {/* Bloque del cliente seleccionado — siempre visible cuando hay cliente */}
        {inferredPartnerId && (
          <div className="border border-line-subtle rounded-xl overflow-hidden">
            <div className="bg-surface-elevated/40 px-4 py-2.5 border-b border-line-subtle flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-ink-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                </svg>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-primary truncate">
                    {partnerProfile?.name || 'Cargando…'}
                  </p>
                  {partnerProfile?.tax_name && partnerProfile.tax_name !== partnerProfile.name && (
                    <p className="text-[11px] text-ink-secondary truncate">
                      <span className="text-ink-muted">Razón social CFDI:</span>{' '}
                      <span className="font-semibold">{partnerProfile.tax_name}</span>
                    </p>
                  )}
                  {!partnerProfile?.tax_name && partnerProfile && (
                    <p className="text-[11px] text-status-warning">
                      ⚠ Sin razón social capturada — se timbrará con el nombre comercial.
                    </p>
                  )}
                  {partnerProfile?.rfc && (
                    <p className="text-[11px] font-mono text-ink-muted">{partnerProfile.rfc}</p>
                  )}
                </div>
              </div>
              {/* Chips con preferencias del cliente */}
              {partnerProfile && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {requiresPo && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-status-warning/15 text-status-warning uppercase tracking-wide" title="Requiere número de OC">
                      OC obligatoria
                    </span>
                  )}
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-status-info/15 text-status-info">
                    {partnerProfile.cfdi_use || 'G01'} · {partnerProfile.payment_method || 'PUE'} · {partnerProfile.payment_form || '99'}
                  </span>
                </div>
              )}
            </div>

            {/* Fallback de notas cuando no hay (mensaje sutil) */}
            {!partnerLoading && !billingNotes && (
              <div className="px-4 py-3 bg-surface-primary">
                <p className="text-xs text-ink-muted italic">
                  Este cliente no tiene notas de facturación capturadas. Edita el catálogo de Socios si quieres dejar indicaciones internas.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Datos fiscales (precargados del cliente) */}
        <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos fiscales</p>
            {partnerProfile && !overrideTouched && (
              <span className="text-[10px] text-status-success bg-status-success/10 border border-status-success/40 px-1.5 py-0.5 rounded-full">
                ✓ Precargados del cliente
              </span>
            )}
            {overrideTouched && (
              <button type="button" onClick={() => {
                setOverrideTouched(false)
                if (partnerProfile) {
                  setPaymentMethod(partnerProfile.payment_method || 'PUE')
                  setPaymentForm(partnerProfile.payment_form     || '99')
                  setUseCfdi(partnerProfile.cfdi_use             || 'G01')
                }
              }} className="btn-ghost btn-sm text-[10px] text-ink-muted">
                Restaurar del cliente
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Uso CFDI</label>
              <SatCatalogSelect
                endpoint="uso-cfdi"
                params={(() => {
                  const reg = mode === 'ocasional' ? ocReceptor.taxRegimeCode : partnerProfile?.tax_regime_code
                  return reg ? { regimen: reg } : {}
                })()}
                value={useCfdi}
                onChange={code => { setUseCfdi(code); setOverrideTouched(true) }}
                placeholder="Buscar por código o nombre…"
              />
            </div>
            <div>
              <label className="label">Método de pago</label>
              <SatCatalogSelect
                endpoint="metodo-pago"
                value={paymentMethod}
                onChange={code => { setPaymentMethod(code); setOverrideTouched(true) }}
                placeholder="PUE / PPD"
              />
            </div>
            <div>
              <label className="label">Forma de pago</label>
              <SatCatalogSelect
                endpoint="forma-pago"
                value={paymentForm}
                onChange={code => { setPaymentForm(code); setOverrideTouched(true) }}
                placeholder="Efectivo, transferencia…"
              />
            </div>
          </div>
          {/* OC del cliente (po_number) — precargada del pedido/remisión si existe */}
          <div>
            <label className="label flex items-center gap-2">
              OC del cliente
              {partnerProfile?.requires_po && <span className="text-status-danger">*</span>}
              {inheritedPoNumber && !poTouched && (
                <span className="text-[10px] text-status-success bg-status-success/10 border border-status-success/40 px-1.5 py-0.5 rounded-full font-normal">
                  ✓ Heredada del {mode === 'direct' ? 'pedido' : 'pedido relacionado'}
                </span>
              )}
              {poTouched && inheritedPoNumber && poNumber !== inheritedPoNumber && (
                <button type="button" onClick={() => { setPoNumber(inheritedPoNumber); setPoTouched(false) }}
                  className="text-[10px] text-ink-muted hover:text-ink-secondary underline">
                  Restaurar ({inheritedPoNumber})
                </button>
              )}
            </label>
            <input className="input" value={poNumber}
              onChange={e => { setPoNumber(e.target.value); setPoTouched(true) }}
              placeholder={partnerProfile?.requires_po ? 'Obligatoria para este cliente' : 'Opcional — captura aquí si el cliente la entrega al facturar'} />
          </div>

          <div>
            <label className="label">Notas internas</label>
            <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Opcional — aparece en la factura" />
          </div>
        </div>

        {mode === 'ocasional' && ocTotals.total > 0 && (
          <div className="bg-teal-500/10 border border-teal-500/40 rounded-lg px-3 py-2 flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-xs text-ink-secondary">
              <span>Subtotal</span><span className="font-mono">{fmtMXN(ocTotals.subtotal, 'MXN')}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-ink-secondary">
              <span>IVA</span><span className="font-mono">{fmtMXN(ocTotals.tax, 'MXN')}</span>
            </div>
            {ocTotals.withheld > 0 && (
              <div className="flex items-center justify-between text-xs text-status-warning">
                <span>Retenciones</span><span className="font-mono">- {fmtMXN(ocTotals.withheld, 'MXN')}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm font-bold text-teal-300 border-t border-teal-500/30 pt-1 mt-0.5">
              <span>Total</span><span className="font-mono">{fmtMXN(ocTotals.total, 'MXN')}</span>
            </div>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={pending}>
            Cancelar
          </button>
          <button type="submit" className="btn-primary flex-1"
            disabled={pending || mixedClients || mixedCurrency ||
              (mode === 'from-remissions' ? selectedNoteIds.length === 0
                : mode === 'direct' ? !salesOrderId
                : ocTotals.total <= 0)}>
            {pending ? <Spinner size="sm" /> : (
              mode === 'from-remissions' && selectedNoteIds.length > 1
                ? `Crear factura consolidada (${selectedNoteIds.length})`
                : 'Crear factura'
            )}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}
