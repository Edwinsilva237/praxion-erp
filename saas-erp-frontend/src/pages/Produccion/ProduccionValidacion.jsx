import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import { processConfigApi } from '@/api/processConfig'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

// Fallback para scrap legacy (cuando scrap_type_id no resuelve al catálogo)
const SCRAP_LEGACY_LABEL = { arranque: 'Arranque', operacion: 'Operación', contaminada: 'Contaminada', desecho: 'Desecho' }
const INCIDENT_LABEL = { paro_maquina: 'Paro máquina', problema_mp: 'Problema MP', cambio_orden: 'Cambio orden', calidad: 'Calidad', otro: 'Otro' }
const INCIDENT_CATEGORIES = [
  { value: 'paro_maquina', label: 'Paro de máquina' },
  { value: 'problema_mp',  label: 'Problema de MP' },
  { value: 'cambio_orden', label: 'Cambio de orden' },
  { value: 'calidad',      label: 'Calidad' },
  { value: 'otro',         label: 'Otro' },
]
const ACTION_LABEL = { update: 'editó', delete: 'eliminó', create: 'agregó' }
const TARGET_LABEL = { shift_progress: 'paquete', shift_scrap: 'merma', shift_incidents: 'incidencia' }

export default function ProduccionValidacion() {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const [selectedId, setSelectedId] = useState(null)
  const [notes, setNotes] = useState('')
  const [editingItem, setEditingItem] = useState(null)
  const [addingType, setAddingType]   = useState(null) // 'package' | 'scrap' | 'incident'

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['shifts-pending'],
    queryFn:  () => productionApi.getActiveShifts(),
    refetchInterval: 15000,
  })

  const pending = shifts.filter(s => s.status === 'pending_handover')

  const { data: detail } = useQuery({
    queryKey: ['shift-detail-val', selectedId],
    queryFn:  () => productionApi.getShift(selectedId),
    enabled:  !!selectedId,
  })

  const { data: corrections = [] } = useQuery({
    queryKey: ['shift-corrections', selectedId],
    queryFn:  () => productionApi.listCorrections(selectedId),
    enabled:  !!selectedId,
  })

  // ── Config multi-tenant ────────────────────────────────────────────────
  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn:  processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesLots = tenantConfig?.uses_lots ?? false

  const { data: scrapTypesRaw } = useQuery({
    queryKey: ['scrap-types-active'],
    queryFn:  () => processConfigApi.listScrapTypes({ isActive: true }),
    staleTime: 60000,
  })
  const scrapTypes = Array.isArray(scrapTypesRaw) ? scrapTypesRaw : (scrapTypesRaw?.data || [])

  const { data: qualityGradesRaw } = useQuery({
    queryKey: ['quality-grades-active'],
    queryFn:  () => processConfigApi.listQualityGrades({ isActive: true }),
    staleTime: 60000,
  })
  const qualityGrades = Array.isArray(qualityGradesRaw) ? qualityGradesRaw : (qualityGradesRaw?.data || [])

  // Resolución de label de scrap: 1) catálogo por id, 2) catálogo por code, 3) legacy enum
  const scrapLabel = (s) => {
    if (s.scrap_type_id) {
      const hit = scrapTypes.find(t => t.id === s.scrap_type_id)
      if (hit) return hit.name || hit.code
    }
    if (s.scrap_type) {
      const hit = scrapTypes.find(t => t.code === s.scrap_type)
      if (hit) return hit.name || hit.code
      return SCRAP_LEGACY_LABEL[s.scrap_type] || s.scrap_type
    }
    return '—'
  }

  // Resolución de label de grado de calidad
  const gradeLabel = (p) => {
    if (p.quality_grade_id) {
      const hit = qualityGrades.find(g => g.id === p.quality_grade_id)
      if (hit) return hit.name || `Grado ${hit.grade_number}`
    }
    return p.is_second_quality ? '2da' : '1ra'
  }
  const isPrimaryQuality = (p) => {
    if (p.quality_grade_id) {
      const hit = qualityGrades.find(g => g.id === p.quality_grade_id)
      if (hit) return parseInt(hit.grade_number) === 1
    }
    return !p.is_second_quality
  }

  const validateMutation = useMutation({
    mutationFn: ({ approved }) => productionApi.validateShift(selectedId, { approved, supervisorNotes: notes }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shifts-pending'] })
      queryClient.invalidateQueries({ queryKey: ['active-shifts'] })
      setSelectedId(null)
      setNotes('')
    },
  })

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['shift-detail-val', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['shift-corrections', selectedId] })
  }

  // Banner de avisos: se muestra al regresar del modal cuando la corrección
  // generó algún warning del backend (ej: stock se ajustó a 0).
  const [actionWarnings, setActionWarnings] = useState([])
  const dismissWarnings = () => setActionWarnings([])

  if (selectedId && detail) {
    const d = detail
    const allPkgs    = d.progress || []
    const goodPkgs   = allPkgs.filter(p =>  isPrimaryQuality(p))
    const secondPkgs = allPkgs.filter(p => !isPrimaryQuality(p))
    const outRange   = goodPkgs.filter(p => !p.weight_ok)
    const totalMpKg  = d.mpLoads?.reduce((s, m) => s + parseFloat(m.kg), 0) || 0
    const totalGoodKg= goodPkgs.reduce((s, p) => s + parseFloat(p.real_weight_kg), 0)
    const totalSecondKg = secondPkgs.reduce((s,p)=>s+parseFloat(p.real_weight_kg), 0)
    const scrapCalcKg = totalMpKg - totalGoodKg - totalSecondKg

    // Breakdown MP por material (para uses_lots=true)
    const mpByMaterial = (d.mpLoads || []).reduce((acc, m) => {
      const key = m.material_name || m.raw_material_name || '—'
      acc[key] = (acc[key] || 0) + parseFloat(m.kg || 0)
      return acc
    }, {})

    // Breakdown PT por grado de calidad (para multi-grade)
    const pkgsByGrade = allPkgs.reduce((acc, p) => {
      const label = gradeLabel(p)
      acc[label] = acc[label] || { kg: 0, units: 0 }
      acc[label].kg    += parseFloat(p.real_weight_kg || 0)
      acc[label].units += parseInt(p.quantity_units || 0)
      return acc
    }, {})
    const hasMultiGrade = Object.keys(pkgsByGrade).length > 2 || qualityGrades.length > 2

    return (
      <div className="container mx-auto px-3 py-4 max-w-3xl">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setSelectedId(null)} className="btn-ghost btn-icon btn-sm">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <div>
            <h1 className="page-title">Validar turno</h1>
            <p className="page-subtitle">{d.product_name} · {d.length_mm ? `${(d.length_mm/1000).toFixed(2)}m` : ''} · Turno {d.shift_number}</p>
          </div>
        </div>

        {/* Banner de avisos de la última corrección (stock truncado, etc) */}
        {actionWarnings.length > 0 && (
          <div className="mb-4 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 flex items-start gap-2">
            <svg className="w-5 h-5 text-status-warning shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
            </svg>
            <div className="flex-1 text-xs text-status-warning">
              <p className="font-medium mb-1">Corrección aplicada con avisos:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {actionWarnings.map((w, i) => (
                  <li key={i}>
                    {w.code === 'STOCK_FLOORED_TO_ZERO' ? (
                      <>El stock de <b>{w.itemName}</b> en almacén <b>{w.warehouseName}</b> habría quedado en {w.attempted} kg (negativo). Se ajustó a 0 para mantener integridad. La MP podría estar en 0 o sin suficiente stock en sistema — verifica con el admin.</>
                    ) : (
                      <>{w.code}: {JSON.stringify(w)}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <button onClick={dismissWarnings} className="text-status-warning hover:text-status-warning shrink-0" title="Descartar">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        )}

        {/* Resumen */}
        <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
          {[
            { label: 'Piezas buenas',   value: d.pt_units_produced || 0,            color: 'text-status-success' },
            { label: hasMultiGrade ? 'Otras calidades' : 'Segunda calidad', value: secondPkgs.reduce((s,p)=>s+(parseInt(p.quantity_units)||0),0), color: 'text-status-warning' },
            { label: 'Fuera de rango',  value: outRange.length,                     color: outRange.length > 0 ? 'text-status-danger' : 'text-ink-secondary' },
            { label: 'MP cargada',      value: `${totalMpKg.toFixed(1)} kg`,        color: 'text-ink-secondary' },
          ].map((m) => (
            <div key={m.label} className="card-sm text-center">
              <p className="text-xs text-ink-muted mb-1">{m.label}</p>
              <p className={clsx('text-xl font-bold', m.color)}>{m.value}</p>
            </div>
          ))}
        </div>

        {/* Balance MP — diferenciado por uses_lots */}
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-ink-secondary">Balance de materia prima</p>
            {usesLots && (
              <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-brand-500/10 text-brand-300 font-semibold">
                Por lotes
              </span>
            )}
          </div>

          {usesLots && Object.keys(mpByMaterial).length > 0 && (
            <div className="mb-3 pb-3 border-b border-line-subtle">
              <p className="text-xs text-ink-muted mb-1.5">Cargas por material</p>
              <div className="space-y-1 text-sm">
                {Object.entries(mpByMaterial).map(([name, kg]) => (
                  <div key={name} className="flex justify-between">
                    <span className="text-ink-secondary">{name}</span>
                    <span className="font-mono tabular-nums">{kg.toFixed(3)} kg</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-ink-muted">MP total cargada</span><span className="font-medium">{totalMpKg.toFixed(3)} kg</span></div>

            {hasMultiGrade ? (
              Object.entries(pkgsByGrade).map(([label, v]) => (
                <div key={label} className="flex justify-between">
                  <span className="text-ink-muted">PT {label}</span>
                  <span className="font-medium">{v.kg.toFixed(3)} kg</span>
                </div>
              ))
            ) : (
              <>
                <div className="flex justify-between"><span className="text-ink-muted">Peso en piezas buenas</span><span className="font-medium text-status-success">{totalGoodKg.toFixed(3)} kg</span></div>
                <div className="flex justify-between"><span className="text-ink-muted">Peso 2da calidad</span><span className="font-medium text-status-warning">{totalSecondKg.toFixed(3)} kg</span></div>
              </>
            )}

            <div className="flex justify-between border-t border-line-subtle pt-2"><span className="text-ink-muted">Merma calculada</span><span className="font-medium text-status-danger">{Math.max(0, scrapCalcKg).toFixed(3)} kg</span></div>
          </div>
        </div>

        {/* Paquetes capturados */}
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-ink-secondary">Paquetes capturados ({d.progress?.length || 0})</p>
            <button onClick={() => setAddingType('package')}
              className="text-xs font-medium text-brand-300 hover:text-brand-300">
              + Agregar
            </button>
          </div>
          {d.progress?.length > 0 ? (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {d.progress.map((p) => {
                const primary = isPrimaryQuality(p)
                return (
                <div key={p.id} className={clsx('flex items-center gap-2 text-sm py-1 px-2 rounded',
                                                !primary && 'bg-status-warning/10',
                                                !p.weight_ok && primary && 'bg-status-danger/10')}>
                  <span className="text-ink-muted w-12 shrink-0">#{p.microlot_number}</span>
                  <span className="flex-1 font-medium">{p.real_weight_kg} kg</span>
                  {!primary && <Badge variant="amber" label={gradeLabel(p)} />}
                  {/* % de desviación siempre visible (excepto calidades no-primarias).
                      Verde si está dentro de tolerancia, rojo si fuera. */}
                  {primary && p.deviation_pct !== null && p.deviation_pct !== undefined && (
                    <span className={clsx(
                      'text-xs font-medium tabular-nums',
                      p.weight_ok ? 'text-emerald-600' : 'text-status-danger'
                    )}>
                      {parseFloat(p.deviation_pct) > 0 ? '+' : ''}{p.deviation_pct}%
                    </span>
                  )}
                  <button onClick={() => setEditingItem({ type: 'shift_progress', id: p.id, data: p, mode: 'edit' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-info" title="Editar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                  </button>
                  <button onClick={() => setEditingItem({ type: 'shift_progress', id: p.id, data: p, mode: 'delete' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-danger" title="Eliminar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                  </button>
                </div>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-ink-muted italic">Sin paquetes capturados</p>
          )}
        </div>

        {/* Merma capturada */}
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-ink-secondary">Merma capturada ({d.scrap?.length || 0})</p>
            <button onClick={() => setAddingType('scrap')}
              className="text-xs font-medium text-brand-300 hover:text-brand-300">
              + Agregar
            </button>
          </div>
          {d.scrap?.length > 0 ? (
            <div className="space-y-1.5">
              {d.scrap.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-sm py-1 px-2 rounded">
                  <Badge variant="gray" label={scrapLabel(s)} />
                  <span className="flex-1 font-medium">{parseFloat(s.kg).toFixed(2)} kg</span>
                  {s.notes && <span className="text-ink-muted text-xs italic flex-1 truncate">{s.notes}</span>}
                  <button onClick={() => setEditingItem({ type: 'shift_scrap', id: s.id, data: s, mode: 'edit' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-info" title="Editar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                  </button>
                  <button onClick={() => setEditingItem({ type: 'shift_scrap', id: s.id, data: s, mode: 'delete' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-danger" title="Eliminar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-muted italic">Sin merma capturada</p>
          )}
        </div>

        {/* Incidencias */}
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-ink-secondary">Incidencias ({d.incidents?.length || 0})</p>
            <button onClick={() => setAddingType('incident')}
              className="text-xs font-medium text-brand-300 hover:text-brand-300">
              + Agregar
            </button>
          </div>
          {d.incidents?.length > 0 ? (
            <div className="space-y-1.5">
              {d.incidents.map((inc) => (
                <div key={inc.id} className="flex items-start gap-2 text-sm py-1 px-2 rounded">
                  <Badge variant="gray" label={INCIDENT_LABEL[inc.category] || inc.category} />
                  <span className="text-ink-secondary flex-1">{inc.description}</span>
                  {inc.duration_min && <span className="text-ink-muted shrink-0">{inc.duration_min} min</span>}
                  <button onClick={() => setEditingItem({ type: 'shift_incidents', id: inc.id, data: inc, mode: 'edit' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-info" title="Editar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                  </button>
                  <button onClick={() => setEditingItem({ type: 'shift_incidents', id: inc.id, data: inc, mode: 'delete' })}
                    className="btn-icon btn-sm text-ink-muted hover:text-status-danger" title="Eliminar">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-muted italic">Sin incidencias</p>
          )}
        </div>

          {/* Recepción del entrante / Cierre forzado */}
        {(d.force_closed_at || (d.reception && d.reception.accepted === false && d.reception.issue_description)) && (
          <div className="mb-4 space-y-3">
            {d.force_closed_at && (
              <div className="rounded-lg border border-status-danger/40 bg-status-danger/10 p-3">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-status-danger shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z"/>
                  </svg>
                  <div className="flex-1 text-xs">
                    <p className="font-medium text-status-danger mb-1">Cierre forzado por supervisor</p>
                    <p className="text-status-danger mb-1">
                      <span className="font-medium">{d.force_closed_by_name || 'Supervisor'}</span>
                      {' · '}
                      {new Date(d.force_closed_at).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </p>
                    {d.force_close_reason && (
                      <p className="text-status-danger italic">Motivo: {d.force_close_reason}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {d.reception && d.reception.accepted === false && d.reception.issue_description && (
              <ReceptionIssuesBlock reception={d.reception} />
            )}
          </div>
        )}

        {/* Costos */}
        {d.costs?.length > 0 && (
          <div className="card mb-4">
            <p className="text-sm font-medium text-ink-secondary mb-3">Costos aplicados</p>
            <div className="space-y-1.5 text-sm">
              {d.costs.map((c) => (
                <div key={c.id} className="flex justify-between">
                  <span className="text-ink-muted">{c.name}</span>
                  <span className="font-medium">${parseFloat(c.amount).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bitácora de correcciones */}
        {corrections.length > 0 && (
          <div className="card mb-4 border-status-info/40">
            <p className="text-sm font-medium text-status-info mb-3">Correcciones aplicadas ({corrections.length})</p>
            <div className="space-y-2">
              {corrections.map((c) => (
                <div key={c.id} className="text-xs border-l-2 border-status-info/40 pl-3 py-1">
                  <div className="flex items-center gap-2 text-ink-secondary">
                    <span className="font-medium">{c.corrected_by_name || 'Usuario'}</span>
                    <span className="text-ink-muted">{ACTION_LABEL[c.action]}</span>
                    <span className="text-ink-secondary">{TARGET_LABEL[c.target_type]}</span>
                    <span className="text-ink-muted">·</span>
                    <span className="text-ink-muted">{new Date(c.corrected_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="text-ink-muted italic mt-0.5">"{c.correction_reason}"</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notas supervisor */}
        <div className="card mb-4">
          <label className="label">Notas del supervisor (opcional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={2} placeholder="Observaciones sobre el turno..." className="input h-auto py-2 resize-none" />
        </div>

        <div className="mb-3">
          <button onClick={() => navigate(`/produccion/turno/${selectedId}/resumen`)}
            className="btn-ghost text-sm">Ver resumen completo</button>
        </div>

        {(() => {
          const relayActive = d.reception?.incoming_status === 'active'
          const relayName   = d.reception?.incoming_operator_name
          const relayNum    = d.reception?.incoming_shift_number
          const blockTitle  = relayActive
            ? `${relayName || 'El relevo'} (Turno ${relayNum || '—'}) ya tomó la línea. Usa los botones de editar para corregir paquetes sin reactivar este turno.`
            : undefined

          return (
            <>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => validateMutation.mutate({ approved: false })}
                  disabled={validateMutation.isPending || relayActive}
                  title={blockTitle}
                  className={clsx(
                    'btn-secondary',
                    relayActive
                      ? 'text-ink-muted border-line-subtle cursor-not-allowed bg-surface-elevated/40'
                      : 'text-status-danger border-status-danger/40 hover:bg-status-danger/10'
                  )}
                >
                  Rechazar
                </button>
                <button
                  onClick={() => validateMutation.mutate({ approved: true })}
                  disabled={validateMutation.isPending}
                  className="btn-primary"
                >
                  {validateMutation.isPending ? <Spinner size="sm" /> : 'Validar turno'}
                </button>
              </div>

              {relayActive && (
                <p className="text-xs text-ink-muted mt-2 leading-snug">
                  ⓘ <span className="font-medium">{relayName || 'El relevo'}</span>
                  {relayNum ? ` (Turno ${relayNum})` : ''} ya tomó la línea.
                  Para corregir paquetes, mermas o incidencias, usa los botones de editar dentro de cada sección.
                </p>
              )}
            </>
          )
        })()}

        {editingItem && (
          <CorrectionModal
            shiftId={selectedId}
            item={editingItem}
            scrapTypes={scrapTypes}
            qualityGrades={qualityGrades}
            onClose={() => setEditingItem(null)}
            onSuccess={(data) => {
              setEditingItem(null)
              if (data?.warnings?.length) setActionWarnings(data.warnings)
              refreshAll()
            }}
          />
        )}

        {addingType && (
          <AddItemModal
            shiftId={selectedId}
            type={addingType}
            shiftDetail={d}
            scrapTypes={scrapTypes}
            qualityGrades={qualityGrades}
            onClose={() => setAddingType(null)}
            onSuccess={(data) => {
              setAddingType(null)
              if (data?.warnings?.length) setActionWarnings(data.warnings)
              refreshAll()
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="container mx-auto px-3 py-4 max-w-3xl">
      <h1 className="page-title mb-4">Turnos pendientes de validar</h1>
      {isLoading ? (
        <div className="text-center py-8"><Spinner /></div>
      ) : pending.length === 0 ? (
        <div className="card text-center py-8 text-sm text-ink-muted">
          No hay turnos pendientes de validar.
        </div>
      ) : (
        <div className="space-y-2">
          {pending.map((s) => (
            <button key={s.id} onClick={() => setSelectedId(s.id)}
              className="w-full card text-left hover:border-brand-500/40 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold">{s.product_name}</p>
                  <p className="text-xs text-ink-muted">Turno {s.shift_number} · {s.operator_name}</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); navigate(`/produccion/turno/${s.id}/resumen`) }}
                  className="btn-ghost btn-sm text-xs">
                  Ver resumen
                </button>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Bloque de observaciones del entrante (recepción) ────────────────────────
function ReceptionIssuesBlock({ reception }) {
  const [expanded, setExpanded] = useState(false)
  const issueText = reception.issue_description || ''
  const isLong = issueText.length > 200
  const displayText = expanded || !isLong ? issueText : issueText.slice(0, 200) + '…'

  return (
    <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
      <div className="flex items-start gap-2">
        <svg className="w-5 h-5 text-status-warning shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
        </svg>
        <div className="flex-1 text-xs">
          <p className="font-medium text-status-warning mb-1">Observaciones del entrante al recibir</p>
          <p className="text-status-warning mb-2">
            <span className="font-medium">{reception.received_by_name || 'Operador'}</span>
            {' · '}
            {new Date(reception.received_at).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
          <div className="rounded bg-surface-primary border border-status-warning/40 p-2 text-status-warning italic whitespace-pre-wrap">
            “{displayText}”
          </div>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-status-warning hover:text-status-warning font-medium"
            >
              {expanded ? 'Ver menos' : 'Ver completo'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Modal de corrección ──────────────────────────────────────────────────────
function CorrectionModal({ shiftId, item, scrapTypes = [], qualityGrades = [], onClose, onSuccess }) {
  const isDelete = item.mode === 'delete'
  const [reason, setReason] = useState('')
  const [error, setError]   = useState(null)
  const [weight, setWeight]   = useState(item.data.real_weight_kg || '')
  const [secondQ, setSecondQ] = useState(!!item.data.is_second_quality)
  const [gradeId, setGradeId] = useState(item.data.quality_grade_id || '')
  const [scrapKg, setScrapKg] = useState(item.data.kg || '')
  // Si el registro tiene scrap_type_id usar ese; si no, usar code legacy; si no, primero del catálogo
  const initialScrapKey = item.data.scrap_type_id
    ? `id:${item.data.scrap_type_id}`
    : (item.data.scrap_type ? `code:${item.data.scrap_type}` : (scrapTypes[0] ? `id:${scrapTypes[0].id}` : ''))
  const [scrapKey, setScrapKey] = useState(initialScrapKey)
  const [incCategory, setIncCategory] = useState(item.data.category || 'paro_maquina')
  const [incDescription, setIncDescription] = useState(item.data.description || '')
  const [incDuration, setIncDuration] = useState(item.data.duration_min || '')

  const mutation = useMutation({
    mutationFn: () => {
      if (!reason.trim()) throw new Error('La razón es obligatoria.')
      const body = { reason: reason.trim() }
      if (item.type === 'shift_progress') {
        if (isDelete) return productionApi.deletePackage(shiftId, item.id, body)
        const patch = { ...body, realWeightKg: parseFloat(weight), isSecondQuality: secondQ }
        if (gradeId) patch.qualityGradeId = gradeId
        return productionApi.editPackage(shiftId, item.id, patch)
      }
      if (item.type === 'shift_scrap') {
        if (isDelete) return productionApi.deleteScrap(shiftId, item.id, body)
        const patch = { ...body, kg: parseFloat(scrapKg) }
        if (scrapKey.startsWith('id:'))   patch.scrapTypeId = scrapKey.slice(3)
        else if (scrapKey.startsWith('code:')) patch.scrapType = scrapKey.slice(5)
        return productionApi.editScrap(shiftId, item.id, patch)
      }
      if (item.type === 'shift_incidents') {
        if (isDelete) return productionApi.deleteIncident(shiftId, item.id, body)
        return productionApi.editIncident(shiftId, item.id, {
          ...body, category: incCategory, description: incDescription,
          durationMin: incDuration === '' ? null : parseInt(incDuration),
        })
      }
    },
    onSuccess: (data) => onSuccess(data),
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error en la corrección.'),
  })

  const title = isDelete
    ? `Eliminar ${TARGET_LABEL[item.type]}`
    : `Editar ${TARGET_LABEL[item.type]}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">{title}</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">
            {error}
          </div>
        )}

        {isDelete ? (
          <div className="text-sm text-ink-secondary">
            <p className="mb-2">⚠️ Esta acción eliminará el registro y revertirá los movimientos de inventario asociados.</p>
            <p className="text-xs text-ink-muted">Esta operación queda registrada en la bitácora del turno.</p>
          </div>
        ) : (
          <>
            {item.type === 'shift_progress' && (
              <>
                <div>
                  <label className="label">Peso (kg) *</label>
                  <input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} className="input" />
                </div>
                {qualityGrades.length > 2 ? (
                  <div>
                    <label className="label">Calidad</label>
                    <select value={gradeId} onChange={(e) => {
                      setGradeId(e.target.value)
                      const hit = qualityGrades.find(g => g.id === e.target.value)
                      setSecondQ(hit ? parseInt(hit.grade_number) !== 1 : false)
                    }} className="select">
                      <option value="">— Mantener actual —</option>
                      {qualityGrades.map(g => (
                        <option key={g.id} value={g.id}>{g.name || `Grado ${g.grade_number}`}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={secondQ} onChange={(e) => setSecondQ(e.target.checked)} />
                    <span>Marcar como 2da calidad</span>
                  </label>
                )}
              </>
            )}
            {item.type === 'shift_scrap' && (
              <>
                <div>
                  <label className="label">Tipo de merma *</label>
                  <select value={scrapKey} onChange={(e) => setScrapKey(e.target.value)} className="select">
                    {scrapTypes.length > 0 ? (
                      scrapTypes.map(t => (
                        <option key={t.id} value={`id:${t.id}`}>{t.name || t.code}</option>
                      ))
                    ) : (
                      Object.entries(SCRAP_LEGACY_LABEL).map(([code, label]) => (
                        <option key={code} value={`code:${code}`}>{label}</option>
                      ))
                    )}
                  </select>
                </div>
                <div>
                  <label className="label">Kilogramos *</label>
                  <input type="number" step="0.001" value={scrapKg} onChange={(e) => setScrapKg(e.target.value)} className="input" />
                </div>
              </>
            )}
            {item.type === 'shift_incidents' && (
              <>
                <div>
                  <label className="label">Categoría *</label>
                  <select value={incCategory} onChange={(e) => setIncCategory(e.target.value)} className="select">
                    {INCIDENT_CATEGORIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Descripción *</label>
                  <textarea value={incDescription} onChange={(e) => setIncDescription(e.target.value)}
                    rows={2} className="input h-auto py-2 resize-none" />
                </div>
                <div>
                  <label className="label">Duración (min, opcional)</label>
                  <input type="number" min="0" value={incDuration} onChange={(e) => setIncDuration(e.target.value)} className="input" />
                </div>
              </>
            )}
          </>
        )}

        <div>
          <label className="label">Razón del cambio *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)}
            rows={2} placeholder="Ej: Pesaje real fue distinto al estimado original..."
            className="input h-auto py-2 resize-none" />
          <p className="text-[11px] text-ink-muted mt-1">Esta razón quedará en la bitácora del turno.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="btn-secondary">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !reason.trim()}
            className={clsx(isDelete ? 'btn-secondary text-status-danger border-status-danger/40 hover:bg-status-danger/10' : 'btn-primary')}>
            {mutation.isPending ? <Spinner size="sm" /> : (isDelete ? 'Eliminar' : 'Guardar')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Modal para agregar paquete/merma/incidencia (correcciones tipo create) ───
function AddItemModal({ shiftId, type, shiftDetail, scrapTypes = [], qualityGrades = [], onClose, onSuccess }) {
  const [reason, setReason] = useState('')
  const [error, setError]   = useState(null)

  // Estados para los distintos tipos
  const [orderId, setOrderId] = useState('')
  const [weight, setWeight]   = useState('')
  const [secondQ, setSecondQ] = useState(false)
  const [gradeId, setGradeId] = useState('')
  const [scrapKg, setScrapKg] = useState('')
  // Default: primer scrap_type del catálogo (uses_lots=true), o legacy 'operacion'
  const [scrapKey, setScrapKey] = useState(scrapTypes[0] ? `id:${scrapTypes[0].id}` : 'code:operacion')
  const [incCategory, setIncCategory] = useState('paro_maquina')
  const [incDescription, setIncDescription] = useState('')
  const [incDuration, setIncDuration] = useState('')

  // Cargar las órdenes del turno (las que tuvieron actividad capturada).
  // Para paquete y merma necesitamos seleccionar a qué orden asignar.
  const ordersInShift = (() => {
    const fromProgress = (shiftDetail?.progress || [])
      .map(p => p.production_order_id)
      .filter(Boolean)
    const fromScrap = (shiftDetail?.scrap || [])
      .map(s => s.production_order_id)
      .filter(Boolean)
    const uniqueIds = [...new Set([...fromProgress, ...fromScrap])]

    // Construir lista con metadata (necesitamos production_order_id, order_number, status)
    return uniqueIds.map(id => {
      const p = (shiftDetail?.progress || []).find(x => x.production_order_id === id)
      const s = (shiftDetail?.scrap    || []).find(x => x.production_order_id === id)
      return {
        id,
        orderNumber: p?.order_number || s?.order_number || id,
        status:      p?.order_status || s?.order_status || 'unknown',
      }
    })
  })()

  const mutation = useMutation({
    mutationFn: () => {
      if (!reason.trim()) throw new Error('La razón es obligatoria.')
      const baseBody = { reason: reason.trim() }
      if (type === 'package') {
        if (!orderId) throw new Error('Selecciona una orden.')
        if (!weight || parseFloat(weight) <= 0) throw new Error('Peso inválido.')
        const body = {
          ...baseBody,
          productionOrderId: orderId,
          realWeightKg: parseFloat(weight),
          isSecondQuality: secondQ,
        }
        if (gradeId) body.qualityGradeId = gradeId
        return productionApi.addPackage(shiftId, body)
      }
      if (type === 'scrap') {
        if (!orderId) throw new Error('Selecciona una orden.')
        if (!scrapKg || parseFloat(scrapKg) <= 0) throw new Error('Peso de merma inválido.')
        const body = {
          ...baseBody,
          productionOrderId: orderId,
          kg: parseFloat(scrapKg),
        }
        if (scrapKey.startsWith('id:'))   body.scrapTypeId = scrapKey.slice(3)
        else if (scrapKey.startsWith('code:')) body.scrapType = scrapKey.slice(5)
        return productionApi.addScrap(shiftId, body)
      }
      if (type === 'incident') {
        if (!incDescription.trim()) throw new Error('La descripción es obligatoria.')
        return productionApi.addIncident(shiftId, {
          ...baseBody,
          category: incCategory,
          description: incDescription.trim(),
          durationMin: incDuration === '' ? null : parseInt(incDuration),
        })
      }
    },
    onSuccess: (data) => onSuccess(data),
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al agregar.'),
  })

  const title = {
    package:  'Agregar paquete olvidado',
    scrap:    'Agregar merma olvidada',
    incident: 'Agregar incidencia',
  }[type]

  // Si no hay órdenes en el turno y se quiere agregar paquete/merma → no se puede
  if ((type === 'package' || type === 'scrap') && ordersInShift.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card w-full max-w-md p-5 flex flex-col gap-4">
          <h2 className="text-base font-semibold text-ink-primary">{title}</h2>
          <p className="text-sm text-ink-secondary">
            ⚠️ No se puede agregar porque este turno no tiene órdenes vinculadas (no se capturó nada todavía). Pide al operador que capture primero al menos un registro de la orden.
          </p>
          <button onClick={onClose} className="btn-secondary">Cerrar</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">{title}</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {error && (
          <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">{error}</div>
        )}

        {(type === 'package' || type === 'scrap') && (
          <div>
            <label className="label">Orden *</label>
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)} className="select">
              <option value="">— Seleccionar —</option>
              {ordersInShift.map(o => (
                <option key={o.id} value={o.id}>
                  {o.orderNumber} {o.status === 'fulfilled' ? '· lista' : o.status === 'in_progress' ? '· en proceso' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-ink-muted mt-1">Solo se permiten órdenes no cerradas por el supervisor.</p>
          </div>
        )}

        {type === 'package' && (
          <>
            <div>
              <label className="label">Peso (kg) *</label>
              <input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} className="input" />
            </div>
            {qualityGrades.length > 2 ? (
              <div>
                <label className="label">Calidad *</label>
                <select value={gradeId} onChange={(e) => {
                  setGradeId(e.target.value)
                  const hit = qualityGrades.find(g => g.id === e.target.value)
                  setSecondQ(hit ? parseInt(hit.grade_number) !== 1 : false)
                }} className="select">
                  <option value="">— Seleccionar —</option>
                  {qualityGrades.map(g => (
                    <option key={g.id} value={g.id}>{g.name || `Grado ${g.grade_number}`}</option>
                  ))}
                </select>
              </div>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={secondQ} onChange={(e) => setSecondQ(e.target.checked)} />
                <span>Marcar como 2da calidad</span>
              </label>
            )}
          </>
        )}

        {type === 'scrap' && (
          <>
            <div>
              <label className="label">Tipo de merma *</label>
              <select value={scrapKey} onChange={(e) => setScrapKey(e.target.value)} className="select">
                {scrapTypes.length > 0 ? (
                  scrapTypes.map(t => (
                    <option key={t.id} value={`id:${t.id}`}>{t.name || t.code}</option>
                  ))
                ) : (
                  Object.entries(SCRAP_LEGACY_LABEL).map(([code, label]) => (
                    <option key={code} value={`code:${code}`}>{label}</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label className="label">Kilogramos *</label>
              <input type="number" step="0.001" value={scrapKg} onChange={(e) => setScrapKg(e.target.value)} className="input" />
            </div>
          </>
        )}

        {type === 'incident' && (
          <>
            <div>
              <label className="label">Categoría *</label>
              <select value={incCategory} onChange={(e) => setIncCategory(e.target.value)} className="select">
                {INCIDENT_CATEGORIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Descripción *</label>
              <textarea value={incDescription} onChange={(e) => setIncDescription(e.target.value)}
                rows={2} className="input h-auto py-2 resize-none" />
            </div>
            <div>
              <label className="label">Duración (min, opcional)</label>
              <input type="number" min="0" value={incDuration} onChange={(e) => setIncDuration(e.target.value)} className="input" />
            </div>
          </>
        )}

        <div>
          <label className="label">Razón *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)}
            rows={2} placeholder="Ej: Operador olvidó capturar este registro..."
            className="input h-auto py-2 resize-none" />
          <p className="text-[11px] text-ink-muted mt-1">Esta razón quedará en la bitácora del turno.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="btn-secondary">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !reason.trim()}
            className="btn-primary">
            {mutation.isPending ? <Spinner size="sm" /> : 'Agregar'}
          </button>
        </div>
      </div>
    </div>
  )
}
