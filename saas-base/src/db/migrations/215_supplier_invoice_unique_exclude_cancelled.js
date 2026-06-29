'use strict'

/**
 * Mig 215 — La unicidad de factura de proveedor (UUID SAT y folio por proveedor)
 * deja de contar las CANCELADAS.
 *
 * Caso real: una factura de gasto se cargó mal (el sistema la leyó como USD y
 * multiplicó por el tipo de cambio). El usuario la CANCELÓ para recargarla bien,
 * pero al intentarlo el sistema respondía "Ya existe una factura con ese UUID /
 * folio" — porque `si_uuid_sat_unique` (UNIQUE global de uuid_sat) y
 * `si_number_partner_tenant` (UNIQUE tenant+proveedor+folio) NO distinguían
 * estado: una fila cancelada seguía reservando su UUID y su folio.
 *
 * Una factura cancelada no debe bloquear la recarga de la correcta. Se cambian
 * ambos UNIQUE por índices únicos PARCIALES que excluyen `status = 'cancelled'`:
 *   - puede haber N canceladas con el mismo UUID/folio,
 *   - pero a lo sumo UNA viva (no cancelada).
 * (Los NULL — uuid_sat de gastos sin CFDI, partner_id de genéricas — se siguen
 *  tratando como distintos por PostgreSQL, igual que antes.)
 */

const up = `
  ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS si_uuid_sat_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS si_uuid_sat_active_unique
    ON supplier_invoices (uuid_sat)
    WHERE status <> 'cancelled';

  ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS si_number_partner_tenant;
  CREATE UNIQUE INDEX IF NOT EXISTS si_number_partner_active_unique
    ON supplier_invoices (tenant_id, partner_id, invoice_number)
    WHERE status <> 'cancelled';
`

const down = `
  DROP INDEX IF EXISTS si_number_partner_active_unique;
  ALTER TABLE supplier_invoices
    ADD CONSTRAINT si_number_partner_tenant
    UNIQUE (tenant_id, partner_id, invoice_number);

  DROP INDEX IF EXISTS si_uuid_sat_active_unique;
  ALTER TABLE supplier_invoices
    ADD CONSTRAINT si_uuid_sat_unique
    UNIQUE (uuid_sat);
`

module.exports = { up, down }
