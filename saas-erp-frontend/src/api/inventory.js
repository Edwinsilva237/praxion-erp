import api from './axios'

const BASE = '/inventory'

export const inventoryApi = {
  // ── Almacenes ──────────────────────────────────────────────────────────────
  getWarehouses: () =>
    api.get(`${BASE}/warehouses`).then(r => r.data),

  // ── Resumen y stock ───────────────────────────────────────────────────────
  getSummary: () =>
    api.get(`${BASE}/summary`).then(r => r.data),

  getStock: (params) =>
    api.get(`${BASE}/stock`, { params }).then(r => r.data),

  // ── Kardex ────────────────────────────────────────────────────────────────
  getMovements: (params) =>
    api.get(`${BASE}/movements`, { params }).then(r => r.data),

  getMovement: (id) =>
    api.get(`${BASE}/movements/${id}`).then(r => r.data),

  // ── Documentos de ajuste ──────────────────────────────────────────────────
  listAdjustments: (params) =>
    api.get(`${BASE}/adjustments`, { params }).then(r => r.data),

  getAdjustment: (id) =>
    api.get(`${BASE}/adjustments/${id}`).then(r => r.data),

  createAdjustment: (body) =>
    api.post(`${BASE}/adjustments`, body).then(r => r.data),

  cancelAdjustment: (id, body) =>
    api.post(`${BASE}/adjustments/${id}/cancel`, body).then(r => r.data),

  // ── Recalcular saldos desde el kardex ─────────────────────────────────────
  // apply=false → vista previa del diff; apply=true → aplica.
  recomputeStock: (apply = false) =>
    api.post(`${BASE}/recompute-stock`, { apply }).then(r => r.data),

  // ── Editar el costo unitario (avg_cost) de un artículo en un almacén ───────
  setStockCost: ({ itemType, itemId, warehouseId, status = 'available', unitCost, note }) =>
    api.post(`${BASE}/stock/cost`, { itemType, itemId, warehouseId, status, unitCost, note }).then(r => r.data),

  // ── Liberar 2ª calidad (blocked → available) para poder venderla ──────────
  releaseBlockedStock: ({ itemId, warehouseId, quantity, note }) =>
    api.post(`${BASE}/stock/release-blocked`, { itemId, warehouseId, quantity, note }).then(r => r.data),

  // ── Traspaso entre almacenes (cantidad suelta o lotes completos) ──────────
  transferStock: ({ itemType, itemId, fromWarehouseId, toWarehouseId, quantity, lotIds, note }) =>
    api.post(`${BASE}/stock/transfer`, { itemType, itemId, fromWarehouseId, toWarehouseId, quantity, lotIds, note }).then(r => r.data),

  // Lotes activos con saldo de un artículo en un almacén (para elegir qué mover)
  getTransferableLots: ({ itemType, itemId, warehouseId }) =>
    api.get(`${BASE}/stock/transferable-lots`, {
      params: { item_type: itemType, item_id: itemId, warehouse_id: warehouseId },
    }).then(r => r.data),

  // ── Autocomplete de items ─────────────────────────────────────────────────
  searchItems: (params) =>
    api.get(`${BASE}/items/search`, { params }).then(r => r.data),

  // ── Niveles de stock ──────────────────────────────────────────────────────
  listLevels: (params) =>
    api.get(`${BASE}/levels`, { params }).then(r => r.data),

  getLevelsSummary: () =>
    api.get(`${BASE}/levels/summary`).then(r => r.data),

  getLevelsByItem: (itemType, itemId) =>
    api.get(`${BASE}/levels/${itemType}/${itemId}`).then(r => r.data),

  upsertLevel: (itemType, itemId, warehouseId, body) =>
    api.put(`${BASE}/levels/${itemType}/${itemId}/${warehouseId}`, body).then(r => r.data),

  removeLevel: (itemType, itemId, warehouseId) =>
    api.delete(`${BASE}/levels/${itemType}/${itemId}/${warehouseId}`).then(r => r.data),

  /**
   * Sugeridor automatico de reorder_point.
   * params = { warehouseId, leadTimeDays, safetyStock, days }
   */
  getConsumption: (itemType, itemId, params) =>
    api.get(`${BASE}/items/${itemType}/${itemId}/consumption`, { params }).then(r => r.data),

  /**
   * Detalle completo de un item en un almacen para el panel lateral.
   * Retorna: { item, warehouse, stock, level, movements, suggestedQty }
   */
  getItemDetail: (itemType, itemId, warehouseId) =>
    api.get(`${BASE}/items/${itemType}/${itemId}/detail`, {
      params: { warehouseId }
    }).then(r => r.data),

  // ── Vales de salida (consumo interno a áreas) ─────────────────────────────
  listConsumptionAreas: (includeInactive = false) =>
    api.get(`${BASE}/consumption-areas`, {
      params: includeInactive ? { include_inactive: 1 } : {},
    }).then(r => r.data),

  createConsumptionArea: (name) =>
    api.post(`${BASE}/consumption-areas`, { name }).then(r => r.data),

  updateConsumptionArea: (id, body) =>
    api.patch(`${BASE}/consumption-areas/${id}`, body).then(r => r.data),

  listConsumptionVouchers: (params) =>
    api.get(`${BASE}/consumption-vouchers`, { params }).then(r => r.data),

  getConsumptionVoucher: (id) =>
    api.get(`${BASE}/consumption-vouchers/${id}`).then(r => r.data),

  createConsumptionVoucher: (body) =>
    api.post(`${BASE}/consumption-vouchers`, body).then(r => r.data),

  cancelConsumptionVoucher: (id, reason) =>
    api.post(`${BASE}/consumption-vouchers/${id}/cancel`, { reason }).then(r => r.data),

  consumptionByArea: (params) =>
    api.get(`${BASE}/consumption-vouchers/summary-by-area`, { params }).then(r => r.data),

  getConsumptionVoucherPdf: (id) =>
    api.get(`${BASE}/consumption-vouchers/${id}/pdf`, { responseType: 'blob' }).then(r => r.data),

  getConsumptionVoucherSignature: (id) =>
    api.get(`${BASE}/consumption-vouchers/${id}/signature`, { responseType: 'blob' }).then(r => r.data),
}
