'use strict'

/**
 * Mig 235 — Complementos de pago de PROVEEDOR (REP, CFDI tipo P) RECIBIDOS.
 *
 * Espejo en COMPRAS de `payment_complements` (mig 033, emisión a clientes),
 * pero para RECEPCIÓN: cuando el tenant paga una factura PPD, el proveedor
 * debe emitirle un Recibo Electrónico de Pago (REP). Aquí se guarda el REP
 * recibido (por el buzón de correo o subido a mano), ligado a:
 *   - el PAGO que el tenant registró (`supplier_payments`) — sugerido/confirmado
 *   - la(s) FACTURA(S) que liquida (`supplier_invoices`, por UUID del
 *     DoctoRelacionado) — cruce determinista
 *
 * A diferencia de la emisión (donde Facturapi guarda el detalle), aquí los
 * campos SAT del docto relacionado (parcialidad, saldo anterior/insoluto) se
 * extraen del XML y se PERSISTEN — son la evidencia de cumplimiento.
 *
 *   supplier_payment_complements      → cabecera del REP (1 fila por CFDI tipo P)
 *   supplier_payment_complement_docs  → 1 fila por DoctoRelacionado (por pago)
 *
 * También: `supplier_invoices.metodo_pago_sat` (PUE/PPD del CFDI) — sin él no
 * se puede saber qué facturas EXIGEN complemento (solo las PPD). El parser lo
 * extrae de ahora en adelante; las facturas viejas quedan NULL (desconocido).
 *
 * SIN permiso nuevo (reusa purchases:*) → SIN re-login.
 */

const up = `
  -- ─── Cabecera del REP recibido ────────────────────────────────────────────
  CREATE TABLE supplier_payment_complements (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    partner_id          UUID REFERENCES business_partners(id) ON DELETE SET NULL,
    generic_supplier    VARCHAR(255),          -- nombre del emisor si no está en catálogo
    cfdi_uuid           UUID NOT NULL,         -- UUID del REP (TimbreFiscalDigital)
    rfc_emisor          VARCHAR(13),
    serie               VARCHAR(25),
    folio               VARCHAR(40),
    issue_date          DATE,                  -- fecha del comprobante
    payment_date        DATE,                  -- FechaPago del (primer) pago del REP
    payment_form        VARCHAR(3),            -- FormaDePagoP (03 transferencia, etc.)
    amount              NUMERIC(14,2) NOT NULL DEFAULT 0,  -- suma de Monto de los pagos
    currency            document_currency NOT NULL DEFAULT 'MXN',
    exchange_rate       NUMERIC(12,6),
    supplier_payment_id UUID REFERENCES supplier_payments(id) ON DELETE SET NULL,
    -- matched: facturas ligadas y pago identificado; review: algo no cuadró y
    -- lo revisa un humano (folio desconocido, pago no encontrado, etc.)
    match_status        VARCHAR(20) NOT NULL DEFAULT 'review',
    source              VARCHAR(20) NOT NULL DEFAULT 'manual',   -- email | manual
    notes               TEXT,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT spc_uuid_unique UNIQUE (tenant_id, cfdi_uuid),
    CONSTRAINT spc_match_status_check CHECK (match_status IN ('matched','review')),
    CONSTRAINT spc_source_check CHECK (source IN ('email','manual'))
  );
  CREATE INDEX idx_spc_tenant   ON supplier_payment_complements (tenant_id, created_at DESC);
  CREATE INDEX idx_spc_partner  ON supplier_payment_complements (partner_id);
  CREATE INDEX idx_spc_payment  ON supplier_payment_complements (supplier_payment_id);

  CREATE TRIGGER set_updated_at_supplier_payment_complements
    BEFORE UPDATE ON supplier_payment_complements
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  COMMENT ON TABLE supplier_payment_complements IS
    'REP (CFDI tipo P) recibidos de proveedores, ligados al pago emitido y a las facturas que liquidan';

  -- ─── Doctos relacionados (facturas que el REP liquida) ────────────────────
  CREATE TABLE supplier_payment_complement_docs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    complement_id       UUID NOT NULL REFERENCES supplier_payment_complements(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    related_uuid        UUID,                  -- IdDocumento (UUID de la factura liquidada)
    supplier_invoice_id UUID REFERENCES supplier_invoices(id) ON DELETE SET NULL,
    serie               VARCHAR(25),
    folio               VARCHAR(40),
    currency            VARCHAR(10),           -- MonedaDR
    num_parcialidad     INTEGER,
    imp_saldo_ant       NUMERIC(14,2),
    imp_pagado          NUMERIC(14,2) NOT NULL DEFAULT 0,
    imp_saldo_insoluto  NUMERIC(14,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX idx_spcd_complement ON supplier_payment_complement_docs (complement_id);
  CREATE INDEX idx_spcd_invoice    ON supplier_payment_complement_docs (supplier_invoice_id);
  CREATE INDEX idx_spcd_tenant     ON supplier_payment_complement_docs (tenant_id);

  -- ─── MetodoPago SAT (PUE/PPD) en facturas de proveedor ────────────────────
  ALTER TABLE supplier_invoices ADD COLUMN metodo_pago_sat VARCHAR(3);
  COMMENT ON COLUMN supplier_invoices.metodo_pago_sat IS
    'MetodoPago del CFDI (PUE/PPD). Solo PPD exige complemento de pago. NULL = desconocido (factura previa a la mig 235 o sin XML).';
`

const down = `
  ALTER TABLE supplier_invoices DROP COLUMN IF EXISTS metodo_pago_sat;
  DROP TABLE IF EXISTS supplier_payment_complement_docs;
  DROP TABLE IF EXISTS supplier_payment_complements;
`

module.exports = { up, down }
