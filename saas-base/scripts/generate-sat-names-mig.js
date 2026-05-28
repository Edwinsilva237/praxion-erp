'use strict'

/**
 * One-shot: lee el Excel oficial del SAT (catCFDI_V_4_*.xls) y extrae
 * las descripciones de c_ClaveProdServ y c_ClaveUnidad. Genera mig 169
 * con UPSERTs en batches de 1000 hacia sat_product_codes y sat_unit_codes.
 *
 * Estructura del Excel (verificada):
 *   - Hoja por catálogo, fila 0 = titulo, filas 1-3 = metadata, fila 4 = header,
 *     fila 5+ = datos. Col A = código, Col B = descripción.
 *
 * Uso: node scripts/generate-sat-names-mig.js [ruta-al-xls]
 */

const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const filePath = process.argv[2] || 'C:/Users/admin/Downloads/catCFDI_V_4_20260521.xls'
console.log('Leyendo:', filePath)
const wb = XLSX.readFile(filePath, { cellDates: false })

function extract(sheetName) {
  const sheet = wb.Sheets[sheetName]
  if (!sheet) { console.error('Hoja no encontrada:', sheetName); return [] }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null })
  // Data empieza en fila 5 (índice 5). Col A = code, Col B = descripción.
  const out = []
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.length === 0) continue
    const code = String(r[0] || '').trim()
    const name = String(r[1] || '').trim()
    if (!code || !name || name === code) continue
    out.push({ code, name })
  }
  return out
}

const productos = extract('c_ClaveProdServ')
const unidades  = extract('c_ClaveUnidad')
console.log('c_ClaveProdServ con descripcion:', productos.length)
console.log('c_ClaveUnidad con descripcion:  ', unidades.length)

function esc(s) {
  // Comillas simples → dobles. Backslashes → dobles.
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function makeBatched(table, rows, batchSize = 500) {
  const out = []
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const values = batch.map(r => `('${esc(r.code)}', '${esc(r.name)}')`).join(',')
    out.push(`  INSERT INTO ${table} (code, name) VALUES ${values}
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();`)
  }
  return out.join('\n')
}

const mig = `'use strict'

/**
 * Mig 169 — descripciones oficiales del SAT desde el Excel CFDI 4.0.
 *
 * Procesa catCFDI_V_4_*.xls (Anexo 20 del SAT) y hace UPSERT de las
 * descripciones en sat_product_codes y sat_unit_codes. Las migs 166-168
 * habian cargado los codigos validos con name = code (placeholder); ahora
 * los reemplazamos con los nombres legibles oficiales.
 *
 * Estadisticas de esta carga:
 *  - c_ClaveProdServ: ${productos.length} descripciones de ${productos.length} entradas con texto.
 *  - c_ClaveUnidad:   ${unidades.length} descripciones.
 *
 * Idempotente: re-correr no duplica. Pisa cualquier descripcion previa
 * (incluso las del seed manual de mig 166) con la oficial del SAT.
 */

const up = \`
  -- ─── c_ClaveProdServ: ${productos.length} descripciones ────────────────────────
${makeBatched('sat_product_codes', productos)}

  -- ─── c_ClaveUnidad: ${unidades.length} descripciones ──────────────────────────
${makeBatched('sat_unit_codes', unidades)}
\`

const down = \`
  SELECT 1;  -- No-op
\`

module.exports = { up, down }
`

const outPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '169_sat_names_from_xls.js')
fs.writeFileSync(outPath, mig)
const stats = fs.statSync(outPath)
console.log('Mig generada:', outPath)
console.log('Tamaño:', Math.round(stats.size / 1024), 'KB')
