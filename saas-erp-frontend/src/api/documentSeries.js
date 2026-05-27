import api from './axios'

const B = '/document-series'

export const documentSeriesApi = {
  meta: () => api.get(`${B}/meta`).then(r => r.data),

  list: (params = {}) =>
    api.get(B, { params: { includeInactive: true, ...params } })
      .then(r => r.data),

  get:    (id)        => api.get(`${B}/${id}`).then(r => r.data),
  create: (body)      => api.post(B, body).then(r => r.data),
  update: (id, body)  => api.patch(`${B}/${id}`, body).then(r => r.data),
  delete: (id)        => api.delete(`${B}/${id}`).then(r => r.data),
}

// Labels y agrupación se cargan del backend (GET /meta) en runtime
// para no duplicar la lista. Aquí mantenemos fallback estático por si
// el endpoint falla.
export const ENTITY_LABELS_FALLBACK = {
  invoice:              'Facturas (CFDI)',
  sales_order:          'Pedidos de venta',
  delivery_note:        'Remisiones',
  sales_return:         'Devoluciones de venta',
  quotation:            'Cotizaciones',
  purchase_order:       'Órdenes de compra',
  supplier_receipt:     'Recepciones de proveedor',
  inventory_adjustment: 'Ajustes de inventario',
}

export const ENTITY_GROUPS_FALLBACK = {
  ventas:     ['invoice', 'sales_order', 'delivery_note', 'sales_return', 'quotation'],
  compras:    ['purchase_order', 'supplier_receipt'],
  inventario: ['inventory_adjustment'],
}

export const GROUP_LABELS = {
  ventas:     'Ventas',
  compras:    'Compras',
  inventario: 'Inventario',
}
