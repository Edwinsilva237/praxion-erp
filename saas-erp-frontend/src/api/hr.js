import api from './axios'

const B = '/hr'

export const hrApi = {
  // Empleados
  listEmployees: (params = {}) => api.get(`${B}/employees`, { params }).then(r => r.data),
  getEmployee:   (id)          => api.get(`${B}/employees/${id}`).then(r => r.data),
  createEmployee:(body)        => api.post(`${B}/employees`, body).then(r => r.data),
  updateEmployee:(id, body)    => api.patch(`${B}/employees/${id}`, body).then(r => r.data),
  removeEmployee:(id)          => api.delete(`${B}/employees/${id}`).then(r => r.data),

  // Vacaciones por empleado
  getVacations:  (id)          => api.get(`${B}/employees/${id}/vacations`).then(r => r.data),
  getLedger:     (id)          => api.get(`${B}/employees/${id}/vacations/ledger`).then(r => r.data),
  generatePeriods:(id)         => api.post(`${B}/employees/${id}/vacations/generate`).then(r => r.data),
  registerTaken: (id, body)    => api.post(`${B}/employees/${id}/vacations/taken`, body).then(r => r.data),
  registerPaid:  (id, body)    => api.post(`${B}/employees/${id}/vacations/paid`, body).then(r => r.data),
  registerAdjustment:(id, body)=> api.post(`${B}/employees/${id}/vacations/adjustment`, body).then(r => r.data),
  deleteEntry:   (id, entryId) => api.delete(`${B}/employees/${id}/vacations/ledger/${entryId}`).then(r => r.data),

  // Tabla de días por antigüedad (config del tenant)
  getRules:      ()            => api.get(`${B}/vacations/rules`).then(r => r.data),
  updateRules:   (rules)       => api.put(`${B}/vacations/rules`, { rules }).then(r => r.data),
  resetRules:    ()            => api.post(`${B}/vacations/rules/reset`).then(r => r.data),
}
