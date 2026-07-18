'use strict'

/**
 * Mig 231 — agrega 'fiscal_csf' y 'fiscal_32d' al enum attachment_category.
 *
 * Para la feature de DISTRIBUCIÓN DE DOCUMENTOS FISCALES: el tenant guarda su
 * propia Constancia de Situación Fiscal (CSF) y su Opinión de Cumplimiento
 * (art. 32-D CFF) como attachments a nivel tenant (entity_type='tenant'), para
 * luego enviarlas por correo a sus clientes.
 *
 * Mismo patrón que mig 084 / 199 / 213 / 230: `ALTER TYPE ... ADD VALUE` solo
 * agrega el valor (NO lo usa en esta misma migración → seguro dentro del
 * BEGIN/COMMIT del runner en PG12+), IF NOT EXISTS = idempotente. Se hace en
 * migración APARTE de las tablas (mig 232) para no mezclar ADD VALUE con DDL
 * que pudiera referenciar el enum en la misma transacción.
 */

const up = `
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'fiscal_csf';
  ALTER TYPE attachment_category ADD VALUE IF NOT EXISTS 'fiscal_32d';
`

// Postgres no permite quitar valores de un enum; el down es no-op.
const down = `
  -- irreversible: Postgres no soporta DROP VALUE en un enum.
`

module.exports = { up, down }
