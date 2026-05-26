'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  const { rows } = await p.query(
    'SELECT name, rfc, tax_regime_code, zip_code FROM business_partners WHERE id = $1',
    ['2b2bc87a-2361-4ae2-a106-89ebbe91eb28']
  )
  console.log(rows[0])
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
