'use strict'

/**
 * Agrega campos específicos de proveedor a business_partners.
 *
 * Distintos del crédito que YO doy a un cliente (credit_days/credit_limit),
 * estos campos describen lo que el PROVEEDOR me da o me exige:
 *
 *   supplier_credit_days     — días de crédito que el proveedor me concede
 *   supplier_credit_limit    — línea de crédito que el proveedor abre conmigo
 *   supplier_lead_time_days  — días promedio entre OC y recepción
 *   supplier_min_order_amount — monto mínimo de pedido (MOQ en $)
 *   supplier_bank_name       — banco donde le pago al proveedor
 *   supplier_account_holder  — titular de la cuenta (puede diferir del nombre)
 *   supplier_account_number  — número de cuenta
 *   supplier_clabe           — CLABE 18 dígitos para SPEI
 *   supplier_swift           — SWIFT/BIC si es proveedor extranjero
 *   website                  — sitio web del proveedor (catálogo, contacto)
 *   supplier_rating          — A (estratégico) / B (estándar) / C (ocasional)
 */

const up = `
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS supplier_credit_days       INTEGER,
    ADD COLUMN IF NOT EXISTS supplier_credit_limit      NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS supplier_lead_time_days    INTEGER,
    ADD COLUMN IF NOT EXISTS supplier_min_order_amount  NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS supplier_bank_name         VARCHAR(80),
    ADD COLUMN IF NOT EXISTS supplier_account_holder    VARCHAR(150),
    ADD COLUMN IF NOT EXISTS supplier_account_number    VARCHAR(40),
    ADD COLUMN IF NOT EXISTS supplier_clabe             VARCHAR(18),
    ADD COLUMN IF NOT EXISTS supplier_swift             VARCHAR(11),
    ADD COLUMN IF NOT EXISTS website                    VARCHAR(200),
    ADD COLUMN IF NOT EXISTS supplier_rating            CHAR(1);

  ALTER TABLE business_partners
    ADD CONSTRAINT bp_supplier_clabe_format
      CHECK (supplier_clabe IS NULL OR supplier_clabe ~ '^[0-9]{18}$');

  ALTER TABLE business_partners
    ADD CONSTRAINT bp_supplier_rating_valid
      CHECK (supplier_rating IS NULL OR supplier_rating IN ('A','B','C'));

  ALTER TABLE business_partners
    ADD CONSTRAINT bp_supplier_credit_days_positive
      CHECK (supplier_credit_days IS NULL OR supplier_credit_days >= 0);

  ALTER TABLE business_partners
    ADD CONSTRAINT bp_supplier_lead_time_positive
      CHECK (supplier_lead_time_days IS NULL OR supplier_lead_time_days >= 0);

  COMMENT ON COLUMN business_partners.supplier_rating IS
    'Calificación del proveedor: A=estratégico, B=estándar, C=ocasional/spot';
`

const down = `
  ALTER TABLE business_partners DROP CONSTRAINT IF EXISTS bp_supplier_clabe_format;
  ALTER TABLE business_partners DROP CONSTRAINT IF EXISTS bp_supplier_rating_valid;
  ALTER TABLE business_partners DROP CONSTRAINT IF EXISTS bp_supplier_credit_days_positive;
  ALTER TABLE business_partners DROP CONSTRAINT IF EXISTS bp_supplier_lead_time_positive;
  ALTER TABLE business_partners
    DROP COLUMN IF EXISTS supplier_credit_days,
    DROP COLUMN IF EXISTS supplier_credit_limit,
    DROP COLUMN IF EXISTS supplier_lead_time_days,
    DROP COLUMN IF EXISTS supplier_min_order_amount,
    DROP COLUMN IF EXISTS supplier_bank_name,
    DROP COLUMN IF EXISTS supplier_account_holder,
    DROP COLUMN IF EXISTS supplier_account_number,
    DROP COLUMN IF EXISTS supplier_clabe,
    DROP COLUMN IF EXISTS supplier_swift,
    DROP COLUMN IF EXISTS website,
    DROP COLUMN IF EXISTS supplier_rating;
`

module.exports = { up, down }
