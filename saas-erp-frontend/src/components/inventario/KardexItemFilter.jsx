import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'

/**
 * Filtro de ARTÍCULO para el Kardex: autocomplete de productos/materias primas.
 * Al elegir uno, `onSelect({ id, item_type, name, sku })`; para limpiar,
 * `onSelect(null)`. El movements-query filtra por item_id + item_type.
 */
export default function KardexItemFilter({ value, onSelect }) {
  const [q, setQ]       = useState('')
  const [open, setOpen] = useState(false)

  const { data: results = [] } = useQuery({
    queryKey: ['kardex-item-search', q],
    queryFn:  () => inventoryApi.searchItems({ q, limit: 10 }),
    enabled:  open && q.trim().length >= 2,
    staleTime: 30000,
  })

  if (value) {
    return (
      <div className="flex items-center gap-1.5 h-9 px-3 rounded-lg border border-brand-500/40 bg-brand-500/10 text-sm text-ink-primary max-w-[16rem]">
        <span className="truncate">{value.name}{value.sku ? <span className="text-ink-muted"> · {value.sku}</span> : null}</span>
        <button type="button" onClick={() => { onSelect(null); setQ('') }}
          className="text-ink-muted hover:text-status-danger shrink-0" title="Quitar filtro de producto">✕</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        className="input w-56"
        placeholder="Buscar producto…"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 w-72 max-h-64 overflow-auto rounded-xl border border-line-subtle bg-surface-primary shadow-lg p-1">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-muted">Sin coincidencias</p>
          ) : results.map(it => (
            <button key={`${it.item_type}-${it.id}`} type="button"
              onMouseDown={() => { onSelect({ id: it.id, item_type: it.item_type, name: it.name, sku: it.sku }); setOpen(false); setQ('') }}
              className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-surface-elevated/60">
              <div className="text-sm text-ink-primary truncate">{it.name}</div>
              <div className="text-[11px] text-ink-muted">
                {it.sku ? `${it.sku} · ` : ''}{it.item_type === 'product' ? 'Producto' : 'Materia prima'}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
