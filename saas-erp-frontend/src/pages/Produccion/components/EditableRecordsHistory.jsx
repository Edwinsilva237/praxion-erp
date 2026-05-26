import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const SCRAP_TYPES = [
  { value: 'arranque',    label: 'Arranque' },
  { value: 'operacion',   label: 'Operación' },
  { value: 'contaminada', label: 'Contaminada' },
  { value: 'desecho',     label: 'Desecho' },
]
const INCIDENT_CATS = [
  { value: 'paro_maquina', label: 'Paro de máquina' },
  { value: 'problema_mp',  label: 'Problema de MP' },
  { value: 'cambio_orden', label: 'Cambio de orden' },
  { value: 'calidad',      label: 'Calidad' },
  { value: 'otro',         label: 'Otro' },
]
const DELETE_WINDOW_MIN = 30

// ─────────────────────────────────────────────────────────────────────────────
// Calcula minutos restantes para poder eliminar. ≤ 0 → ya no puede eliminar.
// ─────────────────────────────────────────────────────────────────────────────
function deleteMinutesLeft(createdAtIso) {
  if (!createdAtIso) return 0
  const ageMin = (Date.now() - new Date(createdAtIso).getTime()) / 60000
  return Math.max(0, Math.ceil(DELETE_WINDOW_MIN - ageMin))
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal: historial editable de paquetes / merma / incidencias / MP
// Solo modo OPERADOR DUEÑO + turno activo. Si no aplica, oculta los controles.
// ─────────────────────────────────────────────────────────────────────────────
export default function EditableRecordsHistory({ shift, currentUser, onFeedback }) {
  const [section, setSection] = useState('paquetes')
  const [tick, setTick] = useState(0) // fuerza re-render para que el countdown actualice
  const [editing, setEditing] = useState(null) // { kind, record }

  // Forzar re-render cada 30s para que la ventana de eliminación se actualice
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  if (!shift) return null
  const canEdit = shift.status === 'active' && shift.operator_id === currentUser?.id

  const progress  = shift.progress  || []
  const scrap     = shift.scrap     || []
  const incidents = shift.incidents || []
  const mpLoads   = shift.mpLoads   || []

  const totalRecords = progress.length + scrap.length + incidents.length + mpLoads.length
  if (totalRecords === 0) return null

  const sections = [
    { key: 'paquetes',   label: 'Paquetes',   count: progress.length  },
    { key: 'merma',      label: 'Merma',      count: scrap.length     },
    { key: 'incidencia', label: 'Incidencia', count: incidents.length },
    { key: 'mp',         label: 'MP',         count: mpLoads.length   },
  ]

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
        Registros del turno
      </p>

      {/* Sub-tabs por tipo */}
      <div className="flex bg-surface-elevated/40 border border-line-subtle rounded-lg p-0.5 gap-0.5">
        {sections.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            disabled={s.count === 0}
            className={clsx(
              'flex-1 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-30',
              section === s.key
                ? 'bg-surface-primary text-ink-primary shadow-sm'
                : 'text-ink-muted hover:text-ink-secondary'
            )}>
            {s.label} <span className="text-ink-muted">({s.count})</span>
          </button>
        ))}
      </div>

      <div className="border border-line-subtle rounded-xl overflow-hidden">
        {section === 'paquetes' && (
          <PackageList records={progress} canEdit={canEdit} shiftId={shift.id}
            onEdit={(r) => setEditing({ kind: 'package', record: r })}
            onFeedback={onFeedback} _tick={tick} />
        )}
        {section === 'merma' && (
          <ScrapList records={scrap} canEdit={canEdit} shiftId={shift.id}
            onEdit={(r) => setEditing({ kind: 'scrap', record: r })}
            onFeedback={onFeedback} _tick={tick} />
        )}
        {section === 'incidencia' && (
          <IncidentList records={incidents} canEdit={canEdit} shiftId={shift.id}
            onEdit={(r) => setEditing({ kind: 'incident', record: r })}
            onFeedback={onFeedback} _tick={tick} />
        )}
        {section === 'mp' && (
          <MpList records={mpLoads} canEdit={canEdit} shiftId={shift.id}
            onEdit={(r) => setEditing({ kind: 'mp', record: r })}
            onFeedback={onFeedback} _tick={tick} />
        )}
      </div>

      {editing?.kind === 'package'  && (
        <EditPackageModal  shiftId={shift.id} record={editing.record} onClose={() => setEditing(null)} onFeedback={onFeedback} />
      )}
      {editing?.kind === 'scrap'    && (
        <EditScrapModal    shiftId={shift.id} record={editing.record} onClose={() => setEditing(null)} onFeedback={onFeedback} />
      )}
      {editing?.kind === 'incident' && (
        <EditIncidentModal shiftId={shift.id} record={editing.record} onClose={() => setEditing(null)} onFeedback={onFeedback} />
      )}
      {editing?.kind === 'mp'       && (
        <EditMpModal       shiftId={shift.id} record={editing.record} onClose={() => setEditing(null)} onFeedback={onFeedback} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Action buttons (Editar / Eliminar) — reutilizado en las 4 listas
// ─────────────────────────────────────────────────────────────────────────────
function RowActions({ canEdit, createdAtIso, onEdit, onDelete, isDeleting }) {
  if (!canEdit) return null
  const minLeft = deleteMinutesLeft(createdAtIso)
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button onClick={onEdit} title="Editar"
        className="text-[10px] text-ink-muted hover:text-brand-300 px-1.5 py-0.5 rounded hover:bg-surface-elevated/40">
        ✎
      </button>
      {minLeft > 0 ? (
        <button onClick={onDelete} disabled={isDeleting}
          title={`Eliminar (${minLeft} min restantes)`}
          className="text-[10px] text-ink-muted hover:text-status-danger px-1.5 py-0.5 rounded hover:bg-status-danger/10 disabled:opacity-40">
          {isDeleting ? <Spinner className="w-3 h-3" /> : '✕'}
        </button>
      ) : (
        <span title="Ventana de 30 min vencida" className="text-[10px] text-ink-muted px-1.5">—</span>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Listas por tipo
// ─────────────────────────────────────────────────────────────────────────────
function PackageList({ records, canEdit, shiftId, onEdit, onFeedback }) {
  const qc = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)
  const del = useMutation({
    mutationFn: (id) => productionApi.deletePackage(shiftId, id),
    onMutate: (id) => setDeletingId(id),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      qc.invalidateQueries({ queryKey: ['production-queue-capture'] })
      onFeedback?.('ok', 'Paquete eliminado.')
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo eliminar.'),
  })
  const list = [...records].reverse()
  return (
    <>
      {list.map((p, i) => (
        <div key={p.id} className={clsx(
          'flex items-center gap-3 px-3 py-2.5',
          i > 0 && 'border-t border-line-subtle',
          p.is_second_quality && 'bg-status-warning/10/60'
        )}>
          <span className="text-xs font-mono text-ink-muted w-8 shrink-0">#{p.microlot_number}</span>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-ink-primary truncate">{p.product_name || '—'}</p>
            <p className="text-[10px] text-ink-muted">{fmtTime(p.captured_at)}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {p.is_second_quality && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-status-warning/15 text-status-warning">Cal.2</span>
            )}
            <span className="text-sm font-bold text-ink-secondary font-mono tabular-nums">
              {parseFloat(p.real_weight_kg || 0).toFixed(3)} kg
            </span>
          </div>
          <RowActions canEdit={canEdit} createdAtIso={p.captured_at}
            onEdit={() => onEdit(p)}
            onDelete={() => { if (confirm('¿Eliminar este paquete?')) del.mutate(p.id) }}
            isDeleting={deletingId === p.id} />
        </div>
      ))}
    </>
  )
}

function ScrapList({ records, canEdit, shiftId, onEdit, onFeedback }) {
  const qc = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)
  const del = useMutation({
    mutationFn: (id) => productionApi.deleteScrap(shiftId, id),
    onMutate: (id) => setDeletingId(id),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Merma eliminada.')
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo eliminar.'),
  })
  const list = [...records].reverse()
  return (
    <>
      {list.map((s, i) => {
        const typeLabel = SCRAP_TYPES.find(t => t.value === s.scrap_type)?.label || s.scrap_type
        return (
          <div key={s.id} className={clsx('flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-line-subtle')}>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink-primary truncate">{typeLabel}</p>
              <p className="text-[10px] text-ink-muted">{fmtTime(s.captured_at)}</p>
            </div>
            <span className="text-sm font-bold text-ink-secondary font-mono tabular-nums shrink-0">
              {parseFloat(s.kg || 0).toFixed(3)} kg
            </span>
            <RowActions canEdit={canEdit} createdAtIso={s.captured_at}
              onEdit={() => onEdit(s)}
              onDelete={() => { if (confirm('¿Eliminar este registro de merma?')) del.mutate(s.id) }}
              isDeleting={deletingId === s.id} />
          </div>
        )
      })}
    </>
  )
}

function IncidentList({ records, canEdit, shiftId, onEdit, onFeedback }) {
  const qc = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)
  const del = useMutation({
    mutationFn: (id) => productionApi.deleteIncident(shiftId, id),
    onMutate: (id) => setDeletingId(id),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Incidencia eliminada.')
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo eliminar.'),
  })
  const list = [...records].reverse()
  return (
    <>
      {list.map((inc, i) => {
        const catLabel = INCIDENT_CATS.find(c => c.value === inc.category)?.label || inc.category
        return (
          <div key={inc.id} className={clsx('flex items-start gap-3 px-3 py-2.5', i > 0 && 'border-t border-line-subtle')}>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink-primary">
                {catLabel}{inc.duration_min ? ` · ${inc.duration_min} min` : ''}
              </p>
              <p className="text-[11px] text-ink-secondary line-clamp-2">{inc.description}</p>
              <p className="text-[10px] text-ink-muted mt-0.5">{fmtTime(inc.created_at)}</p>
            </div>
            <RowActions canEdit={canEdit} createdAtIso={inc.created_at}
              onEdit={() => onEdit(inc)}
              onDelete={() => { if (confirm('¿Eliminar esta incidencia?')) del.mutate(inc.id) }}
              isDeleting={deletingId === inc.id} />
          </div>
        )
      })}
    </>
  )
}

function MpList({ records, canEdit, shiftId, onEdit, onFeedback }) {
  const qc = useQueryClient()
  const [deletingId, setDeletingId] = useState(null)
  const del = useMutation({
    mutationFn: (id) => productionApi.deleteMpLoad(shiftId, id),
    onMutate: (id) => setDeletingId(id),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Carga de MP eliminada.')
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo eliminar.'),
  })
  const list = [...records].reverse()
  return (
    <>
      {list.map((mp, i) => (
        <div key={mp.id} className={clsx('flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-line-subtle')}>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-ink-primary truncate">{mp.material_name}</p>
            <p className="text-[10px] text-ink-muted">
              {fmtTime(mp.loaded_at)}{mp.is_replacement ? ' · reposición' : ''}
            </p>
          </div>
          <span className="text-sm font-bold text-ink-secondary font-mono tabular-nums shrink-0">
            {parseFloat(mp.kg || 0).toFixed(3)} kg
          </span>
          <RowActions canEdit={canEdit} createdAtIso={mp.loaded_at}
            onEdit={() => onEdit(mp)}
            onDelete={() => { if (confirm('¿Eliminar esta carga de MP?')) del.mutate(mp.id) }}
            isDeleting={deletingId === mp.id} />
        </div>
      ))}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modales de edición
// ─────────────────────────────────────────────────────────────────────────────
function ModalShell({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-sm p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">{title}</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function EditPackageModal({ shiftId, record, onClose, onFeedback }) {
  const qc = useQueryClient()
  const [weight, setWeight] = useState(String(record.real_weight_kg || ''))
  const [isSecondQ, setIsSecondQ] = useState(!!record.is_second_quality)
  const [notes, setNotes] = useState(record.notes || '')
  const m = useMutation({
    mutationFn: () => productionApi.editPackage(shiftId, record.id, {
      realWeightKg: parseFloat(weight),
      isSecondQuality: isSecondQ,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      qc.invalidateQueries({ queryKey: ['production-queue-capture'] })
      onFeedback?.('ok', 'Paquete actualizado.')
      onClose()
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo actualizar.'),
  })
  return (
    <ModalShell title={`Editar paquete #${record.microlot_number}`} onClose={onClose}>
      <div>
        <label className="label">Peso (kg)</label>
        <input type="number" step="0.001" min="0.001" value={weight}
          onChange={(e) => setWeight(e.target.value)}
          className="input text-lg h-12 text-center font-bold" />
      </div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={isSecondQ}
          onChange={(e) => setIsSecondQ(e.target.checked)}
          className="w-5 h-5 accent-amber-500" />
        <span className="text-sm text-ink-secondary">Segunda calidad</span>
      </label>
      <div>
        <label className="label">Notas</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          rows={2} className="input h-auto py-2 resize-none" />
      </div>
      <button onClick={() => m.mutate()} disabled={m.isPending || !weight || parseFloat(weight) <= 0}
        className="btn-primary w-full h-12 justify-center">
        {m.isPending ? <Spinner className="w-4 h-4" /> : 'Guardar'}
      </button>
    </ModalShell>
  )
}

function EditScrapModal({ shiftId, record, onClose, onFeedback }) {
  const qc = useQueryClient()
  const [kg, setKg] = useState(String(record.kg || ''))
  const [scrapType, setScrapType] = useState(record.scrap_type)
  const [notes, setNotes] = useState(record.notes || '')
  const m = useMutation({
    mutationFn: () => productionApi.editScrap(shiftId, record.id, {
      kg: parseFloat(kg),
      scrapType,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Merma actualizada.')
      onClose()
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo actualizar.'),
  })
  return (
    <ModalShell title="Editar merma" onClose={onClose}>
      <div>
        <label className="label">Tipo</label>
        <div className="grid grid-cols-2 gap-2">
          {SCRAP_TYPES.map(t => (
            <button key={t.value} type="button" onClick={() => setScrapType(t.value)}
              className={clsx(
                'py-2 px-3 rounded-lg text-xs border transition-colors',
                scrapType === t.value ? 'bg-brand-500/10 border-brand-500/40 text-brand-300' : 'bg-surface-primary border-line-subtle text-ink-secondary'
              )}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="label">Kilogramos</label>
        <input type="number" step="0.001" min="0.001" value={kg}
          onChange={(e) => setKg(e.target.value)}
          className="input text-lg h-12 text-center font-bold" />
      </div>
      <div>
        <label className="label">Notas</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          rows={2} className="input h-auto py-2 resize-none" />
      </div>
      <button onClick={() => m.mutate()} disabled={m.isPending || !kg || parseFloat(kg) <= 0}
        className="btn-primary w-full h-12 justify-center">
        {m.isPending ? <Spinner className="w-4 h-4" /> : 'Guardar'}
      </button>
    </ModalShell>
  )
}

function EditIncidentModal({ shiftId, record, onClose, onFeedback }) {
  const qc = useQueryClient()
  const [category, setCategory] = useState(record.category)
  const [description, setDescription] = useState(record.description || '')
  const [durationMin, setDurationMin] = useState(record.duration_min != null ? String(record.duration_min) : '')
  const m = useMutation({
    mutationFn: () => productionApi.editIncident(shiftId, record.id, {
      category,
      description,
      durationMin: durationMin ? parseInt(durationMin) : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Incidencia actualizada.')
      onClose()
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo actualizar.'),
  })
  return (
    <ModalShell title="Editar incidencia" onClose={onClose}>
      <div>
        <label className="label">Categoría</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="select w-full">
          {INCIDENT_CATS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div>
        <label className="label">Descripción</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)}
          rows={3} className="input h-auto py-2 resize-none" />
      </div>
      <div>
        <label className="label">Duración (min)</label>
        <input type="number" min="1" value={durationMin}
          onChange={(e) => setDurationMin(e.target.value)} className="input" />
      </div>
      <button onClick={() => m.mutate()} disabled={m.isPending || !description.trim()}
        className="btn-primary w-full h-12 justify-center">
        {m.isPending ? <Spinner className="w-4 h-4" /> : 'Guardar'}
      </button>
    </ModalShell>
  )
}

function EditMpModal({ shiftId, record, onClose, onFeedback }) {
  const qc = useQueryClient()
  const [kg, setKg] = useState(String(record.kg || ''))
  const [isReplacement, setIsReplacement] = useState(!!record.is_replacement)
  const [notes, setNotes] = useState(record.notes || '')
  const m = useMutation({
    mutationFn: () => productionApi.editMpLoad(shiftId, record.id, {
      kg: parseFloat(kg),
      isReplacement,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-detail', shiftId] })
      onFeedback?.('ok', 'Carga de MP actualizada.')
      onClose()
    },
    onError: (e) => onFeedback?.('error', e.response?.data?.error || 'No se pudo actualizar.'),
  })
  return (
    <ModalShell title={`Editar carga · ${record.material_name}`} onClose={onClose}>
      <div>
        <label className="label">Kilogramos</label>
        <input type="number" step="0.001" min="0.001" value={kg}
          onChange={(e) => setKg(e.target.value)}
          className="input text-lg h-12 text-center font-bold" />
      </div>
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" checked={isReplacement}
          onChange={(e) => setIsReplacement(e.target.checked)}
          className="w-5 h-5 accent-brand-500" />
        <span className="text-sm text-ink-secondary">Es reposición</span>
      </label>
      <div>
        <label className="label">Notas</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          rows={2} className="input h-auto py-2 resize-none" />
      </div>
      <button onClick={() => m.mutate()} disabled={m.isPending || !kg || parseFloat(kg) <= 0}
        className="btn-primary w-full h-12 justify-center">
        {m.isPending ? <Spinner className="w-4 h-4" /> : 'Guardar'}
      </button>
    </ModalShell>
  )
}
