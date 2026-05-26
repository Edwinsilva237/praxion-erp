import api from './axios'

const BASE = '/inventory/counts'

export const countsApi = {
  // Listar conteos con filtros
  list: (params) =>
    api.get(BASE, { params }).then(r => r.data),

  // Detalle del conteo (con líneas)
  get: (id) =>
    api.get(`${BASE}/${id}`).then(r => r.data),

  // Crear conteo (toma snapshot del sistema al iniciar)
  create: (body) =>
    api.post(BASE, body).then(r => r.data),

  // Capturar / actualizar una línea
  captureLine: (countId, lineId, body) =>
    api.put(`${BASE}/${countId}/lines/${lineId}`, body).then(r => r.data),

  // Marcar varias líneas como "sin diferencia" (físico = sistema)
  markNoDiff: (countId, lineIds) =>
    api.post(`${BASE}/${countId}/mark-no-diff`, { lineIds }).then(r => r.data),

  // Pasar a conciliación
  moveToReconcile: (countId) =>
    api.post(`${BASE}/${countId}/move-to-reconcile`).then(r => r.data),

  // Aplicar (genera el ajuste contable)
  apply: (countId, closingNotes) =>
    api.post(`${BASE}/${countId}/apply`, { closingNotes }).then(r => r.data),

  // Cancelar
  cancel: (countId, reason) =>
    api.post(`${BASE}/${countId}/cancel`, { reason }).then(r => r.data),

  /**
   * Sugerencia inteligente de items a contar.
   * body = { warehouseId, count, weights:{rotation,history,time,value}, randomness, excludeRecentlyCountedDays }
   * Retorna: { items: [...], meta: { universeSize, abcDistribution, ... } }
   */
  suggest: (body) =>
    api.post(`${BASE}/suggest`, body).then(r => r.data),
}
