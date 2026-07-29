'use strict'

const { Pool } = require('pg')
const { AsyncLocalStorage } = require('async_hooks')
const config = require('../config')
const logger = require('../config/logger')

// Render Postgres (y la mayoría de PG managed) requieren SSL. El cert es
// firmado por una CA interna del proveedor — rejectUnauthorized: false
// acepta el cert sin verificar la cadena (estándar para PG managed).
const sslConfig = config.isProd() ? { rejectUnauthorized: false } : false

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  min: config.db.pool.min,
  max: config.db.pool.max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: sslConfig,
  // Incidente prod 2026-07-29: Render Postgres cortó TODAS las conexiones de
  // golpe y las queries en vuelo se quedaron colgadas contra sockets muertos
  // (timeouts de 15s en el frontend, riesgo de agotar el pool). keepAlive
  // detecta el socket muerto a nivel TCP y los timeouts convierten un cuelgue
  // indefinido en un error rápido que el pool puede reciclar. 60s es holgado
  // para la query más pesada legítima (exports, PDFs) y muy por encima del
  // timeout de 15s del frontend. Las MIGRACIONES sí pueden tardar más, así que
  // `migrate.js` levanta el techo en su propia conexión (ver `liftTimeouts`).
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  query_timeout: 60000,       // cliente: deja de esperar la respuesta
  statement_timeout: 60000,   // servidor: PG mata la query que exceda
})

// OJO: este handler SOLO cubre clientes IDLE (en reposo dentro del pool).
// pg-pool adjunta su `idleListener` al cliente al liberarlo y lo QUITA al
// prestarlo (`_acquireClient` → `client.removeListener('error', idleListener)`),
// así que un cliente prestado queda SIN listener de 'error'. Ver
// `attachCheckoutErrorGuard` abajo para ese caso.
pool.on('error', (err) => {
  logger.error('Unexpected error on idle DB client', { error: err.message })
})

pool.on('connect', () => {
  logger.debug('New DB connection established')
})

// ─────────────────────────────────────────────────────────────────────────────
// Contexto por-request para RLS (Row-Level Security).
//
// El middleware tenantResolver envuelve cada request en `withTenant(id, fn)`,
// lo cual setea el tenant actual en AsyncLocalStorage. Cuando `query()` se
// llama desde cualquier parte del request, lee ese contexto y aplica
// `SET app.tenant_id` + `SET app.rls_enforce` antes de la query real.
//
// Si NO hay contexto (cron jobs, scripts, tests), las queries corren como
// hoy — sin enforcement RLS. Para acciones cross-tenant explícitas (login,
// webhook Stripe) usar `withBypass(fn)`.
// ─────────────────────────────────────────────────────────────────────────────

const als = new AsyncLocalStorage()

function getContext() {
  return als.getStore() || null
}

/**
 * Ejecuta fn dentro del contexto de un tenant específico. Todas las queries
 * dentro de fn aplicarán RLS scoped a ese tenant.
 */
function withTenant(tenantId, fn) {
  if (!tenantId) return fn()
  return als.run({ tenantId, bypass: false }, fn)
}

/**
 * Ejecuta fn en modo bypass — queries cross-tenant explícitas (login,
 * webhook, cron jobs). RLS no se aplica dentro de fn.
 */
function withBypass(fn) {
  return als.run({ tenantId: null, bypass: true }, fn)
}

/**
 * Setea las variables de sesión RLS en el client. Llamada antes de ejecutar
 * cada query. Si no hay contexto, no setea nada y la conexión se comporta
 * como en el código pre-RLS (legacy compatible).
 *
 * Las variables PG persisten en la conexión hasta RESET o desconexión. Por
 * eso reseteamos al liberar el client al pool — para que el siguiente
 * request que tome esa conexión no herede el tenant_id del anterior.
 */
async function applyRlsContext(client) {
  const ctx = getContext()
  // Siempre resetear antes para que conexiones reusadas no hereden estado.
  // Esto es 1 round-trip extra por query — el costo del doble candado.
  if (!ctx) {
    await client.query(`SELECT set_config('app.tenant_id', '', false), set_config('app.rls_enforce', 'false', false)`)
    return
  }
  if (ctx.bypass) {
    await client.query(`SELECT set_config('app.tenant_id', '', false), set_config('app.rls_enforce', 'false', false)`)
    return
  }
  await client.query(
    `SELECT set_config('app.tenant_id', $1, false), set_config('app.rls_enforce', 'true', false)`,
    [ctx.tenantId]
  )
}

/**
 * Blinda un cliente PRESTADO contra la muerte de su conexión.
 *
 * Mientras un cliente está prestado, pg-pool le quita su `idleListener`, así
 * que el cliente se queda SIN ningún listener de 'error'. Si la conexión muere
 * justo entonces, `pg` hace `client.emit('error', err)` (client.js
 * `_handleErrorEvent`) y un EventEmitter sin listener de 'error' hace que Node
 * LANCE la excepción → muere el proceso entero.
 *
 * Fue exactamente la caída de producción del 2026-07-29: Render Postgres cortó
 * todas las conexiones de golpe ("Connection terminated unexpectedly") con
 * queries en vuelo y praxion-api salió con status 1, dejando a TODOS los
 * tenants con timeouts mientras Render lo reiniciaba.
 *
 * El listener temporal absorbe ese 'error': la query en vuelo igual falla (su
 * promesa se rechaza y el caller responde 500, comportamiento correcto), pero
 * el proceso sobrevive. Se retira al liberar el cliente para no acumular
 * listeners en los clientes que el pool recicla.
 */
function attachCheckoutErrorGuard(client) {
  const guard = (err) => {
    logger.error('DB client error mientras estaba prestado (proceso a salvo)', {
      error: err.message,
    })
  }
  client.on('error', guard)
  return () => client.removeListener('error', guard)
}

async function query(text, params) {
  const start = Date.now()
  const client = await pool.connect()
  const detachGuard = attachCheckoutErrorGuard(client)
  try {
    await applyRlsContext(client)
    const result = await client.query(text, params)
    const duration = Date.now() - start
    logger.debug('Query executed', { text, duration, rows: result.rowCount })
    return result
  } finally {
    detachGuard()
    client.release()
  }
}

async function getClient() {
  const client = await pool.connect()
  const originalRelease = client.release.bind(client)
  const detachGuard = attachCheckoutErrorGuard(client)

  const timeout = setTimeout(() => {
    logger.warn('DB client has been checked out for more than 30s')
    client.release()
  }, 30000)

  client.release = () => {
    clearTimeout(timeout)
    detachGuard()
    originalRelease()
  }

  // Aplicamos contexto RLS antes de devolver el client al caller. Va DESPUÉS de
  // envolver `release` a propósito: `applyRlsContext` ejecuta una query y si la
  // conexión acaba de morir (justo el escenario del incidente 2026-07-29) lanza
  // — sin este catch el cliente quedaba prestado para siempre, fugando una
  // conexión del pool en cada intento hasta agotarlo.
  try {
    await applyRlsContext(client)
  } catch (err) {
    client.release()
    throw err
  }

  return client
}

async function withTransaction(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

module.exports = { query, getClient, withTransaction, withTenant, withBypass, pool }
