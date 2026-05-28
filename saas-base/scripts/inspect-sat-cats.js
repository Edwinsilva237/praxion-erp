'use strict'

const XLSX = require('xlsx')
const path = require('path')

const CATALOGS = [
  'c_RegimenFiscal',
  'c_UsoCFDI',
  'c_FormaPago',
  'c_MetodoPago',
  'c_ObjetoImp',
  'c_Impuesto',
  'c_TipoFactor',
  'c_TasaOCuota',
  'c_TipoDeComprobante',
  'c_Pais',
  'c_TipoRelacion',
  'c_Exportacion',
  'c_Periodicidad',
  'c_Meses',
]

const filePath = process.argv[2] || 'C:/Users/admin/Downloads/catCFDI_V_4_20260521.xls'
const wb = XLSX.readFile(filePath)

for (const name of CATALOGS) {
  const sheet = wb.Sheets[name]
  if (!sheet) { console.log(`\n${name}: NOT FOUND`); continue }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null })
  console.log(`\n=== ${name} (${rows.length} rows) ===`)
  // Header (fila 4)
  console.log('HEADER:', rows[4])
  // Primeras 3 filas de datos
  for (let i = 5; i < Math.min(8, rows.length); i++) {
    console.log(`  [${i-5}]:`, rows[i])
  }
}
