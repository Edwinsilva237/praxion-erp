'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  const { rows } = await p.query(
    `SELECT id, description, sat_product_code, sat_unit_code, quantity, unit_price
     FROM invoice_lines WHERE invoice_id = '59887c78-acbe-4be7-8ad1-24bf872d3dc8'`
  )
  console.log(rows)
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
