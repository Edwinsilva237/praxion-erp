'use strict'

/**
 * Planes y suscripciones (Stripe).
 *
 * Diseño:
 *   - `plans`: catálogo. Una fila por plan (free, pro, enterprise). El
 *     stripe_price_id se llena después de crear los products/prices en el
 *     dashboard de Stripe — empieza NULL.
 *   - `subscriptions`: 1:1 con tenants. Cada tenant tiene exactamente UNA
 *     suscripción (PK = tenant_id). El estado refleja lo último que Stripe
 *     nos avisó por webhook + nuestro estado inicial 'trialing'.
 *   - Al crear un tenant nuevo, tenantService inserta automáticamente una
 *     subscription con plan=free, status='trialing', trial_end=NOW()+14d.
 *     Sin contactar Stripe — solo lo hace cuando el tenant aprieta "pagar".
 */

const up = `
  CREATE TYPE subscription_status AS ENUM (
    'trialing',           -- en periodo de prueba
    'active',             -- suscripción activa pagada
    'past_due',           -- cobro falló, en periodo de gracia
    'canceled',           -- cancelada, sin acceso
    'incomplete',         -- checkout iniciado pero no completado
    'incomplete_expired'  -- checkout abandonado
  );

  CREATE TABLE plans (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug                     VARCHAR(40)  NOT NULL UNIQUE,  -- 'free' | 'pro' | 'enterprise'
    name                     VARCHAR(100) NOT NULL,
    description              TEXT,
    -- Stripe Price ID (price_XXX). Vacío significa "este plan no es vendible
    -- en Stripe" (ej. el plan gratis es solo interno).
    stripe_price_id          VARCHAR(100),
    -- Precio en centavos MXN (para mostrar en UI). Stripe es la fuente de
    -- verdad para cobros — este campo es solo display.
    price_mxn_cents          INTEGER      NOT NULL DEFAULT 0,
    currency                 VARCHAR(3)   NOT NULL DEFAULT 'MXN',
    -- Límites del plan. NULL = ilimitado.
    max_users                INTEGER,
    max_invoices_per_month   INTEGER,
    active                   BOOLEAN      NOT NULL DEFAULT TRUE,
    sort_order               INTEGER      NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE TABLE subscriptions (
    tenant_id                UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id                  UUID NOT NULL REFERENCES plans(id),
    -- IDs de Stripe. Vacíos durante el trial inicial (antes de pagar).
    stripe_customer_id       VARCHAR(100),
    stripe_subscription_id   VARCHAR(100),
    status                   subscription_status NOT NULL DEFAULT 'trialing',
    -- Periodos. Para trial: current_period_start = created_at, end = trial_end.
    current_period_start     TIMESTAMPTZ,
    current_period_end       TIMESTAMPTZ,
    trial_end                TIMESTAMPTZ,
    -- Si el tenant pidió cancelar al final del periodo, esto queda en TRUE
    -- y current_period_end es la fecha efectiva. Si cancela inmediato, status='canceled'.
    cancel_at_period_end     BOOLEAN      NOT NULL DEFAULT FALSE,
    canceled_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE INDEX idx_subscriptions_status ON subscriptions(status);
  CREATE INDEX idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);

  -- Trigger de updated_at para ambas tablas (asume helper set_updated_at()
  -- ya creado en migrations previas).
  CREATE TRIGGER set_updated_at_plans BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
  CREATE TRIGGER set_updated_at_subscriptions BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Seed de los 3 planes iniciales. Los precios son referenciales — los
  -- ajustas en BD o en una futura UI de admin. Los stripe_price_id quedan
  -- NULL hasta que el admin los configure en el dashboard de Stripe.
  INSERT INTO plans (slug, name, description, price_mxn_cents, max_users, max_invoices_per_month, sort_order) VALUES
    ('free',       'Gratis',  'Para probar el sistema con un equipo pequeño.',                       0,    2,    10,  1),
    ('pro',        'Pro',     'Para PyMEs con operación regular.',                                99900,   10,   200,  2),
    ('enterprise', 'Empresa', 'Para operaciones grandes con múltiples usuarios y alto volumen.',  249900,   50,  2000,  3);
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_subscriptions ON subscriptions;
  DROP TRIGGER IF EXISTS set_updated_at_plans         ON plans;
  DROP TABLE IF EXISTS subscriptions CASCADE;
  DROP TABLE IF EXISTS plans         CASCADE;
  DROP TYPE  IF EXISTS subscription_status CASCADE;
`

module.exports = { up, down }
