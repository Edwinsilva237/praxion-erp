'use strict'

/**
 * One-shot: lee saas-erp-frontend/src/data/satUnits.js y genera la mig 168
 * con UPSERT de descripciones (las ~150 entries curadas que tenía embebidas
 * en el frontend) hacia sat_unit_codes en BD.
 */

const fs = require('fs')
const path = require('path')

const srcPath = path.join(__dirname, '..', '..', 'saas-erp-frontend', 'src', 'data', 'satUnits.js')
const src = fs.readFileSync(srcPath, 'utf8')

const entries = []
const re = /\{\s*code:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*\}/g
let m
while ((m = re.exec(src)) !== null) {
  entries.push({ code: m[1], label: m[2] })
}

// Deduplicar por code — el satUnits.js tenía algunos duplicados
// (ej. XCT aparece dos veces, D63 también).
const dedup = new Map()
for (const e of entries) {
  if (!dedup.has(e.code)) dedup.set(e.code, e)
}
const finalEntries = [...dedup.values()]
console.log('Entries extraidos:', entries.length, '→ tras dedup:', finalEntries.length)

function esc(s) {
  return s.replace(/'/g, "''")
}

const values = finalEntries.map(e => `('${esc(e.code)}', '${esc(e.label)}')`).join(',\n      ')

const mig = `'use strict'

/**
 * Mig 168 — descripciones de unidades SAT curadas.
 *
 * La mig 167 carga las 2,418 claves de c_ClaveUnidad del XSD oficial con
 * name = code (placeholder, sin descripcion). Esta mig pisa con descripciones
 * legibles para las ${entries.length} unidades mas comunes en industria mexicana
 * (las que estaban embebidas en saas-erp-frontend/src/data/satUnits.js).
 *
 * Al hacer ON CONFLICT (code) DO UPDATE, las entradas previamente cargadas
 * con name=code obtienen su nombre real, sin afectar las que ya tenian
 * descripcion del bulk import del Excel oficial cuando llegue.
 *
 * Codigos no oficiales del SAT (ej. MIL = Millar) tambien se cargan aqui.
 * El XSD del SAT no los tiene, pero los aceptamos para uso comercial
 * interno; al timbrar CFDI el cliente debe verificar la equivalencia oficial.
 */

const up = \`
  INSERT INTO sat_unit_codes (code, name) VALUES
      ${values}
   ON CONFLICT (code) DO UPDATE
     SET name = EXCLUDED.name, updated_at = NOW();
\`

const down = \`
  -- No-op: revertir significaria reescribir nombres con codigos placeholder.
  SELECT 1;
\`

module.exports = { up, down }
`

const outPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '168_sat_unit_names.js')
fs.writeFileSync(outPath, mig)
console.log('Mig generada:', outPath)
