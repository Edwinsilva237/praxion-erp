'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})

async function run() {
  const tenantId = '252a16b3-acc5-40d5-9bdb-83b0e656b238'

  await p.query(
    `INSERT INTO tenant_fiscal_info
       (tenant_id, rfc, razon_social, tax_regime, zip_code, serie_default, folio_next)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET
       rfc          = EXCLUDED.rfc,
       razon_social = EXCLUDED.razon_social,
       tax_regime   = EXCLUDED.tax_regime,
       zip_code     = EXCLUDED.zip_code,
       serie_default= EXCLUDED.serie_default`,
    [tenantId, 'SILE9306023K4', 'EDWIN MANUEL SILVA LOAIZA', '612', '60014', 'A', 1]
  )
  console.log('Datos fiscales del emisor guardados.')

  await p.query(
    `UPDATE business_partners
     SET tax_regime_code = '601', zip_code = '60000'
     WHERE id = '2b2bc87a-2361-4ae2-a106-89ebbe91eb28'`
  )
  console.log('Regimen fiscal del cliente actualizado.')

  await p.end()
}

run().catch(e => { console.error(e.message); p.end() })