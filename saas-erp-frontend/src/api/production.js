import api from './axios'

const BASE = '/production'

export const productionApi = {
  // Cola de órdenes
  getQueue:        (params) => api.get(`${BASE}/queue`, { params }).then(r => r.data),

  // Órdenes
  listOrders:      (params) => api.get(`${BASE}/orders`, { params }).then(r => r.data),
  getOrder:        (id)     => api.get(`${BASE}/orders/${id}`).then(r => r.data),
  createOrder:     (body)   => api.post(`${BASE}/orders`, body).then(r => r.data),
  releaseOrder:    (id, body) => api.post(`${BASE}/orders/${id}/release`, body || {}).then(r => r.data),
  updateOrder:     (id, body) => api.patch(`${BASE}/orders/${id}`, body).then(r => r.data),
  cancelOrder:     (id)     => api.delete(`${BASE}/orders/${id}`).then(r => r.data),
  updatePriority:  (id, body) => api.patch(`${BASE}/orders/${id}/priority`, body).then(r => r.data),
  reorderQueue:    (ids)    => api.post(`${BASE}/orders/reorder`, { orderedIds: ids }).then(r => r.data),

  // Disponibilidad de MP
  previewStock:        (body) => api.post(`${BASE}/orders/preview-stock`, body).then(r => r.data),
  getStockAvailability:(id)   => api.get(`${BASE}/orders/${id}/stock-availability`).then(r => r.data),

  // Versionado de fórmula MP
  changeOrderFormula:    (id, body) => api.post(`${BASE}/orders/${id}/change-formula`, body).then(r => r.data),
  getOrderFormulaHistory:(id)       => api.get(`${BASE}/orders/${id}/formula-history`).then(r => r.data),

  // Turnos activos
  getActiveShifts:  ()         => api.get(`${BASE}/shifts/active`).then(r => r.data),
  getShift:         (id)       => api.get(`${BASE}/shifts/${id}`).then(r => r.data),
  getShiftSummary:  (id)       => api.get(`${BASE}/shifts/${id}/summary`).then(r => r.data),
  getShiftsHistory: (params)   => api.get(`${BASE}/shifts/history`, { params }).then(r => r.data),
  openShift:        (body)     => api.post(`${BASE}/shifts`, body).then(r => r.data),
  closeShift:       (id)       => api.post(`${BASE}/shifts/${id}/close`).then(r => r.data),
  forceCloseShift:  (id, body) => api.post(`${BASE}/shifts/${id}/force-close`, body).then(r => r.data),
  getHandoverSummary: (id)       => api.get(`${BASE}/shifts/${id}/handover-summary`).then(r => r.data),
  acceptHandover:     (id, body) => api.post(`${BASE}/shifts/${id}/accept-handover`, body).then(r => r.data),
  getClosedSummary:   (id)       => api.get(`${BASE}/shifts/${id}/closed-summary`).then(r => r.data),
  reopenShift:      (id)       => api.post(`${BASE}/shifts/${id}/reopen`).then(r => r.data),
  validateShift:    (id, body) => api.post(`${BASE}/shifts/${id}/validate`, body).then(r => r.data),

  // Captura operador
  capturePackage:  (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/packages`, body).then(r => r.data),
  loadMp:          (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/mp-loads`, body).then(r => r.data),
  recordScrap:     (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/scrap`, body).then(r => r.data),
  reportIncident:  (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/incidents`, body).then(r => r.data),

  // Edit/Delete de registros del turno — dual-mode:
  //  · Operador con turno active: sin razón. Delete sólo dentro de 30 min.
  //  · Supervisor en pending_handover: razón obligatoria, queda en shift_corrections.
  editPackage:    (shiftId, pkgId, body) => api.patch(`${BASE}/shifts/${shiftId}/packages/${pkgId}`, body).then(r => r.data),
  deletePackage:  (shiftId, pkgId, body) => api.delete(`${BASE}/shifts/${shiftId}/packages/${pkgId}`, { data: body || {} }).then(r => r.data),
  editScrap:      (shiftId, scrapId, body) => api.patch(`${BASE}/shifts/${shiftId}/scrap/${scrapId}`, body).then(r => r.data),
  deleteScrap:    (shiftId, scrapId, body) => api.delete(`${BASE}/shifts/${shiftId}/scrap/${scrapId}`, { data: body || {} }).then(r => r.data),
  editIncident:   (shiftId, incId, body) => api.patch(`${BASE}/shifts/${shiftId}/incidents/${incId}`, body).then(r => r.data),
  deleteIncident: (shiftId, incId, body) => api.delete(`${BASE}/shifts/${shiftId}/incidents/${incId}`, { data: body || {} }).then(r => r.data),
  editMpLoad:     (shiftId, mpId, body) => api.patch(`${BASE}/shifts/${shiftId}/mp-loads/${mpId}`, body).then(r => r.data),
  deleteMpLoad:   (shiftId, mpId)       => api.delete(`${BASE}/shifts/${shiftId}/mp-loads/${mpId}`).then(r => r.data),
  listCorrections: (shiftId) => api.get(`${BASE}/shifts/${shiftId}/corrections`).then(r => r.data),

  // Agregar registros faltantes (supervisor en validación pre-cierre)
  addPackage:  (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/packages/add`, body).then(r => r.data),
  addScrap:    (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/scrap/add`, body).then(r => r.data),
  addIncident: (shiftId, body) => api.post(`${BASE}/shifts/${shiftId}/incidents/add`, body).then(r => r.data),

  // Cierre explícito de órdenes
  closeOrder:  (orderId, body) => api.post(`${BASE}/orders/${orderId}/close`, body).then(r => r.data),
  reopenOrder: (orderId, body) => api.post(`${BASE}/orders/${orderId}/reopen`, body).then(r => r.data),

  // Turnos programados
  listScheduledShifts:  (params) => api.get(`${BASE}/scheduled-shifts`, { params }).then(r => r.data),
  getMyTodayShifts:     ()       => api.get(`${BASE}/scheduled-shifts/my-today`).then(r => r.data),
  getOperatorHours:     (params) => api.get(`${BASE}/scheduled-shifts/operator-hours`, { params }).then(r => r.data),
  setShiftActiveOrder:  (shiftId, orderId) => api.patch(`${BASE}/shifts/${shiftId}/active-order`, { orderId }).then(r => r.data),
  scheduleShift:        (body)   => api.post(`${BASE}/scheduled-shifts`, body).then(r => r.data),
  updateScheduledShift: (id, body) => api.patch(`${BASE}/scheduled-shifts/${id}`, body).then(r => r.data),
  confirmPresence:      (id)     => api.post(`${BASE}/scheduled-shifts/${id}/confirm`).then(r => r.data),

  // Runtime: miembros del turno activo y reasignación del responsable del handover
  listShiftMembers:     (shiftId) => api.get(`${BASE}/shifts/${shiftId}/members`).then(r => r.data),
  setHandoverResponsible: (shiftId, memberId) =>
    api.post(`${BASE}/shifts/${shiftId}/set-handover-responsible`, { memberId }).then(r => r.data),

  // Reversión de validación (mig 163)
  getRevertContext: (shiftId) => api.get(`${BASE}/shifts/${shiftId}/revert-context`).then(r => r.data),
  revertValidation: (shiftId, body) =>
    api.post(`${BASE}/shifts/${shiftId}/revert-validation`, body).then(r => r.data),

  // Configuración de turnos
  getShiftConfig:    ()      => api.get(`${BASE}/shift-config`).then(r => r.data),
  updateShiftConfig: (body)  => api.put(`${BASE}/shift-config`, body).then(r => r.data),
}
