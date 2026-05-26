'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  const { rows } = await p.query(
    `SELECT id, document_type, document_number, amount_total, amount_paid, amount_pending, status, due_date
     FROM accounts_receivable WHERE tenant_id = '252a16b3-acc5-40d5-9bdb-83b0e656b238'`
  )
  console.log('CXC:', JSON.stringify(rows, null, 2))
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
