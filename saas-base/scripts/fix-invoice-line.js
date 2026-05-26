'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  await p.query(
    `UPDATE invoice_lines SET sat_product_code = '44102305' WHERE invoice_id = '59887c78-acbe-4be7-8ad1-24bf872d3dc8'`
  )
  // Actualizar también el default en products
  await p.query(
    `UPDATE products SET sat_product_code = '44102305' WHERE tenant_id = '252a16b3-acc5-40d5-9bdb-83b0e656b238'`
  )
  console.log('Clave de producto actualizada.')
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
