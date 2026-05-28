'use strict'

/**
 * Script one-shot para generar la mig 167 con los catálogos SAT completos
 * extraídos del XSD oficial CFDI 4.0 (catCFDI.xsd.xml).
 *
 * Uso: node scripts/generate-sat-mig.js <ruta-al-xsd>
 *
 * Genera src/db/migrations/167_sat_catalogs_full.js con INSERTs en batches.
 */

const fs = require('fs')
const path = require('path')

const xsdPath = process.argv[2] || 'C:/Users/admin/Downloads/catCFDI.xsd.xml'
if (!fs.existsSync(xsdPath)) {
  console.error('No existe:', xsdPath)
  process.exit(1)
}

console.log('Leyendo XSD:', xsdPath)
const text = fs.readFileSync(xsdPath, 'utf8')
const lines = text.split(/\r?\n/)

const buckets = {}
let current = null
for (const line of lines) {
  const mType = /<xs:simpleType name="([^"]+)"/.exec(line)
  if (mType) { current = mType[1]; buckets[current] = []; continue }
  if (line.includes('</xs:simpleType>')) { current = null; continue }
  const mEnum = /<xs:enumeration value="([^"]+)"/.exec(line)
  if (mEnum && current) buckets[current].push(mEnum[1])
}

const prodServ = buckets['c_ClaveProdServ'] || []
const unidad   = buckets['c_ClaveUnidad']   || []
console.log('c_ClaveProdServ:', prodServ.length)
console.log('c_ClaveUnidad:  ', unidad.length)

function makeBatched(table, codes, batchSize = 2000) {
  const out = []
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize)
    const values = batch.map(c => `('${c}', '${c}')`).join(',')
    out.push(`  INSERT INTO ${table} (code, name) VALUES ${values} ON CONFLICT (code) DO NOTHING;`)
  }
  return out.join('\n')
}

const header = `'use strict'

/**
 * Mig 167 — catalogos SAT completos (c_ClaveProdServ + c_ClaveUnidad).
 *
 * Carga las ${prodServ.length} claves de producto/servicio y ${unidad.length} claves
 * de unidad del catalogo oficial CFDI 4.0 desde el XSD del SAT. Como el XSD
 * solo trae los codigos validos (sin descripcion), insertamos con name = code
 * como placeholder. ON CONFLICT DO NOTHING preserva las descripciones que ya
 * estan en BD (los 105 del seed inicial de mig 166).
 *
 * Cuando el cliente consiga el Excel oficial con descripciones, hace bulk
 * import via POST /api/sat/product-codes/bulk-import — eso si pisa los names
 * placeholder con las descripciones reales.
 *
 * Tambien crea tabla sat_unit_codes analoga para reemplazar el catalogo
 * curado embebido en frontend (saas-erp-frontend/src/data/satUnits.js).
 */

const up = \`
  -- ─── Tabla sat_unit_codes (c_ClaveUnidad CFDI 4.0) ────────────────────────
  CREATE TABLE IF NOT EXISTS sat_unit_codes (
    code         TEXT        PRIMARY KEY,
    name         TEXT        NOT NULL,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS suc_active ON sat_unit_codes (is_active);
  CREATE INDEX IF NOT EXISTS suc_name_trgm ON sat_unit_codes USING gin (name gin_trgm_ops);

  COMMENT ON TABLE sat_unit_codes IS
    'Catalogo global c_ClaveUnidad del SAT (CFDI 4.0). Sin tenant_id, compartido entre todos los tenants. Carga inicial desde XSD oficial sin descripciones; descripciones via bulk import del Excel oficial.';

  -- ─── Relajar formato de sat_product_codes ─────────────────────────────────
  -- El XSD oficial trae claves de 6-8 caracteres. Ajustamos el CHECK para
  -- aceptar el rango completo (antes era estrictamente 8 digitos).
  ALTER TABLE sat_product_codes DROP CONSTRAINT IF EXISTS spc_code_format;
  ALTER TABLE sat_product_codes
    ADD CONSTRAINT spc_code_format CHECK (code ~ '^[0-9]{6,8}$');

  -- ─── Carga masiva c_ClaveProdServ (${prodServ.length} codigos) ─────────────────────
${makeBatched('sat_product_codes', prodServ)}

  -- ─── Carga masiva c_ClaveUnidad (${unidad.length} codigos) ───────────────────────
${makeBatched('sat_unit_codes', unidad)}
\`

const down = \`
  DROP TABLE IF EXISTS sat_unit_codes;
  -- No revertimos sat_product_codes para no perder datos del seed.
  SELECT 1;
\`

module.exports = { up, down }
`

const outPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '167_sat_catalogs_full.js')
fs.writeFileSync(outPath, header)
const stats = fs.statSync(outPath)
console.log('Mig generada:', outPath)
console.log('Tamaño:', Math.round(stats.size / 1024), 'KB')
