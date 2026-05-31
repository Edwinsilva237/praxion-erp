'use strict'

/**
 * SaaS v2 — Service del Process Template (configuración global del tenant).
 *
 * El primer módulo del SaaS v2. Responsable de:
 *  - Leer la configuración global (flags) del tenant.
 *  - Actualizarla con validaciones de dominio.
 *  - Mantener auditoría de cambios vía updated_by_user_id y audit_logs.
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.1.
 *
 * Política de cambios:
 *  - cost_method y treat_abnormal_scrap_as_loss afectan retroactivamente
 *    cálculos. En una migration futura se versionarán en tabla satélite
 *    (tenant_cost_config_history). Por ahora se registran en audit_logs.
 */

const { query } = require('../../db')
const { audit } = require('../../utils/audit')

// Whitelist de columnas modificables vía PATCH. Cambios en orden o adición
// requieren actualizar también ALLOWED_UPDATES y los CHECK constraints
// correspondientes en la migration 116.
const ALLOWED_UPDATES = [
  'uses_lots',
  'uses_expiry',
  'uses_fefo',
  'uses_handover',
  'uses_supervisor',
  'supervisor_validates',
  'pt_goes_to_wip_first',
  'mp_goes_to_wip_first',
  'allow_second_quality_in_order',
  'default_intra_shift_proration',
  'cost_method',
  'treat_abnormal_scrap_as_loss',
  'allergen_mode',
  'expiry_alert_days',
  'lot_number_pattern',
  'operation_mode',
  'allow_adhoc_shifts',
  'simplified_overhead',
  // §142: flags para atributos específicos de plástico
  'uses_resin_types',
  'tracks_material_origin',
  // §49: límites de horas por operador (mig 156)
  'max_hours_per_day',
  'max_hours_per_week',
  // §53: reversión de validación (mig 163)
  'allow_revert_validation',
  'revert_validation_window_hours',
  'block_revert_if_order_fulfilled',
  'block_revert_if_period_closed',
  'require_revert_dual_approval',
  // Micro pyme: iniciar turno directo sin programación (mig 176)
  'allow_self_start_shift',
  // Micro pyme: permitir crear la orden al iniciar (inicio rápido) (mig 179)
  'allow_quick_order',
  // Facturación: retenciones en todas las modalidades (mig 177)
  'enable_retentions',
]

// Conjuntos de valores enum válidos. Duplican los CHECK constraints en SQL,
// pero permiten devolver un 400 con mensaje claro antes de llegar al DB.
const ENUM_VALUES = {
  default_intra_shift_proration: ['time', 'units', 'weight', 'manual'],
  cost_method:                   ['weighted_avg', 'fifo', 'standard'],
  allergen_mode:                 ['strict', 'priority_only', 'alert_only'],
  operation_mode:                ['industrial', 'small', 'micro'],
}

/**
 * Devuelve la configuración del tenant. Garantiza una fila — si por algún
 * motivo no existe (tenants viejos, races), la crea con defaults.
 */
async function getConfig({ tenantId }) {
  let { rows } = await query(
    `SELECT * FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  if (rows.length === 0) {
    // Self-heal: el seed de migration 116 debió crearla, pero si no
    // existe la creamos on-demand con defaults.
    await query(
      `INSERT INTO tenant_process_config (tenant_id) VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId]
    )
    const refetch = await query(
      `SELECT * FROM tenant_process_config WHERE tenant_id = $1`,
      [tenantId]
    )
    rows = refetch.rows
  }
  return rows[0]
}

/**
 * Actualiza la configuración del tenant. Solo acepta campos en ALLOWED_UPDATES
 * y valida enums antes de tocar DB. Retorna la fila actualizada.
 */
async function updateConfig({ tenantId, userId, updates, ipAddress, userAgent }) {
  if (!updates || typeof updates !== 'object') {
    const err = new Error('updates debe ser un objeto.')
    err.status = 400
    throw err
  }

  // Filtrar a campos permitidos
  const cleaned = {}
  for (const [k, v] of Object.entries(updates)) {
    if (ALLOWED_UPDATES.includes(k)) cleaned[k] = v
  }
  if (Object.keys(cleaned).length === 0) {
    const err = new Error('No hay campos válidos para actualizar.')
    err.status = 400
    throw err
  }

  // Validar enums
  for (const [k, allowed] of Object.entries(ENUM_VALUES)) {
    if (cleaned[k] !== undefined && cleaned[k] !== null && !allowed.includes(cleaned[k])) {
      const err = new Error(`${k} debe ser uno de: ${allowed.join(', ')}.`)
      err.status = 400
      throw err
    }
  }

  // Validar tipos booleanos básicos (los demás los protege el CHECK)
  const BOOLEAN_FIELDS = [
    'uses_lots','uses_expiry','uses_fefo','uses_handover','uses_supervisor',
    'supervisor_validates','pt_goes_to_wip_first','mp_goes_to_wip_first',
    'allow_second_quality_in_order','treat_abnormal_scrap_as_loss',
    'allow_adhoc_shifts','simplified_overhead',
  ]
  for (const k of BOOLEAN_FIELDS) {
    if (cleaned[k] !== undefined && typeof cleaned[k] !== 'boolean') {
      const err = new Error(`${k} debe ser boolean.`)
      err.status = 400
      throw err
    }
  }

  // Validación específica de expiry_alert_days (entero >= 0 o null)
  if (cleaned.expiry_alert_days !== undefined && cleaned.expiry_alert_days !== null) {
    if (!Number.isInteger(cleaned.expiry_alert_days) || cleaned.expiry_alert_days < 0) {
      const err = new Error('expiry_alert_days debe ser un entero >= 0 o null.')
      err.status = 400
      throw err
    }
  }

  // Límites de horas: enteros dentro de rango. La BD también lo protege con CHECK.
  if (cleaned.max_hours_per_day !== undefined) {
    if (!Number.isInteger(cleaned.max_hours_per_day) || cleaned.max_hours_per_day < 1 || cleaned.max_hours_per_day > 24) {
      const err = new Error('max_hours_per_day debe ser un entero entre 1 y 24.')
      err.status = 400
      throw err
    }
  }
  if (cleaned.max_hours_per_week !== undefined) {
    if (!Number.isInteger(cleaned.max_hours_per_week) || cleaned.max_hours_per_week < 1 || cleaned.max_hours_per_week > 168) {
      const err = new Error('max_hours_per_week debe ser un entero entre 1 y 168.')
      err.status = 400
      throw err
    }
  }

  // Snapshot previo para auditoría
  const before = await getConfig({ tenantId })

  // Construir UPDATE dinámico
  const setClauses = []
  const params = []
  let i = 1
  for (const [k, v] of Object.entries(cleaned)) {
    setClauses.push(`${k} = $${i++}`)
    params.push(v)
  }
  setClauses.push(`updated_by_user_id = $${i++}`)
  params.push(userId)
  params.push(tenantId)

  const { rows } = await query(
    `UPDATE tenant_process_config
     SET ${setClauses.join(', ')}
     WHERE tenant_id = $${i}
     RETURNING *`,
    params
  )

  // Auditoría con diff (sólo campos que cambiaron)
  const diff = {}
  for (const k of Object.keys(cleaned)) {
    if (before[k] !== cleaned[k]) {
      diff[k] = { from: before[k], to: cleaned[k] }
    }
  }

  if (Object.keys(diff).length > 0) {
    await audit({
      tenantId, userId,
      action: 'process_config.updated',
      resource: 'tenant_process_config',
      resourceId: tenantId,
      payload: { changes: diff },
      ipAddress, userAgent,
    })
  }

  return rows[0]
}

module.exports = {
  getConfig,
  updateConfig,
  ALLOWED_UPDATES,
  ENUM_VALUES,
}
