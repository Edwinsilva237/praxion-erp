import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import { productsApi } from '@/api/products'
import { rawMaterialsApi } from '@/api/rawMaterials'
import { processConfigApi } from '@/api/processConfig'
import { tenantsApi } from '@/api/tenants'
import useAuthStore from '@/store/useAuthStore'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import HandoverReceptionScreen from './components/HandoverReceptionScreen'
import ClosedShiftSummary from './components/ClosedShiftSummary'
import ForceCloseModal from './components/ForceCloseModal'
import EditableRecordsHistory from './components/EditableRecordsHistory'
import DynamicCaptureFields, { validateDynamicValues } from './components/DynamicCaptureFields'
import clsx from 'clsx'

// ── Constantes ─────────────────────────────────────────────────────────────────
const INCIDENT_CATS = [
  { value: 'paro_maquina', label: 'Paro de máquina' },
  { value: 'problema_mp',  label: 'Problema de MP' },
  { value: 'cambio_orden', label: 'Cambio de orden' },
  { value: 'calidad',      label: 'Calidad' },
  { value: 'otro',         label: 'Otro' },
]
const PRIORITY_CONFIG = {
  urgente: { color: 'bg-red-500',    text: 'text-status-danger',    bg: 'bg-status-danger/10',    border: 'border-status-danger/40',    label: 'URGENTE',  icon: '🔴' },
  alta:    { color: 'bg-amber-400',  text: 'text-status-warning',  bg: 'bg-status-warning/10',  border: 'border-status-warning/40',  label: 'ALTA',     icon: '🟡' },
  normal:  { color: 'bg-green-500',  text: 'text-status-success',  bg: 'bg-status-success/10',  border: 'border-status-success/40',  label: 'NORMAL',   icon: '🟢' },
  baja:    { color: 'bg-gray-300',   text: 'text-ink-muted',   bg: 'bg-surface-elevated/40',   border: 'border-line-subtle',   label: 'BAJA',     icon: '⚪' },
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function getPriority(order) {
  return PRIORITY_CONFIG[order.priority] || PRIORITY_CONFIG.normal
}

function ProgressBar({ value, max, className }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const complete = pct >= 100
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="flex-1 h-2 bg-surface-elevated rounded-full overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all', complete ? 'bg-green-500' : 'bg-brand-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={clsx('text-xs font-mono font-semibold shrink-0 tabular-nums',
        complete ? 'text-status-success' : 'text-brand-300')}>
        {Math.round(pct)}%
      </span>
    </div>
  )
}

// ── Tarjeta de orden en la cola ────────────────────────────────────────────────
function OrdenCard({ order, position, isContinued, onSelect }) {
  const p = getPriority(order)
  const produced = parseInt(order.packages_produced || order.units_produced || 0)
  const target   = parseInt(order.quantity_packages || order.quantity_units || 0)
  const fmtDate  = (d) => d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : null
  const delivery = fmtDate(order.delivery_date)
  const isToday  = order.delivery_date && new Date(order.delivery_date).toDateString() === new Date().toDateString()

  return (
    <div className={clsx(
      'border-2 rounded-2xl overflow-hidden transition-all',
      p.border,
      isContinued && 'ring-2 ring-brand-400 ring-offset-1'
    )}>
      {/* Header de prioridad */}
      <div className={clsx('flex items-center justify-between px-4 py-2', p.bg)}>
        <div className="flex items-center gap-2">
          <span className="text-base">{p.icon}</span>
          <span className={clsx('text-xs font-bold uppercase tracking-wide', p.text)}>{p.label}</span>
          {isContinued && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-brand-600 text-white">
              📌 Continuando
            </span>
          )}
        </div>
        <span className="text-xs text-ink-muted font-medium">#{position} en cola</span>
      </div>

      {/* Cuerpo */}
      <div className="bg-surface-primary px-4 py-3 flex flex-col gap-2.5">
        <div>
          <p className="text-base font-bold text-ink-primary leading-tight">
            {order.product_name}
            {order.length_mm ? <span className="text-ink-muted font-normal ml-1 text-sm">· {(order.length_mm / 1000).toFixed(2)}m</span> : null}
          </p>
          <p className="text-xs text-ink-muted mt-0.5 font-mono">{order.order_number}</p>
        </div>

        <ProgressBar value={produced} max={target} />

        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span className="tabular-nums">
            {produced.toLocaleString('es-MX')} / {target.toLocaleString('es-MX')} paq
          </span>
          {delivery && (
            <span className={clsx('font-medium', isToday ? 'text-status-danger' : 'text-ink-muted')}>
              Entrega: {isToday ? '⚡ HOY' : delivery}
            </span>
          )}
        </div>

        {order.notes && (
          <div className="flex items-start gap-1.5 bg-status-info/10 border border-status-info/40 rounded-lg px-2.5 py-1.5">
            <span className="text-blue-400 shrink-0 mt-0.5">📝</span>
            <p className="text-xs text-status-info leading-snug">{order.notes}</p>
          </div>
        )}

        <button
          onClick={() => onSelect(order.id)}
          className="btn-primary w-full justify-center h-11 text-sm mt-0.5"
        >
          ▶ Capturar esta orden
        </button>
      </div>
    </div>
  )
}

// ── Banner de alerta de cambio de prioridad ────────────────────────────────────
function PriorityAlert({ alerts, onDismiss }) {
  if (!alerts.length) return null
  return (
    <div className="bg-status-danger/10 border-2 border-status-danger/40 rounded-2xl px-4 py-3 flex items-start gap-3">
      <span className="text-xl shrink-0">🔴</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-status-danger">Cambio de prioridad</p>
        {alerts.map((a, i) => (
          <p key={i} className="text-xs text-status-danger mt-0.5">{a}</p>
        ))}
        <p className="text-xs text-status-danger mt-1">Consulta con tu supervisor si necesitas cambiar de orden.</p>
      </div>
      <button onClick={onDismiss} className="text-red-400 hover:text-status-danger shrink-0 text-lg leading-none">✕</button>
    </div>
  )
}

// ── Micro pyme: pantalla de inicio con dos opciones ────────────────────────────
// (A) Iniciar con una orden ya creada (de la cola) · (B) Inicio rápido:
// elige producto + cantidad y el sistema crea la orden y arranca el turno.
function MicroPymeStart({ products = [], selfStartMutation, selfQuickStartMutation, allowQuickOrder = false }) {
  const [mode, setMode]       = useState(null) // null | 'quick'
  const [productId, setPid]   = useState('')
  const [qty, setQty]         = useState('')

  // Sin inicio rápido: un solo botón. El operador arranca el turno y luego
  // elige una orden ya creada de la cola (el dueño controla qué se produce).
  if (!allowQuickOrder) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <p className="font-medium text-ink-secondary">Inicia tu turno para empezar a capturar</p>
        <button
          onClick={() => selfStartMutation.mutate()}
          disabled={selfStartMutation.isPending}
          className="card p-6 hover:border-brand-500/40 transition-colors text-center flex flex-col items-center gap-2 w-full max-w-xs disabled:opacity-50">
          {selfStartMutation.isPending ? <Spinner /> : <span className="text-4xl">▶️</span>}
          <span className="font-semibold text-ink-primary text-lg">Iniciar turno</span>
          <span className="text-[11px] text-ink-muted">Luego eliges la orden a producir de la cola</span>
        </button>
      </div>
    )
  }

  if (mode === 'quick') {
    const qtyN = parseInt(qty, 10)
    return (
      <div className="card p-5 max-w-md mx-auto flex flex-col gap-3">
        <div>
          <p className="font-semibold text-ink-primary">⚡ Inicio rápido</p>
          <p className="text-xs text-ink-muted mt-0.5">
            Elige el producto y la cantidad. El sistema crea la orden, arranca tu turno y te deja capturando.
          </p>
        </div>
        <div>
          <label className="label">Producto</label>
          <select className="select" value={productId} onChange={e => setPid(e.target.value)}>
            <option value="">Selecciona un producto…</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>{p.sku ? `${p.sku} · ` : ''}{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cantidad de paquetes (meta)</label>
          <input type="number" min="1" inputMode="numeric" className="input"
            value={qty} onChange={e => setQty(e.target.value)} placeholder="Ej. 35" />
        </div>
        <div className="flex gap-2 mt-1">
          <button onClick={() => setMode(null)} className="btn-secondary flex-1"
            disabled={selfQuickStartMutation.isPending}>Atrás</button>
          <button
            onClick={() => selfQuickStartMutation.mutate({ productId, quantityPackages: qtyN })}
            disabled={!productId || !qtyN || qtyN <= 0 || selfQuickStartMutation.isPending}
            className="btn-primary flex-1 justify-center h-12 font-bold">
            {selfQuickStartMutation.isPending ? <Spinner size="sm" /> : 'Iniciar y producir'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <p className="font-medium text-ink-secondary">¿Cómo quieres iniciar tu turno?</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
        <button
          onClick={() => selfStartMutation.mutate()}
          disabled={selfStartMutation.isPending}
          className="card p-5 hover:border-brand-500/40 transition-colors text-center flex flex-col items-center gap-1.5 disabled:opacity-50">
          {selfStartMutation.isPending ? <Spinner /> : <span className="text-3xl">📋</span>}
          <span className="font-semibold text-ink-primary">Iniciar con una orden</span>
          <span className="text-[11px] text-ink-muted">Elige una orden ya creada de la cola</span>
        </button>
        <button
          onClick={() => setMode('quick')}
          className="card p-5 hover:border-brand-500/40 transition-colors text-center flex flex-col items-center gap-1.5">
          <span className="text-3xl">⚡</span>
          <span className="font-semibold text-ink-primary">Inicio rápido</span>
          <span className="text-[11px] text-ink-muted">Producto + cantidad; la orden se crea sola</span>
        </button>
      </div>
    </div>
  )
}

// ── Vista: pantalla de bienvenida / selección ──────────────────────────────────
function PantallaSeleccion({
  activeShifts, myTodayShifts, queueOrders, loadingShifts, loadingMyShifts,
  shiftClosed, closedShiftId, closedAt,
  confirmMutation, reopenMutation,
  onSelectShift, onShiftClosed,
  allowSelfStart, allowQuickOrder, selfStartMutation, selfQuickStartMutation, products,
  startNewRequested, onStartNew,
}) {
  const scheduledShifts = myTodayShifts.filter(s => s.status === 'scheduled')

  return (
    <div className="page-enter max-w-lg mx-auto flex flex-col gap-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Captura de producción</h1>
          <p className="page-subtitle">
            {new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </div>


      {loadingShifts || loadingMyShifts ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
    <Spinner />
    <p className="text-xs text-ink-muted">Cargando tus turnos del día...</p>
  </div>
      ) : shiftClosed && closedShiftId && !startNewRequested ? (
        <ClosedShiftSummary
          shiftId={closedShiftId}
          reopenPending={reopenMutation.isPending}
          onReopen={(id) => reopenMutation.mutate(id)}
          onExit={() => onShiftClosed(false)}
          allowSelfStart={allowSelfStart}
          onStartNew={onStartNew}
        />
      ) : allowSelfStart && (startNewRequested || (activeShifts.length === 0 && scheduledShifts.length === 0)) ? (
        <MicroPymeStart
          products={products}
          selfStartMutation={selfStartMutation}
          selfQuickStartMutation={selfQuickStartMutation}
          allowQuickOrder={allowQuickOrder}
        />
      ) : activeShifts.length === 0 && scheduledShifts.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin turnos asignados hoy</p>
          <p className="text-sm text-ink-muted">Consulta con tu supervisor.</p>
        </div>
      ) : (
        <>
          {/* Turno programado pendiente de confirmar */}
          {scheduledShifts.map((s) => (
            <div key={s.id} className="border-2 border-brand-500/40 bg-brand-500/10 rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-brand-500/40">
                <p className="text-sm font-bold text-brand-300">Tu turno de hoy</p>
                <p className="text-xs text-brand-300 mt-0.5">
                  Turno {s.shift_number} · {s.scheduled_start?.slice(0, 5)} · {s.supervisor_name && `Supervisor: ${s.supervisor_name}`}
                </p>
              </div>
              <div className="px-4 py-3 space-y-3">
                <div>
                  <p className="font-bold text-ink-primary">{s.product_name}</p>
                  <p className="text-xs text-ink-muted font-mono">{s.order_number}</p>
                </div>
                <p className="text-sm text-brand-300">
                  Confirma tu presencia para iniciar la captura de producción.
                </p>
                <button
                  onClick={() => confirmMutation.mutate(s.id)}
                  disabled={confirmMutation.isPending}
                  className="btn-primary w-full justify-center h-14 text-base font-bold"
                >
                  {confirmMutation.isPending
                    ? <Spinner className="w-5 h-5" />
                    : '✓  Confirmar presencia — Iniciar turno'
                  }
                </button>
              </div>
            </div>
          ))}

          {/* Turnos activos (de otros que puede tomar) */}
          {activeShifts.map((s) => (
            <button key={s.id} onClick={() => onSelectShift(s.id, null)}
              className="w-full text-left card hover:border-brand-500/40 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-ink-primary">{s.product_name}</span>
                <Badge variant="amber" label={`Turno ${s.shift_number}`} />
              </div>
              <div className="text-sm text-ink-muted space-y-0.5">
                <p>Largo: {s.length_mm ? `${(s.length_mm / 1000).toFixed(2)}m` : '—'} · Resina: {s.resin_type}</p>
                <p>Operador: {s.operator_name}</p>
                <p className="font-medium text-brand-300">{s.pt_units_produced} piezas capturadas</p>
              </div>
            </button>
          ))}

          {/* Cola de producción (siempre visible, informativa) */}
          {queueOrders.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-px bg-surface-elevated" />
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide whitespace-nowrap">
                  Cola de producción
                </p>
                <div className="flex-1 h-px bg-surface-elevated" />
              </div>
              {queueOrders.map((o, idx) => {
                const p = getPriority(o)
                const produced = parseInt(o.packages_produced || o.units_produced || 0)
                const target   = parseInt(o.quantity_packages || o.quantity_units || 0)
                return (
                  <div key={o.id} className={clsx('border rounded-xl px-4 py-3 flex flex-col gap-1.5', p.border, p.bg)}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{p.icon}</span>
                        <span className={clsx('text-xs font-bold', p.text)}>{p.label}</span>
                      </div>
                      <span className="text-xs text-ink-muted">#{idx + 1}</span>
                    </div>
                    <p className="text-sm font-semibold text-ink-primary">{o.product_name}
                      {o.length_mm ? <span className="text-ink-muted font-normal ml-1">· {(o.length_mm / 1000).toFixed(2)}m</span> : null}
                    </p>
                    <ProgressBar value={produced} max={target} />
                    {o.notes && (
                      <p className="text-xs text-status-info">📝 {o.notes}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Pantalla principal de captura ──────────────────────────────────────────────
export default function ProduccionCaptura() {
  const queryClient = useQueryClient()
  const weightRef   = useRef(null)
  const currentUser = useAuthStore((s) => s.user)

  // Estado principal
  const [selectedShift, setSelectedShift]   = useState(null)
  const [activeOrderId, setActiveOrderId]   = useState(null)
  const [continuedFromPrev, setContinued]   = useState(false)
  const [waitingHandover, setWaitingHandover] = useState(false)  // turno en pending_handover
  const [prevOperator, setPrevOperator]       = useState(null)   // {id, name}
  const [shiftClosed,   setShiftClosed]     = useState(false)
  const [closedShiftId, setClosedShiftId]   = useState(null)
  const [closedAt,      setClosedAt]        = useState(null)
  // Micro pyme: el operador pidió iniciar OTRO turno (aunque tenga uno cerrado
  // pendiente de validar). Evita que la pantalla de resumen lo vuelva a atrapar.
  const [startNewRequested, setStartNewRequested] = useState(false)
  const [viewMode, setViewMode]             = useState('cola') // 'cola' | 'captura'
  const [tab, setTab]                       = useState('paquetes')
  const [weight, setWeight]                 = useState('')
  const [isSecondQ, setIsSecondQ]           = useState(false)
  const [secondQProdId, setSecondQProdId]   = useState('')
  const [lastCapture, setLastCapture]       = useState(null)
  const [scrapType, setScrapType]           = useState(null)
  const [scrapKg, setScrapKg]               = useState('')
  const [incidentCat, setIncidentCat]       = useState('paro_maquina')
  const [incidentDesc, setIncidentDesc]     = useState('')
  const [incidentMin, setIncidentMin]       = useState('')
  const [feedback, setFeedback]             = useState(null)
  const [priorityAlerts, setPriorityAlerts] = useState([])
  const [lastCheckedPriority, setLastChecked] = useState(Date.now())
  // Atributos dinámicos capturados por paquete (forma libre según capture_schema
  // del product_kind). Se resetea al cambiar de orden y tras cada captura exitosa.
  const [dynamicValues, setDynamicValues]   = useState({})

  // Queries
  const { data: activeShifts = [], isLoading: loadingShifts } = useQuery({
    queryKey: ['active-shifts'],
    queryFn:  productionApi.getActiveShifts,
    // Polling: 10s esperando handover entrante, 15s con turno activo (para
    // detectar pronto cuando el siguiente operador confirma presencia),
    // 60s si solo estoy viendo la pantalla.
    refetchInterval: waitingHandover ? 10000 : (selectedShift ? 15000 : 60000),
  })

  // Detectar cuando el turno en espera se activa
  useEffect(() => {
    if (!waitingHandover || !selectedShift) return
    const myShift = activeShifts.find(s => s.id === selectedShift)
    if (myShift && myShift.status === 'active') {
      setWaitingHandover(false)
      setPrevOperator(null)
      // Precargar orden activa si existe
      if (myShift.active_order_id) {
        setActiveOrderId(myShift.active_order_id)
        setContinued(true)
        setViewMode('captura')
      }
    }
  }, [activeShifts, selectedShift, waitingHandover])

// Detectar al cargar: si el usuario tiene un turno cerrado propio HOY
  // (pending_handover con closed_at poblado), mostrar la pantalla de resumen.
  // Cubre el caso de recargar la página después de haber cerrado.
  //
  // IMPORTANTE: el filtro es operator_id === currentUser.id. Esto evita que
  // un supervisor (o cualquier otro usuario) que abra la captura vea por
  // error el resumen de un turno ajeno cerrado.
  useEffect(() => {
    // No re-atrapar con el resumen si el operador pidió iniciar otro turno.
    if (selectedShift || shiftClosed || startNewRequested) return
    if (!currentUser?.id) return
    const today = new Date().toISOString().slice(0, 10)
    const myClosedShift = activeShifts.find(s =>
      s.operator_id === currentUser.id &&
      s.status === 'pending_handover' &&
      s.closed_at !== null &&
      s.shift_date === today
    )
    if (myClosedShift) {
      setClosedShiftId(myClosedShift.id)
      setClosedAt(new Date(myClosedShift.closed_at))
      setShiftClosed(true)
    }
  }, [activeShifts, currentUser, selectedShift, shiftClosed, startNewRequested])

  // Auto-restauración al cargar: si el usuario tiene un turno activo o en
  // pending_handover (entrante esperando recibir), reseleccionarlo
  // automáticamente para que no pierda el contexto al recargar la página.
  useEffect(() => {
    if (selectedShift || shiftClosed) return  // ya hay flujo activo
    if (!currentUser?.id || activeShifts.length === 0) return

    const myShift = activeShifts.find(s =>
      s.operator_id === currentUser.id &&
      (s.status === 'active' ||
        (s.status === 'pending_handover' && s.closed_at === null))
    )
    if (!myShift) return

    setSelectedShift(myShift.id)

    if (myShift.status === 'pending_handover') {
      // Entrante esperando recibir: HandoverReceptionScreen lo detectará vía isPendingHandover
      return
    }

    // Turno activo: restaurar orden activa y vista de captura si tenía orden
    if (myShift.active_order_id) {
      setActiveOrderId(myShift.active_order_id)
      setContinued(true)
      setViewMode('captura')
    } else {
      setViewMode('cola')
    }
  }, [activeShifts, currentUser, selectedShift, shiftClosed])

  const { data: queueOrders = [] } = useQuery({
    queryKey: ['production-queue-capture'],
    queryFn:  productionApi.getQueue,
    refetchInterval: 30000,
    staleTime: 0,
    retry: 1,
  })

  const { data: myTodayShifts = [], isLoading: loadingMyShifts } = useQuery({
    queryKey: ['my-today-shifts'],
    queryFn:  productionApi.getMyTodayShifts,
    refetchInterval: 120000,
  })

  const { data: shiftDetail } = useQuery({
    queryKey: ['shift-detail', selectedShift],
    queryFn:  () => productionApi.getShift(selectedShift),
    enabled:  !!selectedShift,
    refetchInterval: 20000,
    staleTime: 0,
    retry: 1,
  })

  const { data: allProducts = [] } = useQuery({
    queryKey: ['products-list'],
    queryFn:  () => productsApi.list({ limit: 200 }),
    select:   (r) => r.data || r,
    staleTime: 60000,
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesLots = tenantConfig?.uses_lots ?? false

  // Flags de inicio directo: los leemos de tenantsApi.getCurrent (SIN permiso),
  // no de processConfigApi.getConfig (que exige process_config:read y el
  // capturista NO tiene → devolvía 403 y la pantalla mostraba "Sin turnos").
  const { data: tenantInfo } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 300000,
  })

  const { data: scrapTypesRaw } = useQuery({
    queryKey: ['scrap-types-active'],
    queryFn:  () => processConfigApi.listScrapTypes({ isActive: true }),
    staleTime: 60000,
  })
  const scrapTypes = Array.isArray(scrapTypesRaw) ? scrapTypesRaw : (scrapTypesRaw?.data || [])

  // Catálogo completo de product_kinds con su capture_schema. Lo usamos para
  // resolver qué atributos capturar por paquete según el producto de la orden activa.
  const { data: kindsRaw } = useQuery({
    queryKey: ['product-kinds-active'],
    queryFn:  () => processConfigApi.listProductKinds({ isActive: true }),
    staleTime: 300000,
  })
  const productKinds = Array.isArray(kindsRaw) ? kindsRaw : (kindsRaw?.data || [])

  // Banner para operador saliente: si su turno activo tiene handover_requested_at, el siguiente está esperando
  const myActiveShift = selectedShift ? activeShifts.find(s => s.id === selectedShift) : null
  const nextOperatorWaiting = myActiveShift?.handover_requested_at && myActiveShift?.status === 'active'

  // Estado del modal de cierre forzado (solo supervisor)
  const [showForceClose, setShowForceClose] = useState(false)

  // ¿El usuario actual es supervisor de este turno?
  const isSupervisorOfShift = !!myActiveShift &&
    myActiveShift.supervisor_id === currentUser?.id &&
    myActiveShift.operator_id !== currentUser?.id

  // ¿Han pasado al menos 5 min desde que el entrante confirmó presencia?
  // El backend valida lo mismo, pero lo replicamos en frontend para UX.
  const minSinceHandoverRequest = myActiveShift?.handover_requested_at
    ? Math.floor((Date.now() - new Date(myActiveShift.handover_requested_at).getTime()) / 60000)
    : 0
  const canForceClose = isSupervisorOfShift && nextOperatorWaiting && minSinceHandoverRequest >= 5
  const forceCloseInMin = isSupervisorOfShift && nextOperatorWaiting && minSinceHandoverRequest < 5
    ? Math.max(1, 5 - minSinceHandoverRequest)
    : 0

  // Detectar cambios de prioridad mientras el operador está capturando
  useEffect(() => {
    if (!selectedShift || !queueOrders.length) return
    const newAlerts = []
    queueOrders.forEach(o => {
      if (o.priority_changed_at) {
        const changedAt = new Date(o.priority_changed_at).getTime()
        if (changedAt > lastCheckedPriority) {
          const p = getPriority(o)
          newAlerts.push(`${o.product_name} cambió a ${p.label} — ${o.order_number}`)
        }
      }
    })
    if (newAlerts.length) {
      setPriorityAlerts(newAlerts)
      setLastChecked(Date.now())
    }
  }, [queueOrders, selectedShift])

  // Auto-seleccionar el primer tipo de merma cuando carga el catálogo
  useEffect(() => {
    if (scrapType === null && scrapTypes.length > 0) {
      setScrapType(scrapTypes[0].code)
    }
  }, [scrapTypes, scrapType])

  // Limpiar atributos dinámicos al cambiar de orden activa
  useEffect(() => { setDynamicValues({}) }, [activeOrderId])

  function showFeedback(type, msg) {
    setFeedback({ type, msg })
    setTimeout(() => setFeedback(null), 2500)
  }

  function handleSelectShift(shiftId, preloadOrderId) {
    setSelectedShift(shiftId)
    if (preloadOrderId) {
      setActiveOrderId(preloadOrderId)
      setContinued(true)
      setViewMode('captura')
    } else {
      setViewMode('cola')
    }
  }

  // Confirmar presencia — detecta orden activa del turno anterior
  const confirmMutation = useMutation({
    mutationFn: (id) => productionApi.confirmPresence(id),
    onSuccess: (data) => {
      const shiftId = data.shift?.id || data.id
      setSelectedShift(shiftId)
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      queryClient.invalidateQueries({ queryKey: ['my-today-shifts'] })

      if (data.waiting_for_handover) {
        // Turno en pending_handover — esperar que el anterior cierre
        setWaitingHandover(true)
        setPrevOperator(data.previous_operator)
        setViewMode('cola') // mostrar cola informativa mientras espera
      } else {
        // Turno activo inmediatamente
        setWaitingHandover(false)
        const prevActiveOrderId = data.previous_active_order_id || null
        if (prevActiveOrderId) {
          setActiveOrderId(prevActiveOrderId)
          setContinued(true)
          setViewMode('captura')
        } else {
          setViewMode('cola')
        }
      }
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'Error al confirmar'),
  })

  // Micro pyme: iniciar turno directo (sin programación). Solo visible si el
  // tenant tiene allow_self_start_shift. Tras crear el turno, abre la cola.
  const selfStartMutation = useMutation({
    mutationFn: () => productionApi.selfStartShift(),
    onSuccess: (shift) => {
      setSelectedShift(shift.id)
      setShiftClosed(false)
      setStartNewRequested(false)
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      queryClient.invalidateQueries({ queryKey: ['my-today-shifts'] })
      setWaitingHandover(false)
      setViewMode('cola')
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'No se pudo iniciar el turno'),
  })

  // Micro pyme: inicio rápido (crea orden + inicia turno + la deja activa).
  const selfQuickStartMutation = useMutation({
    mutationFn: (body) => productionApi.selfQuickStart(body),
    onSuccess: ({ shift, order }) => {
      setSelectedShift(shift.id)
      setActiveOrderId(order.id)
      setContinued(true)
      setShiftClosed(false)
      setStartNewRequested(false)
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      queryClient.invalidateQueries({ queryKey: ['my-today-shifts'] })
      queryClient.invalidateQueries({ queryKey: ['production-queue-capture'] })
      setWaitingHandover(false)
      setViewMode('captura') // ya tiene orden activa → directo a capturar
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'No se pudo iniciar el inicio rápido'),
  })

  const captureMutation = useMutation({
    mutationFn: (body) => productionApi.capturePackage(selectedShift, body),
    onSuccess: (data) => {
      const wasSecondQuality = isSecondQ  // guardar antes de resetear
      setLastCapture(data)
      setWeight('')
      setIsSecondQ(false)
      setSecondQProdId('')
      setDynamicValues({})

      // Actualizar caché de shiftDetail directamente sin esperar refetch
      queryClient.setQueryData(['shift-detail', selectedShift], (old) => {
        if (!old) return old
        const newProgress = [...(old.progress || []), { ...data, captured_at: data.captured_at || new Date().toISOString() }]
        const goodUnits = newProgress.filter(p => !p.is_second_quality)
                                     .reduce((s, p) => s + (p.quantity_units || 0), 0)
        return { ...old, progress: newProgress, pt_units_produced: goodUnits }
      })

      // Actualizar caché de la cola: incrementar packages_produced de la orden activa
      if (!wasSecondQuality && activeOrderId) {
        queryClient.setQueryData(['production-queue-capture'], (old) => {
          if (!Array.isArray(old)) return old
          return old.map(o => o.id !== activeOrderId ? o : {
            ...o,
            packages_produced: (parseInt(o.packages_produced || 0) + 1).toString(),
          })
        })
      }

      // Refetch en background para sincronizar con BD
      queryClient.refetchQueries({ queryKey: ['shift-detail', selectedShift] })
      queryClient.refetchQueries({ queryKey: ['production-queue-capture'] })

      if (wasSecondQuality) {
        // Segunda calidad: no cuenta para la orden principal, solo registro del turno
        showFeedback('warn', `Cal. 2 · Paq. #${data.microlot_number} — ${data.real_weight_kg} kg (no cuenta en orden principal)`)
      } else if (activeOrderId) {
        const activeOrder = queueOrders.find(o => o.id === activeOrderId)
        if (activeOrder) {
          const targetPkgs = parseInt(activeOrder.quantity_packages || 0)
          const donePkgs   = parseInt(activeOrder.packages_produced || 0) + 1
          const remaining  = targetPkgs - donePkgs
          if (remaining === 1)       showFeedback('warn', `¡Falta 1 paquete para completar la orden!`)
          else if (remaining === 0) { showFeedback('ok', `¡Orden completada! Selecciona la siguiente.`); setContinued(false); setViewMode('cola') }
          else                       showFeedback('ok', `Paq. #${data.microlot_number} — ${data.real_weight_kg} kg ${data.weight_ok ? '✓' : '⚠ fuera de rango'}`)
        } else {
          showFeedback('ok', `Paq. #${data.microlot_number} — ${data.real_weight_kg} kg`)
        }
      }
      weightRef.current?.focus()
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'Error al registrar'),
  })

  const scrapMutation = useMutation({
    mutationFn: (body) => productionApi.recordScrap(selectedShift, body),
    onSuccess: () => { setScrapKg(''); showFeedback('ok', 'Merma registrada') },
    onError:   (e) => showFeedback('error', e?.response?.data?.error || 'Error'),
  })

  const incidentMutation = useMutation({
    mutationFn: (body) => productionApi.reportIncident(selectedShift, body),
    onSuccess: () => { setIncidentDesc(''); setIncidentMin(''); showFeedback('ok', 'Incidencia reportada') },
    onError:   (e) => showFeedback('error', e?.response?.data?.error || 'Error'),
  })

  const reopenMutation = useMutation({
    mutationFn: (shiftId) => productionApi.reopenShift(shiftId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      setSelectedShift(data.id)
      setShiftClosed(false)
      showFeedback('ok', 'Turno reabierto — puedes continuar capturando')
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'No se pudo reabrir el turno'),
  })

  const closeMutation = useMutation({
    mutationFn: () => productionApi.closeShift(selectedShift),
    onSuccess: (closedShift) => {
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      queryClient.invalidateQueries({ queryKey: ['my-today-shifts'] })

      // ¿Quién cerró el turno?
      //   - Si fue el operador del turno → mostrar resumen del turno cerrado.
      //   - Si fue un supervisor cerrando el turno de otro → volver al menú
      //     normal con feedback, NO mostrar el resumen ajeno.
      const closerIsOperator = closedShift?.operator_id === currentUser?.id

      if (closerIsOperator) {
        setClosedShiftId(closedShift?.id || selectedShift)
        setClosedAt(new Date())
        setShiftClosed(true)
      } else {
        showFeedback('ok', 'Turno cerrado correctamente. Pendiente de validación.')
      }

      setSelectedShift(null)
      setActiveOrderId(null)
      setContinued(false)
      setViewMode('cola')
    },
    onError: (e) => showFeedback('error', e?.response?.data?.error || 'No se pudo cerrar el turno'),
  })

  function handleCapture(e) {
    e.preventDefault()
    if (!weight || parseFloat(weight) <= 0) return
    // Validar required del capture_schema antes de enviar
    if (captureSchema && !isSecondQ) {
      const err = validateDynamicValues(captureSchema, dynamicValues)
      if (err) { showFeedback('error', err); return }
    }
    captureMutation.mutate({
      productionOrderId:      activeOrderId || null,
      realWeightKg:           parseFloat(weight),
      theoreticalWeightKg:    0,
      lengthMm:               activeOrderId ? (queueOrders.find(o => o.id === activeOrderId)?.length_mm || null) : null,
      isSecondQuality:        isSecondQ,
      secondQualityProductId: (isSecondQ && secondQProdId) ? secondQProdId : null,
      // Solo enviamos atributos si hay schema y captura es de primera calidad.
      dynamicAttributes: (captureSchema && !isSecondQ && Object.keys(dynamicValues).length > 0)
        ? dynamicValues : undefined,
    })
  }

// ── Pantalla de recepción de turno (cuando mi shift está en pending_handover) ─
  // IMPORTANTE: solo se activa para shifts ENTRANTES (closed_at IS NULL).
  // Si el shift está en pending_handover pero ya tiene closed_at, ese es un
  // SALIENTE cerrado esperando validación — debe mostrar ClosedShiftSummary,
  // no la pantalla de recepción.
  const shiftFromList = selectedShift ? activeShifts.find(s => s.id === selectedShift) : null
  const isIncomingPending = (s) => s?.status === 'pending_handover' && !s?.closed_at

  const isPendingHandover =
    waitingHandover ||
    isIncomingPending(shiftDetail && shiftDetail.id === selectedShift ? shiftDetail : null) ||
    isIncomingPending(shiftFromList)

  // ¿El shift seleccionado es MI turno cerrado? (saliente esperando validación)
  // Esto detecta el caso de "estaba capturando y alguien cerró mi turno desde otra
  // sesión" (ej: supervisor cerró por mí). El polling actualiza, mi shift pasa a
  // pending_handover con closed_at, y debo ver el resumen, no pantalla de recepción.
  const myShiftJustClosed =
    selectedShift &&
    shiftFromList?.operator_id === currentUser?.id &&
    shiftFromList?.status === 'pending_handover' &&
    shiftFromList?.closed_at !== null

  if (myShiftJustClosed && !shiftClosed) {
    // Migrar al flujo de resumen sin perder el turno_id
    setClosedShiftId(selectedShift)
    setClosedAt(new Date(shiftFromList.closed_at))
    setSelectedShift(null)
    setActiveOrderId(null)
    setContinued(false)
    setShiftClosed(true)
    setViewMode('cola')
    return null  // re-renderizará con el flujo correcto
  }

  if (selectedShift && isPendingHandover) {
    return (
      <HandoverReceptionScreen
        incomingShiftId={selectedShift}
        onAccepted={() => {
          // Cuando el operador acepta, el backend activó su turno.
          // Refrescamos queries y entramos al modo cola para que elija orden.
          setWaitingHandover(false)
          setPrevOperator(null)
          queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
          queryClient.invalidateQueries({ queryKey: ['shift-detail', selectedShift] })
          queryClient.invalidateQueries({ queryKey: ['my-today-shifts'] })
          queryClient.invalidateQueries({ queryKey: ['production-queue-capture'] })
          setViewMode('cola')
        }}
      />
    )
  }

  // ── Sin turno seleccionado — pantalla de bienvenida ────────────────────────
  if (!selectedShift) {
    return (
      <PantallaSeleccion
        activeShifts={activeShifts}
        myTodayShifts={myTodayShifts}
        queueOrders={queueOrders}
        loadingShifts={loadingShifts}
        loadingMyShifts={loadingMyShifts}
        shiftClosed={shiftClosed}
        closedShiftId={closedShiftId}
        closedAt={closedAt}
        confirmMutation={confirmMutation}
        reopenMutation={reopenMutation}
        onSelectShift={handleSelectShift}
        onShiftClosed={setShiftClosed}
        allowSelfStart={tenantInfo?.allow_self_start_shift}
        allowQuickOrder={tenantInfo?.allow_quick_order}
        selfStartMutation={selfStartMutation}
        selfQuickStartMutation={selfQuickStartMutation}
        products={allProducts}
        startNewRequested={startNewRequested}
        onStartNew={() => { setShiftClosed(false); setStartNewRequested(true) }}
      />
    )
  }

  const shift    = shiftDetail
  const progress = shift?.progress || []

  // ── Vista Cola — selección de orden ───────────────────────────────────────
  if (viewMode === 'cola') {
    return (
      <div className="page-enter max-w-lg mx-auto flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Cola de producción</h1>
            <p className="text-xs text-status-success font-medium">
              ✓ Turno activo · {shift?.operator_name || ''}
            </p>
          </div>
          <button onClick={() => { setClosedShiftId(selectedShift); closeMutation.mutate() }}
            disabled={closeMutation.isPending}
            className="btn-secondary btn-sm text-status-danger hover:border-status-danger/40">
            {closeMutation.isPending ? <Spinner size="sm" /> : 'Finalizar turno'}
          </button>
        </div>

        {/* Banner: siguiente operador esperando handover (también en cola) */}
        {nextOperatorWaiting && (
          <div className="bg-status-warning/10 border-2 border-status-warning/40 rounded-2xl px-4 py-3 flex items-start gap-3">
            <span className="text-xl shrink-0">🔔</span>
            <div className="flex-1">
              <p className="text-sm font-bold text-status-warning">El siguiente turno está listo</p>
              <p className="text-xs text-status-warning mt-0.5">
                El operador del siguiente turno confirmó su presencia y está esperando.
                Cierra tu turno cuando termines el paquete actual.
              </p>
            </div>
          </div>
        )}

      

        {/* Alerta de prioridad */}
        <PriorityAlert alerts={priorityAlerts} onDismiss={() => setPriorityAlerts([])} />

        {/* Tarjetas de la cola */}
        {queueOrders.length === 0 ? (
          <div className="empty-state">
            <p className="font-medium text-ink-secondary">Sin órdenes en cola</p>
            <p className="text-sm text-ink-muted">El supervisor debe liberar una orden primero.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {queueOrders.map((o, idx) => (
              <OrdenCard
                key={o.id}
                order={o}
                position={idx + 1}
                isContinued={continuedFromPrev && o.id === activeOrderId}
                onSelect={(id) => {
                  setActiveOrderId(id)
                  setContinued(false)
                  setViewMode('captura')
                  // Persistir orden activa en el turno (no bloquea si falla)
                  productionApi.setShiftActiveOrder(selectedShift, id)
                    .then(() => {
                      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
                      queryClient.invalidateQueries({ queryKey: ['production-queue-capture'] })
                    })
                    .catch(err => {
                      console.error('Error guardando orden activa:', err)
                    })
                }}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── Vista Captura ──────────────────────────────────────────────────────────
  // Si shiftDetail aún no cargó, mostrar spinner antes de renderizar el formulario
  if (viewMode === 'captura' && !shiftDetail && selectedShift) {
    return (
      <div className="page-enter max-w-lg mx-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('cola')}
            className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary font-medium">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
            </svg>
            Cola
          </button>
        </div>
        <div className="flex justify-center py-16"><Spinner /></div>
      </div>
    )
  }

  const activeOrder = queueOrders.find(o => o.id === activeOrderId)
  // Resolver el capture_schema del kind del producto de la orden activa.
  // Si el producto no tiene kind o el kind no define fields, no se muestra nada.
  const activeProduct = activeOrder
    ? allProducts.find(pr => pr.id === activeOrder.product_id)
    : null
  const activeKind = activeProduct?.product_kind_id
    ? productKinds.find(k => k.id === activeProduct.product_kind_id)
    : null
  const captureSchema = activeKind?.capture_schema || null
  const p = activeOrder ? getPriority(activeOrder) : PRIORITY_CONFIG.normal
  const produced = parseInt(activeOrder?.packages_produced || activeOrder?.units_produced || 0)
  const target   = parseInt(activeOrder?.quantity_packages || activeOrder?.quantity_units || 0)

  return (
    <div className="page-enter max-w-lg mx-auto flex flex-col gap-4">
      {/* Header de captura */}
      <div className={clsx('rounded-2xl px-4 py-3 border-2', p.bg, p.border)}>
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setViewMode('cola')}
            className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary font-medium"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
            </svg>
            Cola
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{p.icon}</span>
            <span className={clsx('text-xs font-bold uppercase', p.text)}>{p.label}</span>
          </div>
        </div>
        <p className="text-base font-bold text-ink-primary">
          {activeOrder?.product_name || '—'}
          {activeOrder?.length_mm ? <span className="text-ink-muted font-normal ml-1 text-sm">· {(activeOrder.length_mm / 1000).toFixed(2)}m</span> : null}
        </p>
        <p className="text-xs text-ink-muted font-mono mb-2">{activeOrder?.order_number}</p>
        <ProgressBar value={produced} max={target} />
        <p className="text-xs text-ink-muted mt-1 tabular-nums">
          {produced.toLocaleString('es-MX')} / {target.toLocaleString('es-MX')} paquetes
        </p>
        {continuedFromPrev && (
          <p className="text-xs text-brand-300 font-medium mt-1">📌 Continuando desde turno anterior</p>
        )}
        {activeOrder?.notes && (
          <p className="text-xs text-status-info mt-1">📝 {activeOrder.notes}</p>
        )}
      </div>

      {/* Fórmula MP vigente */}
      {activeOrderId && (
        <FormulaCard orderId={activeOrderId} currentUser={currentUser} shiftDetail={shiftDetail} />
      )}

      
      {/* Modal de cierre forzado (solo se renderiza si está abierto) */}
      {showForceClose && (
        <ForceCloseModal
          shiftId={selectedShift}
          operatorName={myActiveShift?.operator_name}
          onClose={() => setShowForceClose(false)}
          onSuccess={() => {
            setShowForceClose(false)
            showFeedback('ok', 'Turno cerrado forzadamente. El siguiente turno fue activado.')
            setSelectedShift(null)
            setActiveOrderId(null)
            setContinued(false)
            setViewMode('cola')
          }}
        />
      )}



      {/* Banner: siguiente operador esperando handover */}
      {nextOperatorWaiting && (
        <div className="bg-status-warning/10 border-2 border-status-warning/40 rounded-2xl px-4 py-3 flex items-start gap-3">
          <span className="text-xl shrink-0">🔔</span>
          <div className="flex-1">
            <p className="text-sm font-bold text-status-warning">El siguiente turno está listo</p>
            <p className="text-xs text-status-warning mt-0.5">
              El operador del siguiente turno confirmó su presencia y está esperando.
              Cierra tu turno cuando termines el paquete actual.
            </p>
            {/* Botón de cierre forzado: solo supervisor, después de 5 min */}
            {isSupervisorOfShift && (
              <div className="mt-2">
                {canForceClose ? (
                  <button
                    onClick={() => setShowForceClose(true)}
                    className="text-xs font-semibold text-status-danger hover:text-status-danger underline"
                  >
                    Forzar cierre del turno
                  </button>
                ) : forceCloseInMin > 0 ? (
                  <p className="text-xs text-status-warning">
                    Cierre forzado disponible en {forceCloseInMin} min
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Alerta de prioridad */}
      <PriorityAlert alerts={priorityAlerts} onDismiss={() => setPriorityAlerts([])} />

      {/* Feedback */}
      {feedback && (
        <div className={clsx(
          'px-4 py-3 rounded-xl text-sm font-medium text-center',
          feedback.type === 'ok'    && 'bg-status-success/10 text-status-success border border-status-success/40',
          feedback.type === 'warn'  && 'bg-status-warning/10 text-status-warning border border-status-warning/40',
          feedback.type === 'error' && 'bg-status-danger/10 text-status-danger border border-status-danger/40',
        )}>
          {feedback.msg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex bg-surface-elevated/60 rounded-xl p-1 gap-1">
        {[
          ['paquetes', 'Paquetes'],
          ...(usesLots ? [['mp', 'Mat. Primas']] : []),
          ['merma', 'Merma'],
          ['incidencia', 'Incidencia'],
        ].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={clsx(
              'flex-1 py-2 text-sm font-medium rounded-lg transition-colors',
              tab === key ? 'bg-surface-primary text-ink-primary shadow-sm' : 'text-ink-muted hover:text-ink-secondary'
            )}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab Paquetes */}
      {tab === 'paquetes' && (
        <form onSubmit={handleCapture} className="card space-y-4">
          <div>
            <label className="label text-center block text-base font-semibold">
              Peso del paquete (kg) <span className="text-status-danger">*</span>
            </label>
            <input
              ref={weightRef}
              type="number" step="0.001" min="0.001"
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              placeholder="0.000"
              autoFocus
              className="input text-3xl h-16 text-center font-bold tracking-wide"
            />
          </div>

          {/* Captura dinámica: campos definidos por el tenant en el product_kind
              de este producto. Ej: color del extruido, sabor de fritura, talla
              de pastel — los define el tenant en Configuración → Tipos de producto. */}
          {captureSchema && captureSchema.fields?.length > 0 && !isSecondQ && (
            <div className="border-t border-line-subtle pt-3">
              <p className="text-xs font-semibold text-ink-secondary mb-2">
                Atributos del paquete
              </p>
              <DynamicCaptureFields
                schema={captureSchema}
                values={dynamicValues}
                onChange={(code, value) =>
                  setDynamicValues(prev => ({ ...prev, [code]: value }))
                }
                compact
              />
            </div>
          )}

          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={isSecondQ}
              onChange={(e) => { setIsSecondQ(e.target.checked); setSecondQProdId('') }}
              className="w-5 h-5 accent-amber-500" />
            <span className="text-sm text-ink-secondary">Segunda calidad</span>
          </label>

          {isSecondQ && (
            <div>
              <label className="label">Producto de segunda calidad <span className="text-status-danger">*</span></label>
              <select value={secondQProdId} onChange={(e) => setSecondQProdId(e.target.value)} className="select w-full">
                <option value="">Seleccionar producto Cal. 2...</option>
                {allProducts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          <button type="submit"
            disabled={captureMutation.isPending || !weight || !activeOrderId || (isSecondQ && !secondQProdId)}
            className="btn-primary w-full h-14 text-base justify-center font-bold">
            {captureMutation.isPending ? <Spinner className="w-5 h-5" /> : '✅  Registrar paquete'}
          </button>

          {lastCapture && (
            <p className="text-xs text-center text-ink-muted">
              Último: {lastCapture.real_weight_kg} kg · Paq. #{lastCapture.microlot_number}
            </p>
          )}
        </form>
      )}

      {/* Tab Materias Primas (solo cuando uses_lots=true) */}
      {tab === 'mp' && usesLots && (
        <MpLoadTab
          shiftId={selectedShift}
          shiftDetail={shiftDetail}
          onFeedback={showFeedback}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['shift-detail', selectedShift] })
          }}
        />
      )}

      {/* Tab Merma */}
      {tab === 'merma' && (
        <form onSubmit={(e) => {
          e.preventDefault()
          if (!scrapType) return
          scrapMutation.mutate({
            scrapType,
            kg: parseFloat(scrapKg),
            productionOrderId: activeOrderId || null,
          })
        }} className="card space-y-4">
          <div>
            <label className="label">Tipo de merma</label>
            {scrapTypes.length === 0 ? (
              <p className="text-sm text-ink-muted">Cargando tipos de merma...</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {scrapTypes.map(t => (
                  <button key={t.code} type="button"
                    onClick={() => setScrapType(t.code)}
                    className={clsx(
                      'py-2.5 px-3 rounded-lg text-xs text-left border transition-colors',
                      scrapType === t.code ? 'bg-brand-500/10 border-brand-500/40 text-brand-300' : 'bg-surface-primary border-line-subtle text-ink-secondary'
                    )}>
                    <p className="font-medium">{t.name}</p>
                    {t.description && <p className="text-ink-muted mt-0.5 truncate">{t.description}</p>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="label">Kilogramos <span className="text-status-danger">*</span></label>
            <input type="number" step="0.001" min="0.001" inputMode="decimal" value={scrapKg}
              onChange={(e) => setScrapKg(e.target.value)}
              placeholder="0.000" className="input text-xl h-12 text-center font-bold" />
          </div>
          <button type="submit" disabled={scrapMutation.isPending || !scrapKg || !scrapType}
            className="btn-primary w-full h-12 justify-center">
            {scrapMutation.isPending ? <Spinner className="w-4 h-4" /> : 'Registrar merma'}
          </button>
        </form>
      )}

      {/* Tab Incidencia */}
      {tab === 'incidencia' && (
        <form onSubmit={(e) => {
          e.preventDefault()
          incidentMutation.mutate({ category: incidentCat, description: incidentDesc, durationMinutes: incidentMin ? parseInt(incidentMin) : null })
        }} className="card space-y-4">
          <div>
            <label className="label">Categoría</label>
            <select value={incidentCat} onChange={(e) => setIncidentCat(e.target.value)} className="select w-full">
              {INCIDENT_CATS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Descripción <span className="text-status-danger">*</span></label>
            <textarea value={incidentDesc} onChange={(e) => setIncidentDesc(e.target.value)}
              rows={3} placeholder="Describe la incidencia..."
              className="input h-auto py-2 resize-none" />
          </div>
          <div>
            <label className="label">Duración (minutos)</label>
            <input type="number" min="1" inputMode="numeric" pattern="[0-9]*" value={incidentMin}
              onChange={(e) => setIncidentMin(e.target.value)}
              placeholder="Ej: 15" className="input" />
          </div>
          <button type="submit" disabled={incidentMutation.isPending || !incidentDesc}
            className="btn-primary w-full h-12 justify-center">
            {incidentMutation.isPending ? <Spinner className="w-4 h-4" /> : 'Reportar incidencia'}
          </button>
        </form>
      )}

      {/* Historial editable: paquetes / merma / incidencia / MP */}
      <EditableRecordsHistory
        shift={shiftDetail}
        currentUser={currentUser}
        onFeedback={showFeedback}
      />

      {/* Cerrar turno */}
      <div className="border-t border-line-subtle pt-2">
        <button
          onClick={() => { if (confirm('¿Confirmas finalizar tu turno?')) closeMutation.mutate() }}
          disabled={closeMutation.isPending}
          className="btn-secondary w-full justify-center text-status-danger hover:border-status-danger/40 hover:bg-status-danger/10">
          {closeMutation.isPending ? <Spinner className="w-4 h-4" /> : 'Finalizar mi turno'}
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tab de carga de materias primas (uses_lots=true)
// ═══════════════════════════════════════════════════════════════════════════
function MpLoadTab({ shiftId, shiftDetail, onFeedback, onSuccess }) {
  const queryClient = useQueryClient()
  const [rawMaterialId, setRawMaterialId] = useState('')
  const [loadedKg, setLoadedKg] = useState('')

  const { data: mpData } = useQuery({
    queryKey: ['raw-materials-active'],
    queryFn:  () => rawMaterialsApi.list({ isActive: true, limit: 200 }),
    staleTime: 60000,
  })
  const mps = mpData?.data || []

  const mpLoads = shiftDetail?.mp_loads || []

  const mutation = useMutation({
    mutationFn: (body) => productionApi.loadMp(shiftId, body),
    onSuccess: () => {
      setRawMaterialId('')
      setLoadedKg('')
      onFeedback('ok', 'MP registrada')
      onSuccess()
    },
    onError: (e) => onFeedback('error', e?.response?.data?.error || 'Error al registrar MP'),
  })

  return (
    <div className="space-y-4">
      {/* Banner informativo: cargar MP es opcional cuando uses_lots=true */}
      <div className="rounded-xl border border-status-info/30 bg-status-info/5 px-4 py-3 flex gap-3">
        <svg className="w-5 h-5 shrink-0 text-status-info mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div className="text-xs text-ink-secondary leading-relaxed">
          <p className="font-medium text-ink-primary mb-0.5">Carga de MP opcional</p>
          <p>Si conoces el lote específico que estás usando, decláralo aquí para mantener trazabilidad FEFO.</p>
          <p className="mt-1">Si no, el sistema <span className="font-medium text-ink-primary">estimará el consumo al cerrar el turno</span> según la fórmula × peso real producido. En ese caso pierdes el rastreo por lote pero el inventario se descuenta igual.</p>
        </div>
      </div>

      <form onSubmit={(e) => {
        e.preventDefault()
        if (!rawMaterialId || !loadedKg) return
        mutation.mutate({ rawMaterialId, loadedKg: parseFloat(loadedKg) })
      }} className="card space-y-4">
        <div>
          <label className="label">Materia prima <span className="text-status-danger">*</span></label>
          <select value={rawMaterialId} onChange={(e) => setRawMaterialId(e.target.value)} className="select w-full">
            <option value="">Seleccionar material...</option>
            {mps.map(m => (
              <option key={m.id} value={m.id}>{m.name}{m.resin_type ? ` — ${m.resin_type}` : ''}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Kilogramos cargados <span className="text-status-danger">*</span></label>
          <input type="number" step="0.001" min="0.001" inputMode="decimal"
            value={loadedKg} onChange={(e) => setLoadedKg(e.target.value)}
            placeholder="0.000" className="input text-xl h-12 text-center font-bold" />
        </div>
        <button type="submit" disabled={mutation.isPending || !rawMaterialId || !loadedKg}
          className="btn-primary w-full h-12 justify-center">
          {mutation.isPending ? <Spinner className="w-4 h-4" /> : 'Registrar carga de MP'}
        </button>
      </form>

      {/* Historial de cargas del turno */}
      {mpLoads.length > 0 && (
        <div className="card space-y-2">
          <p className="text-xs font-semibold text-ink-secondary">Cargas registradas este turno</p>
          {mpLoads.map((load, i) => (
            <div key={load.id || i} className="flex items-center justify-between text-sm py-1 border-b border-line-subtle last:border-0">
              <span className="text-ink-secondary">{load.raw_material_name || load.rawMaterialName || '—'}</span>
              <span className="font-mono font-medium text-ink-primary">{parseFloat(load.loaded_kg || load.loadedKg || 0).toFixed(2)} kg</span>
            </div>
          ))}
          <div className="flex justify-between text-xs font-semibold text-ink-secondary pt-1">
            <span>Total</span>
            <span className="font-mono">
              {mpLoads.reduce((s, l) => s + parseFloat(l.loaded_kg || l.loadedKg || 0), 0).toFixed(2)} kg
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  Fórmula MP vigente + cambio de fórmula (versionado durante producción)
// ═══════════════════════════════════════════════════════════════════════════
function FormulaCard({ orderId, currentUser, shiftDetail }) {
  const queryClient = useQueryClient()
  const [showChangeModal, setShowChangeModal] = useState(false)
  const [showHistory, setShowHistory]         = useState(false)

  // Cargar la fórmula vigente desde getOrder (solo trae las filas valid_until IS NULL)
  const { data: order } = useQuery({
    queryKey: ['order-detail', orderId],
    queryFn:  () => productionApi.getOrder(orderId),
    enabled:  !!orderId,
    staleTime: 0,
  })

  const formula = order?.mpFormula || []

  // Permiso: admin/super_admin, o supervisor/operador del turno activo.
  // El operador también puede porque en turnos nocturnos puede no haber
  // supervisor disponible. Cualquier cambio queda auditado con razón.
  const userRoles = currentUser?.roles || []
  const isAdmin = userRoles.includes('admin') || userRoles.includes('super_admin')
  const isSupervisorOfThisShift = shiftDetail?.supervisor_id === currentUser?.id
  const isOperatorOfThisShift   = shiftDetail?.operator_id   === currentUser?.id
  const canChange = isAdmin || isSupervisorOfThisShift || isOperatorOfThisShift

  if (formula.length === 0) return null

  return (
    <>
      <div className="bg-surface-primary border border-line-subtle rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold text-ink-secondary">Fórmula vigente</p>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowHistory(true)}
              className="text-xs text-ink-muted hover:text-ink-secondary">
              Historial
            </button>
            {canChange && (
              <button onClick={() => setShowChangeModal(true)}
                className="text-xs font-medium text-brand-300 hover:text-brand-300">
                Cambiar fórmula
              </button>
            )}
          </div>
        </div>
        <div className="space-y-1">
          {formula.map((f) => (
            <div key={f.raw_material_id} className="flex items-center justify-between text-sm">
              <span className="text-ink-secondary">{f.material_name}</span>
              <span className="font-mono text-ink-primary">{parseFloat(f.percentage).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>

      {showChangeModal && (
        <ChangeFormulaModal
          orderId={orderId}
          currentFormula={formula}
          onClose={() => setShowChangeModal(false)}
          onSuccess={() => {
            setShowChangeModal(false)
            queryClient.invalidateQueries({ queryKey: ['order-detail', orderId] })
            queryClient.invalidateQueries({ queryKey: ['queue-orders'] })
          }}
        />
      )}

      {showHistory && (
        <FormulaHistoryModal
          orderId={orderId}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  )
}

function ChangeFormulaModal({ orderId, currentFormula, onClose, onSuccess }) {
  const [materials, setMaterials] = useState(
    currentFormula.map(f => ({
      rawMaterialId: f.raw_material_id,
      materialName:  f.material_name,
      percentage:    parseFloat(f.percentage),
    }))
  )
  const [reason, setReason] = useState('')
  const [error, setError]   = useState(null)

  // Cargar lista de raw_materials del tenant
  const { data: rawMaterialsResp } = useQuery({
    queryKey: ['raw-materials-all'],
    queryFn:  () => rawMaterialsApi.list({ limit: 200 }),
    staleTime: 60000,
  })
  const rawMaterials = Array.isArray(rawMaterialsResp) ? rawMaterialsResp : (rawMaterialsResp?.data || [])

  const total = materials.reduce((s, m) => s + parseFloat(m.percentage || 0), 0)
  const isValid = Math.abs(total - 100) < 0.01 && reason.trim().length > 0 &&
                  materials.every(m => m.rawMaterialId && parseFloat(m.percentage) > 0)

  const setPercentage = (idx, val) => {
    setMaterials(prev => prev.map((m, i) => i === idx ? { ...m, percentage: val } : m))
  }
  const setRawMaterial = (idx, rawMaterialId) => {
    const mat = rawMaterials.find(r => r.id === rawMaterialId)
    setMaterials(prev => prev.map((m, i) => i === idx ? {
      ...m, rawMaterialId, materialName: mat?.name || '',
    } : m))
  }
  const addMaterial = () => {
    if (materials.length >= 4) return
    setMaterials(prev => [...prev, { rawMaterialId: '', materialName: '', percentage: 0 }])
  }
  const removeMaterial = (idx) => {
    setMaterials(prev => prev.filter((_, i) => i !== idx))
  }

  const mutation = useMutation({
    mutationFn: () => productionApi.changeOrderFormula(orderId, {
      newFormula: materials.map(m => ({
        rawMaterialId: m.rawMaterialId,
        percentage:    parseFloat(m.percentage),
      })),
      reason: reason.trim(),
    }),
    onSuccess,
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al cambiar la fórmula.'),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Cambiar fórmula MP</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-3 text-xs text-status-warning">
          ⚠️ El cambio aplica solo a paquetes y merma capturados <strong>desde ahora</strong>. Los registros anteriores conservan la fórmula original.
        </div>

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">{error}</div>
        )}

        <div className="space-y-2">
          {materials.map((m, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select value={m.rawMaterialId} onChange={(e) => setRawMaterial(idx, e.target.value)}
                className="select flex-1 text-sm">
                <option value="">— Seleccionar —</option>
                {rawMaterials.map(r => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
              <input type="number" min="0" max="100" step="0.1" inputMode="decimal"
                value={m.percentage} onChange={(e) => setPercentage(idx, e.target.value)}
                className="input w-20 text-right" />
              <span className="text-xs text-ink-muted">%</span>
              {materials.length > 1 && (
                <button onClick={() => removeMaterial(idx)} className="btn-ghost btn-icon text-status-danger" title="Quitar">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              )}
            </div>
          ))}
          {materials.length < 4 && (
            <button onClick={addMaterial} className="btn-ghost text-sm text-brand-300">+ Agregar material</button>
          )}
        </div>

        <div className={clsx('text-sm font-medium text-right',
          Math.abs(total - 100) < 0.01 ? 'text-status-success' : 'text-status-danger')}>
          Suma: {total.toFixed(2)}% {Math.abs(total - 100) < 0.01 ? '✓' : '(debe ser 100%)'}
        </div>

        <div>
          <label className="label">Razón del cambio *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)}
            rows={2} placeholder="Ej: contaminación lote BOPP, ajuste por calidad..."
            className="input h-auto py-2 resize-none" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="btn-secondary">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={!isValid || mutation.isPending}
            className="btn-primary">
            {mutation.isPending ? <Spinner size="sm" /> : 'Aplicar cambio'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FormulaHistoryModal({ orderId, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['formula-history', orderId],
    queryFn:  () => productionApi.getOrderFormulaHistory(orderId),
    enabled:  !!orderId,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Historial de fórmula</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-6"><Spinner /></div>
        ) : (data?.versions?.length || 0) === 0 ? (
          <p className="text-sm text-ink-muted text-center py-4">Sin historial.</p>
        ) : (
          <div className="space-y-3">
            {data.versions.map((v, idx) => (
              <div key={idx} className={clsx('border rounded-lg p-3',
                v.isCurrent ? 'border-brand-500/40 bg-brand-500/10' : 'border-line-subtle')}>
                <div className="flex items-center justify-between mb-2">
                  <span className={clsx('text-xs font-semibold',
                    v.isCurrent ? 'text-brand-300' : 'text-ink-muted')}>
                    {v.isCurrent ? '● Vigente' : '○ Histórica'}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {new Date(v.validFrom).toLocaleString('es-MX', { dateStyle:'short', timeStyle:'short' })}
                    {v.validUntil && ` → ${new Date(v.validUntil).toLocaleString('es-MX', { dateStyle:'short', timeStyle:'short' })}`}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {v.materials.map(m => (
                    <div key={m.rawMaterialId} className="flex justify-between text-sm">
                      <span className="text-ink-secondary">{m.materialName}</span>
                      <span className="font-mono">{parseFloat(m.percentage).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {(data?.changes?.length || 0) > 0 && (
              <div className="border-t pt-3 mt-2">
                <p className="text-xs font-semibold text-ink-muted mb-2">Cambios registrados</p>
                {data.changes.map((c, idx) => (
                  <div key={idx} className="text-xs border-l-2 border-status-info/40 pl-3 py-1 mb-2">
                    <div className="text-ink-secondary">
                      <span className="font-medium">{c.changedBy || 'Usuario'}</span>
                      <span className="text-ink-muted ml-2">{new Date(c.changedAt).toLocaleString('es-MX', { dateStyle:'short', timeStyle:'short' })}</span>
                    </div>
                    <div className="italic text-ink-muted mt-0.5">"{c.reason}"</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={onClose} className="btn-secondary w-full">Cerrar</button>
      </div>
    </div>
  )
}
