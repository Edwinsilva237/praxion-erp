import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { documentSeriesApi, ENTITY_LABELS_FALLBACK, ENTITY_GROUPS_FALLBACK, GROUP_LABELS } from '@/api/documentSeries'
import { fiscalProfilesApi } from '@/api/fiscalProfiles'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

const CFDI_TYPES = [
  ['',  'Todos los tipos'],
  ['I', 'I — Ingreso (factura)'],
  ['E', 'E — Egreso (nota de crédito)'],
  ['P', 'P — Pago (complemento)'],
  ['N', 'N — Nómina'],
  ['T', 'T — Traslado'],
]

function SerieModal({ series, entityType, fiscalProfile, onClose }) {
  const qc = useQueryClient()
  const isEdit = !!series
  const isInvoice = entityType === 'invoice'

  const [serie,     setSerie]     = useState(series?.serie || '')
  const [folioNext, setFolioNext] = useState(series?.folio_next ?? 1)
  const [cfdiType,  setCfdiType]  = useState(series?.cfdi_type || '')
  const [isDefault, setIsDefault] = useState(series?.is_default || false)
  const [isActive,  setIsActive]  = useState(series?.is_active !== false)
  const [notes,     setNotes]     = useState(series?.notes || '')
  const [error,     setError]     = useState(null)

  const lastUsed = series?.last_used_folio || 0
  const folioBelowUsed = isEdit && lastUsed > 0 && Number(folioNext) <= lastUsed

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        serie,
        folioNext: parseInt(folioNext, 10),
        isDefault,
        isActive,
        notes: notes || null,
      }
      if (isInvoice) body.cfdiType = cfdiType || null

      return isEdit
        ? documentSeriesApi.update(series.id, body)
        : documentSeriesApi.create({
            ...body,
            entityType,
            fiscalProfileId: isInvoice ? fiscalProfile.id : null,
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document-series'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-md p-6 flex flex-col gap-4">

        <div>
          <h2 className="text-base font-semibold text-ink-primary">
            {isEdit ? `✏ Editar serie ${series.serie}` : '➕ Nueva serie'}
          </h2>
          {isInvoice && fiscalProfile && (
            <p className="text-xs text-ink-muted mt-0.5">
              RFC: <span className="font-mono">{fiscalProfile.rfc}</span> · {fiscalProfile.tax_name}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Serie <span className="text-status-danger">*</span></label>
            <input className="input font-mono uppercase" value={serie}
              onChange={e => setSerie(e.target.value.toUpperCase())}
              maxLength={10} placeholder="A" pattern="[A-Za-z0-9_-]{1,10}" required />
            <p className="text-[10px] text-ink-muted mt-0.5">Letras, números, - o _ (1-10).</p>
          </div>
          <div>
            <label className="label">Próximo folio <span className="text-status-danger">*</span></label>
            <input type="number" min="1" className="input font-mono" value={folioNext}
              onChange={e => setFolioNext(e.target.value)} required />
            {isEdit && lastUsed > 0 && (
              <p className="text-[10px] text-ink-muted mt-0.5">
                Último usado: <strong>{lastUsed}</strong>
              </p>
            )}
          </div>
        </div>

        {folioBelowUsed && (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-2.5 text-xs text-status-warning">
            ⚠ El próximo folio ({folioNext}) está por debajo del último folio usado ({lastUsed}).
            Esto puede causar choques de números. Solo continúa si sabes lo que haces.
          </div>
        )}

        {isInvoice && (
          <div>
            <label className="label">Tipo de CFDI</label>
            <select className="select" value={cfdiType} onChange={e => setCfdiType(e.target.value)}>
              {CFDI_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <p className="text-[10px] text-ink-muted mt-0.5">
              Si eliges un tipo, esta serie será sugerida solo para ese tipo de CFDI.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-brand-600"
              checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
            Usar como serie default
            {isInvoice && cfdiType ? ` para CFDI tipo ${cfdiType}` : ''}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-brand-600"
              checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            Serie activa (disponible para uso)
          </label>
        </div>

        <div>
          <label className="label">Notas <span className="text-ink-muted text-xs">(opcional)</span></label>
          <textarea className="input" rows="2" value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ej: serie usada para proyecto X, migrada del sistema anterior..." />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : (isEdit ? 'Guardar cambios' : 'Crear serie')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

function SeriesTableForEntity({ entityType, label, series, profiles, onEdit, onCreate, onDelete }) {
  const isInvoice = entityType === 'invoice'
  const filtered  = series.filter(s => s.entity_type === entityType)

  // Para facturas agrupamos por perfil. Para los demás listamos plano.
  if (isInvoice) {
    if (!profiles.length) {
      return (
        <div className="text-xs text-ink-muted py-2">
          Primero configura tus datos fiscales para poder agregar series de facturas.
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-3">
        {profiles.map(profile => {
          const profileSeries = filtered.filter(s => s.fiscal_profile_id === profile.id)
          return (
            <div key={profile.id} className="border border-border/60 rounded-lg p-3">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="text-sm font-semibold text-ink-primary">
                    🧾 {profile.tax_name}
                  </p>
                  <p className="text-[10px] text-ink-muted font-mono">RFC: {profile.rfc}</p>
                </div>
                <Can do="settings:update">
                  <button onClick={() => onCreate(entityType, profile)}
                    className="btn-secondary btn-sm">➕ Nueva serie</button>
                </Can>
              </div>
              <SeriesRows series={profileSeries} isInvoice={true} onEdit={onEdit} onDelete={onDelete} />
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <Can do="settings:update">
          <button onClick={() => onCreate(entityType, null)}
            className="btn-secondary btn-sm">➕ Nueva serie</button>
        </Can>
      </div>
      <SeriesRows series={filtered} isInvoice={false} onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}

function SeriesRows({ series, isInvoice, onEdit, onDelete }) {
  if (series.length === 0) {
    return (
      <p className="text-xs text-ink-muted py-2">
        Sin series configuradas. Mientras no haya ninguna, el sistema usa la numeración automática por mes (formato legacy).
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wide text-ink-muted">
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2">Serie</th>
            <th className="text-left py-2 px-2">Próximo folio</th>
            {isInvoice && <th className="text-left py-2 px-2">Último usado</th>}
            {isInvoice && <th className="text-left py-2 px-2">Tipo CFDI</th>}
            <th className="text-left py-2 px-2">Estado</th>
            <th className="text-right py-2 px-2"></th>
          </tr>
        </thead>
        <tbody>
          {series.map(s => (
            <tr key={s.id} className="border-b border-border/40 hover:bg-surface-elevated/30">
              <td className="py-2 px-2 font-mono font-semibold">
                {s.serie}
                {s.is_default && (
                  <span className="ml-2 text-[10px] bg-brand-500/15 text-brand-300 rounded px-1.5 py-0.5">
                    default
                  </span>
                )}
              </td>
              <td className="py-2 px-2 font-mono">{s.folio_next}</td>
              {isInvoice && (
                <td className="py-2 px-2 font-mono text-ink-muted">
                  {s.last_used_folio || '—'}
                </td>
              )}
              {isInvoice && (
                <td className="py-2 px-2 text-xs">
                  {s.cfdi_type || <span className="text-ink-muted">todos</span>}
                </td>
              )}
              <td className="py-2 px-2">
                {s.is_active ? (
                  <span className="text-[10px] text-status-success">● activa</span>
                ) : (
                  <span className="text-[10px] text-ink-muted">● inactiva</span>
                )}
              </td>
              <td className="py-2 px-2 text-right">
                <Can do="settings:update">
                  <button onClick={() => onEdit(s)} className="btn-ghost btn-sm text-brand-300">
                    Editar
                  </button>
                  <button onClick={() => onDelete(s)} className="btn-ghost btn-sm text-status-danger">
                    Eliminar
                  </button>
                </Can>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function SeriesFolios() {
  const qc = useQueryClient()
  const [activeGroup, setActiveGroup] = useState('ventas')
  const [editing, setEditing] = useState(null) // { series, entityType, profile? }

  const { data: profiles = [] } = useQuery({
    queryKey: ['fiscal-profile'],
    queryFn:  () => fiscalProfilesApi.list(),
  })
  const { data: series = [], isLoading } = useQuery({
    queryKey: ['document-series'],
    queryFn:  () => documentSeriesApi.list(),
  })
  const { data: meta } = useQuery({
    queryKey: ['document-series-meta'],
    queryFn:  () => documentSeriesApi.meta(),
    staleTime: Infinity,
  })

  const labels = meta?.labels || ENTITY_LABELS_FALLBACK
  const groups = meta?.groups || ENTITY_GROUPS_FALLBACK

  const deleteMutation = useMutation({
    mutationFn: (id) => documentSeriesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['document-series'] }),
    onError: (e) => alert(e.response?.data?.error || 'No se pudo eliminar.'),
  })

  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>

  const activeEntities = groups[activeGroup] || []

  return (
    <div className="page-enter flex flex-col gap-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Series y folios</h1>
        <p className="text-xs text-ink-muted mt-0.5">
          Configura las series de folios de todos los documentos numerados del ERP. Puedes definir
          desde qué número arrancar al migrar desde otro sistema. Mientras no haya una serie
          configurada para un documento, el sistema usa la numeración automática mensual del legacy.
        </p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {Object.keys(groups).map(g => (
          <button key={g} onClick={() => setActiveGroup(g)}
            className={clsx(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition',
              activeGroup === g
                ? 'border-brand-400 text-brand-300'
                : 'border-transparent text-ink-muted hover:text-ink-primary'
            )}>
            {GROUP_LABELS[g] || g}
          </button>
        ))}
      </div>

      {activeEntities.map(entityType => (
        <div key={entityType} className="card p-5">
          <h2 className="text-base font-semibold text-ink-primary mb-3">
            {labels[entityType] || entityType}
          </h2>
          <SeriesTableForEntity
            entityType={entityType}
            label={labels[entityType]}
            series={series}
            profiles={profiles}
            onEdit={(s) => setEditing({
              series: s,
              entityType: s.entity_type,
              profile: s.fiscal_profile_id ? profiles.find(p => p.id === s.fiscal_profile_id) : null,
            })}
            onCreate={(et, profile) => setEditing({ series: null, entityType: et, profile })}
            onDelete={(s) => {
              if (confirm(`¿Eliminar serie "${s.serie}"? Esto solo funciona si no hay documentos emitidos con ella.`)) {
                deleteMutation.mutate(s.id)
              }
            }}
          />
        </div>
      ))}

      {editing && (
        <SerieModal
          series={editing.series}
          entityType={editing.entityType}
          fiscalProfile={editing.profile}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
