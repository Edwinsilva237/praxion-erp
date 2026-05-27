'use strict'

/**
 * DEPRECATED — wrapper de backcompat sobre documentSeriesService.
 *
 * Toda la lógica se movió a `modules/document-series/documentSeriesService.js`
 * cuando se generalizó la tabla `tenant_invoice_series` → `tenant_document_series`
 * (migración 148). Este módulo se mantiene solo para que `invoiceService.js`
 * y otros consumidores no rompan. Internamente delega forzando entity_type='invoice'.
 *
 * Las nuevas integraciones deben importar `documentSeriesService` directamente.
 */

const svc = require('../document-series/documentSeriesService')

async function listSeries({ tenantId, fiscalProfileId = null, includeInactive = false }) {
  const all = await svc.listSeries({ tenantId, entityType: 'invoice', includeInactive })
  if (fiscalProfileId) return all.filter(s => s.fiscal_profile_id === fiscalProfileId)
  return all
}

async function getSeries({ tenantId, seriesId }) {
  return svc.getSeries({ tenantId, seriesId })
}

async function createSeries({ tenantId, fiscalProfileId, serie, folioNext, cfdiType, isDefault, notes, userId }) {
  return svc.createSeries({
    tenantId, entityType: 'invoice', fiscalProfileId,
    serie, folioNext, cfdiType, isDefault, notes, userId,
  })
}

const updateSeries  = (args) => svc.updateSeries(args)
const deleteSeries  = (args) => svc.deleteSeries(args)
const consumeNextFolio        = (args) => svc.consumeNextFolio(args)
const resolveSeriesForEmission = (args) => svc.resolveSeriesForEmission({ ...args, entityType: 'invoice' })

module.exports = {
  listSeries, getSeries, createSeries, updateSeries, deleteSeries,
  consumeNextFolio, resolveSeriesForEmission,
}
