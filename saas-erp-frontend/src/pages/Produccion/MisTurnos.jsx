import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { productionApi } from '@/api/production'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// Vista de SOLO LECTURA para capturistas / operadores: muestra únicamente
// SUS turnos asignados de la semana (no los de los demás). Los datos vienen de
// /scheduled-shifts/mine, que está acotado al usuario logueado en el backend.

const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

const STATUS_META = {
  scheduled:         { label: 'Programado',      cls: 'bg-brand-500/10 text-brand-300' },
  active:            { label: 'Activo',          cls: 'bg-status-success/15 text-status-success' },
  pending_handover:  { label: 'Esperando relevo', cls: 'bg-status-warning/15 text-status-warning' },
  completed:         { label: 'Completado',      cls: 'bg-surface-elevated text-ink-secondary' },
  reviewed:          { label: 'Validado',        cls: 'bg-status-info/15 text-status-info' },
  cancelled:         { label: 'Cancelado',       cls: 'bg-status-danger/15 text-status-danger' },
}

function startOfWeek(offsetWeeks = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()                       // 0=Dom .. 6=Sáb
  const toMonday = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + toMonday + offsetWeeks * 7)
  return d
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtTime(t) {
  if (!t) return ''
  const [h, m] = String(t).split(':')
  const hh = parseInt(h, 10)
  const ampm = hh >= 12 ? 'pm' : 'am'
  const h12 = ((hh + 11) % 12) + 1
  return `${h12}:${m}${ampm}`
}

export default function MisTurnos() {
  const navigate = useNavigate()
  const userId = useAuthStore(s => s.user?.id)
  const [weekOffset, setWeekOffset] = useState(0)

  const monday = useMemo(() => startOfWeek(weekOffset), [weekOffset])
  const sunday = useMemo(() => addDays(monday, 6), [monday])
  const dateFrom = ymd(monday)
  const dateTo   = ymd(sunday)
  const todayStr = ymd(new Date())

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['my-shifts', dateFrom, dateTo],
    queryFn:  () => productionApi.getMyShifts({ dateFrom, dateTo }),
  })

  const shiftsByDate = useMemo(() => {
    const map = {}
    for (const s of shifts) {
      const k = String(s.scheduled_date).slice(0, 10)
      if (!map[k]) map[k] = []
      map[k].push(s)
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => String(a.scheduled_start).localeCompare(String(b.scheduled_start)))
    }
    return map
  }, [shifts])

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday])

  const weekLabel = `${monday.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} – ${sunday.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}`

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Mis turnos</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Solo tus turnos asignados de la semana. Para registrar tu producción, ve a{' '}
            <button onClick={() => navigate('/produccion/captura')} className="text-brand-300 hover:underline">
              Captura
            </button>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset(w => w - 1)} className="btn-ghost btn-sm" title="Semana anterior">←</button>
          <button onClick={() => setWeekOffset(0)}
            className={clsx('btn-sm', weekOffset === 0 ? 'btn-secondary' : 'btn-ghost')}>
            Esta semana
          </button>
          <button onClick={() => setWeekOffset(w => w + 1)} className="btn-ghost btn-sm" title="Semana siguiente">→</button>
        </div>
      </div>

      <p className="text-sm font-medium text-ink-secondary">{weekLabel}</p>

      {isLoading ? (
        <div className="card flex justify-center py-16"><Spinner /></div>
      ) : shifts.length === 0 ? (
        <div className="card py-16 text-center">
          <p className="text-sm font-medium text-ink-secondary">No tienes turnos asignados esta semana.</p>
          <p className="text-xs text-ink-muted mt-1">Tu supervisor los asigna en la programación de la planta.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2">
          {days.map((d, i) => {
            const key = ymd(d)
            const dayShifts = shiftsByDate[key] || []
            const isToday = key === todayStr
            return (
              <div key={key}
                className={clsx('card p-2.5 flex flex-col gap-2 min-h-[96px]',
                  isToday && 'ring-1 ring-brand-500/50')}>
                <div className="flex items-baseline justify-between">
                  <span className={clsx('text-xs font-semibold uppercase tracking-wide',
                    isToday ? 'text-brand-300' : 'text-ink-muted')}>
                    {DAY_NAMES[i]} {d.getDate()}
                  </span>
                  {isToday && <span className="text-[9px] text-brand-300 font-medium">HOY</span>}
                </div>

                {dayShifts.length === 0 ? (
                  <span className="text-[11px] text-ink-muted italic mt-1">Sin turno</span>
                ) : (
                  dayShifts.map(s => {
                    const meta = STATUS_META[s.status] || { label: s.status, cls: 'bg-surface-elevated text-ink-secondary' }
                    const myRole = (s.members || []).find(m => m.user_id === userId)?.role_name
                    return (
                      <div key={s.id} className="rounded-lg border border-line-subtle bg-surface-elevated/30 p-2 flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-ink-primary">Turno {s.shift_number}</span>
                          <span className="text-[10px] text-ink-muted">{fmtTime(s.scheduled_start)}</span>
                        </div>
                        <span className={clsx('inline-block w-fit text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full', meta.cls)}>
                          {meta.label}
                        </span>
                        {myRole && (
                          <span className="text-[10px] text-ink-secondary">Tu rol: <strong>{myRole}</strong></span>
                        )}
                        <span className="text-[10px] text-ink-muted leading-snug">
                          {s.order_number
                            ? <>{s.order_number}{s.product_name ? ` · ${s.product_name}` : ''}</>
                            : <em>Sin orden (se elige al iniciar)</em>}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
