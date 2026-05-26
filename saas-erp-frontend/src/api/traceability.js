import api from './axios'

const BASE = '/traceability'

export const traceabilityApi = {
  /** Busca lotes por número o lote del proveedor. type: 'all' | 'raw' | 'product' */
  search: (q, type = 'all') =>
    api.get(`${BASE}/search`, { params: { q, type } }).then(r => r.data),

  /** Cadena completa de un lote PT: MP que entró + clientes que recibieron */
  getProductLot: (id) =>
    api.get(`${BASE}/product-lot/${id}`).then(r => r.data),

  /** Cadena hacia adelante de un lote MP: PTs producidos + clientes finales (recall) */
  getRawMaterialLot: (id) =>
    api.get(`${BASE}/raw-material-lot/${id}`).then(r => r.data),
}
