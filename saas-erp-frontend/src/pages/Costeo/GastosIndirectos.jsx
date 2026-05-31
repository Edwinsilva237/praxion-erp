import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { overheadApi } from '@/api/overhead'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import HelpTip from '@/components/ui/HelpTip'
import { ORDEN_HELP } from '@/pages/SuperAdmin/tenant-process/helpTexts'
import useAuthStore from '@/store/useAuthStore'
import clsx from 'clsx'

const BASE_LABELS = {
  shifts: 'Por turno',
  hours:  'Por horas',
  units:  'Por unidades',
  weight: 'Por kg',
  equal:  'Partes iguales',
}
const FREQ_LABELS = {
  weekly:    'Semanal',
  biweekly:  'Quincenal',
  monthly:   'Mensual',
  annual:    'Anual',
  event:     'Por evento',
}

const HELP_BASE = {
  title: '¿Qué base elijo?',
  body: 'La base define cómo se reparte el costo entre los turnos del período.',
  examples: [
    { label: 'Partes iguales / por turno', value: 'Renta, nómina admin (no depende del volumen)' },
    { label: 'Por horas',     value: 'Sueldos de planta, mantenimiento' },
    { label: 'Por kg',        value: 'Energía eléctrica, agua' },
    { label: 'Por unidades',  value: 'Empaque, consumibles' },
  ],
}
const HELP_FREQ = {
  title: '¿Cuándo elegir cada frecuencia?',
  body: 'Determina cada cuánto vas a capturar el monto real.',
  examples: [
    { label: 'Semanal',    value: 'Raya semanal (nómina cada 7 días), consumibles' },
    { label: 'Quincenal',  value: 'Nómina pagada cada 15 días' },
    { label: 'Mensual',    value: 'Renta, luz, sueldos (lo más común)' },
    { label: 'Anual',      value: 'Predial, seguro, licencias' },
    { label: 'Por evento', value: 'Reparación grande, gasto esporádico' },
  ],
}
const HELP_CODIGO = {
  title: 'Código',
  body: 'Identificador corto en minúsculas y sin espacios. Sirve para referirse al gasto en reportes (no cambia después de crear).',
  examples: [
    { label: 'Bueno',  value: 'renta, energia_electrica, mantenimiento' },
    { label: 'Evitar', value: '"Renta del local 2026" (muy largo)' },
  ],
}
const HELP_ESTIMADO = {
  title: 'Monto estimado por período',
  body: 'Aproximadamente cuánto vas a gastar en este rubro durante un período típico. Se usa como valor por defecto al generar el período del mes. Después puedes ajustarlo en "Períodos del mes" sin recapturarlo aquí.',
}

const EMPTY = {
  code: '', name: '', allocation_base: 'shifts', capture_frequency: 'monthly',
  default_estimated_amount: 0, default_expected_basis_divisor: null, sort_order: 0, notes: '',
}

// Unidad de la base de prorrateo, para la pregunta de "esperados al mes".
const BASIS_UNIT = { shifts: 'turnos', hours: 'horas', units: 'unidades', weight: 'kg', equal: 'turnos' }

function ItemModal({ item, onClose, onSaved }) {
  const isNew = !item?.id
  const [form, setForm] = useState(() => isNew ? { ...EMPTY } : {
    code: item.code, name: item.name,
    allocation_base: item.allocation_base,
    capture_frequency: item.capture_frequency,
    default_estimated_amount: item.default_estimated_amount ?? 0,
    default_expected_basis_divisor: item.default_expected_basis_divisor ?? null,
    sort_order: item.sort_order ?? 0,
    notes: item.notes ?? '',
  })
  const [error, setError] = useState(null)

  const mut = useMutation({
    mutationFn: isNew
      ? () => overheadApi.createItem(form)
      : () => overheadApi.updateItem(item.id, form),
    onSuccess: () => onSaved(),
    onError:   (err) => setError(err.response?.data?.error || err.message),
  })

  const set = (f, v) => setForm(p => ({ ...p, [f]: v }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-bg-primary/80 backdrop-blur-sm">
      <div className="bg-surface-primary rounded-2xl shadow-xl w-full max-w-lg border border-line-subtle">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-subtle">
          <h3 className="text-sm font-semibold text-ink-primary">
            {isNew ? 'Nuevo gasto indirecto' : `Editar · ${item.name}`}
          </h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {error && <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-sm text-status-danger">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Código
                <HelpTip {...HELP_CODIGO} />
              </label>
              <input className="input" placeholder="ej: renta" value={form.code} onChange={e => set('code', e.target.value)} disabled={!isNew} />
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Orden
                <HelpTip {...ORDEN_HELP} />
              </label>
              <input type="number" min={0} className="input" value={form.sort_order} onChange={e => set('sort_order', parseInt(e.target.value) || 0)} />
            </div>
          </div>

          <div>
            <label className="label">Nombre</label>
            <input className="input" placeholder="ej: Renta del local" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1">
                Base de prorrateo
                <HelpTip {...HELP_BASE} />
              </label>
              <select className="select" value={form.allocation_base} onChange={e => set('allocation_base', e.target.value)}>
                {Object.entries(BASE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="label flex items-center gap-1">
                Frecuencia
                <HelpTip {...HELP_FREQ} />
              </label>
              <select className="select" value={form.capture_frequency} onChange={e => set('capture_frequency', e.target.value)}>
                {Object.entries(FREQ_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label flex items-center gap-1">
              Monto estimado por período (MXN)
              <HelpTip {...HELP_ESTIMADO} />
            </label>
            <input
              type="number" min={0} step="0.01"
              className="input"
              value={form.default_estimated_amount}
              onChange={e => set('default_estimated_amount', parseFloat(e.target.value) || 0)}
            />
            <p className="text-xs text-ink-muted mt-1">Se usará como valor por defecto al crear el período del mes. Lo podrás ajustar después.</p>
          </div>

          <div>
            <label className="label">
              ¿Cuántos {BASIS_UNIT[form.allocation_base] || 'turnos'} esperas al mes? <span className="text-ink-muted font-normal">(opcional)</span>
            </label>
            <input
              type="number" min={0} step="0.01"
              className="input"
              placeholder={`Ej. 60 ${BASIS_UNIT[form.allocation_base] || 'turnos'}`}
              value={form.default_expected_basis_divisor ?? ''}
              onChange={e => {
                const n = parseFloat(e.target.value)
                set('default_expected_basis_divisor', e.target.value === '' || isNaN(n) ? null : n)
              }}
            />
            <p className="text-xs text-ink-muted mt-1">
              Reparte el estimado durante el mes: cada {BASIS_UNIT[form.allocation_base] === 'turnos' ? 'turno' : (BASIS_UNIT[form.allocation_base] || 'turno')} carga
              <strong> monto ÷ esperados</strong>. Si lo dejas vacío, cada turno cargará el monto completo hasta el cierre de mes.
            </p>
          </div>

          <div>
            <label className="label">Notas (opcional)</label>
            <textarea className="input min-h-16 resize-y" placeholder="Descripción interna..." value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line-subtle">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending || !form.code || !form.name} className="btn-primary btn-sm">
            {mut.isPending ? <Spinner className="w-3 h-3" /> : null}
            {isNew ? 'Crear' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function GastosIndirectos() {
  const qc = useQueryClient()
  const can = useAuthStore(s => s.can)
  const permissions = useAuthStore(s => s.permissions)
  const isSuperAdmin = permissions?.includes?.('*')
  const canManage = isSuperAdmin || can?.('overhead', 'update')

  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [serverError, setServerError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['overhead-items', showInactive],
    queryFn:  () => overheadApi.listItems({ includeInactive: showInactive || undefined }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }) => overheadApi.updateItem(id, { is_active: isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['overhead-items'] })
      setSuccessMsg('Actualizado.')
      setTimeout(() => setSuccessMsg(null), 2500)
    },
    onError: (err) => setServerError(err.response?.data?.error || err.message),
  })

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['overhead-items'] })
    setEditing(null)
    setSuccessMsg('Guardado.')
    setTimeout(() => setSuccessMsg(null), 2500)
  }

  const fmtMoney = (n) => n == null ? '—' : `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Gastos indirectos</h1>
          <p className="page-subtitle">Catálogo de costos fijos a prorratear entre turnos</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing('new')} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nuevo gasto
          </button>
        )}
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-xl px-4 py-3 text-sm text-status-info">
        <p className="font-medium mb-1">¿Qué es esto?</p>
        <p className="leading-relaxed">
          Catálogo de tus <strong>gastos fijos</strong> (renta, luz, sueldos administrativos…). Cada gasto genera un
          renglón por mes en "Períodos del mes". Al cerrar el mes capturas los montos reales y el sistema recostea
          automáticamente cada orden producida.
        </p>
        <p className="leading-relaxed mt-1">
          <Link to="/costeo" className="underline hover:no-underline">Ver el flujo completo →</Link>
        </p>
      </div>

      {successMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 text-sm text-status-success flex items-center justify-between">
          <span>{successMsg}</span><button onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}
      {serverError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-sm text-status-danger flex items-center justify-between">
          <span>{serverError}</span><button onClick={() => setServerError(null)}>✕</button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink-secondary cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="w-4 h-4 accent-brand-600" />
          Mostrar inactivos
        </label>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin gastos indirectos configurados</p>
          <p className="text-sm text-ink-muted mt-1 max-w-md mx-auto">
            Agrega los gastos fijos que quieres prorratear entre turnos: renta, energía eléctrica, sueldos, etc.
          </p>
          {canManage && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <Link to="/costeo" className="btn-primary btn-sm">Usar asistente guiado</Link>
              <span className="text-xs text-ink-muted">o</span>
              <button onClick={() => setEditing('new')} className="btn-ghost btn-sm">Crear uno manualmente</button>
            </div>
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Código</th>
                <th>Prorrateo</th>
                <th>Frecuencia</th>
                <th className="text-right">Estimado/período</th>
                <th>Estado</th>
                {canManage && <th className="w-16"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className={clsx(!item.is_active && 'opacity-50')}>
                  <td>
                    <p className="font-medium text-sm">{item.name}</p>
                    {item.notes && <p className="text-xs text-ink-muted truncate max-w-xs">{item.notes}</p>}
                  </td>
                  <td className="font-mono text-xs text-ink-secondary">{item.code}</td>
                  <td className="text-sm text-ink-secondary">{BASE_LABELS[item.allocation_base] || item.allocation_base}</td>
                  <td>
                    <Badge
                      variant={item.capture_frequency === 'event' ? 'amber' : 'blue'}
                      label={FREQ_LABELS[item.capture_frequency] || item.capture_frequency}
                    />
                  </td>
                  <td className="text-right font-mono text-sm">{fmtMoney(item.default_estimated_amount)}</td>
                  <td><Badge variant={item.is_active ? 'green' : 'gray'} label={item.is_active ? 'Activo' : 'Inactivo'} /></td>
                  {canManage && (
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setEditing(item)} className="btn-ghost btn-icon text-ink-muted">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => toggleMut.mutate({ id: item.id, isActive: !item.is_active })}
                          className={clsx('btn-ghost btn-icon', item.is_active ? 'text-status-warning' : 'text-status-success')}
                        >
                          {item.is_active
                            ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                            : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                          }
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ItemModal item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={handleSaved} />
      )}
    </div>
  )
}
