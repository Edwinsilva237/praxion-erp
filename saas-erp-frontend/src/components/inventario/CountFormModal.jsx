import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { inventoryApi } from '@/api/inventory'
import { countsApi } from '@/api/counts'
import Spinner from '@/components/ui/Spinner'
import SuggestionPanel from './SuggestionPanel'
import clsx from 'clsx'

/**
 * Modal para iniciar un conteo nuevo (cíclico o cierre de mes).
 *
 * Flujo:
 *   1. Configurar: tipo, almacén, alcance, fecha, notas
 *   2. Si alcance = "suggested": panel de sugerencia inteligente con propuesta editable
 *   3. Confirmar: crea conteo (snapshot) y navega a /inventario/conteos/:id
 */
export default function CountFormModal({ onClose }) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [step, setStep] = useState(1)   // 1 = config, 2 = sugerencia

  const [countType, setCountType]     = useState('cyclic')
  const [warehouseId, setWarehouseId] = useState('')
  const [scope, setScope]             = useState('all')
  const [countDate, setCountDate]     = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes]             = useState('')
  const [error, setError]             = useState(null)

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })
  const activeWarehouses = warehouses.filter(w => w.is_active)

  const mutation = useMutation({
    mutationFn: (body) => countsApi.create(body),
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ['counts'] })
      navigate(`/inventario/conteos/${count.id}`)
    },
    onError: (err) => setError(err.response?.data?.error || err.message),
  })

  function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (countType === 'cyclic' && !warehouseId) {
      setError('Selecciona un almacén para el conteo cíclico.')
      return
    }

    if (countType === 'cyclic' && scope === 'suggested') {
      setStep(2)
      return
    }

    mutation.mutate({
      countType,
      warehouseId: countType === 'cyclic' ? warehouseId : null,
      scope:       countType === 'cyclic' ? scope : 'all',
      countDate,
      notes,
    })
  }

  function handleConfirmSuggestion(selectedItems) {
    setError(null)
    mutation.mutate({
      countType:    'cyclic',
      warehouseId,
      scope:        'selected',
      selectedItems,
      countDate,
      notes,
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={clsx(
        'card w-full p-6 max-h-[92vh] overflow-y-auto',
        step === 1 ? 'max-w-lg' : 'max-w-2xl'
      )}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {step === 1 ? 'Nuevo conteo físico' : 'Sugerencia inteligente'}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {step === 1
                ? 'Al iniciar se tomará un snapshot del sistema. Los movimientos posteriores no se reconciliarán al snapshot.'
                : `Almacén: ${activeWarehouses.find(w => w.id === warehouseId)?.name || ''} · Configura los criterios y revisa la propuesta antes de iniciar.`}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {step === 1 && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Tipo de conteo</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCountType('cyclic')}
                  className={clsx(
                    'p-3 rounded-xl border-2 text-left transition-all',
                    countType === 'cyclic'
                      ? 'border-brand-500/40 bg-brand-500/10'
                      : 'border-line-subtle hover:border-line-strong'
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">🔄</span>
                    <span className="text-sm font-semibold">Cíclico</span>
                  </div>
                  <p className="text-[11px] text-ink-muted">
                    Parcial · 1 almacén · cualquier momento
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setCountType('month_close')}
                  className={clsx(
                    'p-3 rounded-xl border-2 text-left transition-all',
                    countType === 'month_close'
                      ? 'border-brand-500/40 bg-brand-500/10'
                      : 'border-line-subtle hover:border-line-strong'
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">📅</span>
                    <span className="text-sm font-semibold">Cierre de mes</span>
                  </div>
                  <p className="text-[11px] text-ink-muted">
                    Completo · todos los almacenes
                  </p>
                </button>
              </div>
            </div>

            {countType === 'cyclic' && (
              <>
                <div>
                  <label className="label">Almacén *</label>
                  <select
                    className="select"
                    value={warehouseId}
                    onChange={e => setWarehouseId(e.target.value)}
                  >
                    <option value="">Selecciona un almacén…</option>
                    {activeWarehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.type === 'raw_material' ? 'MP' :
                                   w.type === 'finished_product' ? 'PT' :
                                   w.type === 'wip' ? 'WIP' :
                                   w.type === 'regrind' ? 'Regrind' : w.type})
                        {w.is_default ? ' ⭐' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="label">Alcance</label>
                  <div className="space-y-2">
                    {[
                      { value: 'suggested',    label: '💡 Sugerencia inteligente',          desc: 'Items priorizados por riesgo (ABC + diferencias + tiempo + valor). Recomendado.', highlight: true },
                      { value: 'all',          label: 'Todo el almacén',                     desc: 'Incluye items con stock=0 que tengan niveles configurados.' },
                      { value: 'with_stock',   label: 'Solo items con stock > 0',            desc: 'Más rápido. No detecta items "perdidos".' },
                      { value: 'below_min',    label: 'Solo items bajo mínimo / reorden',    desc: 'Foco en lo crítico.' },
                    ].map(opt => (
                      <label key={opt.value} className={clsx(
                        'flex items-start gap-3 p-2 rounded-lg border cursor-pointer transition-colors',
                        scope === opt.value
                          ? (opt.highlight ? 'border-status-info/40 bg-status-info/10' : 'border-brand-500/40 bg-brand-500/10')
                          : (opt.highlight ? 'border-status-info/40 bg-status-info/10/30 hover:bg-status-info/10' : 'border-line-subtle hover:bg-surface-elevated/40')
                      )}>
                        <input
                          type="radio"
                          name="scope"
                          value={opt.value}
                          checked={scope === opt.value}
                          onChange={e => setScope(e.target.value)}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-ink-secondary">{opt.label}</p>
                          <p className="text-[11px] text-ink-muted">{opt.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {countType === 'month_close' && (
              <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl p-3">
                <p className="text-xs text-status-warning">
                  <strong>Cierre de mes:</strong> incluye TODOS los almacenes activos y TODOS los items
                  con stock o con niveles configurados. Solo puede haber un cierre de mes en proceso por mes.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Fecha del conteo</label>
                <input
                  type="date"
                  className="input"
                  value={countDate}
                  onChange={e => setCountDate(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="label">Notas (opcional)</label>
              <textarea
                className="input min-h-[60px]"
                placeholder="Ej. Conteo posterior a inventario físico de fin de mes…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            {error && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-xs text-status-danger">
                {error}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn-secondary flex-1">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={mutation.isPending}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {mutation.isPending ? <Spinner size="sm" /> :
                  (countType === 'cyclic' && scope === 'suggested')
                    ? 'Continuar →'
                    : 'Iniciar conteo →'}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <>
            {error && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-xs text-status-danger mb-3">
                {error}
              </div>
            )}
            <SuggestionPanel
              warehouseId={warehouseId}
              onBack={() => setStep(1)}
              onConfirm={handleConfirmSuggestion}
            />
            {mutation.isPending && (
              <div className="absolute inset-0 bg-surface-primary/60 flex items-center justify-center z-10 rounded-xl">
                <div className="bg-surface-primary rounded-xl shadow-card px-6 py-4 flex items-center gap-3">
                  <Spinner />
                  <span className="text-sm text-ink-secondary">Iniciando conteo…</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
