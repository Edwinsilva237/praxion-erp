'use strict'

// Helpers de fecha para SQL sensibles a zona horaria.
//
// Problema: Render corre Postgres en UTC. `CURRENT_DATE` / `NOW()::date` dan la
// fecha UTC, que en México (UTC−6) se adelanta un día durante la tarde-noche
// local (18:00–23:59 MX = 00:00–05:59 UTC del día siguiente). Eso hacía que un
// documento que vence HOY se marcara "vencido" ~6h antes de tiempo en las
// comparaciones de aging (is_overdue, days_overdue, due_soon).
//
// Solución: calcular "hoy" en la zona del negocio. `NOW()` es un timestamptz
// absoluto; `AT TIME ZONE <tz>` lo convierte al wall-clock local y `::date`
// extrae el día de calendario correcto para el negocio.

const config = require('../config')

// La zona viene de config (env APP_TIMEZONE), controlada por el operador — NO
// es input de usuario. Aun así validamos un formato IANA razonable por higiene
// antes de interpolarla en SQL (defensa en profundidad).
const BUSINESS_TZ = /^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(config.timezone || '')
  ? config.timezone
  : 'America/Mexico_City'

// Expresión SQL lista para interpolar en template strings de queries.
// Reemplaza a `CURRENT_DATE` en comparaciones de vencimiento.
//   Ej: `WHERE due_date < ${LOCAL_TODAY}`
const LOCAL_TODAY = `((NOW() AT TIME ZONE '${BUSINESS_TZ}')::date)`

module.exports = { LOCAL_TODAY, BUSINESS_TZ }
