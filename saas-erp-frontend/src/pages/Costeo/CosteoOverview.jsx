import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import BienvenidaWizard from './components/BienvenidaWizard'
import clsx from 'clsx'

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const fmtMoney = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

// ─── Página principal ─────────────────────────────────────────────────────────
export default function CosteoOverview() {
  const navigate = useNavigate()
  const now = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  const itemsQ = useQuery({
    queryKey: ['overhead-items', 'all'],
    queryFn:  () => overheadApi.listItems({}),
  })
  const periodsQ = useQuery({
    queryKey: ['overhead-periods', year, month],
    queryFn:  () => overheadApi.listPeriods({ year, month }),
  })

  const items   = itemsQ.data   || []
  const periods = periodsQ.data || []
  const activeItems = items.filter(i => i.is_active)
  const periodsWithEstimate = periods.filter(p => parseFloat(p.estimated_amount) > 0)
  const periodsMissingEstimate = periods.filter(p => !(parseFloat(p.estimated_amount) > 0))
  const finalizedCount = periods.filter(p => p.is_finalized).length
  const monthLabel = `${MONTHS[month-1]} ${year}`

  // Estado: bienvenida cuando no hay items
  const showWelcome = !itemsQ.isLoading && activeItems.length === 0

  // Construir checklist dinámico
  const checklist = buildChecklist({
    activeItems,
    periods,
    periodsWithEstimate,
    periodsMissingEstimate,
    finalizedCount,
    monthLabel,
  })

  if (itemsQ.isLoading || periodsQ.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }

  if (showWelcome) {
    return <BienvenidaWizard onDone={() => { itemsQ.refetch(); periodsQ.refetch() }} />
  }

  return (
    <div className="page-enter flex flex-col gap-6 max-w-5xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Costeo — Resumen</h1>
          <p className="page-subtitle">Cómo funciona, qué tienes hoy y qué te falta hacer</p>
        </div>
      </div>

      <FlowDiagram />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatusCard
          title="Gastos en catálogo"
          value={activeItems.length}
          subtitle={`${items.length - activeItems.length} inactivo(s)`}
          to="/costeo/gastos-indirectos"
          tone="brand"
        />
        <StatusCard
          title={`Período de ${monthLabel}`}
          value={periods.length === 0
            ? 'Sin crear'
            : `${periodsWithEstimate.length}/${periods.length} con estimado`}
          subtitle={
            periods.length === 0
              ? 'Aún no se generaron períodos'
              : periodsMissingEstimate.length > 0
                ? `${periodsMissingEstimate.length} sin estimar`
                : 'Todo estimado'
          }
          to="/costeo/periodos"
          tone={periodsMissingEstimate.length > 0 ? 'amber' : 'success'}
        />
        <StatusCard
          title="Cierre del mes"
          value={
            finalizedCount === 0
              ? 'Pendiente'
              : finalizedCount === periods.length
                ? 'Cerrado'
                : `${finalizedCount}/${periods.length}`
          }
          subtitle={finalizedCount === periods.length && periods.length > 0
            ? 'Listo para reporte'
            : 'Captura los reales al final del mes'}
          to="/costeo/cierre"
          tone={finalizedCount === periods.length && periods.length > 0 ? 'success' : 'gray'}
        />
      </div>

      {checklist.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-semibold text-ink-primary mb-3">Próximos pasos</h2>
          <ol className="space-y-2">
            {checklist.map((step, i) => (
              <ChecklistItem
                key={i}
                done={step.done}
                title={step.title}
                description={step.description}
                cta={step.cta}
                onClick={step.to ? () => navigate(step.to) : null}
              />
            ))}
          </ol>
        </section>
      )}

      <ConceptosClave />
    </div>
  )
}

// ─── Diagrama de flujo ────────────────────────────────────────────────────────
function FlowDiagram() {
  const steps = [
    { num: 1, label: 'Define tus gastos',     desc: 'Renta, luz, sueldos…' },
    { num: 2, label: 'Estima cada mes',       desc: 'Cuánto vas a gastar' },
    { num: 3, label: 'Produce normalmente',   desc: 'Cada turno se prorratea' },
    { num: 4, label: 'Cierra con los reales', desc: 'Recoste de órdenes' },
  ]
  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-ink-primary mb-1">¿Cómo funciona el costeo?</h2>
      <p className="text-xs text-ink-secondary mb-4 leading-relaxed">
        El sistema reparte (<em>prorratea</em>) los gastos fijos del mes (renta, luz, sueldos administrativos…) entre los turnos
        producidos, para que cada orden cargue su parte justa. Tú das un <strong>estimado</strong> a inicio de mes; al cerrar
        capturas los <strong>reales</strong> y el sistema <strong>recostea</strong> automáticamente las órdenes del período.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {steps.map((s, i) => (
          <div key={s.num} className="relative">
            <div className="border border-line-subtle rounded-lg p-3 h-full">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-6 h-6 rounded-full bg-brand-500/20 text-brand-300 text-xs font-bold flex items-center justify-center shrink-0">
                  {s.num}
                </span>
                <p className="text-xs font-semibold text-ink-primary leading-tight">{s.label}</p>
              </div>
              <p className="text-[11px] text-ink-muted leading-snug">{s.desc}</p>
            </div>
            {i < steps.length - 1 && (
              <div className="hidden md:block absolute top-1/2 -right-2 -translate-y-1/2 text-ink-muted">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M7 4l6 6-6 6"/></svg>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Tarjeta de estado ────────────────────────────────────────────────────────
function StatusCard({ title, value, subtitle, to, tone = 'gray' }) {
  const toneCls = {
    brand:   'border-brand-500/30',
    amber:   'border-status-warning/40',
    success: 'border-status-success/40',
    gray:    'border-line-subtle',
  }[tone] || 'border-line-subtle'

  const content = (
    <div className={clsx('card flex flex-col gap-1 hover:bg-surface-elevated/50 transition-colors', toneCls)}>
      <p className="text-xs text-ink-muted">{title}</p>
      <p className="text-xl font-semibold text-ink-primary">{value}</p>
      <p className="text-xs text-ink-secondary">{subtitle}</p>
    </div>
  )
  return to ? <Link to={to} className="block">{content}</Link> : content
}

// ─── Item de checklist ────────────────────────────────────────────────────────
function ChecklistItem({ done, title, description, cta, onClick }) {
  return (
    <li className={clsx('flex items-start gap-3 p-3 rounded-lg border', done ? 'border-status-success/30 bg-status-success/5' : 'border-line-subtle')}>
      <span className={clsx('w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5',
        done ? 'bg-status-success text-white' : 'bg-surface-elevated text-ink-muted border border-line-subtle')}>
        {done ? '✓' : ' '}
      </span>
      <div className="flex-1 min-w-0">
        <p className={clsx('text-sm font-medium', done ? 'text-ink-secondary line-through' : 'text-ink-primary')}>{title}</p>
        {description && <p className="text-xs text-ink-muted leading-snug mt-0.5">{description}</p>}
      </div>
      {!done && cta && onClick && (
        <button onClick={onClick} className="btn-primary btn-sm shrink-0 text-xs">{cta}</button>
      )}
    </li>
  )
}

function buildChecklist({ activeItems, periods, periodsWithEstimate, periodsMissingEstimate, finalizedCount, monthLabel }) {
  const list = []
  // Paso 1
  list.push({
    title: 'Define tus gastos fijos en el catálogo',
    description: 'Renta, energía, mantenimiento, sueldos administrativos, etc.',
    done: activeItems.length > 0,
    cta: 'Ir al catálogo',
    to: '/costeo/gastos-indirectos',
  })
  // Paso 2
  list.push({
    title: `Genera los períodos de ${monthLabel}`,
    description: 'Cada gasto activo genera un renglón mensual donde defines tu estimado.',
    done: activeItems.length > 0 && periods.length > 0,
    cta: periods.length === 0 && activeItems.length > 0 ? 'Generar períodos' : 'Ver períodos',
    to: '/costeo/periodos',
  })
  // Paso 3
  list.push({
    title: `Captura el monto estimado de cada gasto del mes`,
    description: periodsMissingEstimate.length > 0
      ? `Faltan ${periodsMissingEstimate.length} de ${periods.length}. El estimado se prorratea entre los turnos producidos.`
      : 'Listo — cada turno está absorbiendo su parte del estimado.',
    done: periods.length > 0 && periodsMissingEstimate.length === 0,
    cta: 'Editar estimados',
    to: '/costeo/periodos',
  })
  // Paso 4
  list.push({
    title: `Cierra ${monthLabel} con los montos reales`,
    description: 'Al final del mes capturas lo que realmente gastaste y el sistema recostea las órdenes producidas.',
    done: periods.length > 0 && finalizedCount === periods.length,
    cta: 'Iniciar cierre',
    to: '/costeo/cierre',
  })
  return list
}

// ─── Conceptos clave (colapsable) ─────────────────────────────────────────────
function ConceptosClave() {
  const [open, setOpen] = useState(false)
  return (
    <section className="card">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div>
          <h2 className="text-sm font-semibold text-ink-primary">Conceptos clave</h2>
          <p className="text-xs text-ink-muted mt-0.5">Para entender qué hace cada cosa</p>
        </div>
        <svg className={clsx('w-4 h-4 text-ink-muted transition-transform', open && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {open && (
        <div className="mt-4 pt-4 border-t border-line-subtle space-y-4 text-sm text-ink-secondary leading-relaxed">
          <Concept
            term="Gasto indirecto"
            short="Costo que no es materia prima."
            detail="Renta, energía, sueldos administrativos, mantenimiento… No se carga a una orden específica; se reparte entre todos los turnos del período."
          />
          <Concept
            term="Base de prorrateo"
            short="Cómo se reparte el costo entre turnos."
            detail={
              <ul className="list-disc list-inside space-y-0.5 mt-1">
                <li><strong>Partes iguales / por turno</strong>: se divide entre cuántos turnos hubo. Bueno para renta.</li>
                <li><strong>Por horas</strong>: turnos largos absorben más. Para mantenimiento o supervisión.</li>
                <li><strong>Por kg producido</strong>: turnos más productivos pagan más. Para energía o consumibles.</li>
                <li><strong>Por unidades</strong>: cada pieza absorbe un porcentaje. Para empaque.</li>
              </ul>
            }
          />
          <Concept
            term="Frecuencia"
            short="Cada cuánto se captura el monto."
            detail="Mensual es lo normal (renta, luz). Quincenal para nóminas quincenales. Anual para gastos como impuestos prediales. Por evento cuando es esporádico (reparación grande)."
          />
          <Concept
            term="Estimado vs Real"
            short="Estimado al inicio, real al cierre."
            detail="Capturas el estimado a inicio de mes para que el sistema vaya cargando costo a los turnos en tiempo real. Al cerrar el mes ingresas el monto real y el sistema recostea cada orden producida con el dato preciso."
          />
          <Concept
            term="Recosteo"
            short="Recalculo automático al cerrar."
            detail="El cierre dispara recálculo de costos. Las órdenes producidas durante el mes pasan de costo estimado a costo recosteado, y el reporte de varianza muestra la diferencia."
          />
          <Concept
            term="Varianza"
            short="Diferencia entre estimado y real."
            detail="Si gastaste $50k de luz cuando estimaste $40k, hay +$10k de varianza (+25%). El reporte muestra rubros con desviación >10% como alertas; te sirve para corregir el estimado del mes siguiente."
          />
        </div>
      )}
    </section>
  )
}

function Concept({ term, short, detail }) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink-primary">{term} <span className="text-ink-muted font-normal">— {short}</span></p>
      <div className="text-xs text-ink-secondary mt-1">{detail}</div>
    </div>
  )
}
