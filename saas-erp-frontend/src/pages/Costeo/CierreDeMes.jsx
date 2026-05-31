import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import CollapsibleHelp from '@/components/ui/CollapsibleHelp'
import Badge from '@/components/ui/Badge'
import useAuthStore from '@/store/useAuthStore'
import { useNavigate } from 'react-router-dom'

const fmtMoney = (n) =>
  n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// Paso 1: selector de mes
function StepSelectMonth({ year, month, setYear, setMonth, onNext }) {
  const now = new Date()
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  return (
    <div className="flex flex-col gap-6">
      <CollapsibleHelp title="¿Qué pasa en el cierre de mes?">
        <ol className="list-decimal list-inside leading-relaxed space-y-0.5">
          <li>Eliges el mes a cerrar (típicamente el mes que terminó).</li>
          <li>Capturas <strong>cuánto realmente gastaste</strong> en cada rubro (puedes copiarlo de tu contabilidad o estados de cuenta).</li>
          <li>Revisas el resumen y confirmas.</li>
          <li>El sistema <strong>recostea</strong> automáticamente todas las órdenes producidas en el mes para usar el costo real en vez del estimado.</li>
        </ol>
      </CollapsibleHelp>
      <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 text-sm text-status-warning">
        ⚠ El cierre es <strong>irreversible</strong>. Asegúrate de tener los montos reales antes de confirmar. Si necesitas corregir después, contacta al admin.
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Año</label>
          <select className="select w-24" value={year} onChange={e => setYear(parseInt(e.target.value))}>
            {[now.getFullYear() - 1, now.getFullYear()].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Mes</label>
          <select className="select w-36" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
            {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
          </select>
        </div>
      </div>
      <div>
        <button onClick={onNext} className="btn-primary">Cargar períodos →</button>
      </div>
    </div>
  )
}

// Paso 2: ingresar montos reales
function StepEnterReals({ year, month, periods, reals, setReals, onBack, onNext, isLoading }) {
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  const total = Object.values(reals).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="font-medium mb-1">Captura el real de {MONTHS[month-1]} {year}</p>
        <p className="leading-relaxed">
          Anota cuánto pagaste realmente en cada rubro durante este mes (consulta tus facturas, recibos o estados de cuenta).
          La columna izquierda muestra lo que <em>estimaste</em>; lo capturas aquí es el <em>real</em>. La diferencia se llama
          varianza y la verás al confirmar.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : periods.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin períodos abiertos para este mes.</p>
          <p className="text-sm text-ink-muted mt-1">Crea los períodos primero desde "Períodos de overhead".</p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Gasto</th>
                  <th className="text-right">Estimado</th>
                  <th className="text-right w-44">Real capturado</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(p => (
                  <tr key={p.id}>
                    <td>
                      <p className="font-medium text-sm">{p.item_name || p.overhead_item_id}</p>
                      {p.item_code && <p className="text-xs font-mono text-ink-muted">{p.item_code}</p>}
                    </td>
                    <td className="text-right font-mono text-sm text-ink-muted">
                      {fmtMoney(p.estimated_amount)}
                    </td>
                    <td className="text-right">
                      <input
                        type="number" min={0} step="0.01"
                        className="input input-sm w-36 text-right"
                        value={reals[p.id] ?? p.estimated_amount ?? ''}
                        onChange={e => setReals(prev => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="0.00"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} className="text-right font-medium text-sm">Total real:</td>
                  <td className="text-right font-mono font-semibold text-sm">{fmtMoney(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={onBack} className="btn-ghost btn-sm">← Volver</button>
            <button
              onClick={onNext}
              disabled={periods.length === 0}
              className="btn-primary"
            >
              Revisar y cerrar →
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Paso 3: confirmación
function StepConfirm({ year, month, periods, reals, onBack, onConfirm, isPending, error }) {
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
  const totalEst  = periods.reduce((s, p) => s + (parseFloat(p.estimated_amount) || 0), 0)
  const totalReal = periods.reduce((s, p) => s + (parseFloat(reals[p.id]) || 0), 0)
  const delta = totalReal - totalEst
  const deltaPct = totalEst ? (delta / totalEst) * 100 : 0

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 text-sm text-status-warning">
        <p className="font-medium mb-1">Última revisión antes de cerrar</p>
        <p className="leading-relaxed">
          Verifica los totales abajo. Al confirmar: (1) se finalizan los períodos del mes, (2) el sistema recalcula el
          costo real de cada turno producido en el período, (3) las órdenes pasan de costo estimado a costo recosteado.
          <strong> No se puede deshacer.</strong>
        </p>
      </div>

      <div className="bg-surface-elevated rounded-xl border border-line-subtle p-5 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-ink-primary">Resumen del cierre — {MONTHS[month-1]} {year}</h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <p className="text-xs text-ink-muted">Estimado total</p>
            <p className="text-lg font-semibold font-mono">{fmtMoney(totalEst)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Real total</p>
            <p className="text-lg font-semibold font-mono">{fmtMoney(totalReal)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Varianza</p>
            <p className={`text-lg font-semibold font-mono ${delta > 0 ? 'text-status-danger' : 'text-status-success'}`}>
              {delta >= 0 ? '+' : ''}{fmtMoney(delta)} ({deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%)
            </p>
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Gasto</th>
              <th className="text-right">Estimado</th>
              <th className="text-right">Real</th>
              <th className="text-right">Varianza</th>
            </tr>
          </thead>
          <tbody>
            {periods.map(p => {
              const est  = parseFloat(p.estimated_amount) || 0
              const real = parseFloat(reals[p.id]) || 0
              const diff = real - est
              return (
                <tr key={p.id}>
                  <td className="text-sm">{p.item_name || p.overhead_item_id}</td>
                  <td className="text-right font-mono text-sm text-ink-muted">{fmtMoney(est)}</td>
                  <td className="text-right font-mono text-sm">{fmtMoney(real)}</td>
                  <td className={`text-right font-mono text-sm ${Math.abs(diff) > est * 0.1 ? 'text-status-warning font-semibold' : ''}`}>
                    {diff >= 0 ? '+' : ''}{fmtMoney(diff)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack} disabled={isPending} className="btn-ghost btn-sm">← Volver</button>
        <button onClick={onConfirm} disabled={isPending} className="btn-primary">
          {isPending ? <Spinner className="w-3 h-3" /> : null}
          Confirmar cierre de mes
        </button>
      </div>
    </div>
  )
}

// Paso 4: resultado
function StepResult({ result, year, month, onGoReport }) {
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

  return (
    <div className="flex flex-col gap-6 items-center text-center py-6">
      <div className="w-16 h-16 rounded-full bg-status-success/15 flex items-center justify-center">
        <svg className="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <div>
        <h3 className="text-base font-semibold text-ink-primary">Cierre completado</h3>
        <p className="text-sm text-ink-muted mt-1">
          {MONTHS[month-1]} {year} — {result?.periodsFinalized ?? '?'} período(s) finalizados,{' '}
          {result?.shiftsRecosted ?? '?'} turno(s) recosteados.
        </p>
      </div>
      <button onClick={onGoReport} className="btn-primary">
        Ver reporte de varianza →
      </button>
    </div>
  )
}

export default function CierreDeMes() {
  const navigate = useNavigate()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('overhead', 'update')

  const now = new Date()
  const [step, setStep] = useState(1)
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [reals, setReals] = useState({})
  const [closeResult, setCloseResult] = useState(null)
  const [closeError, setCloseError] = useState(null)

  const periodsQuery = useQuery({
    queryKey: ['overhead-periods-close', year, month],
    queryFn:  () => overheadApi.listPeriods({ year, month, includeFinalized: false }),
    enabled: step >= 2,
  })

  const closeMut = useMutation({
    mutationFn: () => overheadApi.closeMonth({
      year, month,
      reals: (periodsQuery.data || []).map(p => ({
        periodId:   p.id,
        realAmount: parseFloat(reals[p.id]) || 0,
      })),
    }),
    onSuccess: (data) => {
      setCloseResult(data)
      setStep(4)
    },
    onError: (err) => setCloseError(err.response?.data?.error || err.message),
  })

  const STEP_LABELS = ['Seleccionar mes', 'Capturar reales', 'Confirmar', 'Resultado']

  if (!canManage) {
    return (
      <div className="page-enter flex flex-col gap-6">
        <div className="page-header">
          <h1 className="page-title">Cierre de mes</h1>
        </div>
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin permisos</p>
          <p className="text-sm text-ink-muted mt-1">Necesitas permiso overhead:update para ejecutar el cierre.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cierre de mes</h1>
          <p className="page-subtitle">Captura los montos reales y recostea las órdenes del período</p>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-0">
        {STEP_LABELS.map((label, i) => {
          const num = i + 1
          const active   = step === num
          const done     = step > num
          return (
            <div key={num} className="flex items-center">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                ${active ? 'bg-brand-600 text-white' : done ? 'text-status-success' : 'text-ink-muted'}`}>
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold
                  ${active ? 'bg-white/20' : done ? 'bg-status-success/20' : 'bg-surface-elevated'}`}>
                  {done ? '✓' : num}
                </span>
                {label}
              </div>
              {i < STEP_LABELS.length - 1 && (
                <div className="w-6 h-px bg-line-subtle mx-1" />
              )}
            </div>
          )
        })}
      </div>

      {/* Contenido por paso */}
      {step === 1 && (
        <StepSelectMonth
          year={year} month={month}
          setYear={setYear} setMonth={setMonth}
          onNext={() => { setReals({}); setStep(2) }}
        />
      )}
      {step === 2 && (
        <StepEnterReals
          year={year} month={month}
          periods={periodsQuery.data || []}
          reals={reals} setReals={setReals}
          isLoading={periodsQuery.isLoading}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <StepConfirm
          year={year} month={month}
          periods={periodsQuery.data || []}
          reals={reals}
          isPending={closeMut.isPending}
          error={closeError}
          onBack={() => setStep(2)}
          onConfirm={() => { setCloseError(null); closeMut.mutate() }}
        />
      )}
      {step === 4 && (
        <StepResult
          result={closeResult}
          year={year} month={month}
          onGoReport={() => navigate(`/costeo/varianza?year=${year}&month=${month}`)}
        />
      )}
    </div>
  )
}
