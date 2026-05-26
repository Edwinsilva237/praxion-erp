import api from './axios'

const BASE = '/process-config'

export const processConfigApi = {
  // ── Config global ──────────────────────────────────────────────────────
  getConfig: () =>
    api.get(BASE).then(r => r.data),

  updateConfig: (patch) =>
    api.patch(BASE, patch).then(r => r.data),

  // ── Unidades ───────────────────────────────────────────────────────────
  listUnits: (params) =>
    api.get(`${BASE}/units`, { params }).then(r => r.data),

  createUnit: (body) =>
    api.post(`${BASE}/units`, body).then(r => r.data),

  updateUnit: (id, patch) =>
    api.patch(`${BASE}/units/${id}`, patch).then(r => r.data),

  // ── Conversiones ──────────────────────────────────────────────────────
  listUnitConversions: (params) =>
    api.get(`${BASE}/unit-conversions`, { params }).then(r => r.data),

  createUnitConversion: (body) =>
    api.post(`${BASE}/unit-conversions`, body).then(r => r.data),

  updateUnitConversion: (id, patch) =>
    api.patch(`${BASE}/unit-conversions/${id}`, patch).then(r => r.data),

  // ── Tipos de almacén ───────────────────────────────────────────────────
  listWarehouseTypes: (params) =>
    api.get(`${BASE}/warehouse-types`, { params }).then(r => r.data),

  createWarehouseType: (body) =>
    api.post(`${BASE}/warehouse-types`, body).then(r => r.data),

  updateWarehouseType: (id, patch) =>
    api.patch(`${BASE}/warehouse-types/${id}`, patch).then(r => r.data),

  // ── Tipos de merma ─────────────────────────────────────────────────────
  listScrapTypes: (params) =>
    api.get(`${BASE}/scrap-types`, { params }).then(r => r.data),

  createScrapType: (body) =>
    api.post(`${BASE}/scrap-types`, body).then(r => r.data),

  updateScrapType: (id, patch) =>
    api.patch(`${BASE}/scrap-types/${id}`, patch).then(r => r.data),

  // ── Grados de calidad ──────────────────────────────────────────────────
  listQualityGrades: (params) =>
    api.get(`${BASE}/quality-grades`, { params }).then(r => r.data),

  createQualityGrade: (body) =>
    api.post(`${BASE}/quality-grades`, body).then(r => r.data),

  updateQualityGrade: (id, patch) =>
    api.patch(`${BASE}/quality-grades/${id}`, patch).then(r => r.data),

  // ── Roles de turno ─────────────────────────────────────────────────────
  listShiftRoles: (params) =>
    api.get(`${BASE}/shift-roles`, { params }).then(r => r.data),

  createShiftRole: (body) =>
    api.post(`${BASE}/shift-roles`, body).then(r => r.data),

  updateShiftRole: (id, patch) =>
    api.patch(`${BASE}/shift-roles/${id}`, patch).then(r => r.data),

  // ── Tipos de producto ──────────────────────────────────────────────────
  listProductKinds: (params) =>
    api.get(`${BASE}/product-kinds`, { params }).then(r => r.data),

  createProductKind: (body) =>
    api.post(`${BASE}/product-kinds`, body).then(r => r.data),

  updateProductKind: (id, patch) =>
    api.patch(`${BASE}/product-kinds/${id}`, patch).then(r => r.data),

  // ── Alérgenos ──────────────────────────────────────────────────────────
  listAllergens: (params) =>
    api.get(`${BASE}/allergens`, { params }).then(r => r.data),

  createAllergen: (body) =>
    api.post(`${BASE}/allergens`, body).then(r => r.data),

  updateAllergen: (id, patch) =>
    api.patch(`${BASE}/allergens/${id}`, patch).then(r => r.data),
}
