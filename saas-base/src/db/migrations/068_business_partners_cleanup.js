'use strict'

/**
 * Limpieza de columnas muertas o redundantes en business_partners.
 *
 * Columnas a eliminar:
 *   - sat_product_code / sat_unit_code: existen también en `products` (que
 *     es donde se usan al timbrar). En business_partners nadie los lee/escribe.
 *   - default_address_id: redundante con `delivery_addresses.is_default`.
 *     Nunca se llenó. La consulta del default usa is_default desde la tabla
 *     de addresses, no esta FK.
 *   - billing_contact_id: igual que arriba — FK que nunca se llenó. Los
 *     contactos se manejan por la flag is_primary en business_partner_contacts.
 *   - accepts_partial: flag visible en el formulario pero ningún flujo del
 *     backend lo respeta. Mejor quitarlo hasta que tenga lógica real.
 *
 * NO se elimina `tax_regime` (texto largo, redundante con tax_regime_code)
 * porque el módulo de timbrado lo lee. Cuando se valide que no rompe nada,
 * se puede hacer otra migración para eliminarlo.
 */

const up = `
  ALTER TABLE business_partners
    DROP COLUMN IF EXISTS sat_product_code,
    DROP COLUMN IF EXISTS sat_unit_code,
    DROP COLUMN IF EXISTS default_address_id,
    DROP COLUMN IF EXISTS billing_contact_id,
    DROP COLUMN IF EXISTS accepts_partial;
`

const down = `
  ALTER TABLE business_partners
    ADD COLUMN IF NOT EXISTS sat_product_code   VARCHAR(8),
    ADD COLUMN IF NOT EXISTS sat_unit_code      VARCHAR(5)  DEFAULT 'H87',
    ADD COLUMN IF NOT EXISTS default_address_id UUID        REFERENCES delivery_addresses(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS billing_contact_id UUID        REFERENCES business_partner_contacts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS accepts_partial    BOOLEAN     NOT NULL DEFAULT true;
`

module.exports = { up, down }
