'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  await p.query(
    `UPDATE business_partners
     SET facturapi_id = $1, rfc = $2, tax_regime_code = $3
     WHERE id = $4`,
    ['69f8febef0a15298342c10cb', 'XAXX010101000', '616', '2b2bc87a-2361-4ae2-a106-89ebbe91eb28']
  )
  console.log('Cliente actualizado con facturapi_id y RFC generico.')
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
