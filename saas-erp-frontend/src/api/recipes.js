import api from './axios'

const BASE = '/recipes'

export const recipesApi = {
  /** GET /api/recipes?productId&vigentOnly=true&isActive */
  list: (params) =>
    api.get(BASE, { params }).then(r => r.data),

  /** GET /api/recipes/:id — incluye componentes */
  get: (id) =>
    api.get(`${BASE}/${id}`).then(r => r.data),

  /**
   * POST /api/recipes — crea nueva versión.
   * Si el producto ya tiene receta vigente, esta queda como nueva versión
   * y la anterior se cierra automáticamente con valid_until=NOW().
   */
  create: (body) =>
    api.post(BASE, body).then(r => r.data),

  /** PATCH /api/recipes/:id — solo metadata (name, is_active) */
  update: (id, patch) =>
    api.patch(`${BASE}/${id}`, patch).then(r => r.data),
}
