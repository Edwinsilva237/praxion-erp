'use strict'

/**
 * One-shot: lista las hojas del catalogo CFDI del SAT en .xls y muestra
 * las primeras filas de cada una para entender estructura.
 */

const XLSX = require('xlsx')
const path = require('path')

const filePath = process.argv[2] || 'C:/Users/admin/Downloads/catCFDI_V_4_20260521.xls'
console.log('Leyendo:', filePath)
const wb = XLSX.readFile(filePath)
console.log('Hojas:', wb.SheetNames.length)
for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false })
  console.log(`\n=== ${name} (${rows.length} filas) ===`)
  rows.slice(0, 5).forEach((r, i) => console.log(`  [${i}]`, r.slice(0, 5)))
}
