'use strict'

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { pool } = require('./index')
const { createMigrationsTable } = require('./migrations/000_schema_migrations')
const logger = require('../config/logger')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

// El pool comparte timeouts de 60s para blindar el API (ver ./index.js), pero
// una migración con relleno de datos sobre una tabla grande puede tardar mucho
// más — y morir a los 60s abortaría el deploy a media migración. Aquí levantamos
// el techo: `statement_timeout = 0` quita el del servidor y cada query lleva un
// `query_timeout` explícito (pg trata el 0 como falsy y caería al default del
// pool, así que hay que pasar un número grande, no cero).
const MIGRATION_TIMEOUT_MS = 30 * 60 * 1000  // 30 min

/** Ejecuta una query sin el techo de 60s del pool (ver arriba). */
function longQuery(client, text, params) {
  return client.query({ text, values: params, query_timeout: MIGRATION_TIMEOUT_MS })
}

/** Quita el statement_timeout del servidor en ESTA conexión. */
function liftTimeouts(client) {
  return longQuery(client, 'SET statement_timeout = 0')
}

function getMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.match(/^\d{3}_(?!schema_migrations).*\.js$/))
    .sort()
}

async function getApplied(client) {
  const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY id')
  return new Set(rows.map((r) => r.name))
}

async function migrate() {
  const client = await pool.connect()
  try {
    await liftTimeouts(client)
    await client.query(createMigrationsTable)
    const applied = await getApplied(client)
    const files = getMigrationFiles()
    const pending = files.filter((f) => !applied.has(f))

    if (pending.length === 0) {
      logger.info('No pending migrations.')
      return
    }

    for (const file of pending) {
      const { up } = require(path.join(MIGRATIONS_DIR, file))
      logger.info(`Applying migration: ${file}`)
      await client.query('BEGIN')
      try {
        await longQuery(client, up)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        logger.info(`  ✓ ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error(`  ✗ ${file}: ${err.message}`)
        throw err
      }
    }

    logger.info(`Applied ${pending.length} migration(s).`)
  } finally {
    client.release()
    await pool.end()
  }
}

async function rollback() {
  const client = await pool.connect()
  try {
    await liftTimeouts(client)
    await client.query(createMigrationsTable)
    const applied = await getApplied(client)
    const files = getMigrationFiles().filter((f) => applied.has(f))

    if (files.length === 0) {
      logger.info('Nothing to rollback.')
      return
    }

    const last = files[files.length - 1]
    const { down } = require(path.join(MIGRATIONS_DIR, last))
    logger.info(`Rolling back: ${last}`)
    await client.query('BEGIN')
    try {
      await longQuery(client, down)
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [last])
      await client.query('COMMIT')
      logger.info(`  ✓ Rolled back ${last}`)
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error(`  ✗ ${err.message}`)
      throw err
    }
  } finally {
    client.release()
    await pool.end()
  }
}

const command = process.argv[2]
if (command === 'rollback') {
  rollback().catch((e) => { logger.error(e.message); process.exit(1) })
} else {
  migrate().catch((e) => { logger.error(e.message); process.exit(1) })
}
