'use strict'

const express = require('express')
const multer = require('multer')
const { authGuard } = require('../../middleware/authGuard')
const { query } = require('../../db')

const router = express.Router()
router.use(authGuard)

// Multer en memoria — el CSV del SAT pesa ~5MB (~52K entradas).
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain'].includes(file.mimetype)
      || /\.(csv|txt)$/i.test(file.originalname)
    cb(ok ? null : new Error('Solo CSV/TXT.'), ok)
  },
})

// Solo super_admin (rol global, tenant_id NULL) puede cargar el catálogo
// completo del SAT — afecta a todos los tenants.
async function assertSuperAdmin(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.name = 'super_admin' AND r.tenant_id IS NULL`,
      [req.auth.userId]
    )
    if (!rows[0]) return res.status(403).json({ error: 'Solo super_admin puede cargar el catálogo SAT.' })
    next()
  } catch (err) { next(err) }
}

/**
 * GET /api/sat/product-codes
 *   - Sin parámetros → primeras 30 entradas activas alfabéticamente por nombre.
 *   - ?q=palomitas    → busca por substring del nombre (case-insensitive).
 *   - ?q=50202200    → si parecen 8 dígitos, busca por code exacto + prefijo.
 *
 * El catálogo es público (no scope por tenant) — la única restricción es estar
 * autenticado.
 */
router.get('/product-codes', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(parseInt(req.query.limit || 30, 10), 100)
    if (!q) {
      const { rows } = await query(
        `SELECT code, name FROM sat_product_codes
          WHERE is_active = true ORDER BY code LIMIT $1`,
        [limit]
      )
      return res.json(rows)
    }
    if (/^\d{1,8}$/.test(q)) {
      // Búsqueda por código: exacto o prefijo. Limit pequeño + ORDER BY code.
      const { rows } = await query(
        `SELECT code, name FROM sat_product_codes
          WHERE is_active = true AND code LIKE $1
          ORDER BY code LIMIT $2`,
        [`${q}%`, limit]
      )
      return res.json(rows)
    }
    // Búsqueda por nombre: ILIKE substring + ranking por similaridad (pg_trgm).
    const { rows } = await query(
      `SELECT code, name
         FROM sat_product_codes
        WHERE is_active = true
          AND name ILIKE '%' || $1 || '%'
        ORDER BY similarity(name, $1) DESC, code
        LIMIT $2`,
      [q, limit]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

/**
 * GET /api/sat/product-codes/:code
 *
 * Resuelve una clave específica del c_ClaveProdServ. Devuelve 404 si el código
 * no está en el catálogo seed — el frontend lo trata como "no verificada"
 * pero permite que el usuario igualmente la guarde (el SAT puede tenerla en
 * el catálogo completo aunque no esté en nuestro seed inicial).
 */
router.get('/product-codes/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim()
    if (!/^\d{8}$/.test(code)) {
      return res.status(400).json({ error: 'El código debe tener 8 dígitos.' })
    }
    const { rows } = await query(
      `SELECT code, name FROM sat_product_codes WHERE code = $1`,
      [code]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Código no encontrado en el catálogo.' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// ─── c_ClaveUnidad (~2,418 entradas, sin descripciones por default) ────────
router.get('/unit-codes', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const limit = Math.min(parseInt(req.query.limit || 30, 10), 100)
    if (!q) {
      const { rows } = await query(
        `SELECT code, name FROM sat_unit_codes
          WHERE is_active = true ORDER BY code LIMIT $1`,
        [limit]
      )
      return res.json(rows)
    }
    // El código del SAT puede ser 1-3 caracteres alfanuméricos (KGM, MTR, H87,
    // pero también '11', 'KT'). Buscamos por prefijo de code en mayúsculas y
    // por substring de name (las pocas que tienen descripción).
    const qUpper = q.toUpperCase()
    const { rows } = await query(
      `SELECT code, name FROM sat_unit_codes
        WHERE is_active = true
          AND (code LIKE $1 || '%' OR name ILIKE '%' || $2 || '%')
        ORDER BY (code = $1) DESC, similarity(name, $2) DESC, code
        LIMIT $3`,
      [qUpper, q, limit]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/unit-codes/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase()
    const { rows } = await query(
      `SELECT code, name FROM sat_unit_codes WHERE code = $1`,
      [code]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Código no encontrado.' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

router.post('/unit-codes/bulk-import',
  assertSuperAdmin,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo CSV.' })
      const text = req.file.buffer.toString('utf8')
      const lines = text.split(/\r?\n/).filter(l => l.trim())
      if (lines.length === 0) return res.status(400).json({ error: 'Archivo vacío.' })
      const startIdx = /^[A-Z0-9]{1,3}\s*,/.test(lines[0]) ? 0 : 1
      const rows = []
      const errors = []
      for (let i = startIdx; i < lines.length; i++) {
        const m = lines[i].match(/^([A-Z0-9]{1,3})\s*,\s*(?:"([^"]*)"|(.+?))\s*$/)
        if (!m) { errors.push({ line: i + 1, content: lines[i].slice(0, 80) }); continue }
        const code = m[1]
        const name = (m[2] ?? m[3] ?? '').trim()
        if (name) rows.push({ code, name })
      }
      let upserted = 0
      const BATCH = 1000
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const values = []
        const params = []
        for (const r of batch) {
          values.push(`($${params.length + 1}, $${params.length + 2})`)
          params.push(r.code, r.name)
        }
        await query(
          `INSERT INTO sat_unit_codes (code, name) VALUES ${values.join(',')}
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          params
        )
        upserted += batch.length
      }
      res.json({ upserted, skipped: errors.length, errors: errors.slice(0, 20) })
    } catch (err) { next(err) }
  }
)

/**
 * POST /api/sat/product-codes/bulk-import
 *
 * Recibe CSV con columnas `code,name` (header opcional) y hace upsert masivo
 * en sat_product_codes. Idempotente — re-correr con el mismo archivo no
 * duplica. Pensado para cargar el catálogo c_ClaveProdServ completo del SAT
 * (~52K entradas) cuando esté disponible. Solo super_admin global.
 *
 * Formato esperado del CSV:
 *   code,name
 *   01010101,No existe en el catálogo
 *   10101500,Animales vivos
 *   ...
 *
 * El header se ignora si la primera línea no parece código (8 dígitos).
 */
router.post('/product-codes/bulk-import',
  assertSuperAdmin,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Se requiere un archivo CSV.' })

      const text = req.file.buffer.toString('utf8')
      const lines = text.split(/\r?\n/).filter(l => l.trim())
      if (lines.length === 0) return res.status(400).json({ error: 'El archivo está vacío.' })

      // Detectar y saltar header.
      const startIdx = /^\d{8}/.test(lines[0]) ? 0 : 1
      const rows = []
      const errors = []
      for (let i = startIdx; i < lines.length; i++) {
        // Soporta CSV simple "code,name" — nombres con coma deben ir entre comillas.
        const m = lines[i].match(/^(\d{8})\s*,\s*(?:"([^"]*)"|(.+?))\s*$/)
        if (!m) { errors.push({ line: i + 1, content: lines[i].slice(0, 80) }); continue }
        const code = m[1]
        const name = (m[2] ?? m[3] ?? '').trim()
        if (name) rows.push({ code, name })
      }

      // Upsert en batches de 1000 para no pasar el límite de parámetros (65535).
      let upserted = 0
      const BATCH = 1000
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const values = []
        const params = []
        for (const r of batch) {
          values.push(`($${params.length + 1}, $${params.length + 2})`)
          params.push(r.code, r.name)
        }
        await query(
          `INSERT INTO sat_product_codes (code, name)
           VALUES ${values.join(',')}
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name, updated_at = NOW()`,
          params
        )
        upserted += batch.length
      }

      res.json({
        upserted,
        skipped: errors.length,
        errors: errors.slice(0, 20),
      })
    } catch (err) { next(err) }
  }
)

// ═══════════════════════════════════════════════════════════════════════════
// CATALOGOS FISCALES (mig 170) — alimentan dropdowns en formularios de
// facturacion y validacion pre-timbrado. Todos son catalogos globales.
// ═══════════════════════════════════════════════════════════════════════════

// Helper genérico para devolver toda la lista activa de un catálogo.
function simpleListRoute(table, orderBy = 'code') {
  return async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT * FROM ${table} WHERE is_active = true ORDER BY ${orderBy}`
      )
      res.json(rows)
    } catch (err) { next(err) }
  }
}

router.get('/regimen-fiscal', async (req, res, next) => {
  try {
    // Opcional: ?persona=fisica|moral filtra los regimenes que aplican.
    const persona = String(req.query.persona || '').toLowerCase()
    let where = 'WHERE is_active = true'
    if (persona === 'fisica') where += ' AND fisica = true'
    else if (persona === 'moral') where += ' AND moral = true'
    const { rows } = await query(`SELECT * FROM sat_regimen_fiscal ${where} ORDER BY code`)
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/uso-cfdi', async (req, res, next) => {
  try {
    // ?persona=fisica|moral y/o ?regimen=612 filtra los usos compatibles.
    const persona = String(req.query.persona || '').toLowerCase()
    const regimen = String(req.query.regimen || '').trim()
    let where = 'WHERE is_active = true'
    const params = []
    if (persona === 'fisica') where += ' AND fisica = true'
    else if (persona === 'moral') where += ' AND moral = true'
    if (regimen) {
      // regimenes_csv es "601, 603, 606, 612, ..." — buscamos el código entre los
      // separados por coma (con tolerancia a espacios).
      params.push(regimen)
      where += ` AND (regimenes_csv IS NULL OR string_to_array(regexp_replace(regimenes_csv, '\\\\s+', '', 'g'), ',') @> ARRAY[$${params.length}])`
    }
    const { rows } = await query(`SELECT * FROM sat_uso_cfdi ${where} ORDER BY code`, params)
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/forma-pago',        simpleListRoute('sat_forma_pago'))
router.get('/metodo-pago',       simpleListRoute('sat_metodo_pago'))
router.get('/objeto-imp',        simpleListRoute('sat_objeto_imp'))
router.get('/impuesto',          simpleListRoute('sat_impuesto'))
router.get('/tipo-factor',       simpleListRoute('sat_tipo_factor'))
router.get('/tasa-cuota',        simpleListRoute('sat_tasa_cuota'))
router.get('/tipo-comprobante',  simpleListRoute('sat_tipo_comprobante'))
router.get('/tipo-relacion',     simpleListRoute('sat_tipo_relacion'))

// País: muchos (250), buscable por código o nombre.
router.get('/pais', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) {
      const { rows } = await query(
        `SELECT * FROM sat_pais WHERE is_active = true ORDER BY name LIMIT 50`
      )
      return res.json(rows)
    }
    const { rows } = await query(
      `SELECT * FROM sat_pais
        WHERE is_active = true
          AND (code ILIKE $1 || '%' OR name ILIKE '%' || $1 || '%')
        ORDER BY (code = upper($1)) DESC, name
        LIMIT 50`,
      [q]
    )
    res.json(rows)
  } catch (err) { next(err) }
})

module.exports = router
