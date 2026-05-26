'use strict'

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { pool } = require('./index')
const { createMigrationsTable } = require('./migrations/000_schema_migrations')
const logger = require('../config/logger')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

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
        await client.query(up)
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
      await client.query(down)
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
