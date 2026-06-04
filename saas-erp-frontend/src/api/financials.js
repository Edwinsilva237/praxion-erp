import api from './axios'

const B = '/financials'

export const financialsApi = {
  // ── CXC ────────────────────────────────────────────────────────────────
  listCXC:           (p) => api.get(`${B}/cxc`, { params: p }).then(r => r.data),
  getCXC:            (id) => api.get(`${B}/cxc/${id}`).then(r => r.data),
  customerStatement: (partnerId, p) =>
    api.get(`${B}/customers/${partnerId}/statement`, { params: p }).then(r => r.data),

  // ── Pagos ──────────────────────────────────────────────────────────────
  // Historial de pagos RECIBIDOS (cobros reales). Params: partnerId, from, to, method, page, limit.
  listPayments:      (p) => api.get(`${B}/payments`, { params: p }).then(r => r.data),
  registerPayment:   (body) => api.post(`${B}/cxc/payments`, body).then(r => r.data),
  applyAdvance:      (advanceId, body) =>
    api.post(`${B}/cxc/advances/${advanceId}/apply`, body).then(r => r.data),

  // Timbra complemento faltante para una factura PPD ya cobrada
  stampMissingComplement: (arId, body) =>
    api.post(`${B}/cxc/${arId}/stamp-complement`, body).then(r => r.data),

  // Complementos de pago — descargas y envío por correo desde CXC
  downloadComplementPdf: (facturapiId) =>
    api.get(`${B}/payment-complements/${facturapiId}/pdf`, { responseType: 'blob' }),
  downloadComplementXml: (facturapiId) =>
    api.get(`${B}/payment-complements/${facturapiId}/xml`, { responseType: 'blob' }),
  sendComplementEmail: (complementId, emails) =>
    api.post(`${B}/payment-complements/${complementId}/send-email`, { emails }).then(r => r.data),

  // Recibo de pago (PDF no fiscal) — usable para remisiones y facturas PUE
  downloadReceiptPdf: (paymentId) =>
    api.get(`${B}/payments/${paymentId}/receipt-pdf`, { responseType: 'blob' }),
  sendReceiptEmail: (paymentId, emails) =>
    api.post(`${B}/payments/${paymentId}/receipt-email`, { emails }).then(r => r.data),

  // Conciliación bancaria: dado un monto recibido, busca combinaciones
  // de facturas pendientes que sumen ese monto.
  matchPayment: (body) =>
    api.post(`${B}/payment-matcher`, body).then(r => r.data),
}
