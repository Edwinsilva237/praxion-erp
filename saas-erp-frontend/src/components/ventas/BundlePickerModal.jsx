import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/api/products'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN } from '@/utils/fmt'
import clsx from 'clsx'

/**
 * Selector de paquete para agregarlo a un pedido.
 *
 * Lista los paquetes ACTIVOS del catálogo; los de moneda distinta a la del
 * pedido se muestran deshabilitados (el prorrateo es nativo de la moneda del
 * paquete). onConfirm(bundle, qty) — el padre decide qué hacer (explotar en
 * el form de captura, o pegarle al endpoint en el detalle del pedido).
 */
export function BundlePickerModal({ currency = 'MXN', onConfirm, onClose, busy = false }) {
  const [selected, setSelected] = useState(null)
  const [qty, setQty]           = useState('1')
  const [search, setSearch]     = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['product-bundles', 'picker'],
    queryFn: () => productsApi.listBundles({ isActive: true, limit: 100 }),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const bundles = data?.data || []

  const filtered = useMemo(() => {
    if (!search.trim()) return bundles
    const q = search.trim().toLowerCase()
    return bundles.filter(b =>
      (b.name || '').toLowerCase().includes(q) ||
      (b.items_summary || '').toLowerCase().includes(q)
    )
  }, [bundles, search])

  const canConfirm = selected && parseFloat(qty) > 0 && !busy

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg p-0 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Agregar paquete</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              El paquete entra como bloque: sus productos con el precio especial ya prorrateado.
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon btn-sm">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 overflow-y-auto">
          {bundles.length > 4 && (
            <input className="input" placeholder="Buscar paquete..."
              value={search} onChange={e => setSearch(e.target.value)} />
          )}

          {isLoading ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-ink-muted text-center py-8">
              {search ? 'Sin resultados.' : 'No hay paquetes activos. Créalos en Comercial → Paquetes.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map(b => {
                const wrongCurrency = b.currency !== currency
                const isSelected = selected?.id === b.id
                return (
                  <button key={b.id} type="button"
                    disabled={wrongCurrency}
                    onClick={() => setSelected(b)}
                    className={clsx(
                      'text-left border rounded-xl p-3 transition-colors',
                      wrongCurrency
                        ? 'border-line-subtle opacity-50 cursor-not-allowed'
                        : isSelected
                          ? 'border-brand-500 bg-brand-500/10'
                          : 'border-line-subtle hover:border-brand-500/50'
                    )}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-ink-primary">📦 {b.name}</p>
                      <p className="font-mono font-semibold text-brand-300 whitespace-nowrap">
                        {fmtMXN(b.bundle_price, b.currency)}
                      </p>
                    </div>
                    <p className="text-xs text-ink-muted mt-1 line-clamp-2">
                      {b.items_count} producto{b.items_count === 1 ? '' : 's'}: {b.items_summary || '—'}
                    </p>
                    {wrongCurrency && (
                      <p className="text-[10px] text-status-warning mt-1">
                        Definido en {b.currency} — el pedido es en {currency}.
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line-subtle flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-muted">Paquetes:</label>
            <input type="number" step="1" min="1" inputMode="numeric"
              className="input w-20 text-right font-mono"
              value={qty} onChange={e => setQty(e.target.value)} />
            {selected && parseFloat(qty) > 0 && (
              <span className="text-xs font-mono text-brand-300">
                = {fmtMXN(parseFloat(selected.bundle_price) * parseFloat(qty), selected.currency)}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary btn-sm">Cancelar</button>
            <button type="button" disabled={!canConfirm}
              onClick={() => onConfirm(selected, parseFloat(qty))}
              className="btn-primary btn-sm">
              {busy ? <Spinner size="sm" /> : 'Agregar al pedido'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
