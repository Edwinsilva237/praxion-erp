'use strict'

const express = require('express')
const { authGuard } = require('../../middleware/authGuard')
const { query } = require('../../db')

const router = express.Router()
router.use(authGuard)

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

module.exports = router
