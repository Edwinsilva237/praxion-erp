import api from './axios'

const BASE = '/product-lots'

export const productLotsApi = {
  /**
   * Lista lotes de producto disponibles para despachar.
   * Ordenados FEFO (primero vence, primero sale).
   *
   * params:
   *   productId      UUID (recomendado para filtrar)
   *   warehouseId    UUID opcional
   *   status         'active' (default) | 'all' | 'quarantined' | etc.
   *   onlyAvailable  'true' (default) — solo lotes con quantity_remaining > 0
   */
  list: (params) =>
    api.get(BASE, { params }).then(r => r.data),
}
