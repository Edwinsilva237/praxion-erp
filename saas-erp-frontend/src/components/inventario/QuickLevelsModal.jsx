import { createPortal } from 'react-dom'
import InventoryLevelsPanel from './InventoryLevelsPanel'

/**
 * Modal pequeño que envuelve <InventoryLevelsPanel /> para edición rápida
 * desde el ItemDetailPanel. NO requiere abrir el modal completo del producto/MP.
 *
 * Props:
 *   - itemType, itemId
 *   - itemName, warehouseName (para el header)
 *   - warehouseId (almacén pre-seleccionado en el panel)
 *   - unit, leadTimeDays
 *   - onClose
 */
export default function QuickLevelsModal({
  itemType, itemId,
  itemName, warehouseName,
  warehouseId, unit, leadTimeDays,
  onClose,
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-lg max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start justify-between z-10">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-ink-primary truncate">
              Niveles de inventario
            </h2>
            <p className="text-xs text-ink-muted mt-0.5 truncate">
              {itemName} · {warehouseName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="btn-ghost btn-icon text-ink-muted shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Contenido */}
        <div className="px-5 py-4">
          <InventoryLevelsPanel
            itemType={itemType}
            itemId={itemId}
            leadTimeDays={leadTimeDays}
            unit={unit}
            initialWarehouseId={warehouseId}
            // El lead_time se edita desde el detalle del producto/MP
            // (no aquí), por eso onLeadTimeChange es no-op.
            onLeadTimeChange={() => {}}
            readOnly={false}
          />

          <p className="text-[11px] text-ink-muted mt-3 text-center">
            Para cambiar el lead time, edita el producto/MP desde su catálogo.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-line-subtle px-5 py-3 flex justify-end">
          <button onClick={onClose} className="btn-secondary btn-sm">Cerrar</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
