'use strict'

/**
 * One-shot: lee Excel CFDI 4.0 del SAT, extrae 10 catalogos criticos para
 * facturacion y genera mig 170 con CREATE TABLE + INSERT por cada uno.
 *
 * Catalogos cargados:
 *   - sat_regimen_fiscal:    code, name, fisica, moral
 *   - sat_uso_cfdi:          code, name, fisica, moral, regimenes_csv
 *   - sat_forma_pago:        code, name, bancarizado
 *   - sat_metodo_pago:       code, name
 *   - sat_objeto_imp:        code, name
 *   - sat_impuesto:          code, name
 *   - sat_tipo_factor:       code, name
 *   - sat_tasa_cuota:        code, valor_min, valor_max, factor (CSV de tipo_factor que aplica)
 *   - sat_tipo_comprobante:  code, name, valor_maximo
 *   - sat_pais:              code, name
 */

const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const filePath = process.argv[2] || 'C:/Users/admin/Downloads/catCFDI_V_4_20260521.xls'
const wb = XLSX.readFile(filePath)

function readRows(sheetName) {
  const sheet = wb.Sheets[sheetName]
  if (!sheet) { console.warn(`Hoja no encontrada: ${sheetName}`); return [] }
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null })
}

// Una fila es de DATA si su col[0] es un valor de código (corto, no es texto
// largo, no empieza con "c_" / "Versión" / "Catálogo", no es metadata "4.0").
// Lo aplicamos por fila en vez de detectar "donde empieza" — más robusto a
// hojas con headers en filas distintas.
function isDataRow(r) {
  if (!r || r.length === 0) return false
  const v = r[0]
  if (v == null) return false
  const s = String(v).trim()
  if (!s) return false
  // Excluir cabeceras y metadata
  if (/^c_/i.test(s)) return false
  if (s === 'Catálogo' || s.startsWith('Catálogo de')) return false
  if (s === 'Versión CFDI' || s === 'Descripción') return false
  if (/^\d+\.\d+$/.test(s)) return false
  // Códigos del SAT son tipicamente cortos (1-10 chars).
  if (s.length > 12) return false
  return true
}

function isYes(v) {
  if (!v) return false
  return /^(s|si|sí|yes|true|1)$/i.test(String(v).trim())
}

function esc(s) {
  if (s == null) return 'NULL'
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function escBool(v) { return v ? 'true' : 'false' }

// ─── c_RegimenFiscal ────────────────────────────────────────────────────────
function parseRegimenFiscal() {
  const rows = readRows('c_RegimenFiscal')
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    out.push({
      code,
      name:   String(r[1] || '').trim(),
      fisica: isYes(r[2]),
      moral:  isYes(r[3]),
    })
  }
  return out
}

// ─── c_UsoCFDI ─────────────────────────────────────────────────────────────
function parseUsoCFDI() {
  const rows = readRows('c_UsoCFDI')
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    out.push({
      code,
      name:           String(r[1] || '').trim(),
      fisica:         isYes(r[2]),
      moral:          isYes(r[3]),
      regimenes_csv:  String(r[6] || '').trim() || null,
    })
  }
  return out
}

// ─── c_FormaPago ───────────────────────────────────────────────────────────
function parseFormaPago() {
  const rows = readRows('c_FormaPago')
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    out.push({
      code,
      name:        String(r[1] || '').trim(),
      bancarizado: isYes(r[2]),
    })
  }
  return out
}

// ─── Catálogos chicos (code, name) ─────────────────────────────────────────
function parseSimpleCodeName(sheetName) {
  const rows = readRows(sheetName)
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    const name = String(r[1] || '').trim()
    out.push({ code, name })
  }
  return out
}

// ─── c_TipoDeComprobante (code, name, valor_maximo) ───────────────────────
function parseTipoComprobante() {
  const rows = readRows('c_TipoDeComprobante')
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    out.push({
      code,
      name:          String(r[1] || '').trim(),
      valor_maximo:  String(r[2] || '').trim() || null,
    })
  }
  return out
}

// ─── c_TasaOCuota (code, name, valor_min, valor_max) ──────────────────────
function parseTasaCuota() {
  const rows = readRows('c_TasaOCuota')
  // En esta hoja el header es distinto. Vamos a inspeccionarlo.
  const headerRow = rows[5] || []
  const out = []
  for (let i = 0; i < rows.length; i++) {
    if (!isDataRow(rows[i])) continue
    const r = rows[i] || []
    const code = String(r[0] || '').trim()
    if (!code) continue
    out.push({
      code,
      name:         String(r[1] || '').trim(),
      valor_min:    String(r[2] || '').trim() || null,
      valor_max:    String(r[3] || '').trim() || null,
    })
  }
  return out
}

// ─── Generación de SQL ──────────────────────────────────────────────────────
const regimen      = parseRegimenFiscal()
const usoCfdi      = parseUsoCFDI()
const formaPago    = parseFormaPago()
const metodoPago   = parseSimpleCodeName('c_MetodoPago')
const objetoImp    = parseSimpleCodeName('c_ObjetoImp')
const impuesto     = parseSimpleCodeName('c_Impuesto')
const tipoFactor   = parseSimpleCodeName('c_TipoFactor')
const tasaCuota    = parseTasaCuota()
const tipoComp     = parseTipoComprobante()
const pais         = parseSimpleCodeName('c_Pais')

console.log('Parsed:')
console.log('  regimen_fiscal:', regimen.length)
console.log('  uso_cfdi:      ', usoCfdi.length)
console.log('  forma_pago:    ', formaPago.length)
console.log('  metodo_pago:   ', metodoPago.length)
console.log('  objeto_imp:    ', objetoImp.length)
console.log('  impuesto:      ', impuesto.length)
console.log('  tipo_factor:   ', tipoFactor.length)
console.log('  tasa_cuota:    ', tasaCuota.length)
console.log('  tipo_comprob:  ', tipoComp.length)
console.log('  pais:          ', pais.length)

function inserts(table, rows, fields) {
  if (rows.length === 0) return ''
  // Deduplicar por code para evitar "ON CONFLICT cannot affect row second time".
  const seen = new Set()
  const dedup = []
  for (const r of rows) {
    if (seen.has(r.code)) continue
    seen.add(r.code)
    dedup.push(r)
  }
  rows = dedup
  const cols = fields.map(f => f.col).join(', ')
  const values = rows.map(r => {
    const v = fields.map(f => {
      const val = r[f.key]
      if (f.type === 'bool') return escBool(val)
      return esc(val)
    })
    return `(${v.join(', ')})`
  }).join(',\n    ')
  return `  INSERT INTO ${table} (${cols}) VALUES
    ${values}
   ON CONFLICT (code) DO UPDATE SET ${fields.filter(f => f.col !== 'code').map(f => `${f.col} = EXCLUDED.${f.col}`).join(', ')};`
}

const mig = `'use strict'

/**
 * Mig 170 — 10 catalogos fiscales del SAT para validar pre-timbrado.
 *
 * Carga desde catCFDI_V_4_*.xls oficial del Anexo 20 los catalogos:
 *  - sat_regimen_fiscal    (${regimen.length})    persona fisica/moral aplicable
 *  - sat_uso_cfdi          (${usoCfdi.length})   uso del CFDI + regimenes compatibles
 *  - sat_forma_pago        (${formaPago.length})  bancarizado
 *  - sat_metodo_pago       (${metodoPago.length}) PUE / PPD
 *  - sat_objeto_imp        (${objetoImp.length})  objeto de impuesto por concepto
 *  - sat_impuesto          (${impuesto.length})   IVA / ISR / IEPS
 *  - sat_tipo_factor       (${tipoFactor.length}) Tasa / Cuota / Exento
 *  - sat_tasa_cuota        (${tasaCuota.length})  rangos validos
 *  - sat_tipo_comprobante  (${tipoComp.length})   I, E, T, N, P, R
 *  - sat_pais              (${pais.length})       para receptores extranjeros
 *
 * El frontend consume estos via /api/sat/<catalogo> y los muestra como
 * dropdowns en formularios fiscales (cliente, factura, conceptos).
 */

const up = \`
  -- ─── Tablas ────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sat_regimen_fiscal (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    fisica      BOOLEAN NOT NULL DEFAULT false,
    moral       BOOLEAN NOT NULL DEFAULT false,
    is_active   BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_uso_cfdi (
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    fisica          BOOLEAN NOT NULL DEFAULT false,
    moral           BOOLEAN NOT NULL DEFAULT false,
    regimenes_csv   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_forma_pago (
    code         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    bancarizado  BOOLEAN NOT NULL DEFAULT false,
    is_active    BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_metodo_pago (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_objeto_imp (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_impuesto (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tipo_factor (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tasa_cuota (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    valor_min  TEXT,
    valor_max  TEXT,
    is_active  BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tipo_comprobante (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    valor_maximo   TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_pais (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  -- ─── Datos ────────────────────────────────────────────────────────────────
${inserts('sat_regimen_fiscal', regimen, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
  { col: 'fisica', key: 'fisica', type: 'bool' },
  { col: 'moral', key: 'moral', type: 'bool' },
])}

${inserts('sat_uso_cfdi', usoCfdi, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
  { col: 'fisica', key: 'fisica', type: 'bool' },
  { col: 'moral', key: 'moral', type: 'bool' },
  { col: 'regimenes_csv', key: 'regimenes_csv' },
])}

${inserts('sat_forma_pago', formaPago, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
  { col: 'bancarizado', key: 'bancarizado', type: 'bool' },
])}

${inserts('sat_metodo_pago', metodoPago, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
])}

${inserts('sat_objeto_imp', objetoImp, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
])}

${inserts('sat_impuesto', impuesto, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
])}

${inserts('sat_tipo_factor', tipoFactor, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
])}

${inserts('sat_tasa_cuota', tasaCuota, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
  { col: 'valor_min', key: 'valor_min' },
  { col: 'valor_max', key: 'valor_max' },
])}

${inserts('sat_tipo_comprobante', tipoComp, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
  { col: 'valor_maximo', key: 'valor_maximo' },
])}

${inserts('sat_pais', pais, [
  { col: 'code', key: 'code' },
  { col: 'name', key: 'name' },
])}
\`

const down = \`
  DROP TABLE IF EXISTS sat_pais, sat_tipo_comprobante, sat_tasa_cuota,
    sat_tipo_factor, sat_impuesto, sat_objeto_imp, sat_metodo_pago,
    sat_forma_pago, sat_uso_cfdi, sat_regimen_fiscal;
\`

module.exports = { up, down }
`

const outPath = path.join(__dirname, '..', 'src', 'db', 'migrations', '170_sat_fiscal_catalogs.js')
fs.writeFileSync(outPath, mig)
const stats = fs.statSync(outPath)
console.log('\nMig generada:', outPath)
console.log('Tamaño:', Math.round(stats.size / 1024), 'KB')
