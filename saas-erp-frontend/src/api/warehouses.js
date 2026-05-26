import api from './axios'

const BASE = '/warehouses'

export const warehousesApi = {
  // Listar almacenes (por defecto solo activos; pasa includeInactive=true para todos)
  list: ({ type, includeInactive } = {}) =>
    api.get(BASE, {
      params: {
        type:             type || undefined,
        include_inactive: includeInactive ? 'true' : undefined,
      },
    }).then(r => r.data),

  getById: (id) =>
    api.get(`${BASE}/${id}`).then(r => r.data),

  /**
   * body = {
   *   name, type, resin_type?, description?,
   *   is_active?, make_default?
   * }
   */
  create: (body) =>
    api.post(BASE, body).then(r => r.data),

  /** patch acepta: name, resin_type, description, is_active */
  update: (id, patch) =>
    api.patch(`${BASE}/${id}`, patch).then(r => r.data),

  /** Marca este almacén como default de su tipo (desmarca al actual default). */
  setDefault: (id) =>
    api.post(`${BASE}/${id}/set-default`).then(r => r.data),

  /** Elimina (rechaza si tiene stock o movimientos). */
  remove: (id) =>
    api.delete(`${BASE}/${id}`).then(r => r.data),
}
