'use strict'

// Migración 040 — Crea almacenes por defecto para cada tenant existente
// Las tablas inventory_stock e inventory_movements ya existen desde migración 014.
// Solo necesitamos asegurarnos de que cada tenant tenga sus 3 almacenes base.

const up = `
  -- Insertar almacenes base para tenants que aún no los tengan
  INSERT INTO warehouses (tenant_id, name, type, description)
  SELECT
    t.id,
    'Almacén MP',
    'raw_material',
    'Almacén principal de materias primas'
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.tenant_id = t.id AND w.type = 'raw_material'
  );

  INSERT INTO warehouses (tenant_id, name, type, description)
  SELECT
    t.id,
    'Almacén PT',
    'finished_product',
    'Almacén de producto terminado'
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.tenant_id = t.id AND w.type = 'finished_product'
  );

  INSERT INTO warehouses (tenant_id, name, type, description)
  SELECT
    t.id,
    'Almacén Regrind',
    'regrind',
    'Almacén de material regrind/recuperado'
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.tenant_id = t.id AND w.type = 'regrind'
  );

  INSERT INTO warehouses (tenant_id, name, type, description)
  SELECT
    t.id,
    'Producción en Proceso',
    'wip',
    'Almacén WIP — acumula esquineros y MP mientras el turno está activo'
  FROM tenants t
  WHERE NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.tenant_id = t.id AND w.type = 'wip'
  );
`

const down = `
  -- No eliminar almacenes en down para no perder datos históricos
  SELECT 1;
`

module.exports = { up, down }
