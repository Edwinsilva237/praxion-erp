import api from './axios'

const BASE = '/overhead'

export const overheadApi = {
  // ── Items ──────────────────────────────────────────────────────────────────
  listItems: (params) =>
    api.get(`${BASE}/items`, { params }).then(r => r.data),

  createItem: (body) =>
    api.post(`${BASE}/items`, body).then(r => r.data),

  updateItem: (id, patch) =>
    api.patch(`${BASE}/items/${id}`, patch).then(r => r.data),

  // ── Períodos ───────────────────────────────────────────────────────────────
  listPeriods: (params) =>
    api.get(`${BASE}/periods`, { params }).then(r => r.data),

  ensurePeriods: (body) =>
    api.post(`${BASE}/periods/ensure-current`, body).then(r => r.data),

  updatePeriod: (id, patch) =>
    api.patch(`${BASE}/periods/${id}`, patch).then(r => r.data),

  // ── Cierre de mes ──────────────────────────────────────────────────────────
  closeMonth: (body) =>
    api.post(`${BASE}/close-month`, body).then(r => r.data),

  // ── Reporte de varianza ────────────────────────────────────────────────────
  getVarianceReport: (params) =>
    api.get(`${BASE}/variance-report`, { params }).then(r => r.data),

  // ── Snapshots de orden ─────────────────────────────────────────────────────
  getOrderSnapshots: (orderId) =>
    api.get(`${BASE}/snapshots`, { params: { orderId } }).then(r => r.data),
}
