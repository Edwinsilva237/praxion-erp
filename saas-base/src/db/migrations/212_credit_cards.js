'use strict'

/**
 * Catálogo de TARJETAS DE CRÉDITO del tenant + asociación opcional en pagos.
 *
 * Hermana de `bank_accounts` (mig 082) pero con campos propios de tarjeta:
 *   - statement_day / payment_day: día de corte y día límite de pago (1-31,
 *     recurrentes cada mes). Con ellos el cron de recordatorios calcula la
 *     próxima fecha concreta de pago.
 *   - responsible_user_id: usuario responsable de la tarjeta. Si es un usuario
 *     del sistema, el recordatorio le llega por push directo (audienceService).
 *     `responsible_name` es el fallback en texto si el titular no es usuario.
 *   - reminder_lead_days: con cuántos días de anticipación avisar (default 3).
 *   - credit_limit: opcional, informativo.
 *
 * `supplier_payments.credit_card_id`: a qué tarjeta se cargó el pago (opcional,
 * espejo de bank_account_id). Permite a futuro el "estado de cuenta" del ciclo.
 *
 * RLS: replica la policy estándar de la mig 099 (la 099 ya corrió, así que las
 * tablas NUEVAS con tenant_id deben habilitar RLS en su propia migración para
 * quedar al mismo nivel que bank_accounts).
 */

const up = `
  CREATE TABLE credit_cards (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    alias                VARCHAR(80)  NOT NULL,
    bank_name            VARCHAR(80),
    last_four            VARCHAR(4),
    statement_day        SMALLINT     NOT NULL,
    payment_day          SMALLINT     NOT NULL,
    responsible_user_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
    responsible_name     VARCHAR(120),
    credit_limit         NUMERIC(14,2),
    currency             document_currency NOT NULL DEFAULT 'MXN',
    reminder_lead_days   SMALLINT     NOT NULL DEFAULT 3,
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    notes                TEXT,
    created_by           UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT cc_statement_day_range CHECK (statement_day BETWEEN 1 AND 31),
    CONSTRAINT cc_payment_day_range   CHECK (payment_day   BETWEEN 1 AND 31),
    CONSTRAINT cc_last_four_format    CHECK (last_four IS NULL OR last_four ~ '^[0-9]{4}$'),
    CONSTRAINT cc_lead_days_range     CHECK (reminder_lead_days BETWEEN 0 AND 30)
  );

  CREATE INDEX idx_cc_tenant ON credit_cards (tenant_id);
  CREATE INDEX idx_cc_active  ON credit_cards (tenant_id, active);

  CREATE TRIGGER set_updated_at_credit_cards
    BEFORE UPDATE ON credit_cards
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- RLS estándar (igual a la policy de la mig 099): pasa si el interruptor está
  -- apagado O si la fila es del tenant actual.
  ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;
  ALTER TABLE credit_cards FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON credit_cards
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  -- Asociación opcional del pago a una tarjeta (espejo de bank_account_id).
  ALTER TABLE supplier_payments
    ADD COLUMN credit_card_id UUID REFERENCES credit_cards(id) ON DELETE SET NULL;

  CREATE INDEX idx_sp_credit_card ON supplier_payments (credit_card_id)
    WHERE credit_card_id IS NOT NULL;

  COMMENT ON COLUMN supplier_payments.credit_card_id IS
    'Tarjeta de crédito a la que se cargó el pago. Opcional, para control y estado de cuenta del ciclo.';
`

const down = `
  ALTER TABLE supplier_payments DROP COLUMN IF EXISTS credit_card_id;
  DROP POLICY IF EXISTS rls_tenant ON credit_cards;
  DROP TRIGGER IF EXISTS set_updated_at_credit_cards ON credit_cards;
  DROP TABLE IF EXISTS credit_cards CASCADE;
`

module.exports = { up, down }
