'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
async function run() {
  // Corregir todas las líneas de facturas con clave incorrecta
  const result = await p.query(
    `UPDATE invoice_lines SET sat_product_code = '44102305'
     WHERE sat_product_code = '10111402'`
  )
  console.log('Líneas actualizadas:', result.rowCount)

  // Corregir también el default en invoice_lines
  await p.query(
    `ALTER TABLE invoice_lines ALTER COLUMN sat_product_code SET DEFAULT '44102305'`
  )
  console.log('Default actualizado en invoice_lines.')
  await p.end()
}
run().catch(e => { console.error(e.message); p.end() })
