'use strict'

/**
 * Mig 193 — bandera por tenant `allow_negative_stock` + se levanta el CHECK que
 * impedía saldos negativos en inventory_stock.
 *
 * Contexto (2026-06-04):
 *  Hasta hoy `updateStock` clampaba TODA salida a 0 (`Math.max(0, …)`), respaldado
 *  por el CHECK `stock_quantity_positive (quantity >= 0)` (mig 014). Así, vender/
 *  remisionar un producto sin existencia capturada NO bajaba el saldo a negativo
 *  — lo dejaba en 0 silenciosamente y el artículo desaparecía de la lista de stock
 *  (que filtraba `quantity > 0`). Se perdía la señal de que faltaba una captura.
 *
 *  Esta bandera (opt-in, default false = comportamiento histórico) permite que el
 *  stock baje a NEGATIVO en las salidas por VENTA (remisión). Un saldo negativo es
 *  bandera roja accionable: "este producto se vendió pero falta validar el turno de
 *  producción o capturar la entrada". Como ahora el negativo es un estado VÁLIDO
 *  (gobernado por la bandera a nivel de aplicación), se elimina el CHECK que lo
 *  prohibía a nivel de BD. Los tenants SIN la bandera siguen clampeando a 0 por la
 *  lógica de `updateStock`, así que en la práctica no verán negativos.
 *
 *  SaaS-first: bandera por tenant — un vertical de alimentos puede preferir bloquear
 *  la sobreventa; un taller make-to-order prefiere permitir el negativo y marcarlo.
 */

const up = `
  ALTER TABLE inventory_stock DROP CONSTRAINT IF EXISTS stock_quantity_positive;

  ALTER TABLE tenant_process_config
    ADD COLUMN IF NOT EXISTS allow_negative_stock BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.allow_negative_stock IS
    'Inventario: true permite que el stock baje a negativo en salidas por venta/remisión cuando no hay existencia capturada (el negativo es bandera de "falta validar producción o capturar entrada"). false (default) clampa a 0 — comportamiento histórico.';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS allow_negative_stock;

  -- Restaura el CHECK histórico. Falla si quedaron saldos negativos en la BD
  -- (limpiarlos antes de revertir).
  ALTER TABLE inventory_stock
    ADD CONSTRAINT stock_quantity_positive CHECK (quantity >= 0);
`

module.exports = { up, down }
