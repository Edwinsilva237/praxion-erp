import api from './axios'

const B = '/invoicing'

export const invoicingApi = {
  // ── Facturas ───────────────────────────────────────────────────────────
  list:        (p) => api.get(`${B}/invoices`, { params: p }).then(r => r.data),
  get:         (id) => api.get(`${B}/invoices/${id}`).then(r => r.data),

  // Crear
  fromRemission:  (body) => api.post(`${B}/invoices/from-remission`,  body).then(r => r.data),
  fromRemissions: (body) => api.post(`${B}/invoices/from-remissions`, body).then(r => r.data),
  direct:         (body) => api.post(`${B}/invoices/direct`,           body).then(r => r.data),
  occasional:     (body) => api.post(`${B}/invoices/occasional`,       body).then(r => r.data),

  // Editar metadatos de un borrador (no toca las líneas de producto)
  update:        (id, body) => api.patch(`${B}/invoices/${id}`, body).then(r => r.data),

  // Cancelar borrador (local)
  cancel:        (id, body) => api.post(`${B}/invoices/${id}/cancel`, body).then(r => r.data),

  // Timbrado. El backend puede responder de dos formas:
  //   - 200 con el resultado completo (modo síncrono / Redis no configurado)
  //   - 202 con { queued, jobId } — debemos hacer polling hasta que termine.
  // Esta función oculta esa diferencia: la promesa siempre se resuelve con el
  // resultado final (o se rechaza con el error de timbrado). Así el componente
  // que llama no necesita saber si fue cola o no.
  stamp: async (id) => {
    const first = await api.post(`${B}/invoices/${id}/stamp`).then(r => ({
      data: r.data, status: r.status,
    }))
    if (first.status !== 202 || !first.data.queued) {
      // Modo síncrono — devolver tal cual.
      return first.data
    }
    // Modo cola: pollear cada 1s hasta 60s.
    const { jobId } = first.data
    const startedAt = Date.now()
    const TIMEOUT_MS = 60_000
    const INTERVAL_MS = 1_000
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, INTERVAL_MS))
      const { data: s } = await api.get(`${B}/invoices/${id}/stamp-status`, {
        params: { jobId },
      })
      if (s.status === 'completed') return s.result
      if (s.status === 'failed') {
        const err = new Error(s.error || 'El timbrado falló.')
        err.response = { data: { error: s.error } }
        throw err
      }
      // Estados intermedios: waiting / active / delayed → seguir polling.
    }
    const err = new Error('El timbrado está tardando más de lo normal. Revisa el panel de tareas o vuelve a intentarlo.')
    err.response = { data: { error: err.message } }
    throw err
  },

  // Estado de un job de timbrado en curso (uso interno; expuesto por si una
  // UI quiere mostrar progreso visual además del polling de stamp()).
  stampStatus: (id, jobId) =>
    api.get(`${B}/invoices/${id}/stamp-status`, { params: { jobId } }).then(r => r.data),

  // Reconcilia una factura en limbo (timbrada en Facturapi pero local 'draft').
  // Devuelve { reconciled: bool, uuid?, folio?, facturapi_id?, reason? }.
  reconcile: (id) =>
    api.post(`${B}/invoices/${id}/reconcile`).then(r => r.data),

  // Email
  sendEmail:     (id, emails) =>
    api.post(`${B}/invoices/${id}/send-email`, { emails }).then(r => r.data),

  // Cancelación ante SAT
  cancelSat:     (id, body) =>
    api.post(`${B}/invoices/${id}/cancel-sat`, body).then(r => r.data),

  // Sincronización con SAT (consulta a Facturapi y reconcilia local)
  syncSat:       (id) =>
    api.post(`${B}/invoices/${id}/sync-sat`).then(r => r.data),

  // Acuse de cancelación (prueba legal). Solo facturas ya canceladas.
  downloadCancellationReceiptPdf: (id) =>
    api.get(`${B}/invoices/${id}/cancellation-receipt/pdf`, { responseType: 'blob' }),
  downloadCancellationReceiptXml: (id) =>
    api.get(`${B}/invoices/${id}/cancellation-receipt/xml`, { responseType: 'blob' }),

  // Nota de crédito
  creditNote:    (id, body) =>
    api.post(`${B}/invoices/${id}/credit-note`, body).then(r => r.data),
  downloadCreditNoteXml: (invoiceId, cnId) =>
    api.get(`${B}/invoices/${invoiceId}/credit-note/${cnId}/xml`, { responseType: 'blob' }),
  downloadCreditNotePdf: (invoiceId, cnId) =>
    api.get(`${B}/invoices/${invoiceId}/credit-note/${cnId}/pdf`, { responseType: 'blob' }),

  // Complemento de pago (CFDI tipo P para facturas PPD)
  paymentComplement: (id, body) =>
    api.post(`${B}/invoices/${id}/payment-complement`, body).then(r => r.data),
  downloadComplementXml: (invoiceId, complementFacturapiId) =>
    api.get(`${B}/invoices/${invoiceId}/payment-complement/${complementFacturapiId}/xml`, { responseType: 'blob' }),
  downloadComplementPdf: (invoiceId, complementFacturapiId) =>
    api.get(`${B}/invoices/${invoiceId}/payment-complement/${complementFacturapiId}/pdf`, { responseType: 'blob' }),

  // Descargas — devuelven blob para que el componente cree URL temporal
  downloadXmlStamped: (id) =>
    api.get(`${B}/invoices/${id}/xml-stamped`, { responseType: 'blob' }),
  downloadPdfStamped: (id) =>
    api.get(`${B}/invoices/${id}/pdf-stamped`, { responseType: 'blob' }),
  downloadXmlDraft:   (id) =>
    api.get(`${B}/invoices/${id}/xml`, { responseType: 'blob' }),
  downloadPdfDraft:   (id) =>
    api.get(`${B}/invoices/${id}/pdf`, { responseType: 'blob' }),
}
