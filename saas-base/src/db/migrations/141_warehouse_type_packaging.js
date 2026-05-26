'use strict'

/**
 * SaaS v2 — Migration 141: agregar 'packaging' al ENUM warehouse_type.
 *
 * El ENUM legacy `warehouse_type` (migración 010) solo tenía 5 valores:
 *   raw_material | regrind | wip | finished_product | resale
 *
 * Se agrega 'packaging' para que los tenants puedan tener almacenes
 * dedicados de empaque (bolsas, etiquetas, fleje, cajas, etc.) sin
 * mezclarlos con la materia prima principal.
 *
 * Nota: el catálogo SaaS v2 `tenant_warehouse_types` (migración 121)
 * ya tenía 'embalaje' seedeado, pero las queries de inventario y el
 * frontend usan `warehouses.type` (ENUM legacy). Esto cierra esa
 * inconsistencia.
 *
 * Postgres requiere ADD VALUE para ENUMs; no se puede revertir
 * fácilmente (no hay DROP VALUE). El down se deja como no-op.
 */

const up = `
  ALTER TYPE warehouse_type ADD VALUE IF NOT EXISTS 'packaging';
`

const down = `
  -- Postgres no permite DROP VALUE en ENUMs. Para revertir habría que
  -- recrear el tipo completo. Se deja como no-op consciente.
`

module.exports = { up, down }
