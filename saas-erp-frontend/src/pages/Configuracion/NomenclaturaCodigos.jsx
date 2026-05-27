import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { codeFormatsApi, ENTITY_TYPES, CODE_MODES } from '@/api/codeFormats'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'
import clsx from 'clsx'

function previewExample(pattern, padding, seq) {
  if (!pattern) return ''
  try {
    return pattern.replace(/\{seq\}/g, String(seq).padStart(padding, '0'))
  } catch { return '—' }
}

function FormatModal({ entityType, format, onClose }) {
  const qc = useQueryClient()
  const isEdit = !!format
  const defaultPrefix = entityType.value.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'COD'
  const [pattern,  setPattern]  = useState(format?.pattern  || `${defaultPrefix}-{seq}`)
  const [padding,  setPadding]  = useState(format?.padding  || 4)
  const [nextSeq,  setNextSeq]  = useState(format?.next_seq || 1)
  const [mode,     setMode]     = useState(format?.mode     || 'suggested')
  const [isActive, setIsActive] = useState(format?.is_active !== false)
  const [notes,    setNotes]    = useState(format?.notes    || '')
  const [error,    setError]    = useState(null)

  const patternHasSeq = pattern.includes('{seq}')
  const example = patternHasSeq ? previewExample(pattern, padding, nextSeq) : '(falta {seq} en el patrón)'

  const mutation = useMutation({
    mutationFn: () => codeFormatsApi.upsert(entityType.value, {
      pattern,
      padding: parseInt(padding, 10),
      nextSeq: parseInt(nextSeq, 10),
      mode,
      isActive,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['code-formats'] })
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => { e.preventDefault(); setError(null); mutation.mutate() }}
        className="card w-full max-w-lg p-6 flex flex-col gap-4">

        <div>
          <h2 className="text-base font-semibold text-ink-primary">
            {isEdit ? `✏ Editar nomenclatura — ${entityType.label}` : `➕ Configurar — ${entityType.label}`}
          </h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Define el patrón y el siguiente número que se asignará a {entityType.label.toLowerCase()}.
          </p>
        </div>

        <div>
          <label className="label">Patrón <span className="text-status-danger">*</span></label>
          <input className="input font-mono" value={pattern}
            onChange={e => setPattern(e.target.value)} required
            placeholder="CLI-{seq}" maxLength={100} />
          <p className="text-[10px] text-ink-muted mt-0.5">
            Usa <code className="font-mono bg-surface-elevated px-1 rounded">{'{seq}'}</code> donde quieras el número secuencial.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Ceros a la izquierda</label>
            <select className="select" value={padding} onChange={e => setPadding(e.target.value)}>
              {[1,2,3,4,5,6,7,8].map(n => (
                <option key={n} value={n}>{n} dígitos</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Próximo número <span className="text-status-danger">*</span></label>
            <input type="number" min="1" className="input font-mono" value={nextSeq}
              onChange={e => setNextSeq(e.target.value)} required />
          </div>
        </div>

        <div className="bg-brand-500/10 border border-brand-100 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wide text-brand-300 mb-1">Ejemplo</p>
          <p className="font-mono font-semibold text-sm text-brand-300">{example}</p>
        </div>

        <div>
          <label className="label">Modo de generación</label>
          <div className="flex flex-col gap-2 mt-1">
            {CODE_MODES.map(m => (
              <label key={m.value} className={clsx(
                'flex items-start gap-2 text-sm cursor-pointer border rounded-lg p-2.5 transition',
                mode === m.value
                  ? 'border-brand-300 bg-brand-500/10'
                  : 'border-border hover:bg-surface-elevated/40'
              )}>
                <input type="radio" name="mode" value={m.value}
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                  className="mt-0.5 accent-brand-600" />
                <div>
                  <p className="font-semibold">{m.label}</p>
                  <p className="text-[11px] text-ink-muted">{m.hint}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-brand-600"
            checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          Nomenclatura activa
        </label>

        <div>
          <label className="label">Notas <span className="text-ink-muted text-xs">(opcional)</span></label>
          <textarea className="input" rows="2" value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ej: migrado del sistema anterior, último código era CLI-0142." />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="submit" disabled={mutation.isPending || !patternHasSeq}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : (isEdit ? 'Guardar' : 'Crear')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

export default function NomenclaturaCodigos() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(null) // { entityType, format? }

  const { data: formats = [], isLoading } = useQuery({
    queryKey: ['code-formats'],
    queryFn:  () => codeFormatsApi.list(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => codeFormatsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['code-formats'] }),
  })

  if (isLoading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="page-enter flex flex-col gap-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Nomenclatura de códigos</h1>
        <p className="text-xs text-ink-muted mt-0.5">
          Define el patrón de códigos para cada catálogo. El sistema sugiere o genera el siguiente
          número al crear un registro nuevo, evitando dudas al capturista.
        </p>
      </div>

      <div className="card p-5">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wide text-ink-muted">
            <tr className="border-b border-border">
              <th className="text-left py-2 px-2">Catálogo</th>
              <th className="text-left py-2 px-2">Patrón</th>
              <th className="text-left py-2 px-2">Próximo código</th>
              <th className="text-left py-2 px-2">Modo</th>
              <th className="text-left py-2 px-2">Estado</th>
              <th className="text-right py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {ENTITY_TYPES.map(et => {
              const fmt = formats.find(f => f.entity_type === et.value)
              return (
                <tr key={et.value} className="border-b border-border/40 hover:bg-surface-elevated/30">
                  <td className="py-2.5 px-2 font-medium">{et.label}</td>
                  <td className="py-2.5 px-2 font-mono text-xs">
                    {fmt ? fmt.pattern : <span className="text-ink-muted">(sin configurar)</span>}
                  </td>
                  <td className="py-2.5 px-2 font-mono text-xs">
                    {fmt ? previewExample(fmt.pattern, fmt.padding, fmt.next_seq) : '—'}
                  </td>
                  <td className="py-2.5 px-2 text-xs">
                    {fmt ? (CODE_MODES.find(m => m.value === fmt.mode)?.label || fmt.mode) : 'manual'}
                  </td>
                  <td className="py-2.5 px-2">
                    {fmt?.is_active ? (
                      <span className="text-[10px] text-status-success">● activa</span>
                    ) : fmt ? (
                      <span className="text-[10px] text-ink-muted">● inactiva</span>
                    ) : (
                      <span className="text-[10px] text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right">
                    <Can do="settings:update">
                      <button onClick={() => setEditing({ entityType: et, format: fmt })}
                        className="btn-ghost btn-sm text-brand-300">
                        {fmt ? 'Editar' : 'Configurar'}
                      </button>
                      {fmt && (
                        <button
                          onClick={() => {
                            if (confirm(`¿Eliminar la nomenclatura de ${et.label}? Los códigos volverán a ser libres.`)) {
                              deleteMutation.mutate(fmt.id)
                            }
                          }}
                          className="btn-ghost btn-sm text-status-danger">
                          Quitar
                        </button>
                      )}
                    </Can>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-status-info/10 border border-status-info/40 rounded-lg p-3">
        <p className="text-xs text-status-info">
          💡 <strong>Modos:</strong> "Sugerido" muestra el patrón como pista y un botón para autocompletar.
          "Automático" genera el código solo y deja el campo de solo lectura.
          "Manual" desactiva todo y el capturista escribe libre.
        </p>
      </div>

      {editing && (
        <FormatModal
          entityType={editing.entityType}
          format={editing.format}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
