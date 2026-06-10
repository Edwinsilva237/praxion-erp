import api from './axios'

export const productsApi = {
  list: (params) =>
    api.get('/products', { params }).then((r) => r.data),

  get: (id) =>
    api.get(`/products/${id}`).then((r) => r.data),

  create: (body) =>
    api.post('/products', body).then((r) => r.data),

  update: (id, body) =>
    api.patch(`/products/${id}`, body).then((r) => r.data),

  // Borrado (solo admin; el backend rechaza si tiene movimientos asociados)
  remove: (id) =>
    api.delete(`/products/${id}`).then((r) => r.data),

  // Specs de calidad (solo esquineros)
  getQualitySpecs: (id) =>
    api.get(`/products/${id}/quality-specs`).then((r) => r.data),

  addQualitySpec: (id, body) =>
    api.post(`/products/${id}/quality-specs`, body).then((r) => r.data),

  // ── Paquetes (bundles): combos con precio especial prorrateado ─────────
  listBundles: (params) =>
    api.get('/products/bundles', { params }).then((r) => r.data),

  getBundle: (bundleId) =>
    api.get(`/products/bundles/${bundleId}`).then((r) => r.data),

  // Líneas componente por 1 paquete, con precio prorrateado
  explodeBundle: (bundleId) =>
    api.get(`/products/bundles/${bundleId}/explode`).then((r) => r.data),

  createBundle: (body) =>
    api.post('/products/bundles', body).then((r) => r.data),

  updateBundle: (bundleId, body) =>
    api.patch(`/products/bundles/${bundleId}`, body).then((r) => r.data),

  deleteBundle: (bundleId) =>
    api.delete(`/products/bundles/${bundleId}`).then((r) => r.data),

  // Presentaciones de venta
  listPackOptions: (id) =>
    api.get(`/products/${id}/pack-options`).then((r) => r.data),

  addPackOption: (id, body) =>
    api.post(`/products/${id}/pack-options`, body).then((r) => r.data),

  updatePackOption: (id, packOptionId, body) =>
    api.patch(`/products/${id}/pack-options/${packOptionId}`, body).then((r) => r.data),

  deletePackOption: (id, packOptionId) =>
    api.delete(`/products/${id}/pack-options/${packOptionId}`).then((r) => r.data),

  // ── Adjuntos: imagen (única) + ficha técnica (múltiples PDFs) ──────────
  listAttachments: (id, category) =>
    api.get(`/products/${id}/attachments`, { params: category ? { category } : {} })
       .then((r) => r.data),

  uploadAttachment: (id, file, category = 'technical_sheet', description) => {
    const form = new FormData()
    form.append('file', file)
    form.append('category', category)
    if (description) form.append('description', description)
    return api.post(`/products/${id}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => r.data)
  },

  // Devuelve blob para que el componente cree object URL (imagen o descarga).
  downloadAttachment: (id, attachmentId) =>
    api.get(`/products/${id}/attachments/${attachmentId}/download`,
            { responseType: 'blob' }).then((r) => r.data),

  deleteAttachment: (id, attachmentId) =>
    api.delete(`/products/${id}/attachments/${attachmentId}`).then((r) => r.data),
}
