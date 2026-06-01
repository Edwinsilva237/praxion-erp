'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const codeFormatService = require('../code-formats/codeFormatService')

/**
 * Lista productos del tenant con filtros opcionales.
 */
async function listProducts({ tenantId, type, resinType, isActive, isProduced, search, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (type)     { params.push(type);     filters.push(`p.type = $${params.length}`) }
  if (resinType){ params.push(resinType);filters.push(`p.resin_type = $${params.length}`) }
  if (isActive !== undefined) { params.push(isActive); filters.push(`p.is_active = $${params.length}`) }
  if (isProduced !== undefined) { params.push(isProduced); filters.push(`p.is_produced = $${params.length}`) }
  if (search)   {
    params.push(`%${search.toLowerCase()}%`)
    filters.push(`(LOWER(p.name) LIKE $${params.length} OR LOWER(p.sku) LIKE $${params.length})`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT p.id, p.sku, p.name, p.type, p.resin_type, p.is_produced,
            p.product_kind_id,
            tpk.code AS product_kind_code, tpk.name AS product_kind_name,
            p.units_per_package, p.sale_unit,
            p.sat_product_code, p.sat_unit_code, p.objeto_imp,
            p.tax_factor, p.tax_rate,
            p.lead_time_days, p.base_price, p.base_currency,
            p.is_active, p.created_at,
            qs.grams_per_linear_meter,
            qs.tolerance_pct,
            qs.units_per_package AS spec_units_per_package,
            (qs.id IS NOT NULL) AS has_quality_spec,
            img.id AS image_attachment_id
     FROM products p
     LEFT JOIN tenant_product_kinds tpk ON tpk.id = p.product_kind_id
     LEFT JOIN LATERAL (
       SELECT id, grams_per_linear_meter, tolerance_pct, units_per_package
       FROM product_quality_specs
       WHERE product_id = p.id AND valid_until IS NULL
       ORDER BY valid_from DESC LIMIT 1
     ) qs ON true
     LEFT JOIN LATERAL (
       SELECT id FROM attachments
        WHERE entity_type = 'product' AND entity_id = p.id AND category = 'image'
        ORDER BY created_at DESC LIMIT 1
     ) img ON true
     WHERE p.tenant_id = $1 ${where}
     ORDER BY p.type, p.sku
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM products p WHERE p.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getProduct({ tenantId, productId }) {
  const { rows } = await query(
    `SELECT p.* FROM products p WHERE p.id = $1 AND p.tenant_id = $2`,
    [productId, tenantId]
  )
  if (rows.length === 0) return null

  const product = rows[0]

  const { rows: prices } = await query(
    `SELECT cp.id, cp.business_partner_id AS partner_id, cp.unit_price AS price, cp.currency,
            bp.name AS partner_name
     FROM customer_prices cp
     JOIN business_partners bp ON bp.id = cp.business_partner_id
     WHERE cp.product_id = $1 AND cp.tenant_id = $2
       AND (cp.valid_until IS NULL OR cp.valid_until >= CURRENT_DATE)
     ORDER BY bp.name`,
    [productId, tenantId]
  )

  // Specs de calidad vigentes (si las hay) — solo aplica a esquineros pero
  // devolvemos siempre para uniformidad. Si no hay specs, qualitySpec = null.
  const { rows: specs } = await query(
    `SELECT id, grams_per_linear_meter, tolerance_pct, units_per_package, notes,
            valid_from, created_by
     FROM product_quality_specs
     WHERE product_id = $1 AND valid_until IS NULL
     ORDER BY valid_from DESC LIMIT 1`,
    [productId]
  )

  // Presentaciones de venta (rollo, millar, caja, etc.)
  const { rows: packOptions } = await query(
    `SELECT id, pack_unit, base_per_pack, sat_unit_code, is_default, notes
       FROM product_pack_options
      WHERE product_id = $1 AND tenant_id = $2
      ORDER BY is_default DESC, base_per_pack ASC, pack_unit ASC`,
    [productId, tenantId]
  )

  // Imagen principal (última subida con category='image')
  const { rows: imgRows } = await query(
    `SELECT id FROM attachments
      WHERE tenant_id = $1 AND entity_type = 'product' AND entity_id = $2
        AND category = 'image'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, productId]
  )

  return {
    ...product,
    customerPrices:      prices,
    qualitySpec:         specs[0] || null,
    packOptions,
    image_attachment_id: imgRows[0]?.id || null,
  }
}

// ─── Presentaciones (pack_options) ──────────────────────────────────────────

async function listPackOptions({ tenantId, productId }) {
  const { rows } = await query(
    `SELECT id, pack_unit, base_per_pack, sat_unit_code, is_default, notes
       FROM product_pack_options
      WHERE product_id = $1 AND tenant_id = $2
      ORDER BY is_default DESC, base_per_pack ASC, pack_unit ASC`,
    [productId, tenantId]
  )
  return rows
}

async function createPackOption({
  tenantId, productId, packUnit, basePerPack, satUnitCode, isDefault, notes,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Validar que el producto existe
    const { rows: prod } = await client.query(
      `SELECT id FROM products WHERE id = $1 AND tenant_id = $2`,
      [productId, tenantId]
    )
    if (!prod.length) throw createError(404, 'Producto no encontrado.')

    // Si is_default = true, desmarcar el default actual
    if (isDefault) {
      await client.query(
        `UPDATE product_pack_options SET is_default = false
          WHERE tenant_id = $1 AND product_id = $2 AND is_default = true`,
        [tenantId, productId]
      )
    }

    const { rows } = await client.query(
      `INSERT INTO product_pack_options
         (tenant_id, product_id, pack_unit, base_per_pack, sat_unit_code, is_default, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [tenantId, productId, packUnit.trim(),
       parseFloat(basePerPack) || 1,
       (satUnitCode || 'H87').toUpperCase(),
       !!isDefault, notes || null]
    )

    await audit({
      tenantId, userId, action: 'product_pack_option.created',
      resource: 'product_pack_options', resourceId: rows[0].id,
      payload: { productId, packUnit, basePerPack },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function updatePackOption({
  tenantId, packOptionId, packUnit, basePerPack, satUnitCode, isDefault, notes,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT product_id FROM product_pack_options
        WHERE id = $1 AND tenant_id = $2`,
      [packOptionId, tenantId]
    )
    if (!existing.length) throw createError(404, 'Presentación no encontrada.')

    if (isDefault === true) {
      await client.query(
        `UPDATE product_pack_options SET is_default = false
          WHERE tenant_id = $1 AND product_id = $2 AND id <> $3 AND is_default = true`,
        [tenantId, existing[0].product_id, packOptionId]
      )
    }

    const { rows } = await client.query(
      `UPDATE product_pack_options SET
         pack_unit     = COALESCE($1, pack_unit),
         base_per_pack = COALESCE($2, base_per_pack),
         sat_unit_code = COALESCE($3, sat_unit_code),
         is_default    = COALESCE($4, is_default),
         notes         = COALESCE($5, notes)
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [packUnit ? packUnit.trim() : null,
       basePerPack != null ? parseFloat(basePerPack) : null,
       satUnitCode ? satUnitCode.toUpperCase() : null,
       isDefault !== undefined ? isDefault : null,
       notes ?? null,
       packOptionId, tenantId]
    )

    await audit({
      tenantId, userId, action: 'product_pack_option.updated',
      resource: 'product_pack_options', resourceId: packOptionId,
      payload: { packUnit, basePerPack, isDefault },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function deletePackOption({ tenantId, packOptionId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    // Verificar que no esté referenciada por líneas activas
    const { rows: usage } = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM (
         SELECT id FROM sales_order_lines   WHERE pack_option_id = $1 LIMIT 1
         UNION ALL
         SELECT id FROM delivery_note_lines WHERE pack_option_id = $1 LIMIT 1
         UNION ALL
         SELECT id FROM invoice_lines       WHERE pack_option_id = $1 LIMIT 1
       ) u`,
      [packOptionId]
    )
    if (usage[0].cnt > 0) {
      throw createError(409, 'Esta presentación ya se usó en algún documento. No puede eliminarse — créa una nueva o márcala como no-default.')
    }

    const { rows } = await client.query(
      `DELETE FROM product_pack_options WHERE id = $1 AND tenant_id = $2
       RETURNING id, product_id, pack_unit, is_default`,
      [packOptionId, tenantId]
    )
    if (!rows.length) return false

    // Si era el default, marcar otra como default si existe
    if (rows[0].is_default) {
      await client.query(
        `UPDATE product_pack_options SET is_default = true
          WHERE id = (
            SELECT id FROM product_pack_options
             WHERE tenant_id = $1 AND product_id = $2
             ORDER BY base_per_pack ASC LIMIT 1
          )`,
        [tenantId, rows[0].product_id]
      )
    }

    await audit({
      tenantId, userId, action: 'product_pack_option.deleted',
      resource: 'product_pack_options', resourceId: packOptionId,
      payload: { productId: rows[0].product_id, packUnit: rows[0].pack_unit },
      ipAddress, userAgent,
    })

    return true
  })
}

async function createProduct({
  tenantId, sku, name, type, isProduced, productKindId, resinType,
  lengthMm, widthMm, thicknessMm, unitsPerPackage, saleUnit, description,
  satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
  basePrice, baseCurrency,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Compatibilidad: si el caller no explicita is_produced, lo derivamos del
    // enum legacy `type`. Tenants/tests viejos siguen funcionando.
    const resolvedIsProduced = isProduced !== undefined
      ? !!isProduced
      : (type === 'corner_protector')

    // Resolver SKU según nomenclatura configurada (mode=auto sobrescribe,
    // mode=suggested consume si coincide con el preview).
    const resolvedSku = await codeFormatService.applyCodeFormat({
      client, tenantId, entityType: 'product', providedCode: sku,
    })

    const { rows } = await client.query(
      `INSERT INTO products
         (tenant_id, sku, name, type, is_produced, product_kind_id, resin_type,
          length_mm, width_mm, thickness_mm, units_per_package, sale_unit, description,
          sat_product_code, sat_unit_code, objeto_imp, lead_time_days,
          base_price, base_currency, tax_factor, tax_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        tenantId,
        (resolvedSku || '').toUpperCase().trim(),
        name.trim(),
        type || (resolvedIsProduced ? 'corner_protector' : 'resale'),
        resolvedIsProduced,
        productKindId || null,
        resinType || null,
        lengthMm || null,
        widthMm || null,
        thicknessMm || null,
        unitsPerPackage || 50,
        saleUnit || 'paquete',
        description || null,
        satProductCode || '44102305',
        satUnitCode    || 'H87',
        objetoImp      || '02',
        leadTimeDays != null ? parseInt(leadTimeDays) : 7,
        basePrice != null && basePrice !== '' ? basePrice : null,
        baseCurrency || 'MXN',
        taxFactor || 'Tasa',
        taxRate != null && taxRate !== '' ? taxRate : 16,
      ]
    )
    const product = rows[0]

    // Crear presentación default automáticamente para que todos los productos
    // tengan al menos una pack_option (ver migración 074).
    await client.query(
      `INSERT INTO product_pack_options
         (tenant_id, product_id, pack_unit, base_per_pack, sat_unit_code, is_default)
       VALUES ($1, $2, $3, 1, $4, true)`,
      [tenantId, product.id, product.sale_unit || 'pieza', product.sat_unit_code || 'H87']
    )

    await audit({
      tenantId, userId, action: 'product.created', resource: 'products',
      resourceId: product.id, payload: { sku: product.sku, type },
      ipAddress, userAgent,
    })

    return product
  })
}

async function updateProduct({
  tenantId, productId, name, description, saleUnit, isActive,
  satProductCode, satUnitCode, objetoImp, taxFactor, taxRate, leadTimeDays,
  basePrice, baseCurrency,
  expectedSalePrice,        // §6c: NRV multi-calidad (products.expected_sale_price)
  productKindId,            // §6c: clasificación SaaS v2
  defaultQualityGradeId,    // §6c: calidad por defecto del producto
  isProduced,               // §6c: flag explícito de producto fabricado
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // base_price / expected_sale_price tienen semántica especial: '' o null lo limpian a NULL.
    const basePriceProvided         = basePrice         !== undefined
    const baseCurrencyProvided      = baseCurrency      !== undefined
    const expectedSalePriceProvided = expectedSalePrice !== undefined
    const productKindIdProvided     = productKindId     !== undefined
    const defaultGradeIdProvided    = defaultQualityGradeId !== undefined

    // Capturar la clave de unidad SAT anterior para propagarla a las
    // presentaciones que estaban en sincronía con ella (típicamente la default
    // que se auto-crea espejando al producto). Solo aplica cuando el caller
    // manda satUnitCode.
    let oldSatUnitCode = null
    if (satUnitCode) {
      const { rows: prev } = await client.query(
        `SELECT sat_unit_code FROM products WHERE id = $1 AND tenant_id = $2`,
        [productId, tenantId]
      )
      oldSatUnitCode = prev[0]?.sat_unit_code || null
    }

    const { rows } = await client.query(
      `UPDATE products SET
         name                  = COALESCE($1, name),
         description           = COALESCE($2, description),
         sale_unit             = COALESCE($3, sale_unit),
         is_active             = COALESCE($4, is_active),
         sat_product_code      = COALESCE($5, sat_product_code),
         sat_unit_code         = COALESCE($6, sat_unit_code),
         objeto_imp            = COALESCE($7, objeto_imp),
         lead_time_days        = COALESCE($8, lead_time_days),
         base_price            = CASE WHEN $11::boolean THEN $9::numeric           ELSE base_price            END,
         base_currency         = CASE WHEN $12::boolean THEN COALESCE($10::document_currency, base_currency) ELSE base_currency END,
         expected_sale_price   = CASE WHEN $13::boolean THEN $14::numeric          ELSE expected_sale_price   END,
         product_kind_id       = CASE WHEN $15::boolean THEN $16::uuid             ELSE product_kind_id       END,
         default_quality_grade_id = CASE WHEN $17::boolean THEN $18::uuid          ELSE default_quality_grade_id END,
         is_produced           = COALESCE($19, is_produced),
         tax_factor            = COALESCE($22, tax_factor),
         tax_rate              = COALESCE($23, tax_rate)
       WHERE id = $20 AND tenant_id = $21
       RETURNING *`,
      [
        name        || null,
        description || null,
        saleUnit    || null,
        isActive !== undefined ? isActive : null,
        satProductCode || null,
        satUnitCode    || null,
        objetoImp      || null,
        leadTimeDays !== undefined && leadTimeDays !== null ? parseInt(leadTimeDays) : null,
        basePriceProvided ? (basePrice === '' || basePrice === null ? null : basePrice) : null,
        baseCurrencyProvided ? (baseCurrency || null) : null,
        basePriceProvided,
        baseCurrencyProvided,
        expectedSalePriceProvided,
        expectedSalePriceProvided ? (expectedSalePrice === '' || expectedSalePrice === null ? null : expectedSalePrice) : null,
        productKindIdProvided,
        productKindIdProvided ? (productKindId || null) : null,
        defaultGradeIdProvided,
        defaultGradeIdProvided ? (defaultQualityGradeId || null) : null,
        isProduced !== undefined ? isProduced : null,
        productId,
        tenantId,
        taxFactor || null,
        taxRate != null && taxRate !== '' ? taxRate : null,
      ]
    )
    if (rows.length === 0) return null

    // Propagar el cambio de clave de unidad SAT a las presentaciones que tenían
    // la clave anterior. La factura toma sat_unit_code de product_pack_options
    // (no del producto) — sin esto, editar la clave del producto NO surtía
    // efecto al facturar y el validador SAT seguía rebotando (ej. "ROL"→"XRO").
    // Acotado a las presentaciones que coincidían con la clave vieja: no pisa
    // las que el usuario fijó a propósito con otra unidad (ej. "caja"=XBX).
    const newSatUnitCode = rows[0].sat_unit_code
    if (satUnitCode && oldSatUnitCode && newSatUnitCode && newSatUnitCode !== oldSatUnitCode) {
      await client.query(
        `UPDATE product_pack_options
            SET sat_unit_code = $1
          WHERE product_id = $2 AND tenant_id = $3 AND sat_unit_code = $4`,
        [newSatUnitCode, productId, tenantId, oldSatUnitCode]
      )
    }

    await audit({
      tenantId, userId, action: 'product.updated', resource: 'products',
      resourceId: productId, payload: { name, isActive, satProductCode },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function addQualitySpec({
  tenantId, productId, gramsPerLinearMeter, tolerancePct,
  unitsPerPackage, notes, userId, ipAddress, userAgent,
}) {
  const product = await getProduct({ tenantId, productId })
  if (!product) throw createError(404, 'Producto no encontrado.')
  // Las especificaciones de calidad solo aplican a productos que se fabrican.
  // (Antes se validaba contra type='corner_protector'; ahora cualquier producto
  // producido puede tener specs — la pantalla de Calidad por tenant definirá
  // qué campos aplican.)
  if (!product.is_produced) {
    throw createError(400, 'Solo los productos que se fabrican internamente pueden tener especificaciones de calidad.')
  }

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE product_quality_specs SET valid_until = NOW()
       WHERE product_id = $1 AND valid_until IS NULL`,
      [productId]
    )

    const { rows } = await client.query(
      `INSERT INTO product_quality_specs
         (product_id, grams_per_linear_meter, tolerance_pct,
          units_per_package, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [productId, gramsPerLinearMeter, tolerancePct,
       unitsPerPackage || 50, notes || null, userId]
    )

    await audit({
      tenantId, userId, action: 'product.quality_spec_updated', resource: 'products',
      resourceId: productId,
      payload: { gramsPerLinearMeter, tolerancePct },
      ipAddress, userAgent,
    })

    return rows[0]
  })
}

async function getQualitySpecHistory({ tenantId, productId }) {
  const { rows: product } = await query(
    `SELECT id FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, tenantId]
  )
  if (product.length === 0) return null

  const { rows } = await query(
    `SELECT qs.*, u.full_name AS created_by_name
     FROM product_quality_specs qs
     LEFT JOIN users u ON u.id = qs.created_by
     WHERE qs.product_id = $1
     ORDER BY qs.valid_from DESC`,
    [productId]
  )
  return rows
}

/**
 * Elimina un producto SOLO si no tiene movimientos/actividad asociada.
 * Permiso `products:delete` (solo admin) ya verificado en la ruta. La config
 * propia del producto (pack_options, quality_specs, recipes, allergens,
 * customer_prices) cae por ON DELETE CASCADE; los adjuntos (referencia
 * polimórfica, sin FK) se limpian explícitamente.
 */
async function deleteProduct({ tenantId, productId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: prod } = await client.query(
      `SELECT id, sku, name FROM products WHERE id = $1 AND tenant_id = $2`,
      [productId, tenantId]
    )
    if (!prod.length) throw createError(404, 'Producto no encontrado.')

    // Guard: cualquier rastro de actividad bloquea el borrado. product_id es
    // único y ya pertenece a este tenant, así que basta filtrar por él en las
    // tablas de línea (no traen tenant_id). El kardex es polimórfico.
    const { rows: act } = await client.query(
      `SELECT
         EXISTS(SELECT 1 FROM inventory_movements WHERE tenant_id=$2 AND item_type='product' AND item_id=$1) AS movements,
         EXISTS(SELECT 1 FROM product_lots        WHERE product_id=$1) AS lots,
         EXISTS(SELECT 1 FROM production_orders   WHERE product_id=$1) AS production,
         EXISTS(SELECT 1 FROM sales_order_lines   WHERE product_id=$1) AS orders,
         EXISTS(SELECT 1 FROM delivery_note_lines WHERE product_id=$1) AS remisiones,
         EXISTS(SELECT 1 FROM invoice_lines       WHERE product_id=$1) AS invoices,
         EXISTS(SELECT 1 FROM quotation_lines     WHERE product_id=$1) AS quotes`,
      [productId, tenantId]
    )
    const a = act[0]
    const reasons = []
    if (a.movements)  reasons.push('movimientos de inventario')
    if (a.lots)       reasons.push('lotes')
    if (a.production)  reasons.push('órdenes de producción')
    if (a.orders)     reasons.push('pedidos')
    if (a.remisiones) reasons.push('remisiones')
    if (a.invoices)   reasons.push('facturas')
    if (a.quotes)     reasons.push('cotizaciones')
    if (reasons.length) {
      throw createError(409,
        `No se puede eliminar: el producto tiene ${reasons.join(', ')} asociado(s). Desactívalo en su lugar.`)
    }

    // Adjuntos (imagen/COA/fichas) — referencia polimórfica, sin FK a products.
    await client.query(
      `DELETE FROM attachments WHERE tenant_id=$2 AND entity_type='product' AND entity_id=$1`,
      [productId, tenantId]
    )

    await client.query(`DELETE FROM products WHERE id=$1 AND tenant_id=$2`, [productId, tenantId])

    await audit({
      tenantId, userId, action: 'product.deleted',
      resource: 'products', resourceId: productId,
      payload: { sku: prod[0].sku, name: prod[0].name },
      ipAddress, userAgent,
    })

    return { id: productId, sku: prod[0].sku, name: prod[0].name }
  })
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listProducts, getProduct, createProduct,
  updateProduct, addQualitySpec, getQualitySpecHistory,
  listPackOptions, createPackOption, updatePackOption, deletePackOption,
  deleteProduct,
}
