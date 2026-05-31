import { useState, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { genId } from '@/utils/genId'
import clsx from 'clsx'

// ── Helpers de formato locales ────────────────────────────────────────────────
const fmtMXN = (n) => {
  if (n == null || isNaN(n)) return '$0.00'
  return `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
const fmtNum = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return '0'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

const EMPTY_LINE = () => ({
  uid:       genId(),
  itemType:  'raw_material',
  item:      null,
  direction: 'in',
  quantity:  '',
  unitCost:  '',
  notes:     '',
})

// ─────────────────────────────────────────────────────────────────────────────
//  AdjustmentModal
// ─────────────────────────────────────────────────────────────────────────────
export default function AdjustmentModal({ warehouses = [], onClose, onSaved }) {
  const qc = useQueryClient()

  // Filtrar WIP — los almacenes de producción en proceso son read-only
  const adjustableWarehouses = useMemo(
    () => warehouses.filter(w => w.type !== 'wip'),
    [warehouses]
  )

  const [warehouseId, setWarehouseId] = useState('')
  const [reason, setReason]           = useState('')
  const [notes, setNotes]             = useState('')
  const [lines, setLines]             = useState([EMPTY_LINE()])
  const [serverError, setServerError] = useState(null)
  const [showFieldErrors, setShowFieldErrors] = useState(false)

  // ── Autocomplete builder ────────────────────────────────────────────────────
  const buildSearchFn = useCallback((itemType) => async (q) => {
    const data = await inventoryApi.searchItems({
      q,
      type: itemType,
      warehouseId: warehouseId || undefined,
      limit: 10,
    })
    return data.map(it => ({
      id:    it.id,
      label: it.name,
      sub:   it.sku
        ? `SKU ${it.sku} · ${it.unit}${warehouseId ? ` · stock: ${fmtNum(it.current_quantity)} ${it.unit}` : ''}`
        : `${it.unit}${warehouseId ? ` · stock: ${fmtNum(it.current_quantity)} kg` : ''}`,
      meta: it,
    }))
  }, [warehouseId])

  // ── Mutación ────────────────────────────────────────────────────────────────
  const mutation = useMutation({
    mutationFn: inventoryApi.createAdjustment,
    onSuccess: (adj) => {
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-movements'] })
      qc.invalidateQueries({ queryKey: ['inv-adjustments'] })
      onSaved?.(adj)
      onClose()
    },
    onError: (err) => {
      setServerError(err.response?.data?.error || err.message || 'Error al guardar el ajuste.')
    },
  })

  // ── Manipulación de líneas ──────────────────────────────────────────────────
  function updateLine(uid, patch) {
    setLines(prev => prev.map(l => l.uid === uid ? { ...l, ...patch } : l))
  }
  function removeLine(uid) {
    setLines(prev => prev.length === 1 ? prev : prev.filter(l => l.uid !== uid))
  }
  function addLine() {
    setLines(prev => [...prev, EMPTY_LINE()])
  }

  function onSelectItem(uid, selection) {
    if (!selection) {
      updateLine(uid, { item: null })
      return
    }
    const meta = selection.meta
    const line = lines.find(l => l.uid === uid)
    const shouldPrefillCost = line && line.direction === 'out' && meta.avg_cost
    updateLine(uid, {
      item: meta,
      unitCost: shouldPrefillCost
        ? Number(meta.avg_cost).toFixed(4)
        : line.unitCost,
    })
  }

  function onChangeDirection(uid, newDir) {
    const line = lines.find(l => l.uid === uid)
    if (!line) return
    const patch = { direction: newDir }
    if (newDir === 'out' && line.item?.avg_cost) {
      patch.unitCost = Number(line.item.avg_cost).toFixed(4)
    }
    updateLine(uid, patch)
  }

  function onChangeItemType(uid, newType) {
    updateLine(uid, { itemType: newType, item: null, unitCost: '' })
  }

  // ── Resumen ─────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    let inLines = 0, outLines = 0, inValue = 0, outValue = 0
    for (const l of lines) {
      const q = parseFloat(l.quantity) || 0
      const c = parseFloat(l.unitCost) || 0
      if (q <= 0) continue
      if (l.direction === 'in') { inLines++;  inValue  += q * c }
      else                      { outLines++; outValue += q * c }
    }
    return { inLines, outLines, inValue, outValue, net: inValue - outValue }
  }, [lines])

  // ── Validación de stock por línea ───────────────────────────────────────────
  function lineHasStockWarning(l) {
    if (l.direction !== 'out' || !l.item) return false
    const q = parseFloat(l.quantity)
    if (!q || q <= 0) return false
    const stock = parseFloat(l.item.current_quantity || 0)
    return q > stock
  }

  // ── Validación general ──────────────────────────────────────────────────────
  const validation = useMemo(() => {
    const errors = []
    if (!warehouseId)   errors.push('Selecciona un almacén.')
    if (!reason.trim()) errors.push('Escribe el motivo del ajuste.')
    if (!notes.trim())  errors.push('Las notas adicionales son obligatorias.')

    const validLines = lines.filter(l => l.item && parseFloat(l.quantity) > 0)
    if (validLines.length === 0) errors.push('Agrega al menos una línea válida.')

    const linesWithoutNotes = lines.filter(
      l => l.item && parseFloat(l.quantity) > 0 && !String(l.notes || '').trim()
    )
    if (linesWithoutNotes.length > 0) {
      errors.push(`Faltan notas en ${linesWithoutNotes.length} línea(s) — son obligatorias.`)
    }

    const insufficient = lines.filter(lineHasStockWarning)
    if (insufficient.length > 0) {
      errors.push(`Stock insuficiente en ${insufficient.length} línea(s).`)
    }

    return { errors, isValid: errors.length === 0 }
  }, [warehouseId, reason, notes, lines])

  // ── Submit ──────────────────────────────────────────────────────────────────
  function handleSubmit(e) {
    e?.preventDefault()
    setShowFieldErrors(true)
    setServerError(null)
    if (!validation.isValid) return

    const payload = {
      warehouseId,
      reason: reason.trim(),
      notes: notes.trim(),
      lines: lines
        .filter(l => l.item && parseFloat(l.quantity) > 0)
        .map(l => ({
          itemType:  l.itemType,
          itemId:    l.item.id,
          quantity:  parseFloat(l.quantity),
          unit:      l.item.unit,
          unitCost:  parseFloat(l.unitCost) || 0,
          direction: l.direction,
          notes:     l.notes.trim(),
        })),
    }
    mutation.mutate(payload)
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="card w-full max-w-4xl my-6 p-6 max-h-[95vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Nuevo ajuste de inventario</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Captura entradas y salidas en un mismo documento. Las notas son obligatorias.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto pr-1">
          {/* ── Cabecera ───────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
            <div className="md:col-span-1">
              <label className="label">Almacén destino *</label>
              <select
                className={clsx('select', showFieldErrors && !warehouseId && 'border-status-danger/40')}
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
              >
                <option value="">Selecciona almacén</option>
                {adjustableWarehouses.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name}{w.is_default ? ' ⭐' : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-ink-muted mt-1">
                Los almacenes WIP no aparecen — se gestionan automáticamente por producción.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="label">Motivo *</label>
              <input
                className={clsx('input', showFieldErrors && !reason.trim() && 'border-status-danger/40')}
                placeholder="Ej: Inventario físico mayo, productos dañados..."
                value={reason}
                onChange={e => setReason(e.target.value)}
                maxLength={200}
              />
            </div>
            <div className="md:col-span-3">
              <label className="label">
                Notas adicionales *
                <span className="text-ink-muted font-normal ml-1">(detalla el contexto del ajuste)</span>
              </label>
              <textarea
                className={clsx('input min-h-[60px]', showFieldErrors && !notes.trim() && 'border-status-danger/40')}
                placeholder="Detalles internos, referencias a auditoría, observaciones específicas..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          {!warehouseId && (
            <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-3 py-2 mb-4 text-xs text-status-warning">
              Selecciona primero un almacén para que el buscador muestre saldos y costos promedio.
            </div>
          )}

          {/* ── Líneas ──────────────────────────────────────────────────── */}
          <div className="border-t border-line-subtle pt-4 mb-3">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-ink-secondary">Líneas del ajuste</h3>
              <button type="button" onClick={addLine} className="btn-secondary btn-sm">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
                </svg>
                Agregar línea
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {lines.map((line, idx) => (
                <LineCard
                  key={line.uid}
                  index={idx}
                  line={line}
                  warehouseId={warehouseId}
                  onUpdate={(patch) => updateLine(line.uid, patch)}
                  onRemove={() => removeLine(line.uid)}
                  onSelectItem={(sel) => onSelectItem(line.uid, sel)}
                  onChangeDirection={(d) => onChangeDirection(line.uid, d)}
                  onChangeItemType={(t)  => onChangeItemType(line.uid, t)}
                  buildSearchFn={buildSearchFn}
                  hasStockWarning={lineHasStockWarning(line)}
                  showFieldErrors={showFieldErrors}
                  canRemove={lines.length > 1}
                />
              ))}
            </div>
          </div>

          {/* ── Resumen ─────────────────────────────────────────────────── */}
          <div className="border-t border-line-subtle pt-4 mt-4 grid grid-cols-3 gap-3">
            <div className="bg-status-success/10 border border-status-success/40 rounded-xl p-3">
              <p className="text-[10px] uppercase font-semibold text-status-success tracking-wider">Entradas</p>
              <p className="text-sm sm:text-base font-bold text-status-success mt-1 tabular-nums break-all">+{fmtMXN(summary.inValue)}</p>
              <p className="text-[10px] text-green-500 mt-0.5">{summary.inLines} línea{summary.inLines !== 1 && 's'}</p>
            </div>
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-xl p-3">
              <p className="text-[10px] uppercase font-semibold text-status-danger tracking-wider">Salidas</p>
              <p className="text-sm sm:text-base font-bold text-status-danger mt-1 tabular-nums break-all">−{fmtMXN(summary.outValue)}</p>
              <p className="text-[10px] text-status-danger mt-0.5">{summary.outLines} línea{summary.outLines !== 1 && 's'}</p>
            </div>
            <div className={clsx(
              'border rounded-xl p-3',
              summary.net >= 0 ? 'bg-status-info/10 border-status-info/40' : 'bg-status-warning/10 border-status-warning/40'
            )}>
              <p className={clsx(
                'text-[10px] uppercase font-semibold tracking-wider',
                summary.net >= 0 ? 'text-status-info' : 'text-status-warning'
              )}>Neto</p>
              <p className={clsx(
                'text-sm sm:text-base font-bold mt-1 tabular-nums break-all',
                summary.net >= 0 ? 'text-status-info' : 'text-status-warning'
              )}>
                {summary.net >= 0 ? '+' : '−'}{fmtMXN(Math.abs(summary.net))}
              </p>
              <p className={clsx(
                'text-[10px] mt-0.5',
                summary.net >= 0 ? 'text-blue-500' : 'text-amber-500'
              )}>
                {summary.net >= 0 ? 'Aumento de inventario' : 'Disminución de inventario'}
              </p>
            </div>
          </div>

          {/* ── Errores ─────────────────────────────────────────────────── */}
          {showFieldErrors && validation.errors.length > 0 && (
            <ul className="mt-4 bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 text-xs text-status-warning list-disc list-inside space-y-0.5">
              {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {serverError && (
            <p className="mt-4 bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-xs text-status-danger">
              {serverError}
            </p>
          )}
        </form>

        {/* Footer */}
        <div className="flex gap-2 pt-4 border-t border-line-subtle mt-4">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={handleSubmit}
            className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar ajuste'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sub-componente: tarjeta de línea
// ─────────────────────────────────────────────────────────────────────────────
function LineCard({
  index, line, warehouseId,
  onUpdate, onRemove, onSelectItem, onChangeDirection, onChangeItemType,
  buildSearchFn, hasStockWarning, showFieldErrors, canRemove,
}) {
  const isIn = line.direction === 'in'
  const stockText = line.item && warehouseId
    ? `Stock actual: ${fmtNum(line.item.current_quantity)} ${line.item.unit} · Costo prom.: ${fmtMXN(line.item.avg_cost)}`
    : null
  const lineComplete = line.item && parseFloat(line.quantity) > 0
  const notesMissing = lineComplete && !String(line.notes || '').trim() && showFieldErrors

  return (
    <div className={clsx(
      'border rounded-xl p-3',
      hasStockWarning ? 'border-status-danger/40 bg-status-danger/10/30' :
      notesMissing    ? 'border-status-warning/40 bg-status-warning/10/30' :
                        'border-line-subtle bg-surface-primary'
    )}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-ink-muted">Línea {index + 1}</span>
        {canRemove && (
          <button type="button" onClick={onRemove}
            className="text-ink-muted hover:text-status-danger p-1" title="Eliminar línea">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/>
            </svg>
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <div className="flex bg-surface-elevated/60 rounded-lg p-0.5 text-xs">
          <button type="button" onClick={() => onChangeItemType('raw_material')}
            className={clsx('px-3 py-1 rounded-md font-medium transition-all',
              line.itemType === 'raw_material' ? 'bg-surface-primary shadow text-status-warning' : 'text-ink-muted hover:text-ink-secondary')}>
            Materia prima
          </button>
          <button type="button" onClick={() => onChangeItemType('product')}
            className={clsx('px-3 py-1 rounded-md font-medium transition-all',
              line.itemType === 'product' ? 'bg-surface-primary shadow text-brand-300' : 'text-ink-muted hover:text-ink-secondary')}>
            Producto terminado
          </button>
        </div>

        <div className="flex bg-surface-elevated/60 rounded-lg p-0.5 text-xs">
          <button type="button" onClick={() => onChangeDirection('in')}
            className={clsx('px-3 py-1 rounded-md font-medium transition-all',
              isIn ? 'bg-surface-primary shadow text-status-success' : 'text-ink-muted hover:text-ink-secondary')}>
            + Entrada
          </button>
          <button type="button" onClick={() => onChangeDirection('out')}
            className={clsx('px-3 py-1 rounded-md font-medium transition-all',
              !isIn ? 'bg-surface-primary shadow text-status-danger' : 'text-ink-muted hover:text-ink-secondary')}>
            − Salida
          </button>
        </div>
      </div>

      <div className="mb-2">
        <label className="label">Artículo *</label>
        <Autocomplete
          value={line.item ? { id: line.item.id, label: line.item.name } : null}
          onChange={onSelectItem}
          onSearch={buildSearchFn(line.itemType)}
          placeholder={`Buscar ${line.itemType === 'raw_material' ? 'materia prima' : 'producto'}...`}
        />
        {stockText && (
          <p className="text-[11px] text-ink-muted mt-1 ml-1">{stockText}</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
        <div>
          <label className="label">
            Cantidad * {line.item && <span className="text-ink-muted font-normal">({line.item.unit})</span>}
          </label>
          <input
            type="number"
            step="0.0001"
            min="0.0001"
            className={clsx('input', hasStockWarning && 'border-status-danger/40 focus:ring-status-danger/40')}
            placeholder="0.00"
            value={line.quantity}
            onChange={e => onUpdate({ quantity: e.target.value })}
          />
          {hasStockWarning && (
            <p className="text-[11px] text-status-danger mt-1">
              Excede el stock disponible ({fmtNum(line.item.current_quantity)} {line.item.unit}).
            </p>
          )}
        </div>
        <div>
          <label className="label">
            Costo unitario {!isIn && <span className="text-[10px] text-ink-muted">(auto del costo prom.)</span>}
          </label>
          <input
            type="number"
            step="0.0001"
            min="0"
            className="input"
            placeholder="0.0000"
            value={line.unitCost}
            onChange={e => onUpdate({ unitCost: e.target.value })}
            readOnly={!isIn}
          />
        </div>
      </div>

      <div>
        <label className="label">
          Notas *
          <span className="text-[10px] text-ink-muted ml-1">(obligatorio — describe esta línea)</span>
        </label>
        <input
          className={clsx('input', notesMissing && 'border-amber-400 focus:ring-amber-300')}
          placeholder="Ej: faltante en bodega, mercancía dañada, conteo cíclico estante 3..."
          value={line.notes}
          onChange={e => onUpdate({ notes: e.target.value })}
        />
        {notesMissing && (
          <p className="text-[11px] text-status-warning mt-1">Las notas son obligatorias para esta línea.</p>
        )}
      </div>
    </div>
  )
}
