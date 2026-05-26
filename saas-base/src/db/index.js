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
})

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

async function query(text, params) {
  const start = Date.now()
  const client = await pool.connect()
  try {
    await applyRlsContext(client)
    const result = await client.query(text, params)
    const duration = Date.now() - start
    logger.debug('Query executed', { text, duration, rows: result.rowCount })
    return result
  } finally {
    client.release()
  }
}

async function getClient() {
  const client = await pool.connect()
  const originalRelease = client.release.bind(client)

  const timeout = setTimeout(() => {
    logger.warn('DB client has been checked out for more than 30s')
    client.release()
  }, 30000)

  // Aplicamos contexto RLS antes de devolver el client al caller.
  await applyRlsContext(client)

  client.release = () => {
    clearTimeout(timeout)
    originalRelease()
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
