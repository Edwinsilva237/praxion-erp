import { useState, useRef, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { createPortal } from 'react-dom'
import { partnersApi } from '@/api/partners'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// ─── Catálogos SAT ────────────────────────────────────────────────────────────
const REGIMENES = [
  { code: '601', label: '601 – General de Ley Personas Morales' },
  { code: '603', label: '603 – Personas Morales con Fines no Lucrativos' },
  { code: '605', label: '605 – Sueldos y Salarios e Ingresos Asimilados' },
  { code: '606', label: '606 – Arrendamiento' },
  { code: '608', label: '608 – Demás ingresos' },
  { code: '609', label: '609 – Consolidación' },
  { code: '610', label: '610 – Residentes en el Extranjero' },
  { code: '611', label: '611 – Ingresos por Dividendos' },
  { code: '612', label: '612 – Personas Físicas con Actividades Empresariales' },
  { code: '614', label: '614 – Ingresos por intereses' },
  { code: '616', label: '616 – Sin obligaciones fiscales' },
  { code: '620', label: '620 – Sociedades Cooperativas de Producción' },
  { code: '621', label: '621 – Incorporación Fiscal' },
  { code: '622', label: '622 – Actividades Agrícolas, Ganaderas, Silvícolas' },
  { code: '623', label: '623 – Opcional para Grupos de Sociedades' },
  { code: '624', label: '624 – Coordinados' },
  { code: '625', label: '625 – Régimen de las Actividades Empresariales con ingresos por Plataformas Tecnológicas' },
  { code: '626', label: '626 – Régimen Simplificado de Confianza (RESICO)' },
]

const CFDI_USES = [
  { code: 'G01', label: 'G01 – Adquisición de mercancias' },
  { code: 'G02', label: 'G02 – Devoluciones, descuentos o bonificaciones' },
  { code: 'G03', label: 'G03 – Gastos en general' },
  { code: 'I01', label: 'I01 – Construcciones' },
  { code: 'I02', label: 'I02 – Mobilario y equipo de oficina por inversiones' },
  { code: 'I03', label: 'I03 – Equipo de transporte' },
  { code: 'I04', label: 'I04 – Equipo de computo y accesorios' },
  { code: 'I06', label: 'I06 – Comunicaciones telefónicas' },
  { code: 'I08', label: 'I08 – Otra maquinaria y equipo' },
  { code: 'D01', label: 'D01 – Honorarios médicos, dentales y hospitalarios' },
  { code: 'D10', label: 'D10 – Pagos por servicios educativos (colegiaturas)' },
  { code: 'S01', label: 'S01 – Sin efectos fiscales' },
  { code: 'CP01', label: 'CP01 – Pagos' },
]

const PAYMENT_METHODS = [
  { code: 'PUE', label: 'PUE – Pago en una sola exhibición' },
  { code: 'PPD', label: 'PPD – Pago en parcialidades o diferido' },
]

const PAYMENT_FORMS = [
  { code: '01', label: '01 – Efectivo' },
  { code: '02', label: '02 – Cheque nominativo' },
  { code: '03', label: '03 – Transferencia electrónica' },
  { code: '04', label: '04 – Tarjeta de crédito' },
  { code: '28', label: '28 – Tarjeta de débito' },
  { code: '99', label: '99 – Por definir' },
]

const ESTADOS_MX = [
  'Aguascalientes','Baja California','Baja California Sur','Campeche','Chiapas',
  'Chihuahua','Ciudad de México','Coahuila','Colima','Durango','Guanajuato',
  'Guerrero','Hidalgo','Jalisco','México','Michoacán','Morelos','Nayarit',
  'Nuevo León','Oaxaca','Puebla','Querétaro','Quintana Roo','San Luis Potosí',
  'Sinaloa','Sonora','Tabasco','Tamaulipas','Tlaxcala','Veracruz','Yucatán','Zacatecas',
]

const CONTACT_ROLES = [
  'Compras', 'Almacén', 'Facturación', 'Cuentas por pagar',
  'Gerencia', 'Ventas', 'Logística', 'Calidad', 'General',
]

const TYPE_LABEL   = { customer: 'Cliente', supplier: 'Proveedor', both: 'Ambos' }
const TYPE_VARIANT = { customer: 'blue', supplier: 'amber', both: 'purple' }

// Mapea el texto del régimen extraído de la CSF al código SAT correspondiente.
// Soporta variaciones con/sin acentos, mayúsculas y prefijos numéricos.
function findRegimeCode(rawText) {
  if (!rawText) return ''
  const normalize = (s) => s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const target = normalize(rawText)

  // Pass 1: match por inclusión bidireccional del label "limpio" (sin "601 – ")
  for (const r of REGIMENES) {
    const labelOnly = r.label.replace(/^\d+\s*[–\-]\s*/, '')
    const candidate = normalize(labelOnly)
    if (target === candidate || target.includes(candidate) || candidate.includes(target)) {
      return r.code
    }
  }
  // Pass 2: el texto puede empezar con el código directamente ("601 General de Ley...")
  const m = rawText.match(/^(\d{3})\b/)
  if (m && REGIMENES.some(r => r.code === m[1])) return m[1]
  return ''
}

// ─── Schema ───────────────────────────────────────────────────────────────────
const contactSchema = z.object({
  name:      z.string().min(1, 'Requerido'),
  position:  z.string().optional().or(z.literal('')),
  email:     z.string().email('Email inválido').optional().or(z.literal('')),
  phone:     z.string().optional().or(z.literal('')),
  isPrimary: z.boolean().optional(),
})

const addressSchema = z.object({
  alias:           z.string().min(1, 'Requerido'),
  contactName:     z.string().optional().or(z.literal('')),
  phone:           z.string().optional().or(z.literal('')),
  address:         z.string().min(1, 'Requerido'),
  neighborhood:    z.string().optional().or(z.literal('')),
  city:            z.string().min(1, 'Requerido'),
  state:           z.string().min(1, 'Requerido'),
  zipCode:         z.string().optional().or(z.literal('')),
  freightIncluded: z.boolean().optional(),
  isDefault:       z.boolean().optional(),
  notes:           z.string().optional().or(z.literal('')),
})

const schema = z.object({
  // General
  type:         z.enum(['customer', 'supplier', 'both'], { required_error: 'Requerido' }),
  name:         z.string().min(2, 'Mínimo 2 caracteres'),
  personType:   z.enum(['moral', 'fisica']).optional(),
  internalCode: z.string().optional().or(z.literal('')),

  // Fiscal
  rfc:           z.string().max(13).optional().or(z.literal('')),
  taxName:       z.string().optional().or(z.literal('')),
  taxRegime:     z.string().optional().or(z.literal('')),
  taxRegimeCode: z.string().optional().or(z.literal('')),
  zipCode:       z.string().max(10).optional().or(z.literal('')),

  // CFDI
  cfdiUse:       z.string().optional().or(z.literal('')),
  paymentMethod: z.string().optional().or(z.literal('')),
  paymentForm:   z.string().optional().or(z.literal('')),

  // Comercial
  creditType:        z.enum(['cash', 'credit']).optional(),
  creditDays:        z.coerce.number().min(0).max(365).optional(),
  creditLimit:       z.coerce.number().min(0).optional(),
  preferredCurrency: z.enum(['MXN', 'USD']).optional(),
  requiresPo:        z.boolean().optional(),

  // Proveedor (solo se llenan cuando type='supplier' o 'both')
  supplierCreditDays:      z.coerce.number().min(0).max(365).optional().or(z.literal('')),
  supplierCreditLimit:     z.coerce.number().min(0).optional().or(z.literal('')),
  supplierLeadTimeDays:    z.coerce.number().min(0).max(365).optional().or(z.literal('')),
  supplierMinOrderAmount:  z.coerce.number().min(0).optional().or(z.literal('')),
  supplierBankName:        z.string().max(80).optional().or(z.literal('')),
  supplierAccountHolder:   z.string().max(150).optional().or(z.literal('')),
  supplierAccountNumber:   z.string().max(40).optional().or(z.literal('')),
  supplierClabe:           z.string().regex(/^$|^[0-9]{18}$/, 'CLABE debe tener 18 dígitos').optional().or(z.literal('')),
  supplierSwift:           z.string().max(11).optional().or(z.literal('')),
  website:                 z.string().max(200).optional().or(z.literal('')),
  supplierRating:          z.enum(['A','B','C']).optional().or(z.literal('')),

  // Domicilio fiscal
  address:      z.string().optional().or(z.literal('')),
  neighborhood: z.string().optional().or(z.literal('')),
  city:         z.string().optional().or(z.literal('')),
  state:        z.string().optional().or(z.literal('')),

  // Facturación electrónica
  autoSendInvoice:   z.boolean().optional(),
  autoSendRemission: z.boolean().optional(),
  billingNotes:      z.string().optional().or(z.literal('')),

  // Contactos (array dinámico)
  contacts: z.array(contactSchema).optional(),

  // Notas generales
  notes: z.string().optional().or(z.literal('')),
})

// ─── Componente Colapsable ────────────────────────────────────────────────────
function Section({ title, icon, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-line-subtle rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-ink-muted">{icon}</span>
          <span className="text-sm font-medium text-ink-primary">{title}</span>
          {badge && <span className="badge badge-blue text-[10px]">{badge}</span>}
        </div>
        <svg
          className={clsx('w-4 h-4 text-ink-muted transition-transform', open && 'rotate-180')}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 py-4 space-y-4">{children}</div>}
    </div>
  )
}

// ─── Radio group visual ───────────────────────────────────────────────────────
function RadioGroup({ options, value, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map(({ val, label }) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          className={clsx(
            'flex-1 text-center py-2 rounded-lg border text-sm transition-colors',
            value === val
              ? 'border-brand-600 bg-brand-500/10 text-brand-300 font-medium'
              : 'border-line-subtle text-ink-secondary hover:bg-surface-elevated/40'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ─── Toggle checkbox ──────────────────────────────────────────────────────────
function Toggle({ label, checked, onChange, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <div className="relative mt-0.5">
        <input type="checkbox" className="sr-only" checked={!!checked} onChange={e => onChange(e.target.checked)} />
        <div className={clsx(
          'w-9 h-5 rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-surface-elevated'
        )}>
          <div className={clsx(
            'absolute top-0.5 w-4 h-4 bg-surface-primary rounded-full shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5'
          )} />
        </div>
      </div>
      <div>
        <p className="text-sm text-ink-secondary">{label}</p>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
    </label>
  )
}

// Mapea la fila completa del backend (snake_case + contacts agregados) a los
// defaultValues del react-hook-form (camelCase). Centralizado para que el
// useForm inicial y el reset() al cargar el detalle usen la misma lógica.
function partnerToFormValues(partner) {
  return {
    type:              partner.type,
    name:              partner.name || '',
    personType:        partner.person_type || 'moral',
    internalCode:      partner.internal_code || '',
    rfc:               partner.rfc || '',
    taxName:           partner.tax_name || '',
    taxRegime:         partner.tax_regime || '',
    taxRegimeCode:     partner.tax_regime_code || '',
    zipCode:           partner.zip_code || '',
    cfdiUse:           partner.cfdi_use || 'G01',
    paymentMethod:     partner.payment_method || 'PUE',
    paymentForm:       partner.payment_form || '99',
    creditType:        partner.credit_type || 'cash',
    creditDays:        partner.credit_days || 0,
    creditLimit:       partner.credit_limit || 0,
    preferredCurrency: partner.preferred_currency || 'MXN',
    requiresPo:        partner.requires_po || false,
    address:           partner.address || '',
    neighborhood:      partner.neighborhood || '',
    city:              partner.city || '',
    state:             partner.state || '',
    autoSendInvoice:   partner.auto_send_invoice || false,
    autoSendRemission: partner.auto_send_remission || false,
    billingNotes:      partner.billing_notes || '',
    // Proveedor
    supplierCreditDays:     partner.supplier_credit_days     ?? '',
    supplierCreditLimit:    partner.supplier_credit_limit    ?? '',
    supplierLeadTimeDays:   partner.supplier_lead_time_days  ?? '',
    supplierMinOrderAmount: partner.supplier_min_order_amount ?? '',
    supplierBankName:       partner.supplier_bank_name       || '',
    supplierAccountHolder:  partner.supplier_account_holder  || '',
    supplierAccountNumber:  partner.supplier_account_number  || '',
    supplierClabe:          partner.supplier_clabe           || '',
    supplierSwift:          partner.supplier_swift           || '',
    website:                partner.website                  || '',
    supplierRating:         partner.supplier_rating          || '',
    // Los contactos vienen del backend en snake_case (is_primary). El form usa camelCase.
    contacts: (partner.contacts || []).map(c => ({
      name:      c.name      || '',
      position:  c.position  || '',
      email:     c.email     || '',
      phone:     c.phone     || '',
      isPrimary: c.is_primary || false,
    })),
    notes: partner.notes || '',
  }
}

const NEW_PARTNER_DEFAULTS = {
  type: 'customer',
  personType: 'moral',
  creditType: 'cash',
  creditDays: 0,
  creditLimit: 0,
  preferredCurrency: 'MXN',
  cfdiUse: 'G01',
  paymentMethod: 'PUE',
  paymentForm: '99',
  autoSendInvoice: false,
  autoSendRemission: false,
  contacts: [],
}

// ─── Modal principal ──────────────────────────────────────────────────────────
function PartnerModal({ partner: partnerStub, onClose, onSaved }) {
  const isEdit = !!partnerStub
  const qc = useQueryClient()
  const fileInputRef = useRef()
  const [csfLoading, setCsfLoading] = useState(false)
  const [csfWarning, setCsfWarning] = useState(null)

  // Domicilios de entrega (estado local, se guardan por separado)
  const [addresses, setAddresses] = useState([])
  // newAddress: null cerrado | { ..., _editingId: <id|null> } formulario abierto en modo crear (id null) o editar
  const [newAddress, setNewAddress] = useState(null)

  // Contactos colapsables: { [index]: true } cuando expandido
  const [expandedContacts, setExpandedContacts] = useState({})

  // En edición, cargar el detalle completo: el listado de partners NO devuelve todos los campos.
  const { data: partnerDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['partner', partnerStub?.id],
    queryFn: () => partnersApi.get(partnerStub.id),
    enabled: !!partnerStub?.id,
  })

  const { register, handleSubmit, watch, setValue, control, reset,
    formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: NEW_PARTNER_DEFAULTS,
  })

  // Cuando llega el detalle completo del partner (en edición), repoblar el form.
  // Sin esto, los campos que no vienen en el listado (taxName, cfdi_use, billing_notes, contacts, etc.)
  // quedan vacíos aunque estén guardados en BD.
  useEffect(() => {
    if (partnerDetail) {
      reset(partnerToFormValues(partnerDetail))
    }
  }, [partnerDetail, reset])

  const { fields: contactFields, append: addContact, remove: removeContact } = useFieldArray({
    control, name: 'contacts',
  })

  // Cargar domicilios si es edición.
  // Nota: en react-query v5 el callback `onSuccess` en useQuery fue eliminado.
  // Hay que reaccionar al cambio de `data` con un useEffect.
  const { data: addressData } = useQuery({
    queryKey: ['partner-addresses', partnerStub?.id],
    queryFn: () => partnersApi.listAddresses(partnerStub.id),
    enabled: !!partnerStub?.id,
  })
  useEffect(() => {
    if (addressData) setAddresses(addressData)
  }, [addressData])

  // ── CSF upload ──────────────────────────────────────────────────────────────
  const handleCSF = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsfLoading(true)
    setCsfWarning(null)
    try {
      const { extracted, vigency, warning } = await partnersApi.parseCSF(file)
      // Pre-llenar campos
      if (extracted.rfc)       setValue('rfc', extracted.rfc)
      if (extracted.name) {
        // Solo prellenar la razón social fiscal. El nombre comercial queda libre
        // para que el usuario lo capture manualmente (típicamente es un alias
        // corto distinto a la razón social, ej. "Don Pepe" vs "PEPSA SA DE CV").
        setValue('taxName', extracted.name)
      }
      if (extracted.zipCode)   setValue('zipCode', extracted.zipCode)
      if (extracted.address)   setValue('address', extracted.address)
      if (extracted.city)      setValue('city', extracted.city)
      if (extracted.state)     setValue('state', extracted.state)
      if (extracted.neighborhood) setValue('neighborhood', extracted.neighborhood)
      if (extracted.taxRegime) {
        setValue('taxRegime', extracted.taxRegime)
        // Intentar mapear el texto al código SAT para que el select quede sincronizado.
        const code = findRegimeCode(extracted.taxRegime)
        if (code) setValue('taxRegimeCode', code)
      }
      if (extracted.personType) setValue('personType', extracted.personType)
      if (warning) setCsfWarning(warning)
    } catch (err) {
      setCsfWarning(err.response?.data?.error || 'No se pudo leer la CSF')
    } finally {
      setCsfLoading(false)
      fileInputRef.current.value = ''
    }
  }

  // ── Guardar socio ───────────────────────────────────────────────────────────
  const mutation = useMutation({
    mutationFn: (data) =>
      isEdit ? partnersApi.update(partnerStub.id, data) : partnersApi.create(data),
    onSuccess: async (saved) => {
      // Persistir cambios en domicilios de entrega:
      //   _new       → POST /addresses
      //   _modified  → PATCH /addresses/:id
      //   _deleted   → DELETE /addresses/:id (no implementado aquí — sólo borrado local)
      for (const addr of addresses) {
        try {
          if (addr._new) {
            const { _new, _modified, id, ...payload } = addr
            await partnersApi.addAddress(saved.id, payload)
          } else if (addr._modified) {
            const { _new, _modified, id, ...payload } = addr
            await partnersApi.updateAddress(saved.id, id, payload)
          }
        } catch {}
      }
      qc.invalidateQueries({ queryKey: ['partners'] })
      qc.invalidateQueries({ queryKey: ['partner-addresses', saved.id] })
      onSaved()
    },
  })

  const onSubmit = (data) => mutation.mutate(data)

  // ── Domicilio de entrega ────────────────────────────────────────────────────
  // Acepta crear nuevo o editar existente según newAddress._editingId.
  const handleSaveAddress = () => {
    if (!newAddress) return
    if (!newAddress.alias || !newAddress.address || !newAddress.city || !newAddress.state) return

    const editingId = newAddress._editingId
    if (editingId) {
      // Edición: reemplazar en el array, marcando como modificado (si era existente del backend).
      setAddresses(prev => prev.map(a => {
        if (a.id !== editingId) return a
        const { _editingId, ...rest } = newAddress
        return { ...a, ...rest, id: editingId, _modified: !a._new }
      }))
    } else {
      // Creación: agregar al array con flag _new.
      const { _editingId, ...rest } = newAddress
      setAddresses(prev => [...prev, { ...rest, _new: true, id: Date.now() }])
    }
    setNewAddress(null)
  }

  const handleEditAddress = (addr) => {
    setNewAddress({ ...addr, _editingId: addr.id })
  }

  const modalContent = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-2xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink-primary">
              {isEdit ? 'Editar socio de negocio' : 'Nuevo socio de negocio'}
            </h2>
            {detailLoading && (
              <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                <Spinner size="sm" /> Cargando datos…
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Botón CSF */}
            <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleCSF} />
            <button
              type="button"
              onClick={() => fileInputRef.current.click()}
              disabled={csfLoading}
              className="btn-secondary btn-sm flex items-center gap-1.5"
              title="Pre-llenar desde Constancia de Situación Fiscal"
            >
              {csfLoading
                ? <Spinner size="sm" />
                : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
              }
              {csfLoading ? 'Leyendo CSF...' : 'Cargar CSF'}
            </button>
            <button onClick={onClose} className="p-1 rounded-lg text-ink-muted hover:text-ink-secondary hover:bg-surface-elevated/60">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Aviso CSF */}
        {csfWarning && (
          <div className="mx-6 mt-3 p-3 bg-status-warning/10 border border-status-warning/40 rounded-lg text-xs text-status-warning shrink-0">
            ⚠️ {csfWarning}
          </div>
        )}

        {/* Formulario scrollable */}
        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">

          {/* ── 1. Datos generales ─────────────────────────────────────────── */}
          <Section
            title="Datos generales"
            defaultOpen={true}
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>}
          >
            <div>
              <label className="label">Tipo *</label>
              <RadioGroup
                options={[{val:'customer',label:'Cliente'},{val:'supplier',label:'Proveedor'},{val:'both',label:'Ambos'}]}
                value={watch('type')}
                onChange={(v) => setValue('type', v)}
              />
              {errors.type && <p className="field-error">{errors.type.message}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Nombre comercial *</label>
                <input className={`input ${errors.name ? 'input-error' : ''}`}
                  placeholder="Ej: Don Pepe, Pepsa Norte..."
                  {...register('name')} />
                {errors.name && <p className="field-error">{errors.name.message}</p>}
              </div>
              <div>
                <label className="label">Código interno</label>
                <input className="input" placeholder="PROV-001" {...register('internalCode')} />
              </div>
            </div>

            <div>
              <label className="label">Tipo de persona</label>
              <RadioGroup
                options={[{val:'moral',label:'Persona moral'},{val:'fisica',label:'Persona física'}]}
                value={watch('personType')}
                onChange={(v) => setValue('personType', v)}
              />
            </div>

            <div>
              <label className="label">Notas generales</label>
              <textarea className="input h-16 resize-none" {...register('notes')} />
            </div>
          </Section>

          {/* ── 2. Datos fiscales ──────────────────────────────────────────── */}
          <Section
            title="Datos fiscales"
            defaultOpen={true}
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z"/></svg>}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">RFC</label>
                <input className="input" placeholder="XAXX010101000" style={{textTransform:'uppercase'}} {...register('rfc')} />
              </div>
              <div>
                <label className="label">Razón social (CFDI)</label>
                <input className="input" placeholder="Nombre exacto como aparece en CSF"
                  {...register('taxName')} />
              </div>
            </div>

            <div>
              <label className="label">Régimen fiscal</label>
              <select className="select" {...register('taxRegimeCode')}
                onChange={(e) => {
                  setValue('taxRegimeCode', e.target.value)
                  const found = REGIMENES.find(r => r.code === e.target.value)
                  if (found) setValue('taxRegime', found.label)
                }}
              >
                <option value="">Seleccionar régimen</option>
                {REGIMENES.map(r => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
            </div>

          </Section>

          {/* ── 3. Preferencias CFDI (solo si es cliente o ambos) ─────────── */}
          {['customer','both'].includes(watch('type')) && (
          <Section
            title="Preferencias CFDI"
            badge="cliente"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>}
          >
            <div>
              <label className="label">Uso de CFDI</label>
              <select className="select" {...register('cfdiUse')}>
                {CFDI_USES.map(u => <option key={u.code} value={u.code}>{u.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Método de pago</label>
                <select className="select" {...register('paymentMethod')}>
                  {PAYMENT_METHODS.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Forma de pago</label>
                <select className="select" {...register('paymentForm')}>
                  {PAYMENT_FORMS.map(f => <option key={f.code} value={f.code}>{f.label}</option>)}
                </select>
              </div>
            </div>
          </Section>
          )}

          {/* ── 4. Condiciones comerciales (solo cliente: crédito que YO doy) ── */}
          {['customer','both'].includes(watch('type')) && (
          <Section
            title="Condiciones comerciales"
            badge="cliente"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}
          >
            <div>
              <label className="label">Condiciones de pago</label>
              <RadioGroup
                options={[{val:'cash',label:'Contado'},{val:'credit',label:'Crédito'}]}
                value={watch('creditType')}
                onChange={(v) => setValue('creditType', v)}
              />
            </div>

            {watch('creditType') === 'credit' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Días de crédito</label>
                  <input type="number" min="0" className="input" {...register('creditDays')} />
                </div>
                <div>
                  <label className="label">Límite de crédito (MXN)</label>
                  <input type="number" min="0" className="input" {...register('creditLimit')} />
                </div>
              </div>
            )}

            <div>
              <label className="label">Moneda preferida</label>
              <RadioGroup
                options={[{val:'MXN',label:'MXN – Peso mexicano'},{val:'USD',label:'USD – Dólar'}]}
                value={watch('preferredCurrency')}
                onChange={(v) => setValue('preferredCurrency', v)}
              />
            </div>

            <div className="space-y-3 pt-1">
              <Toggle
                label="Requiere número de OC"
                description="Aviso al capturar pedido. Obligatorio al timbrar factura."
                checked={watch('requiresPo')}
                onChange={(v) => setValue('requiresPo', v)}
              />
            </div>
          </Section>
          )}

          {/* ── 4b. Datos del proveedor (solo si es proveedor o ambos) ───── */}
          {['supplier','both'].includes(watch('type')) && (
          <Section
            title="Datos del proveedor"
            badge="proveedor"
            defaultOpen={watch('type') === 'supplier'}
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1"/></svg>}
          >
            <p className="text-[11px] text-ink-muted -mt-1">
              Estos datos describen lo que el proveedor te ofrece (crédito, lead time)
              y cómo le pagas (datos bancarios). Distintos de las condiciones que TÚ otorgas a clientes.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Días de crédito que te da</label>
                <input type="number" min="0" max="365" className="input"
                  placeholder="Ej. 30" {...register('supplierCreditDays')} />
                <p className="text-[10px] text-ink-muted mt-0.5">Para calcular el vencimiento de tus pagos a este proveedor.</p>
              </div>
              <div>
                <label className="label">Límite de crédito que te abre</label>
                <input type="number" min="0" step="0.01" className="input"
                  placeholder="0.00" {...register('supplierCreditLimit')} />
                <p className="text-[10px] text-ink-muted mt-0.5">Opcional · referencia interna.</p>
              </div>
              <div>
                <label className="label">Lead time promedio (días)</label>
                <input type="number" min="0" max="365" className="input"
                  placeholder="Ej. 7" {...register('supplierLeadTimeDays')} />
                <p className="text-[10px] text-ink-muted mt-0.5">Días entre OC y recepción. Alimenta sugerencias de reorden.</p>
              </div>
              <div>
                <label className="label">Monto mínimo de pedido (MOQ)</label>
                <input type="number" min="0" step="0.01" className="input"
                  placeholder="0.00" {...register('supplierMinOrderAmount')} />
                <p className="text-[10px] text-ink-muted mt-0.5">Validación al crear OC. 0 = sin mínimo.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Calificación</label>
                <select className="select" {...register('supplierRating')}>
                  <option value="">— Sin calificar —</option>
                  <option value="A">A — Estratégico</option>
                  <option value="B">B — Estándar</option>
                  <option value="C">C — Ocasional / Spot</option>
                </select>
                <p className="text-[10px] text-ink-muted mt-0.5 leading-snug">
                  <strong>A</strong>: confiable en calidad, precio y tiempo — prioridad alta. ·{' '}
                  <strong>B</strong>: cumple, alternativa válida. ·{' '}
                  <strong>C</strong>: solo cuando A/B no pueden surtir.
                </p>
              </div>
              <div>
                <label className="label">Sitio web</label>
                <input className="input" placeholder="https://proveedor.com" {...register('website')} />
              </div>
            </div>

            <div className="pt-2">
              <p className="text-xs font-medium text-ink-secondary uppercase tracking-wide mb-2">
                Datos bancarios — dónde pagas al proveedor
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Banco</label>
                  <input className="input" placeholder="BBVA, Banorte..." {...register('supplierBankName')} />
                </div>
                <div>
                  <label className="label">Titular de la cuenta</label>
                  <input className="input" placeholder="Puede diferir del nombre del proveedor"
                    {...register('supplierAccountHolder')} />
                </div>
                <div>
                  <label className="label">No. cuenta</label>
                  <input className="input font-mono" {...register('supplierAccountNumber')} />
                </div>
                <div>
                  <label className="label">CLABE (18 dígitos)</label>
                  <input className="input font-mono" maxLength={18}
                    placeholder="012345678901234567"
                    {...register('supplierClabe')} />
                  {errors.supplierClabe && <p className="field-error">{errors.supplierClabe.message}</p>}
                </div>
                <div className="sm:col-span-2">
                  <label className="label">SWIFT / BIC <span className="text-ink-muted font-normal text-[10px]">(solo proveedor extranjero)</span></label>
                  <input className="input font-mono" maxLength={11}
                    placeholder="BBVAMXMM"
                    {...register('supplierSwift')} />
                </div>
              </div>
            </div>
          </Section>
          )}

          {/* ── 5. Domicilios ─────────────────────────────────────────────── */}
          <Section
            title="Domicilios"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>}
          >
            {/* Domicilio fiscal */}
            <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">Domicilio fiscal</p>
            <input className="input" placeholder="Calle y número" {...register('address')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <input className="input" placeholder="Colonia" {...register('neighborhood')} />
              <input className="input" placeholder="Ciudad" {...register('city')} />
              <select className="select" {...register('state')}>
                <option value="">Estado</option>
                {ESTADOS_MX.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
              <input className="input" placeholder="C.P. fiscal" maxLength={5} {...register('zipCode')} />
            </div>

            {/* Domicilios de entrega */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide">
                  Domicilios de entrega
                  {addresses.length > 0 && <span className="ml-1.5 badge badge-gray">{addresses.length}</span>}
                </p>
                {!newAddress && (
                  <button type="button" onClick={() => setNewAddress({})}
                    className="btn-ghost btn-sm text-brand-300 text-xs flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                    </svg>
                    Agregar domicilio
                  </button>
                )}
              </div>

              {/* Lista de domicilios guardados */}
              {addresses.map((addr, i) => {
                // Normaliza ambos casos: backend usa snake_case, los nuevos en frontend usan camelCase.
                const freight   = addr.freightIncluded ?? addr.freight_included
                const isDefault = addr.isDefault       ?? addr.is_default
                const contactName = addr.contactName   ?? addr.contact_name
                const zip       = addr.zipCode         ?? addr.zip_code
                return (
                  <div key={addr.id || i} className="flex items-start justify-between p-3 bg-surface-elevated/40 rounded-lg mb-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-ink-primary">{addr.alias}</p>
                      <p className="text-ink-muted text-xs">
                        {addr.address}{addr.neighborhood ? `, ${addr.neighborhood}` : ''}, {addr.city}, {addr.state}{zip ? ` · CP ${zip}` : ''}
                      </p>
                      {contactName && <p className="text-ink-muted text-[11px] mt-0.5">Contacto: {contactName}</p>}
                      <div className="flex gap-1 mt-1">
                        {freight && <span className="badge badge-green text-[10px]">Flete incluido</span>}
                        {isDefault && <span className="badge badge-blue text-[10px]">Principal</span>}
                        {addr._modified && <span className="badge badge-amber text-[10px]">Modificado</span>}
                        {addr._new && <span className="badge badge-amber text-[10px]">Nuevo</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button type="button" onClick={() => handleEditAddress({
                        ...addr,
                        // Mapear los campos snake_case del backend a camelCase del form
                        freightIncluded: freight,
                        isDefault, contactName, zipCode: zip,
                      })}
                        className="text-ink-muted hover:text-brand-300 p-1" title="Editar">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button type="button" onClick={() => setAddresses(prev => prev.filter((_, j) => j !== i))}
                        className="text-ink-muted hover:text-status-danger p-1" title="Quitar">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* Formulario nuevo / edición de domicilio */}
              {newAddress !== null && (
                <div className="border border-brand-100 bg-brand-500/10/30 rounded-xl p-4 space-y-3">
                  <p className="text-xs font-medium text-brand-300">
                    {newAddress._editingId ? 'Editar domicilio de entrega' : 'Nuevo domicilio de entrega'}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Alias *</label>
                      <input className="input" placeholder="Bodega principal"
                        value={newAddress.alias || ''}
                        onChange={e => setNewAddress(p => ({...p, alias: e.target.value}))} />
                    </div>
                    <div>
                      <label className="label">Contacto</label>
                      <input className="input" placeholder="Nombre del responsable"
                        value={newAddress.contactName || ''}
                        onChange={e => setNewAddress(p => ({...p, contactName: e.target.value}))} />
                    </div>
                  </div>
                  <div>
                    <label className="label">Dirección *</label>
                    <input className="input" placeholder="Calle y número"
                      value={newAddress.address || ''}
                      onChange={e => setNewAddress(p => ({...p, address: e.target.value}))} />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <input className="input" placeholder="Colonia"
                      value={newAddress.neighborhood || ''}
                      onChange={e => setNewAddress(p => ({...p, neighborhood: e.target.value}))} />
                    <input className="input" placeholder="Ciudad *"
                      value={newAddress.city || ''}
                      onChange={e => setNewAddress(p => ({...p, city: e.target.value}))} />
                    <select className="select"
                      value={newAddress.state || ''}
                      onChange={e => setNewAddress(p => ({...p, state: e.target.value}))}>
                      <option value="">Estado *</option>
                      {ESTADOS_MX.map(e => <option key={e} value={e}>{e}</option>)}
                    </select>
                    <input className="input" placeholder="C.P."
                      value={newAddress.zipCode || ''}
                      onChange={e => setNewAddress(p => ({...p, zipCode: e.target.value}))} />
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                      <input type="checkbox"
                        checked={!!newAddress.freightIncluded}
                        onChange={e => setNewAddress(p => ({...p, freightIncluded: e.target.checked}))} />
                      Flete incluido
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                      <input type="checkbox"
                        checked={!!newAddress.isDefault}
                        onChange={e => setNewAddress(p => ({...p, isDefault: e.target.checked}))} />
                      Domicilio principal
                    </label>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => setNewAddress(null)} className="btn-secondary btn-sm">Cancelar</button>
                    <button type="button" onClick={handleSaveAddress} className="btn-primary btn-sm">
                      {newAddress._editingId ? 'Guardar cambios' : 'Agregar'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* ── 6. Personas asociadas ──────────────────────────────────────── */}
          <Section
            title="Personas asociadas"
            badge={contactFields.length > 0 ? contactFields.length : undefined}
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>}
          >
            {contactFields.map((field, i) => {
              const contact = watch(`contacts.${i}`) || {}
              const isExpanded = !!expandedContacts[i] || !contact.name
              return (
                <div key={field.id} className="border border-line-subtle rounded-xl overflow-hidden">
                  {/* Header colapsable */}
                  <button type="button"
                    onClick={() => setExpandedContacts(prev => ({ ...prev, [i]: !prev[i] }))}
                    className="w-full flex items-center justify-between px-4 py-3 bg-surface-elevated/40 hover:bg-surface-elevated/60 text-left transition-colors">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <svg className={clsx('w-3.5 h-3.5 text-ink-muted shrink-0 transition-transform', isExpanded && 'rotate-90')}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                      </svg>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-primary truncate">
                          {contact.name || <span className="text-ink-muted italic">Sin nombre</span>}
                        </p>
                        <p className="text-[11px] text-ink-muted truncate">
                          {[contact.position, contact.email, contact.phone].filter(Boolean).join(' · ') || 'Sin datos de contacto'}
                        </p>
                      </div>
                      {contact.isPrimary && <span className="badge badge-blue text-[10px] shrink-0">Principal</span>}
                    </div>
                    <button type="button" onClick={(e) => { e.stopPropagation(); removeContact(i) }}
                      className="text-ink-muted hover:text-red-400 ml-2 shrink-0" title="Quitar contacto">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                    </button>
                  </button>

                  {/* Cuerpo expandido */}
                  {isExpanded && (
                    <div className="px-4 py-3 space-y-3 bg-surface-primary">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label">Nombre *</label>
                          <input className={`input ${errors.contacts?.[i]?.name ? 'input-error' : ''}`}
                            {...register(`contacts.${i}.name`)} />
                        </div>
                        <div>
                          <label className="label">Área / Rol</label>
                          <select className="select" {...register(`contacts.${i}.position`)}>
                            <option value="">Seleccionar área</option>
                            {CONTACT_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label">Correo</label>
                          <input type="email" className="input" {...register(`contacts.${i}.email`)} />
                        </div>
                        <div>
                          <label className="label">Teléfono</label>
                          <input className="input" {...register(`contacts.${i}.phone`)} />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
                        <input type="checkbox" {...register(`contacts.${i}.isPrimary`)} />
                        Contacto principal
                      </label>
                    </div>
                  )}
                </div>
              )
            })}

            <button type="button"
              onClick={() => {
                addContact({ name: '', position: '', email: '', phone: '', isPrimary: false })
                // Auto-expandir el contacto recién agregado
                setExpandedContacts(prev => ({ ...prev, [contactFields.length]: true }))
              }}
              className="btn-secondary w-full justify-center text-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
              </svg>
              Agregar persona
            </button>
          </Section>

          {/* ── 7. Facturación electrónica (solo cliente o ambos) ────────── */}
          {['customer','both'].includes(watch('type')) && (
          <Section
            title="Facturación electrónica"
            badge="cliente"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>}
          >
            <div className="space-y-3">
              <Toggle
                label="Enviar XML + PDF automáticamente al timbrar"
                description="Se envía por correo en cuanto se sella el CFDI"
                checked={watch('autoSendInvoice')}
                onChange={(v) => setValue('autoSendInvoice', v)}
              />
              <Toggle
                label="Enviar remisión automáticamente"
                description="Se envía PDF al emitir la nota de entrega"
                checked={watch('autoSendRemission')}
                onChange={(v) => setValue('autoSendRemission', v)}
              />
            </div>

            <div>
              <label className="label">Notas de facturación</label>
              <textarea className="input h-16 resize-none"
                placeholder="Instrucciones especiales al facturar..."
                {...register('billingNotes')} />
            </div>
          </Section>
          )}

          {/* Error servidor */}
          {mutation.error && (
            <div className="p-3 bg-status-danger/10 border border-status-danger/40 rounded-lg text-sm text-status-danger">
              {mutation.error.response?.data?.error || 'Ocurrió un error. Intenta de nuevo.'}
            </div>
          )}
        </form>

        {/* Footer fijo */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line-subtle shrink-0">
          <button type="button" onClick={onClose} className="btn-secondary">Cancelar</button>
          <button
            onClick={handleSubmit(onSubmit)}
            disabled={isSubmitting || mutation.isPending}
            className="btn-primary"
          >
            {(isSubmitting || mutation.isPending) && <Spinner size="sm" className="text-white" />}
            {isEdit ? 'Guardar cambios' : 'Crear socio'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modalContent, document.body)
}

// ─── Modal de captura rápida ──────────────────────────────────────────────────
// Para clientes "solo remisión": no requiere RFC ni datos fiscales. Al
// momento de timbrar una factura, el backend devuelve MISSING_FISCAL_DATA y
// el frontend abre el form completo para completar.
function QuickPartnerModal({ onClose, onSaved }) {
  const qc = useQueryClient()
  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(z.object({
      type:    z.enum(['customer', 'supplier', 'both']),
      name:    z.string().min(2, 'Mínimo 2 caracteres'),
      phone:   z.string().optional().or(z.literal('')),
      email:   z.string().email('Email inválido').optional().or(z.literal('')),
      address: z.string().optional().or(z.literal('')),
      city:    z.string().optional().or(z.literal('')),
      state:   z.string().optional().or(z.literal('')),
      notes:   z.string().optional().or(z.literal('')),
    })),
    defaultValues: { type: 'customer' },
  })

  const mutation = useMutation({
    mutationFn: async (data) => {
      const contacts = (data.phone || data.email) ? [{
        name: data.name,
        phone: data.phone || null,
        email: data.email || null,
        isPrimary: true,
      }] : []
      return partnersApi.create({
        type: data.type,
        name: data.name,
        address: data.address || null,
        city:    data.city    || null,
        state:   data.state   || null,
        notes:   data.notes   || null,
        contacts,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partners'] })
      onSaved()
    },
  })

  const onSubmit = (data) => mutation.mutate(data)

  const content = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-md flex flex-col max-h-[92vh]">
        <div className="flex items-start justify-between px-6 py-4 border-b border-line-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Captura rápida</h2>
            <p className="text-xs text-ink-muted mt-0.5">Solo para remisión · sin datos fiscales</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-ink-muted hover:text-ink-secondary hover:bg-surface-elevated/60">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <div>
            <label className="label">Tipo *</label>
            <RadioGroup
              options={[{val:'customer',label:'Cliente'},{val:'supplier',label:'Proveedor'},{val:'both',label:'Ambos'}]}
              value={watch('type')}
              onChange={(v) => setValue('type', v)}
            />
          </div>

          <div>
            <label className="label">Nombre *</label>
            <input className={`input ${errors.name ? 'input-error' : ''}`}
              placeholder="Don Pepe, Cliente del mostrador..."
              {...register('name')} />
            {errors.name && <p className="field-error">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Teléfono</label>
              <input className="input" placeholder="55 1234 5678" {...register('phone')} />
            </div>
            <div>
              <label className="label">Email</label>
              <input className={`input ${errors.email ? 'input-error' : ''}`}
                placeholder="contacto@..." {...register('email')} />
              {errors.email && <p className="field-error">{errors.email.message}</p>}
            </div>
          </div>

          <div>
            <label className="label">Dirección de entrega</label>
            <input className="input" placeholder="Calle, número, colonia..." {...register('address')} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Ciudad</label>
              <input className="input" {...register('city')} />
            </div>
            <div>
              <label className="label">Estado</label>
              <select className="select" {...register('state')}>
                <option value="">—</option>
                {ESTADOS_MX.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Notas</label>
            <textarea className="input h-14 resize-none"
              placeholder="Referencia, horario de entrega..." {...register('notes')} />
          </div>

          <div className="p-3 bg-status-info/10 border border-status-info/30 rounded-lg text-xs text-status-info">
            <strong>Tip:</strong> Si después necesitas facturar a este cliente, el sistema te pedirá los datos fiscales al momento de timbrar.
          </div>
        </form>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-line-subtle shrink-0">
          <button type="button" className="btn-secondary" onClick={onClose}
            disabled={isSubmitting || mutation.isPending}>Cancelar</button>
          <button type="button" className="btn-primary"
            onClick={handleSubmit(onSubmit)}
            disabled={isSubmitting || mutation.isPending}>
            {mutation.isPending ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}

// ─── Skeleton tabla ───────────────────────────────────────────────────────────
function TableSkeleton() {
  return (
    <>
      {[1,2,3,4,5].map(i => (
        <tr key={i}>
          <td className="px-4 py-3"><div className="skeleton h-3 w-36 rounded" /></td>
          <td className="px-4 py-3"><div className="skeleton h-5 w-16 rounded-full" /></td>
          <td className="px-4 py-3"><div className="skeleton h-3 w-24 rounded" /></td>
          <td className="px-4 py-3"><div className="skeleton h-3 w-20 rounded" /></td>
          <td className="px-4 py-3"><div className="skeleton h-5 w-12 rounded-full" /></td>
          <td className="px-4 py-3" />
        </tr>
      ))}
    </>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────
export default function Socios() {
  const [search, setSearch]         = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [page, setPage]             = useState(1)
  const [modal, setModal]           = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()

  const { data, isLoading } = useQuery({
    queryKey: ['partners', { search, type: typeFilter, page }],
    queryFn: () => partnersApi.list({
      search: search || undefined,
      type:   typeFilter || undefined,
      page,
      limit: 20,
    }),
    keepPreviousData: true,
  })

  // Deep-link: ?editPartner=<id> abre el modal en modo edición sobre el partner.
  // Lo usamos cuando se intenta timbrar una factura y faltan datos fiscales —
  // el botón "Completar datos" en FacturaDetallePanel navega hacia acá.
  useEffect(() => {
    const editId = searchParams.get('editPartner')
    if (!editId) return
    partnersApi.get(editId)
      .then((partner) => setModal(partner))
      .catch(() => {})
      .finally(() => {
        searchParams.delete('editPartner')
        setSearchParams(searchParams, { replace: true })
      })
  }, [searchParams, setSearchParams])

  const partners   = data?.data  || []
  const total      = data?.total || 0
  const totalPages = Math.ceil(total / 20)

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Socios de negocio</h1>
          <p className="page-subtitle">{isLoading ? '...' : `${total} registros`}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setModal('new')}
            title="Form completo con datos fiscales y comerciales">
            Captura completa
          </button>
          <button className="btn-primary" onClick={() => setModal('quick')}
            title="Cliente sin RFC, solo para remisión">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Captura rápida
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input className="input flex-1" placeholder="Buscar por nombre o RFC..."
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
        <select className="select sm:w-44" value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1) }}>
          <option value="">Todos los tipos</option>
          <option value="customer">Clientes</option>
          <option value="supplier">Proveedores</option>
          <option value="both">Ambos</option>
        </select>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>RFC</th>
                <th>Ciudad</th>
                <th>Estado</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? <TableSkeleton /> : partners.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-ink-muted text-sm">
                    {search ? 'Sin resultados' : 'No hay socios registrados'}
                  </td>
                </tr>
              ) : partners.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-medium text-ink-primary">{p.name}</div>
                    {p.internal_code && <div className="text-xs text-ink-muted">{p.internal_code}</div>}
                  </td>
                  <td><Badge variant={TYPE_VARIANT[p.type]} label={TYPE_LABEL[p.type]} /></td>
                  <td className="text-ink-muted font-mono text-xs">
                    {p.rfc
                      ? p.rfc
                      : <span className="inline-flex items-center gap-1.5">
                          <span>—</span>
                          <Badge variant="gray" label="Solo remisión" />
                        </span>
                    }
                  </td>
                  <td className="text-ink-secondary">{p.city || '—'}</td>
                  <td>
                    <Badge variant={p.is_active ? 'green' : 'gray'} label={p.is_active ? 'Activo' : 'Inactivo'} />
                  </td>
                  <td>
                    <button onClick={() => setModal(p)}
                      className="btn-ghost btn-sm btn-icon text-ink-muted hover:text-ink-secondary" title="Editar">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-line-subtle">
            <p className="text-xs text-ink-muted">Página {page} de {totalPages} · {total} registros</p>
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" disabled={page === 1}
                onClick={() => setPage(p => p - 1)}>Anterior</button>
              <button className="btn-secondary btn-sm" disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}>Siguiente</button>
            </div>
          </div>
        )}
      </div>

      {modal === 'quick' && (
        <QuickPartnerModal
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
      {modal !== null && modal !== 'quick' && (
        <PartnerModal
          partner={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => setModal(null)}
        />
      )}
    </div>
  )
}
