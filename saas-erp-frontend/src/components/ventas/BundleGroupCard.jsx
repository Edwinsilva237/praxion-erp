import { fmtMXN, fmtNum } from '@/utils/fmt'

/**
 * Tarjeta de un PAQUETE dentro de la captura de un pedido o cotización
 * (grupo atómico de líneas). Las cantidades internas y los precios prorrateados
 * no se editan — solo cuántos paquetes lleva, o quitar el paquete completo
 * (regla acordada: el paquete es un bloque).
 *
 * `members` son las líneas del grupo (con .product.label/.sub, .unit,
 * .unit_price, .quantity, y los campos bundle_*). Reusado por PedidoFormModal
 * y CotizacionFormModal.
 */
export function BundleGroupCard({ members, currency, onQtyChange, onRemove }) {
  const m0 = members[0]
  const qty = parseFloat(m0.bundle_quantity || 0)
  const groupTotal = members.reduce((s, l) =>
    s + parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0), 0)
  const disc = m0.bundle_discount_pct

  return (
    <div className="border-2 border-brand-500/40 bg-brand-500/5 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink-primary flex items-center gap-2 flex-wrap">
            <span>📦 {m0.bundle_name}</span>
            {disc != null && disc > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-status-success/15 text-status-success uppercase tracking-wide">
                −{Number(disc).toFixed(1)}% vs lista
              </span>
            )}
          </p>
          <p className="text-[11px] text-ink-muted mt-0.5">
            Precio especial prorrateado entre los productos — las cantidades internas no se editan.
          </p>
        </div>
        <button type="button" onClick={onRemove}
          className="text-xs text-red-400 hover:text-status-danger shrink-0">
          Quitar paquete
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs text-ink-muted">Paquetes:</label>
          <input type="number" step="1" min="1" inputMode="numeric"
            className="input w-20 text-right font-mono"
            value={m0.bundle_quantity}
            onChange={e => onQtyChange(e.target.value)} />
        </div>
        {m0.bundle_price != null && (
          <span className="text-xs text-ink-muted">
            × <span className="font-mono">{fmtMXN(m0.bundle_price, currency)}</span> c/u
          </span>
        )}
        <span className="ml-auto text-sm font-semibold font-mono text-brand-300">
          {qty > 0 ? fmtMXN(groupTotal, currency) : '—'}
        </span>
      </div>

      <div className="border border-line-subtle rounded-lg overflow-x-auto bg-surface-primary">
        <table className="table text-xs min-w-full">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="text-right">Cant.</th>
              <th className="text-right">P. Unit. prorrateado</th>
              <th className="text-right">Importe</th>
            </tr>
          </thead>
          <tbody>
            {members.map((l, i) => (
              <tr key={i}>
                <td>
                  <p className="font-medium text-ink-primary">{l.product?.label}</p>
                  {l.product?.sub && <p className="text-[10px] text-ink-muted font-mono">{l.product.sub}</p>}
                </td>
                <td className="text-right font-mono tabular-nums whitespace-nowrap">
                  {qty > 0 ? fmtNum(parseFloat(l.quantity || 0), 3) : '—'} {l.unit}
                </td>
                <td className="text-right font-mono tabular-nums">{fmtMXN(l.unit_price, currency)}</td>
                <td className="text-right font-mono tabular-nums font-medium">
                  {qty > 0 ? fmtMXN(parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0), currency) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
