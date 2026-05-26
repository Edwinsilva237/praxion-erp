import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import { processConfigApi } from '@/api/processConfig'
import api from '@/api/axios'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// ── Constantes ─────────────────────────────────────────────────────────────
const SHIFTS = [
  { number: '1', label: 'Turno 1', hour: '06:00', range: '6am – 2pm' },
  { number: '2', label: 'Turno 2', hour: '14:00', range: '2pm – 10pm' },
  { number: '3', label: 'Turno 3', hour: '22:00', range: '10pm – 6am' },
]


function timeToMins(t) {
  const [h, m] = String(t || '00:00').slice(0, 5).split(':').map(Number)
  return h * 60 + m
}
function canAssignShift(shiftCfg, todayStr, dateStr) {
  if (dateStr !== todayStr) return { can: true, reason: null }
  const now = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const startM = timeToMins(shiftCfg.start_time)
  const endM = (startM + (shiftCfg.duration_hours || 8) * 60) % (24 * 60)
  const ended = endM > startM ? nowMins > endM : (nowMins > endM && nowMins < startM)
  if (ended) {
    const endH = Math.floor(endM / 60).toString().padStart(2, '0')
    const endMin = (endM % 60).toString().padStart(2, '0')
    return { can: false, reason: `Terminó a las ${endH}:${endMin}` }
  }
  return { can: true, reason: null }
}
const STATUS_CONFIG = {
  scheduled:   { badge: 'blue',   label: 'Programado',  dot: 'bg-blue-400' },
  active:      { badge: 'green',  label: 'Activo',      dot: 'bg-green-500' },
  completed:   { badge: 'gray',   label: 'Completado',  dot: 'bg-gray-400' },
  cancelled:   { badge: 'red',    label: 'Cancelado',   dot: 'bg-red-400' },
}

function fmtDay(date) {
  return date.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
}
function fmtDayLong(date) {
  return date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
}
function getMonday(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay() + 1 + offset * 7)
  d.setHours(0, 0, 0, 0)
  return d
}

// ── Helper: convertir un Date a string YYYY-MM-DD usando hora LOCAL ─────────
// IMPORTANTE: NO usar `toISOString()` para esto. toISOString() devuelve UTC,
// así que cuando la hora local pasa la medianoche UTC el día queda "adelantado".
// Esta función usa getFullYear/getMonth/getDate (locales) para garantizar
// que "hoy" sea el día que ve el usuario en su reloj.
function toLocalISODate(d) {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// ── Modal configuración de turnos ────────────────────────────────────────────
function ShiftConfigModal({ currentConfig, onClose }) {
  const qc = useQueryClient()
  const [shifts, setShifts] = useState(
    currentConfig.map(s => ({
      shiftNumber: s.shift_number,
      name: s.name || '',
      startTime: String(s.start_time || '').slice(0, 5),
      durationHours: s.duration_hours || 8,
      confirmationToleranceMinutes: s.confirmation_tolerance_minutes || 15,
    }))
  )
  const [error, setError] = useState(null)
  function upd(idx, key, val) { setShifts(p => p.map((s, i) => i !== idx ? s : { ...s, [key]: val })) }
  const mutation = useMutation({
    mutationFn: () => productionApi.updateShiftConfig({ shifts }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shift-config'] }); onClose() },
    onError: (e) => setError(e.response?.data?.error || 'Error al guardar'),
  })
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Configuración de turnos</h2>
            <p className="text-xs text-ink-muted mt-0.5">Los cambios aplican a toda la operación</p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        {shifts.map((s, idx) => (
          <div key={s.shiftNumber} className="border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Turno {s.shiftNumber}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Nombre</label>
                <input className="input" value={s.name} onChange={e => upd(idx, 'name', e.target.value)} />
              </div>
              <div>
                <label className="label">Hora de inicio</label>
                <input type="time" className="input" value={s.startTime} onChange={e => upd(idx, 'startTime', e.target.value)} />
              </div>
              <div>
                <label className="label">Duración (horas)</label>
                <input type="number" min="1" max="12" className="input" value={s.durationHours}
                  onChange={e => upd(idx, 'durationHours', parseInt(e.target.value))} />
              </div>
            </div>
          </div>
        ))}
        <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4">
          <label className="label">Tolerancia de confirmación (minutos)</label>
          <input type="number" min="0" max="60" className="input w-24"
            value={shifts[0]?.confirmationToleranceMinutes || 15}
            onChange={e => setShifts(p => p.map(s => ({ ...s, confirmationToleranceMinutes: parseInt(e.target.value) })))}
          />
          <p className="text-xs text-ink-muted mt-1">Tiempo máximo para confirmar presencia antes de generar alerta.</p>
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal editar turno ──────────────────────────────────────────────────────
function EditModal({ shift, users, onClose, onSaved }) {
  const qc = useQueryClient()
  const [operatorId, setOperatorId]   = useState(shift.operator_id || '')
  const [notes, setNotes]             = useState(shift.notes || '')
  const [reasign, setReasign]         = useState(false)
  const [replacementId, setReplId]    = useState('')
  const [isOvertime, setOvertime]     = useState(false)
  const [markAbsence, setAbsence]     = useState(false)
  const [error, setError]             = useState(null)

  // Detectar si el operador de reemplazo ya tiene turno ese día
  const replacementUser = users.find(u => u.id === replacementId)
  const isOvertimeWarn  = replacementId && replacementId !== shift.operator_id

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        operatorId:           reasign ? replacementId : operatorId,
        notes:                notes || null,
        isOvertime:           reasign ? isOvertime : false,
        absenceRegistered:    reasign ? markAbsence : false,
        replacementOperatorId: reasign ? replacementId : null,
      }
      return productionApi.updateScheduledShift(shift.id, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-shifts'] })
      onSaved()
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || 'Error al guardar'),
  })

  const cancelMutation = useMutation({
    mutationFn: () => productionApi.updateScheduledShift(shift.id, { status: 'cancelled' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-shifts'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || 'Error al cancelar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {SHIFTS.find(s => s.number === String(shift.shift_number))?.label} · {fmtDay(new Date(shift.scheduled_date))}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {shift.product_name ? `${shift.product_name} · ${shift.order_number}` : 'Sin orden asignada'}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Operador actual */}
        <div className="bg-surface-elevated/40 rounded-xl px-4 py-3">
          <p className="text-xs text-ink-muted uppercase tracking-wide mb-1">Operador asignado</p>
          <p className="text-sm font-semibold text-ink-primary">{shift.operator_name}</p>
        </div>

        {/* Notas */}
        <div>
          <label className="label">Notas del turno</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Instrucciones especiales para este turno..."
            className="input h-auto py-2 resize-none"
          />
        </div>

        {/* Reasignación */}
        <div className="border border-line-subtle rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setReasign(p => !p)}
            className="w-full flex items-center justify-between px-4 py-3 bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors text-left"
          >
            <span className="text-sm font-medium text-ink-secondary">Reasignar o marcar problema</span>
            <svg className={clsx('w-4 h-4 text-ink-muted transition-transform', reasign && 'rotate-180')}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
            </svg>
          </button>

          {reasign && (
            <div className="px-4 py-3 flex flex-col gap-3 border-t border-line-subtle">
              <div>
                <label className="label">Operador de reemplazo</label>
                <select className="select" value={replacementId} onChange={e => setReplId(e.target.value)}>
                  <option value="">Seleccionar operador...</option>
                  {users.filter(u => u.id !== shift.operator_id).map(u => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </div>

              {isOvertimeWarn && replacementUser && (
                <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2 flex flex-col gap-2">
                  <p className="text-xs text-status-warning font-medium">
                    ⚠ Verifica si {replacementUser.full_name} ya tiene turno asignado hoy
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={isOvertime} onChange={e => setOvertime(e.target.checked)}
                      className="w-4 h-4 accent-amber-500" />
                    <span className="text-xs text-status-warning">Confirmar como tiempo extra</span>
                  </label>
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={markAbsence} onChange={e => setAbsence(e.target.checked)}
                  className="w-4 h-4 accent-red-400" />
                <span className="text-sm text-ink-secondary">
                  Registrar ausencia de {shift.operator_name}
                </span>
              </label>
            </div>
          )}
        </div>

        {error && <p className="field-error">{error}</p>}

        {/* Acciones */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => {
              if (window.confirm(`¿Cancelar el ${SHIFTS.find(s => s.number === String(shift.shift_number))?.label} del ${fmtDay(new Date(shift.scheduled_date))}?`)) {
                cancelMutation.mutate()
              }
            }}
            disabled={cancelMutation.isPending || mutation.isPending}
            className="btn-secondary btn-sm text-status-danger hover:border-status-danger/40"
          >
            {cancelMutation.isPending ? <Spinner size="sm" /> : 'Cancelar turno'}
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (reasign && !replacementId)}
            className="btn-primary flex-1"
          >
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Modal programar turno ───────────────────────────────────────────────────
function NuevoTurnoModal({ defaultShift, defaultDate, orders, users, usesSupervisor = true, onClose }) {
  const qc = useQueryClient()
  const [orderId, setOrderId]       = useState('')
  const [shiftNum, setShiftNum]     = useState(defaultShift || '1')
  const [date, setDate]             = useState(defaultDate || toLocalISODate(new Date()))
  const [start, setStart]           = useState(SHIFTS.find(s => s.number === (defaultShift || '1'))?.hour || '06:00')
  const [operatorId, setOperatorId] = useState('')
  const [supervisorId, setSuperv]   = useState('')
  const [notes, setNotes]           = useState('')
  const [error, setError]           = useState(null)

  // Estado de validación visual: marca campos vacíos cuando el usuario intenta enviar
  // La orden NO es obligatoria asignar (es opcional); operador siempre, supervisor solo si el tenant lo usa.
  const [submitted, setSubmitted]   = useState(false)
  const missingOperator   = submitted && !operatorId
  const missingSupervisor = submitted && usesSupervisor && !supervisorId

  const noOrders = !orders || orders.length === 0
  const noUsers  = !users  || users.length  === 0

  const mutation = useMutation({
    mutationFn: () => {
      // La orden es OPCIONAL: el operador la elige de la cola al iniciar.
      if (!operatorId) throw new Error('Operador requerido.')
      if (usesSupervisor && !supervisorId) throw new Error('Supervisor requerido.')
      return productionApi.scheduleShift({
        productionOrderId: orderId || null,
        shiftNumber:       shiftNum,
        scheduledDate:     date,
        scheduledStart:    start,
        operatorId,
        supervisorId: usesSupervisor ? supervisorId : (supervisorId || operatorId),
        notes: notes || null,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scheduled-shifts'] })
      onClose()
    },
    onError: (e) => {
      // Mensaje robusto: status code + mensaje del backend + detalle si lo hay
      const status = e?.response?.status
      const backendMsg = e?.response?.data?.error || e?.response?.data?.message
      let msg
      if (status === 409) {
        msg = backendMsg || 'Ya existe un turno programado para esa orden, fecha y número de turno.'
      } else if (status === 400) {
        msg = backendMsg || 'Faltan campos requeridos o el formato es inválido.'
      } else if (status === 403) {
        msg = 'No tienes permiso para programar turnos.'
      } else if (status === 404) {
        msg = backendMsg || 'La orden seleccionada no existe o fue eliminada.'
      } else if (status >= 500) {
        msg = `Error del servidor (${status}). ${backendMsg || 'Revisa logs del backend.'}`
      } else if (e.message === 'Network Error') {
        msg = 'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.'
      } else {
        msg = backendMsg || e.message || 'Error desconocido al programar el turno.'
      }
      // Log a consola para diagnóstico — el usuario puede copiarlo si nos vuelve a fallar.
      console.error('[scheduleShift] Error:', { status, backendMsg, fullError: e })
      setError(msg)
    },
  })

  function handleSubmit() {
    setSubmitted(true)
    setError(null)
    // Operador siempre requerido; supervisor solo si el tenant lo usa.
    if (!operatorId || (usesSupervisor && !supervisorId)) {
      setError('Completa los campos marcados en rojo antes de continuar.')
      return
    }
    if (noOrders) {
      setError('No hay órdenes liberadas o en proceso. Crea o libera una orden antes de programar turnos.')
      return
    }
    mutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Programar turno</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Avisos contextuales si faltan datos base */}
        {noOrders && (
          <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
            <p className="font-medium mb-1">⚠ No hay órdenes disponibles</p>
            <p className="text-xs">No tienes órdenes liberadas o en proceso. Crea o libera una orden desde Producción → Órdenes antes de programar turnos.</p>
          </div>
        )}
        {noUsers && (
          <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
            <p className="font-medium mb-1">⚠ No se cargaron usuarios</p>
            <p className="text-xs">El listado de usuarios viene vacío. Verifica que el endpoint /users esté funcionando.</p>
          </div>
        )}

       {/* Orden — OPCIONAL */}
        <div>
          <label className="label">
            Orden de producción <span className="text-xs text-ink-muted font-normal">(opcional)</span>
          </label>
          <select className="select" value={orderId} onChange={e => setOrderId(e.target.value)}>
            <option value="">Sin asignar — el operador elegirá de la cola</option>
            {orders.map(o => (
              <option key={o.id} value={o.id}>
                {o.order_number} — {o.product_name}
                {o.length_mm > 0 ? ` · ${(o.length_mm / 1000).toFixed(2)}m` : ''}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-ink-muted mt-1">
            Si no asignas, el operador continuará la orden en proceso del turno anterior o elegirá otra de la cola por prioridad.
          </p>
        </div>

        

        {/* Turno */}
        <div>
          <label className="label">Turno <span className="text-status-danger">*</span></label>
          <div className="grid grid-cols-3 gap-2">
            {SHIFTS.map(s => (
              <button key={s.number} type="button"
                onClick={() => { setShiftNum(s.number); setStart(s.hour) }}
                className={clsx(
                  'py-2.5 rounded-xl text-xs font-medium border transition-colors text-center',
                  shiftNum === s.number
                    ? 'bg-brand-500/10 border-brand-500/40 text-brand-300'
                    : 'bg-surface-primary border-line-subtle text-ink-secondary hover:bg-surface-elevated/40'
                )}>
                <p className="font-semibold">{s.label}</p>
                <p className="text-ink-muted mt-0.5">{s.range}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Fecha y hora */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha <span className="text-status-danger">*</span></label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Hora inicio</label>
            <input type="time" className="input" value={start} onChange={e => setStart(e.target.value)} />
          </div>
        </div>

        {/* Operador y supervisor */}
        <div>
          <label className="label">Operador <span className="text-status-danger">*</span></label>
          <select
            className={clsx('select', missingOperator && 'border-status-danger/40 ring-1 ring-status-danger/40')}
            value={operatorId}
            onChange={e => setOperatorId(e.target.value)}
            disabled={noUsers}
          >
            <option value="">Seleccionar operador...</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
          {missingOperator && <p className="field-error">Selecciona un operador.</p>}
        </div>

        {usesSupervisor && (
          <div>
            <label className="label">Supervisor <span className="text-status-danger">*</span></label>
            <select
              className={clsx('select', missingSupervisor && 'border-status-danger/40 ring-1 ring-status-danger/40')}
              value={supervisorId}
              onChange={e => setSuperv(e.target.value)}
              disabled={noUsers}
            >
              <option value="">Seleccionar supervisor...</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            {missingSupervisor && <p className="field-error">Selecciona un supervisor.</p>}
          </div>
        )}

        <div>
          <label className="label">Notas</label>
          <textarea rows={2} className="input h-auto py-2 resize-none" value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Instrucciones para el operador..." />
        </div>

        {/* Banner de error grande y visible */}
        {error && (
          <div className="rounded-lg border-2 border-status-danger/40 bg-status-danger/10 p-3 flex items-start gap-2">
            <span className="text-lg leading-none">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-status-danger mb-0.5">No se pudo programar el turno</p>
              <p className="text-sm text-status-danger break-words">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-status-danger shrink-0" title="Cerrar">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button
            onClick={handleSubmit}
            disabled={mutation.isPending || noOrders || noUsers}
            className="btn-primary flex-1"
          >
            {mutation.isPending
              ? <Spinner size="sm" />
              : missingCount > 0 && submitted
                ? `Programar (faltan ${missingCount})`
                : 'Programar turno'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Celda de la cuadrícula ──────────────────────────────────────────────────
function GridCell({ shift, isToday, isPast, onEdit, onNew, shiftNum, dateStr }) {
  if (!shift) {
    if (isPast) return (
      <div className="h-20 rounded-xl bg-surface-elevated/40 border border-dashed border-line-subtle flex items-center justify-center">
        <span className="text-xs text-ink-muted">—</span>
      </div>
    )
    return (
      <button
        onClick={() => onNew(shiftNum, dateStr)}
        className="h-20 rounded-xl border-2 border-dashed border-line-subtle hover:border-brand-500/40 hover:bg-brand-500/10/50 transition-colors flex items-center justify-center group"
      >
        <span className="text-xl text-ink-muted group-hover:text-brand-400 transition-colors">+</span>
      </button>
    )
  }

  const s = STATUS_CONFIG[shift.status] || STATUS_CONFIG.scheduled
  const isOvertime = shift.is_overtime
  const isAbsence  = shift.absence_registered

  return (
    <button
      onClick={() => !isPast && shift.status === 'scheduled' && onEdit(shift)}
      className={clsx(
        'h-20 rounded-xl border-2 p-2 text-left transition-all w-full',
        shift.status === 'active'     && 'border-status-success/40 bg-status-success/10',
        shift.status === 'scheduled'  && !isPast && 'border-status-info/40 bg-status-info/10 hover:border-brand-500/40 cursor-pointer',
        shift.status === 'scheduled'  && isPast  && 'border-line-subtle bg-surface-elevated/40 cursor-default',
        shift.status === 'completed'  && 'border-line-subtle bg-surface-elevated/40 cursor-default',
        shift.status === 'cancelled'  && 'border-status-danger/40 bg-status-danger/10/50 cursor-default opacity-60',
        isAbsence && 'border-status-danger/40',
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="text-xs font-semibold text-ink-primary leading-tight truncate flex-1">
          {shift.operator_name?.split(' ')[0]}
        </p>
        <div className={clsx('w-2 h-2 rounded-full shrink-0 mt-0.5', s.dot)} />
      </div>
      <p className="text-[10px] text-ink-muted truncate mt-0.5">{shift.order_number || 'Sin orden'}</p>
      <div className="flex items-center gap-1 mt-1">
        {isOvertime && (
          <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-status-warning/15 text-status-warning">+Extra</span>
        )}
        {isAbsence && (
          <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-status-danger/15 text-status-danger">Ausencia</span>
        )}
        {shift.notes && (
          <span className="text-[10px] text-ink-muted">📝</span>
        )}
      </div>
    </button>
  )
}

// ── Página principal ─────────────────────────────────────────────────────────
export default function ProduccionProgramacion() {
  const qc = useQueryClient()
  const [viewMode, setViewMode]     = useState('grid') // 'grid' | 'list'
  const [weekOffset, setWeekOffset] = useState(0)
  const [editingShift, setEditing]  = useState(null)
  const [newShiftCtx, setNewCtx]    = useState(null) // { shiftNum, dateStr }
  const [successMsg, setSuccess]    = useState(null)
  const [showConfig, setShowConfig] = useState(false)

  const { data: shiftConfig = [] } = useQuery({
    queryKey: ['shift-config'],
    queryFn: productionApi.getShiftConfig,
    staleTime: 5 * 60 * 1000,
  })
  const shiftsToRender = shiftConfig.length > 0 ? shiftConfig : [
    { shift_number: 1, name: 'Turno 1', start_time: '06:00', duration_hours: 8 },
    { shift_number: 2, name: 'Turno 2', start_time: '14:00', duration_hours: 8 },
    { shift_number: 3, name: 'Turno 3', start_time: '22:00', duration_hours: 8 },
  ]

  const monday = getMonday(weekOffset)
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  const dateFrom   = toLocalISODate(monday)
  const dateTo     = toLocalISODate(sunday)
  const todayStr   = toLocalISODate(new Date())
  const weekLabel  = `${monday.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} — ${sunday.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}`

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['scheduled-shifts', dateFrom, dateTo],
    queryFn: () => productionApi.listScheduledShifts({ dateFrom, dateTo }),
    refetchInterval: 30000,
  })

  const { data: ordersReleased = [] } = useQuery({
    queryKey: ['orders-released'],
    queryFn: () => productionApi.listOrders({ status: 'released', limit: 100 }).then(r => r.data || []),
  })
  const { data: ordersInProgress = [] } = useQuery({
    queryKey: ['orders-in-progress'],
    queryFn: () => productionApi.listOrders({ status: 'in_progress', limit: 100 }).then(r => r.data || []),
  })
  const { data: usersData } = useQuery({
    queryKey: ['users-active'],
    queryFn: () => api.get('/users', { params: { limit: 100 } }).then(r => r.data),
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn: processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesSupervisor = tenantConfig?.uses_supervisor ?? true

  const orders = [...ordersReleased, ...ordersInProgress]
  const users  = usersData?.data || usersData || []

  // Construir los 7 días de la semana
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      const dateStr  = toLocalISODate(d)
      const isPast   = dateStr < todayStr
      const isToday  = dateStr === todayStr
      const dayShifts = shifts.filter(s => {
        const sd = typeof s.scheduled_date === 'string'
          ? s.scheduled_date.slice(0, 10)
          : toLocalISODate(new Date(s.scheduled_date))
        return sd === dateStr
      })
      const byShift = {}
      SHIFTS.forEach(sh => {
        byShift[sh.number] = dayShifts.find(s => String(s.shift_number) === sh.number) || null
      })
      return { date: d, dateStr, isPast, isToday, byShift, allShifts: dayShifts }
    })
  }, [shifts, monday, todayStr])

  // Alerta de turnos sin confirmar hoy
  const pendingToday = shifts.filter(s => {
    const sd = typeof s.scheduled_date === 'string'
      ? s.scheduled_date.slice(0, 10)
      : toLocalISODate(new Date(s.scheduled_date))
    if (sd !== todayStr) return false
    const now      = new Date()
    const [h, m]   = (s.scheduled_start || '').split(':').map(Number)
    const startTime = new Date(); startTime.setHours(h, m, 0, 0)
    return s.status === 'scheduled' && now > startTime
  })

  function handleSaved() {
    setSuccess('Cambios guardados correctamente')
    setTimeout(() => setSuccess(null), 3000)
  }

  return (
    <div className="page-enter flex flex-col gap-5">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Programación de turnos</h1>
          <p className="page-subtitle">Plan semanal de producción</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle vista */}
          <div className="flex bg-surface-elevated/60 rounded-lg p-1 gap-1">
            <button onClick={() => setViewMode('grid')}
              className={clsx('px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                viewMode === 'grid' ? 'bg-surface-primary text-ink-primary shadow-sm' : 'text-ink-muted')}>
              ⊞ Cuadrícula
            </button>
            <button onClick={() => setViewMode('list')}
              className={clsx('px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                viewMode === 'list' ? 'bg-surface-primary text-ink-primary shadow-sm' : 'text-ink-muted')}>
              ≡ Lista
            </button>
          </div>
          <Can do="production:manage">
            <button onClick={() => setShowConfig(true)} className="btn-secondary btn-sm" title="Configurar turnos">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              Configurar
            </button>
          </Can>
          <Can do="production:manage">
            <button onClick={() => setNewCtx({ shiftNum: '1', dateStr: todayStr })}
              className="btn-primary">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
              </svg>
              Programar turno
            </button>
          </Can>
        </div>
      </div>

      {/* Alerta turnos sin confirmar hoy */}
      {pendingToday.length > 0 && (
        <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-lg shrink-0">⚠</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-status-warning">
              {pendingToday.length} turno{pendingToday.length > 1 ? 's' : ''} sin confirmar hoy
            </p>
            {pendingToday.map(s => (
              <p key={s.id} className="text-xs text-status-warning mt-0.5">
                {SHIFTS.find(sh => sh.number === String(s.shift_number))?.label} ({s.scheduled_start?.slice(0, 5)}) — {s.operator_name}
              </p>
            ))}
          </div>
        </div>
      )}

      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          <p className="text-sm text-status-success">{successMsg}</p>
        </div>
      )}

      {/* Navegación de semana */}
      <div className="flex items-center justify-between bg-surface-primary border border-line-subtle rounded-xl px-4 py-2.5">
        <button onClick={() => setWeekOffset(w => w - 1)} className="btn-ghost btn-sm">
          ← Anterior
        </button>
        <div className="flex items-center gap-2 text-sm font-medium text-ink-secondary">
          <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/>
          </svg>
          {weekLabel}
          {weekOffset === 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-600 text-white font-medium">Esta semana</span>
          )}
        </div>
        <button onClick={() => setWeekOffset(w => w + 1)} className="btn-ghost btn-sm">
          Siguiente →
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : viewMode === 'grid' ? (
        // ── Vista Cuadrícula ────────────────────────────────────────────────
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Header días */}
            <div className="grid grid-cols-8 gap-2 mb-2">
              <div /> {/* espacio para labels de turno */}
              {days.map(({ date, isToday, isPast }) => (
                <div key={date.toISOString()} className={clsx(
                  'text-center py-2 rounded-lg text-xs font-medium',
                  isToday ? 'bg-brand-600 text-white' : isPast ? 'text-ink-muted' : 'text-ink-secondary bg-surface-elevated/40'
                )}>
                  {fmtDay(date)}
                </div>
              ))}
            </div>

            {/* Filas por turno */}
            {SHIFTS.map(shift => (
              <div key={shift.number} className="grid grid-cols-8 gap-2 mb-2">
                {/* Label turno */}
                <div className="flex flex-col justify-center pr-2">
                  <p className="text-xs font-semibold text-ink-secondary">{shift.label}</p>
                  <p className="text-[10px] text-ink-muted">{shift.range}</p>
                </div>
                {/* Celdas */}
                {days.map(({ date, dateStr, isToday, isPast, byShift }) => (
                  <GridCell
                    key={dateStr}
                    shift={byShift[shift.number]}
                    isToday={isToday}
                    isPast={isPast}
                    shiftNum={shift.number}
                    dateStr={dateStr}
                    onEdit={setEditing}
                    onNew={(num, ds) => setNewCtx({ shiftNum: num, dateStr: ds })}
                  />
                ))}
              </div>
            ))}

            {/* Leyenda */}
            <div className="flex items-center gap-4 mt-3 px-1">
              {[
                ['bg-blue-400', 'Programado'],
                ['bg-green-500', 'Activo'],
                ['bg-gray-400', 'Completado'],
                ['bg-red-400', 'Cancelado'],
              ].map(([dot, label]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className={clsx('w-2 h-2 rounded-full', dot)} />
                  <span className="text-[10px] text-ink-muted">{label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-status-warning/15 text-status-warning">+Extra</span>
                <span className="text-[10px] text-ink-muted">Tiempo extra</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        // ── Vista Lista ─────────────────────────────────────────────────────
        <div className="flex flex-col gap-3">
          {days.map(({ date, dateStr, isToday, isPast, allShifts }) => (
            <div key={dateStr} className={clsx(
              'card p-0 overflow-hidden',
              isToday && 'border-brand-500/40'
            )}>
              <div className={clsx(
                'flex items-center justify-between px-4 py-2.5 border-b border-line-subtle',
                isToday ? 'bg-brand-500/10' : 'bg-surface-elevated/40'
              )}>
                <div className="flex items-center gap-2">
                  <span className={clsx('text-sm font-medium capitalize',
                    isToday ? 'text-brand-300' : isPast ? 'text-ink-muted' : 'text-ink-secondary')}>
                    {fmtDayLong(date)}
                  </span>
                  {isToday && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-600 text-white font-medium">Hoy</span>
                  )}
                </div>
                <span className="text-xs text-ink-muted">
                  {allShifts.filter(s => s.status !== 'cancelled').length} turno{allShifts.length !== 1 ? 's' : ''}
                </span>
              </div>

              {allShifts.length === 0 ? (
                <div className="px-4 py-3 flex items-center justify-between">
                  <p className="text-xs text-ink-muted">Sin turnos programados</p>
                  {!isPast && (
                    <button onClick={() => setNewCtx({ shiftNum: '1', dateStr })}
                      className="btn-ghost btn-sm text-brand-300 text-xs">
                      + Programar
                    </button>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-line-subtle">
                  {SHIFTS.map(sh => {
                    const s = allShifts.find(x => String(x.shift_number) === sh.number)
                    const sc = s ? STATUS_CONFIG[s.status] : null
                    return (
                      <div key={sh.number} className="flex items-center gap-4 px-4 py-3">
                        <div className="w-20 shrink-0">
                          <p className="text-xs font-mono font-medium text-ink-secondary">{sh.hour}</p>
                          <p className="text-[10px] text-ink-muted">{sh.label}</p>
                        </div>
                        {s ? (
                          <>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p className="text-sm font-medium text-ink-primary truncate">
                                  {s.product_name || <span className="text-ink-muted italic">Sin orden asignada</span>}
                                </p>
                                {s.is_overtime && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning">+Extra</span>
                                )}
                                {s.absence_registered && (
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-status-danger/15 text-status-danger">Ausencia</span>
                                )}
                              </div>
                              <p className="text-xs text-ink-muted mt-0.5">
                                Op: {s.operator_name}{s.order_number ? ` · ${s.order_number}` : ''}
                              </p>
                              {s.notes && <p className="text-xs text-blue-500 mt-0.5">📝 {s.notes}</p>}
                            </div>
                            <Badge variant={sc?.badge} label={sc?.label} />
                            {!isPast && s.status === 'scheduled' && (
                              <button onClick={() => setEditing(s)}
                                className="btn-ghost btn-sm text-ink-muted hover:text-brand-300 shrink-0">
                                Editar
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="flex-1">
                              <p className="text-xs text-ink-muted">Sin asignar</p>
                            </div>
                            {!isPast && (
                              <Can do="production:manage">
                                <button onClick={() => setNewCtx({ shiftNum: sh.number, dateStr })}
                                  className="btn-ghost btn-sm text-brand-300 text-xs shrink-0">
                                  + Asignar
                                </button>
                              </Can>
                            )}
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modales */}
      {showConfig && shiftConfig.length > 0 && (
        <ShiftConfigModal currentConfig={shiftConfig} onClose={() => setShowConfig(false)} />
      )}
      {editingShift && (
        <EditModal
          shift={editingShift}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}

      {newShiftCtx && (
        <NuevoTurnoModal
          defaultShift={newShiftCtx.shiftNum}
          defaultDate={newShiftCtx.dateStr}
          orders={orders}
          users={users}
          usesSupervisor={usesSupervisor}
          onClose={() => setNewCtx(null)}
        />
      )}
    </div>
  )
}
