'use strict'

/**
 * Mig 223 — bandera por tenant `block_sale_without_stock`.
 *
 * Contexto (2026-07-11):
 *  Hoy una remisión NUNCA se bloquea por falta de existencia: la salida se registra
 *  igual y el saldo queda en 0 (clamp) o en negativo según `allow_negative_stock`.
 *  Esta bandera (opt-in, default false = comportamiento actual) hace que la ENTREGA
 *  de la remisión se BLOQUEE con un 400 "Stock insuficiente" cuando el almacén no
 *  tiene existencia para cubrir la salida (activa `validateStock` en updateStock).
 *
 *  SaaS-first: un vertical de alimentos/retail puede exigir bloqueo de sobreventa;
 *  un taller make-to-order prefiere permitir la salida (y marcar negativo). Es la
 *  contraparte estricta de `allow_negative_stock`: si se bloquea la sobreventa,
 *  nunca se llega a dejar saldo negativo, así que en la práctica se usan a lo sumo
 *  una de las dos (la UI las presenta juntas en la tarjeta de Inventario).
 */

const up = `
  ALTER TABLE tenant_process_config
    ADD COLUMN IF NOT EXISTS block_sale_without_stock BOOLEAN NOT NULL DEFAULT false;

  COMMENT ON COLUMN tenant_process_config.block_sale_without_stock IS
    'Inventario: true BLOQUEA la entrega de una remisión (400) si el almacén no tiene existencia suficiente. false (default) permite la salida (comportamiento actual: clampa a 0 o deja negativo según allow_negative_stock).';
`

const down = `
  ALTER TABLE tenant_process_config DROP COLUMN IF EXISTS block_sale_without_stock;
`

module.exports = { up, down }
