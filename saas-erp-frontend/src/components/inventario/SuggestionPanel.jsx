import { useState, useEffect, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { countsApi } from '@/api/counts'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtNum } from '@/utils/fmt'
import clsx from 'clsx'

const PRESETS = {
  standard:    { label: 'Estándar',          weights: { rotation: 40, history: 30, time: 20, value: 10 } },
  high_value:  { label: 'Solo valor alto',   weights: { rotation: 10, history: 20, time:  0, value: 70 } },
  audit:       { label: 'Auditoría completa', weights: { rotation: 25, history: 25, time: 25, value: 25 } },
}

const ABC_BADGE = {
  A: 'bg-status-danger/15 text-status-danger',
  B: 'bg-status-warning/15 text-status-warning',
  C: 'bg-surface-elevated/60 text-ink-secondary',
}

/**
 * Panel de configuración de sugerencia inteligente.
 *
 * Props:
 *   - warehouseId: almacén donde se hace el conteo
 *   - onConfirm: callback con la lista final de {itemType, itemId, warehouseId}
 *   - onBack:    callback para volver al modal
 */
export default function SuggestionPanel({ warehouseId, onConfirm, onBack }) {
  const [preset, setPreset]           = useState('standard')
  const [weights, setWeights]         = useState(PRESETS.standard.weights)
  const [count, setCount]             = useState(25)
  const [randomness, setRandomness]   = useState(15)
  const [excludeRecent, setExcludeRecent] = useState(false)
  const [excludeDays, setExcludeDays] = useState(30)

  const [items, setItems]             = useState([])
  const [meta, setMeta]               = useState(null)
  const [removed, setRemoved]         = useState(new Set())
  const [generated, setGenerated]     = useState(false)

  const suggestMut = useMutation({
    mutationFn: () => countsApi.suggest({
      warehouseId,
      count,
      weights,
      randomness,
      excludeRecentlyCountedDays: excludeRecent ? excludeDays : null,
    }),
    onSuccess: (data) => {
      setItems(data.items || [])
      setMeta(data.meta || null)
      setRemoved(new Set())
      setGenerated(true)
    },
  })

  // Auto-generar al montar
  useEffect(() => {
    suggestMut.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function applyPreset(key) {
    setPreset(key)
    setWeights(PRESETS[key].weights)
  }

  function changeWeight(field, value) {
    setPreset('custom')
    setWeights(w => ({ ...w, [field]: parseInt(value) }))
  }

  const totalWeight = weights.rotation + weights.history + weights.time + weights.value

  const finalItems = useMemo(
    () => items.filter(i => !removed.has(`${i.item_type}|${i.item_id}|${i.warehouse_id}`)),
    [items, removed]
  )

  const finalValue = useMemo(
    () => finalItems.reduce((sum, i) => sum + (i.stock_value || 0), 0),
    [finalItems]
  )

  function toggleRemove(item) {
    const key = `${item.item_type}|${item.item_id}|${item.warehouse_id}`
    setRemoved(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleConfirm() {
    if (finalItems.length === 0) return
    onConfirm(finalItems.map(i => ({
      itemType:    i.item_type,
      itemId:      i.item_id,
      warehouseId: i.warehouse_id,
    })))
  }

  return (
    <div className="space-y-4">
      {/* ── Configuración de pesos ────────────────────────────────────── */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-status-info/40 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-primary flex items-center gap-1">
              💡 Sugerencia inteligente
            </h3>
            <p className="text-[11px] text-ink-muted">
              Items priorizados por riesgo · clasificación ABC + historial de diferencias
            </p>
          </div>
        </div>

        {/* Presets */}
        <div className="flex flex-wrap gap-2 mb-3">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button
              key={k}
              type="button"
              onClick={() => applyPreset(k)}
              className={clsx(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                preset === k
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-primary border border-line-subtle text-ink-secondary hover:bg-surface-elevated/40'
              )}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-purple-500/15 text-purple-300">
              Personalizado
            </span>
          )}
        </div>

        {/* Pesos */}
        <div className="space-y-2.5">
          {[
            { key: 'rotation', label: 'Rotación (ABC, últimos 90d)' },
            { key: 'history',  label: 'Diferencias históricas (12m)' },
            { key: 'time',     label: 'Tiempo sin contar' },
            { key: 'value',    label: 'Valor del inventario' },
          ].map(({ key, label }) => (
            <div key={key}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-ink-secondary">{label}</span>
                <span className="tabular-nums text-ink-secondary font-medium">
                  {Math.round((weights[key] / totalWeight) * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={weights[key]}
                onChange={e => changeWeight(key, e.target.value)}
                className="w-full h-1.5 bg-surface-elevated rounded-full appearance-none cursor-pointer accent-brand-600"
              />
            </div>
          ))}
        </div>

        {/* Cantidad y aleatoriedad */}
        <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-status-info/40">
          <div>
            <label className="text-xs text-ink-secondary font-medium">Items a contar</label>
            <input
              type="number"
              min="1"
              max="500"
              className="input input-sm mt-1"
              value={count}
              onChange={e => setCount(parseInt(e.target.value) || 1)}
            />
          </div>
          <div>
            <label className="text-xs text-ink-secondary font-medium">
              Aleatoriedad <span className="text-ink-muted">({randomness}%)</span>
            </label>
            <input
              type="range"
              min="0"
              max="50"
              step="5"
              value={randomness}
              onChange={e => setRandomness(parseInt(e.target.value))}
              className="w-full mt-2 h-1.5 bg-surface-elevated rounded-full appearance-none cursor-pointer accent-brand-600"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 mt-3 text-xs text-ink-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={excludeRecent}
            onChange={e => setExcludeRecent(e.target.checked)}
          />
          Excluir items contados en los últimos
          <input
            type="number"
            min="1"
            max="365"
            className="input input-sm w-16 text-center disabled:opacity-40"
            value={excludeDays}
            onChange={e => setExcludeDays(parseInt(e.target.value) || 30)}
            disabled={!excludeRecent}
          />
          días
        </label>

        <button
          type="button"
          onClick={() => suggestMut.mutate()}
          disabled={suggestMut.isPending}
          className="btn-primary btn-sm w-full mt-3 disabled:opacity-50"
        >
          {suggestMut.isPending ? <Spinner size="sm" /> : '🔄 Generar nueva propuesta'}
        </button>
      </div>

      {/* ── Resumen ──────────────────────────────────────────────────── */}
      {meta && generated && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="bg-surface-primary border border-line-subtle rounded-lg p-2 text-center">
            <p className="text-[10px] uppercase text-ink-muted tracking-wider">Propuestos</p>
            <p className="text-lg font-bold text-ink-primary tabular-nums">{finalItems.length}</p>
            <p className="text-[10px] text-ink-muted">de {meta.universeSize} totales</p>
          </div>
          <div className="bg-surface-primary border border-line-subtle rounded-lg p-2 text-center">
            <p className="text-[10px] uppercase text-ink-muted tracking-wider">Valor estimado</p>
            <p className="text-sm font-bold text-ink-primary tabular-nums">{fmtMXN(finalValue)}</p>
          </div>
          <div className="bg-surface-primary border border-line-subtle rounded-lg p-2 text-center">
            <p className="text-[10px] uppercase text-ink-muted tracking-wider">Distribución ABC</p>
            <p className="text-xs font-medium tabular-nums">
              <span className="text-status-danger">A:{meta.abcDistribution?.A || 0}</span>{' · '}
              <span className="text-status-warning">B:{meta.abcDistribution?.B || 0}</span>{' · '}
              <span className="text-ink-muted">C:{meta.abcDistribution?.C || 0}</span>
            </p>
          </div>
          <div className="bg-surface-primary border border-line-subtle rounded-lg p-2 text-center">
            <p className="text-[10px] uppercase text-ink-muted tracking-wider">Quitados</p>
            <p className="text-lg font-bold text-ink-muted tabular-nums">{removed.size}</p>
          </div>
        </div>
      )}

      {/* ── Lista de items propuestos ────────────────────────────────── */}
      {suggestMut.isPending && !generated && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {suggestMut.isError && (
        <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg p-3 text-sm text-status-danger">
          {suggestMut.error?.response?.data?.error || suggestMut.error?.message}
        </div>
      )}

      {generated && items.length === 0 && (
        <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl p-4 text-center">
          <p className="text-sm text-status-warning">
            No hay items disponibles para sugerir en este almacén con los criterios actuales.
          </p>
        </div>
      )}

      {generated && items.length > 0 && (
        <div className="bg-surface-primary border border-line-subtle rounded-xl overflow-hidden">
          <div className="px-3 py-2 bg-surface-elevated/40 border-b border-line-subtle flex items-center justify-between">
            <p className="text-xs font-semibold text-ink-secondary">
              Items propuestos ({finalItems.length})
              <span className="text-ink-muted font-normal ml-2">
                · Clic en ✕ para quitar
              </span>
            </p>
            {removed.size > 0 && (
              <button
                type="button"
                onClick={() => setRemoved(new Set())}
                className="text-[11px] text-brand-300 hover:underline"
              >
                Restaurar quitados ({removed.size})
              </button>
            )}
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {items.map((item, idx) => {
              const key = `${item.item_type}|${item.item_id}|${item.warehouse_id}`
              const isRemoved = removed.has(key)
              return (
                <div
                  key={key}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2 border-b border-line-subtle text-sm',
                    isRemoved && 'opacity-40 line-through bg-surface-elevated/40/50'
                  )}
                >
                  <span className="text-[11px] text-ink-muted w-6 tabular-nums shrink-0">
                    #{idx + 1}
                  </span>
                  <span className={clsx(
                    'inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold shrink-0',
                    ABC_BADGE[item.abc_class]
                  )}>
                    {item.abc_class}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-ink-primary truncate">
                      {item.item_name}
                      {item.sku && <span className="ml-1 text-[10px] text-ink-muted font-mono">#{item.sku}</span>}
                    </p>
                    <p className="text-[11px] text-ink-muted truncate">
                      {item.reasons.join(' · ')}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs tabular-nums text-ink-secondary">
                      {fmtNum(item.current_stock, 0)} {item.unit}
                    </p>
                    <p
                      className="text-[10px] tabular-nums text-ink-muted"
                      title={`Score: ${item.score} · Rotación ${item.score_breakdown.rotation} · Historial ${item.score_breakdown.history} · Tiempo ${item.score_breakdown.time} · Valor ${item.score_breakdown.value}`}
                    >
                      Score: {item.score}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleRemove(item)}
                    className="btn-ghost btn-icon shrink-0 text-ink-muted hover:text-status-danger"
                    title={isRemoved ? 'Restaurar' : 'Quitar de la lista'}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      {isRemoved ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      )}
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="flex gap-2 pt-2 border-t border-line-subtle">
        <button type="button" onClick={onBack} className="btn-secondary flex-1">
          ← Atrás
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={finalItems.length === 0 || suggestMut.isPending}
          className="btn-primary flex-1 disabled:opacity-40"
        >
          Iniciar conteo con {finalItems.length} items →
        </button>
      </div>
    </div>
  )
}
