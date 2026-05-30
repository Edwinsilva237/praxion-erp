'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// 174_fix_production_permission_labels.js
// Corrige descripciones engañosas del catálogo de permisos de producción.
//
// `production:create` controla en realidad la CAPTURA (iniciar turno, registrar
// paquetes, MP, scrap, incidentes) — ver production/routes.js (POST /shifts,
// /shifts/:id/packages, /mp-loads, /scrap, /incidents) —, pero su descripción
// decía "Crear órdenes de producción". Crear órdenes lo controla en realidad
// `production:manage` (POST /orders). Esto confundía al configurar roles: no se
// encontraba el permiso de "capturar".
//
// Solo cambia el texto descriptivo — no toca el comportamiento ni las
// asignaciones de los permisos.
// ─────────────────────────────────────────────────────────────────────────────

const up = `
  UPDATE permissions
  SET description = 'Capturar producción: iniciar turnos, registrar paquetes, MP y scrap'
  WHERE resource = 'production' AND action = 'create';

  UPDATE permissions
  SET description = 'Gestión completa: crear y administrar órdenes de producción (gerencia)'
  WHERE resource = 'production' AND action = 'manage';
`

const down = `
  UPDATE permissions
  SET description = 'Crear órdenes de producción'
  WHERE resource = 'production' AND action = 'create';

  UPDATE permissions
  SET description = 'Gestión completa — gerencia'
  WHERE resource = 'production' AND action = 'manage';
`

module.exports = { up, down }
