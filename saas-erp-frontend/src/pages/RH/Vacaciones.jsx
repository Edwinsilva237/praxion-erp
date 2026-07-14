import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { hrApi } from '@/api/hr'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

function fmtDate(ymd) {
  if (!ymd) return '—'
  const [y, m, d] = ymd.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}
const nDays = (n) => `${Number(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })}`
const money = (n) => n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`

const STATUS_META = {
  open:      { label: 'Vigente',   cls: 'bg-status-success/15 text-status-success' },
  exhausted: { label: 'Agotado',   cls: 'bg-ink-muted/15 text-ink-muted' },
  expired:   { label: 'Prescrito', cls: 'bg-status-danger/15 text-status-danger' },
  closed:    { label: 'Cerrado',   cls: 'bg-ink-muted/15 text-ink-muted' },
}
const ENTRY_LABELS = { taken: 'Días gozados', paid: 'Pagados sin gozar', adjustment: 'Ajuste' }

export default function Vacaciones() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // {type:'taken'|'adjustment', period} | {type:'rules'}

  function flash(t) { setMsg(t); setTimeout(() => setMsg(null), 3500) }

  const { data: employees = [] } = useQuery({
    queryKey: ['hr-employees', 'selector'],
    queryFn:  () => hrApi.listEmployees({ includeInactive: '1' }),
  })

  const { data: balance, isLoading } = useQuery({
    queryKey: ['hr-vacations', id],
    queryFn:  () => hrApi.getVacations(id),
    enabled:  !!id,
  })
  const { data: ledger = [] } = useQuery({
    queryKey: ['hr-ledger', id],
    queryFn:  () => hrApi.getLedger(id),
    enabled:  !!id,
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['hr-vacations', id] })
    qc.invalidateQueries({ queryKey: ['hr-ledger', id] })
  }

  const regenerate = useMutation({
    mutationFn: () => hrApi.generatePeriods(id),
    onSuccess: (r) => { invalidate(); flash(`Periodos actualizados (${r.created} nuevos).`) },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })
  const deleteEntry = useMutation({
    mutationFn: (entryId) => hrApi.deleteEntry(id, entryId),
    onSuccess: () => { invalidate(); flash('Movimiento eliminado.') },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  const s = balance?.summary

  return (
    <div className="page-enter max-w-6xl mx-auto py-6 px-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Recursos Humanos · Vacaciones</h1>
          <p className="text-sm text-ink-muted mt-1">
            Periodos vacacionales por antigüedad (LFT reforma 2023). Cada aniversario genera un periodo con sus días;
            el disfrute prescribe 18 meses después.
          </p>
        </div>
        <Can do="hr:manage">
          <button onClick={() => setModal({ type: 'rules' })} className="btn-secondary">
            Tabla de días (LFT)
          </button>
        </Can>
      </div>

      {msg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <p className="text-sm text-status-success">{msg}</p>
        </div>
      )}
      {error && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 flex items-center justify-between">
          <p className="text-sm text-status-danger">{error}</p>
          <button onClick={() => setError(null)} className="text-status-danger">×</button>
        </div>
      )}

      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <label className="text-sm text-ink-secondary">Empleado:</label>
        <select className="select max-w-sm" value={id || ''}
          onChange={e => navigate(e.target.value ? `/rh/vacaciones/${e.target.value}` : '/rh/vacaciones')}>
          <option value="">— Selecciona un empleado —</option>
          {employees.map(e => (
            <option key={e.id} value={e.id}>
              {e.full_name} · {e.employee_number}{e.status !== 'active' ? ' (baja)' : ''}
            </option>
          ))}
        </select>
        {id && (
          <Can do="hr:manage">
            <button onClick={() => regenerate.mutate()} className="btn-ghost btn-sm ml-auto"
              disabled={regenerate.isPending}>
              {regenerate.isPending ? <Spinner size="sm" /> : 'Recalcular periodos'}
            </button>
          </Can>
        )}
      </div>

      {!id ? (
        <div className="card py-16 text-center">
          <p className="text-sm text-ink-muted">Selecciona un empleado para ver sus periodos vacacionales.</p>
        </div>
      ) : isLoading ? (
        <div className="card flex justify-center py-16"><Spinner /></div>
      ) : !balance ? null : (
        <>
          {/* Resumen */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Antigüedad" value={`${balance.years_of_service} año(s)`} />
            <StatCard label="Días pendientes" value={nDays(s.total_pending)} accent="success" />
            <StatCard label="Días prescritos" value={nDays(s.total_expired)} accent={s.total_expired > 0 ? 'danger' : undefined} />
            <StatCard label="Prima vacacional acum." value={money(balance.employee.daily_salary == null ? null : s.total_prima)} />
          </div>

          {/* Periodos */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-subtle">
              <h2 className="text-sm font-semibold text-ink-primary">Periodos vacacionales</h2>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Año</th>
                    <th>Periodo de servicio</th>
                    <th className="text-right">Derecho</th>
                    <th className="text-right">Gozados</th>
                    <th className="text-right">Ajuste</th>
                    <th className="text-right">Pendiente</th>
                    <th className="text-right">Prima</th>
                    <th>Prescribe</th>
                    <th>Estado</th>
                    <th className="text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {balance.periods.map(p => {
                    const st = STATUS_META[p.status] || STATUS_META.open
                    const canUse = p.status === 'open'
                    return (
                      <tr key={p.id}>
                        <td className="font-semibold text-ink-primary">{p.period_number}</td>
                        <td className="text-xs text-ink-secondary">{fmtDate(p.period_start)} → {fmtDate(p.period_end)}</td>
                        <td className="text-right tabular-nums">{nDays(p.days_entitled)}</td>
                        <td className="text-right tabular-nums text-ink-secondary">{nDays(p.taken + p.paid)}</td>
                        <td className="text-right tabular-nums text-ink-secondary">
                          {p.adjustment ? (p.adjustment > 0 ? `+${nDays(p.adjustment)}` : nDays(p.adjustment)) : '—'}
                        </td>
                        <td className="text-right tabular-nums font-semibold text-ink-primary">{nDays(p.pending)}</td>
                        <td className="text-right tabular-nums text-ink-secondary">{money(p.prima_vacacional)}</td>
                        <td className="text-xs text-ink-secondary">{fmtDate(p.expires_at)}</td>
                        <td><span className={clsx('text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full', st.cls)}>{st.label}</span></td>
                        <td className="text-right whitespace-nowrap">
                          <Can do="hr:manage">
                            <button className="btn-ghost btn-sm" disabled={!canUse}
                              onClick={() => setModal({ type: 'taken', period: p })}>Registrar días</button>
                            <button className="btn-ghost btn-sm"
                              onClick={() => setModal({ type: 'adjustment', period: p })}>Ajuste</button>
                          </Can>
                        </td>
                      </tr>
                    )
                  })}
                  {balance.periods.length === 0 && (
                    <tr><td colSpan={10} className="text-center text-sm text-ink-muted py-8">
                      Este empleado aún no cumple su primer año de servicio.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bitácora */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line-subtle">
              <h2 className="text-sm font-semibold text-ink-primary">Movimientos</h2>
            </div>
            {ledger.length === 0 ? (
              <p className="text-sm text-ink-muted text-center py-8">Sin movimientos registrados.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Periodo</th><th>Tipo</th><th className="text-right">Días</th>
                      <th>Fechas</th><th>Nota</th><th>Capturó</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map(l => (
                      <tr key={l.id}>
                        <td className="text-xs text-ink-secondary">{new Date(l.created_at).toLocaleDateString('es-MX')}</td>
                        <td className="text-center">{l.period_number}</td>
                        <td className="text-xs">{ENTRY_LABELS[l.entry_type] || l.entry_type}</td>
                        <td className={clsx('text-right tabular-nums font-medium',
                          l.entry_type === 'adjustment' && l.days > 0 ? 'text-status-success' : 'text-ink-primary')}>
                          {l.entry_type === 'adjustment' && l.days > 0 ? `+${nDays(l.days)}` : nDays(l.days)}
                        </td>
                        <td className="text-xs text-ink-secondary">
                          {l.start_date ? `${fmtDate(l.start_date)}${l.end_date ? ' → ' + fmtDate(l.end_date) : ''}` : '—'}
                        </td>
                        <td className="text-xs text-ink-secondary max-w-[16rem] truncate">{l.note || '—'}</td>
                        <td className="text-xs text-ink-muted">{l.created_by_name || '—'}</td>
                        <td className="text-right">
                          <Can do="hr:manage">
                            <button className="btn-ghost btn-sm text-status-danger"
                              onClick={() => { if (confirm('¿Eliminar este movimiento?')) deleteEntry.mutate(l.id) }}>×</button>
                          </Can>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {modal?.type === 'taken' && (
        <LedgerModal employeeId={id} period={modal.period} kind="taken"
          onClose={() => setModal(null)}
          onSaved={() => { invalidate(); setModal(null); flash('Días registrados.') }} />
      )}
      {modal?.type === 'adjustment' && (
        <LedgerModal employeeId={id} period={modal.period} kind="adjustment"
          onClose={() => setModal(null)}
          onSaved={() => { invalidate(); setModal(null); flash('Ajuste aplicado.') }} />
      )}
      {modal?.type === 'rules' && (
        <RulesModal onClose={() => setModal(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['hr-vacations'] }); setModal(null); flash('Tabla de días actualizada.') }} />
      )}
    </div>
  )
}

function StatCard({ label, value, accent }) {
  const accentCls = accent === 'success' ? 'text-status-success'
    : accent === 'danger' ? 'text-status-danger' : 'text-ink-primary'
  return (
    <div className="card p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={clsx('text-lg font-semibold mt-1 tabular-nums', accentCls)}>{value}</p>
    </div>
  )
}

function LedgerModal({ employeeId, period, kind, onClose, onSaved }) {
  const [days, setDays] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const isTaken = kind === 'taken'

  const mutation = useMutation({
    mutationFn: () => {
      const d = Number(days)
      if (isTaken) {
        if (!(d > 0)) throw new Error('Los días deben ser mayores a 0.')
        return hrApi.registerTaken(employeeId, { periodId: period.id, days: d, startDate: startDate || null, endDate: endDate || null, note: note.trim() || null })
      }
      if (!d) throw new Error('El ajuste debe ser distinto de 0.')
      if (!note.trim()) throw new Error('El ajuste requiere una nota.')
      return hrApi.registerAdjustment(employeeId, { periodId: period.id, days: d, note: note.trim() })
    },
    onSuccess: onSaved,
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">
            {isTaken ? 'Registrar días gozados' : 'Ajuste manual'} · Año {period.period_number}
          </h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted">
          Pendiente actual del periodo: <strong className="text-ink-secondary">{nDays(period.pending)} día(s)</strong>.
          {!isTaken && ' Usa positivo para otorgar días y negativo para descontar.'}
        </p>

        <div>
          <label className="label">Días <span className="text-status-danger">*</span></label>
          <input type="number" step={isTaken ? '0.5' : '0.5'} min={isTaken ? '0.5' : undefined}
            className="input" value={days} onChange={e => setDays(e.target.value)}
            placeholder={isTaken ? 'p. ej. 5' : 'p. ej. 2 o -1'} />
        </div>

        {isTaken && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Del</label>
              <input type="date" className="input" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Al</label>
              <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
        )}

        <div>
          <label className="label">Nota {!isTaken && <span className="text-status-danger">*</span>}</label>
          <textarea className="input" rows={2} value={note} onChange={e => setNote(e.target.value)}
            placeholder={isTaken ? 'Opcional' : 'Justifica el ajuste'} />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>Cancelar</button>
          <button type="submit" className="btn-primary flex-1" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

function RulesModal({ onClose, onSaved }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['hr-rules'], queryFn: () => hrApi.getRules() })
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => { if (data?.rules) setRows(data.rules.map(r => ({ ...r }))) }, [data])

  const save = useMutation({
    mutationFn: () => hrApi.updateRules(rows.map(r => ({
      years_from: Number(r.years_from),
      years_to: r.years_to === '' || r.years_to == null ? null : Number(r.years_to),
      days_entitled: Number(r.days_entitled),
    }))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['hr-rules'] }); onSaved() },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })
  const reset = useMutation({
    mutationFn: () => hrApi.resetRules(),
    onSuccess: (d) => { setRows(d.rules.map(r => ({ ...r }))); qc.invalidateQueries({ queryKey: ['hr-rules'] }) },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  function setRow(i, k, v) { setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [k]: v } : r)) }
  function addRow() { setRows(rs => [...rs, { years_from: '', years_to: '', days_entitled: '' }]) }
  function removeRow(i) { setRows(rs => rs.filter((_, idx) => idx !== i)) }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Días de vacaciones por antigüedad</h2>
          <button type="button" onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        <p className="text-xs text-ink-muted">
          {data?.isDefault
            ? 'Usando la tabla LFT 2023 por default. Si tu empresa otorga más días, edítala.'
            : 'Tabla personalizada de tu empresa. Puedes restaurar la tabla LFT 2023.'}
          {' '}Deja "hasta" vacío para un rango abierto (ese año en adelante).
        </p>

        {isLoading ? <div className="flex justify-center py-8"><Spinner /></div> : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs text-ink-muted font-medium px-1">
              <span>Años desde</span><span>Años hasta</span><span>Días</span><span></span>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                <input type="number" min="1" className="input" value={r.years_from ?? ''}
                  onChange={e => setRow(i, 'years_from', e.target.value)} />
                <input type="number" min="1" className="input" value={r.years_to ?? ''}
                  placeholder="abierto" onChange={e => setRow(i, 'years_to', e.target.value)} />
                <input type="number" min="0" className="input" value={r.days_entitled ?? ''}
                  onChange={e => setRow(i, 'days_entitled', e.target.value)} />
                <button type="button" onClick={() => removeRow(i)} className="btn-ghost btn-sm text-status-danger">×</button>
              </div>
            ))}
            <button type="button" onClick={addRow} className="btn-ghost btn-sm self-start">+ Agregar renglón</button>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={() => { if (confirm('¿Restaurar la tabla LFT 2023?')) reset.mutate() }}
            className="btn-ghost btn-sm text-ink-secondary" disabled={reset.isPending}>Restaurar LFT 2023</button>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="btn-secondary" disabled={save.isPending}>Cancelar</button>
          <button type="button" onClick={() => { setError(null); save.mutate() }} className="btn-primary" disabled={save.isPending}>
            {save.isPending ? <Spinner size="sm" /> : 'Guardar tabla'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
