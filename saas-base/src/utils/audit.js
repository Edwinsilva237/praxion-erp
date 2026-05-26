'use strict'

const { query } = require('../db')
const logger = require('../config/logger')

/**
 * Registra una acción en el log de auditoría.
 * Falla silenciosamente para no interrumpir el flujo principal.
 *
 * @param {object} opts
 * @param {string} opts.tenantId    - UUID del tenant
 * @param {string} opts.userId      - UUID del usuario que ejecutó la acción
 * @param {string} opts.action      - Formato: "resource.verb" — ej: "user.invited"
 * @param {string} opts.resource    - Nombre del recurso afectado — ej: "users"
 * @param {string} [opts.resourceId]  - UUID del objeto afectado
 * @param {object} [opts.payload]     - Datos relevantes (sin contraseñas ni tokens)
 * @param {string} [opts.ipAddress]   - IP del request
 * @param {string} [opts.userAgent]   - User-Agent del request
 */
async function audit({
  tenantId,
  userId,
  action,
  resource,
  resourceId = null,
  payload = {},
  ipAddress = null,
  userAgent = null,
}) {
  try {
    await query(
      `INSERT INTO audit_logs
         (tenant_id, user_id, action, resource, resource_id, payload, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        userId || null,
        action,
        resource,
        resourceId || null,
        JSON.stringify(payload),
        ipAddress || null,
        userAgent || null,
      ]
    )
  } catch (err) {
    // La auditoría nunca debe interrumpir el flujo principal
    logger.error('Failed to write audit log', {
      action,
      resource,
      error: err.message,
    })
  }
}

/**
 * Extrae contexto de auditoría del objeto req de Express.
 * Uso: const ctx = auditContext(req)
 */
function auditContext(req) {
  return {
    tenantId:  req.tenant?.id,
    userId:    req.auth?.userId,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }
}

module.exports = { audit, auditContext }
