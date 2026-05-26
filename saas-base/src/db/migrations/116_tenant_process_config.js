'use strict'

/**
 * SaaS v2 — Migration 116: tenant_process_config
 *
 * Crea la tabla que contiene los flags globales de configuración por tenant
 * (Process Template). Es el primer paso de la conversión del ERP vertical
 * (extrusión de plástico) a SaaS multi-tenant para industrias diversas.
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.1.
 *
 * Decisiones de diseño relevantes:
 *  - Una fila por tenant (no versionada — cambios quedan en audit_logs).
 *  - Los flags que afectan retroactivamente al costeo (cost_method,
 *    treat_abnormal_scrap_as_loss) se versionarán en una tabla satélite
 *    aparte (tenant_cost_config_history) en migration futura.
 *  - Compat layer v1/v2 NO existe — el repo v1 está respaldado por separado;
 *    todos los tenants nacen v2 con esta configuración default.
 *
 * Seed: inserta una fila por cada tenant existente con valores default
 * compatibles con el comportamiento actual (lots=false, supervisor=true, etc.).
 */

const up = `
  CREATE TABLE tenant_process_config (
    tenant_id                     UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

    -- Capacidades opcionales del motor
    uses_lots                     BOOLEAN NOT NULL DEFAULT false,
    uses_expiry                   BOOLEAN NOT NULL DEFAULT false,
    uses_fefo                     BOOLEAN NOT NULL DEFAULT false,
    uses_handover                 BOOLEAN NOT NULL DEFAULT true,
    uses_supervisor               BOOLEAN NOT NULL DEFAULT true,
    supervisor_validates          BOOLEAN NOT NULL DEFAULT true,

    -- Flujo de inventario
    pt_goes_to_wip_first          BOOLEAN NOT NULL DEFAULT true,
    mp_goes_to_wip_first          BOOLEAN NOT NULL DEFAULT true,

    -- Cumplimiento de orden
    allow_second_quality_in_order BOOLEAN NOT NULL DEFAULT false,

    -- Costeo
    default_intra_shift_proration VARCHAR(20) NOT NULL DEFAULT 'time'
      CHECK (default_intra_shift_proration IN ('time','units','weight','manual')),
    cost_method                   VARCHAR(20) NOT NULL DEFAULT 'weighted_avg'
      CHECK (cost_method IN ('weighted_avg','fifo','standard')),
    treat_abnormal_scrap_as_loss  BOOLEAN NOT NULL DEFAULT true,

    -- Alimentos / compliance
    allergen_mode                 VARCHAR(20) NOT NULL DEFAULT 'priority_only'
      CHECK (allergen_mode IN ('strict','priority_only','alert_only')),
    expiry_alert_days             INTEGER NULL,

    -- Lotes
    lot_number_pattern            VARCHAR(80) NULL,

    -- Escala / modo operativo
    operation_mode                VARCHAR(20) NOT NULL DEFAULT 'industrial'
      CHECK (operation_mode IN ('industrial','small','micro')),
    allow_adhoc_shifts            BOOLEAN NOT NULL DEFAULT false,
    simplified_overhead           BOOLEAN NOT NULL DEFAULT false,

    -- Auditoría
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by_user_id            UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id            UUID NULL REFERENCES users(id) ON DELETE SET NULL
  );

  COMMENT ON TABLE tenant_process_config IS
    'SaaS v2: configuración del Process Template por tenant (flags globales). Una fila por tenant.';
  COMMENT ON COLUMN tenant_process_config.uses_lots IS
    'Si true, las MP y PT llevan trazabilidad por lote (NOM-251). Default false para no-alimentarios.';
  COMMENT ON COLUMN tenant_process_config.allergen_mode IS
    'Comportamiento ante alérgenos heredados: strict bloquea todo, priority_only bloquea NOM-051 priorities, alert_only solo notifica.';
  COMMENT ON COLUMN tenant_process_config.cost_method IS
    'Método de valuación de MP: weighted_avg (default), fifo, standard. Cambios afectan retroactivamente — versionar en tenant_cost_config_history (futuro).';
  COMMENT ON COLUMN tenant_process_config.operation_mode IS
    'Escala operativa: industrial (full features), small (sin handover/supervisor), micro (turnos ad-hoc + overhead simple).';
  COMMENT ON COLUMN tenant_process_config.expiry_alert_days IS
    'Días antes de caducidad para emitir alerta. NULL = sin alertas.';
  COMMENT ON COLUMN tenant_process_config.lot_number_pattern IS
    'Patrón de generación de lote tenant-wide. Variables: {YYYY},{MM},{DD},{SHIFT},{LINE},{SKU},{SEQ}. NULL = el patrón se define por producto.';

  CREATE TRIGGER set_updated_at_tenant_process_config
    BEFORE UPDATE ON tenant_process_config
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  -- Seed: una fila por cada tenant existente con defaults
  INSERT INTO tenant_process_config (tenant_id)
  SELECT id FROM tenants
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_process_config tpc WHERE tpc.tenant_id = tenants.id
  );
`

const down = `
  DROP TRIGGER IF EXISTS set_updated_at_tenant_process_config ON tenant_process_config;
  DROP TABLE IF EXISTS tenant_process_config;
`

module.exports = { up, down }
