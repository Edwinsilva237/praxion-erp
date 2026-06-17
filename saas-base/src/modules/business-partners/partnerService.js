'use strict'

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')
const codeFormatService = require('../code-formats/codeFormatService')

// ─── Listado y detalle ───────────────────────────────────────────────────────

async function listPartners({ tenantId, type, role, isActive, search, includeOccasional = false, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  // `role` = filtro por ROL inclusivo: un socio 'both' ES cliente Y proveedor, así
  // que role='customer' también trae los 'both' (y role='supplier' igual). Es lo que
  // usan los selectores (pedidos, OC, precios, pagos, etc.). `type` sigue siendo
  // igualdad EXACTA (lo usa la pantalla de Socios para sus pestañas). Los literales
  // van hardcoded (no interpolación de input) → sin riesgo de inyección.
  if (role === 'customer')      { filters.push(`bp.type IN ('customer','both')`) }
  else if (role === 'supplier') { filters.push(`bp.type IN ('supplier','both')`) }
  else if (type)                { params.push(type); filters.push(`bp.type = $${params.length}`) }
  if (isActive !== undefined) { params.push(isActive); filters.push(`bp.is_active = $${params.length}`) }
  if (search) {
    // Busca por nombre comercial (name), razón social (tax_name) o RFC.
    params.push(`%${search}%`)
    filters.push(`(bp.name ILIKE $${params.length} OR bp.tax_name ILIKE $${params.length} OR bp.rfc ILIKE $${params.length})`)
  }
  // Los clientes ocasionales se ocultan del catálogo principal salvo opt-in.
  if (!includeOccasional) filters.push('bp.is_occasional = false')

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT bp.id, bp.type, bp.person_type, bp.name, bp.tax_name, bp.rfc, bp.internal_code,
            bp.credit_type, bp.credit_days, bp.credit_limit,
            bp.city, bp.state, bp.is_active, bp.is_occasional, bp.created_at,
            COUNT(DISTINCT bpc.id) AS contact_count,
            COUNT(DISTINCT da.id)  AS address_count
     FROM business_partners bp
     LEFT JOIN business_partner_contacts bpc ON bpc.business_partner_id = bp.id
     LEFT JOIN delivery_addresses da ON da.business_partner_id = bp.id AND da.is_active = true
     WHERE bp.tenant_id = $1 ${where}
     GROUP BY bp.id
     ORDER BY bp.name ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM business_partners bp WHERE bp.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

async function getPartner({ tenantId, partnerId }) {
  const { rows } = await query(
    `SELECT bp.*,
            json_agg(DISTINCT jsonb_build_object(
              'id', bpc.id, 'name', bpc.name, 'position', bpc.position,
              'email', bpc.email, 'phone', bpc.phone, 'is_primary', bpc.is_primary
            )) FILTER (WHERE bpc.id IS NOT NULL) AS contacts
     FROM business_partners bp
     LEFT JOIN business_partner_contacts bpc ON bpc.business_partner_id = bp.id
     WHERE bp.id = $1 AND bp.tenant_id = $2
     GROUP BY bp.id`,
    [partnerId, tenantId]
  )
  if (rows.length === 0) return null
  return rows[0]
}

// ─── CRUD principal ──────────────────────────────────────────────────────────

async function createPartner({
  tenantId, type, personType, name, rfc, taxName, taxRegime, taxRegimeCode,
  creditType, creditDays, creditLimit, internalCode,
  address, neighborhood, city, state, zipCode, notes,
  // Preferencias fiscales / comerciales (migración 025 + 026)
  cfdiUse, paymentMethod, paymentForm, preferredCurrency,
  requiresPo,
  autoSendInvoice, autoSendRemission, billingNotes,
  // Campos de proveedor (migración 085)
  supplierCreditDays, supplierCreditLimit, supplierLeadTimeDays,
  supplierMinOrderAmount,
  supplierBankName, supplierAccountHolder, supplierAccountNumber,
  supplierClabe, supplierSwift,
  website, supplierRating,
  isOccasional = false,     // socio eventual: vive fuera del catálogo principal (mig 172)
  contacts = [],
  userId, ipAddress, userAgent,
  client: existingClient,   // permite reusar una txn (p.ej. crear proveedor desde un gasto)
}) {
  // Inferir person_type desde RFC si no viene explícito
  const resolvedPersonType = personType || (rfc ? (rfc.length === 13 ? 'fisica' : 'moral') : null)

  const exec = async (client) => {
    // Resolver código según nomenclatura configurada del tenant. El tipo
    // 'both' usa la nomenclatura de 'customer' (igual que el form).
    const codeEntity = type === 'supplier' ? 'supplier' : 'customer'
    const resolvedCode = await codeFormatService.applyCodeFormat({
      client, tenantId, entityType: codeEntity, providedCode: internalCode,
    })

    const { rows } = await client.query(
      `INSERT INTO business_partners
         (tenant_id, type, person_type, name, rfc, tax_name, tax_regime, tax_regime_code,
          credit_type, credit_days, credit_limit, internal_code,
          address, neighborhood, city, state, zip_code, notes,
          cfdi_use, payment_method, payment_form, preferred_currency,
          requires_po,
          auto_send_invoice, auto_send_remission, billing_notes,
          supplier_credit_days, supplier_credit_limit, supplier_lead_time_days,
          supplier_min_order_amount,
          supplier_bank_name, supplier_account_holder, supplier_account_number,
          supplier_clabe, supplier_swift,
          website, supplier_rating, is_occasional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,
               $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
       RETURNING *`,
      [tenantId, type, resolvedPersonType, name.trim(),
       rfc?.toUpperCase().trim() || null,
       taxName?.trim() || null, taxRegime?.trim() || null, taxRegimeCode?.trim() || null,
       creditType || 'cash', creditDays || 0, creditLimit || 0,
       resolvedCode?.trim() || null,
       address || null, neighborhood?.trim() || null, city?.trim() || null, state?.trim() || null,
       zipCode?.trim() || null, notes || null,
       cfdiUse || 'G01', paymentMethod || 'PUE', paymentForm || '99',
       preferredCurrency || 'MXN',
       requiresPo === true,
       autoSendInvoice === true, autoSendRemission === true,
       billingNotes?.trim() || null,
       supplierCreditDays    === '' || supplierCreditDays    == null ? null : supplierCreditDays,
       supplierCreditLimit   === '' || supplierCreditLimit   == null ? null : supplierCreditLimit,
       supplierLeadTimeDays  === '' || supplierLeadTimeDays  == null ? null : supplierLeadTimeDays,
       supplierMinOrderAmount === '' || supplierMinOrderAmount == null ? null : supplierMinOrderAmount,
       supplierBankName?.trim() || null,
       supplierAccountHolder?.trim() || null,
       supplierAccountNumber?.trim() || null,
       supplierClabe?.trim() || null,
       supplierSwift?.trim() || null,
       website?.trim() || null,
       supplierRating === '' || supplierRating == null ? null : supplierRating,
       isOccasional === true]
    )
    const partner = rows[0]

    for (const contact of contacts) {
      await client.query(
        `INSERT INTO business_partner_contacts
           (business_partner_id, name, position, email, phone, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [partner.id, contact.name, contact.position || null,
         contact.email || null, contact.phone || null, contact.isPrimary || false]
      )
    }

    await audit({
      tenantId, userId, action: 'business_partner.created',
      resource: 'business_partners', resourceId: partner.id,
      payload: { name: partner.name, type, rfc: partner.rfc },
      ipAddress, userAgent,
    })

    return partner
  }

  return existingClient ? exec(existingClient) : withTransaction(exec)
}

async function updatePartner({
  tenantId, partnerId, type, name, rfc, taxName, taxRegime, taxRegimeCode,
  creditType, creditDays, creditLimit, internalCode,
  address, neighborhood, city, state, zipCode, notes, isActive,
  // Preferencias fiscales / comerciales (migración 025 + 026)
  cfdiUse, paymentMethod, paymentForm, preferredCurrency,
  requiresPo,
  autoSendInvoice, autoSendRemission, billingNotes,
  // Proveedor (migración 085)
  supplierCreditDays, supplierCreditLimit, supplierLeadTimeDays,
  supplierMinOrderAmount,
  supplierBankName, supplierAccountHolder, supplierAccountNumber,
  supplierClabe, supplierSwift,
  website, supplierRating,
  contacts,
  userId, ipAddress, userAgent,
}) {
  const resolvedPersonType = rfc ? (rfc.length === 13 ? 'fisica' : 'moral') : null

  // Tipo (customer/supplier/both): el form de edición permite ampliar el rol
  // (p. ej. cliente → ambos) o acotarlo. Solo aceptamos los 3 valores válidos;
  // cualquier otra cosa queda en null → COALESCE no toca la columna. Sin esto
  // updatePartner ignoraba `type` y el socio se quedaba pegado en su tipo viejo.
  const normalizedType = ['customer', 'supplier', 'both'].includes(type) ? type : null

  // El frontend puede mandar string vacío en campos numéricos cuando el
  // partner es solo cliente y nunca tuvo datos de proveedor (Socios.jsx
  // hace `?? ''` al precargar el form). El operador `??` JS no normaliza
  // string vacío a null, así que PostgreSQL fallaba con "invalid input
  // syntax for type integer/numeric". Este helper colapsa '' / undefined / null
  // a null para que COALESCE en la query lo trate como "no tocar el campo".
  const numericOrNull = (v) => (v === '' || v == null ? null : v)

  return withTransaction(async (client) => {
  const { rows } = await client.query(
    `UPDATE business_partners SET
       name             = COALESCE($1,  name),
       rfc              = COALESCE($2,  rfc),
       person_type      = COALESCE($3,  person_type),
       tax_name         = COALESCE($4,  tax_name),
       tax_regime       = COALESCE($5,  tax_regime),
       tax_regime_code  = COALESCE($6,  tax_regime_code),
       credit_type      = COALESCE($7,  credit_type),
       credit_days      = COALESCE($8,  credit_days),
       credit_limit     = COALESCE($9,  credit_limit),
       internal_code    = COALESCE($10, internal_code),
       address          = COALESCE($11, address),
       neighborhood     = COALESCE($12, neighborhood),
       city             = COALESCE($13, city),
       state            = COALESCE($14, state),
       zip_code         = COALESCE($15, zip_code),
       notes            = COALESCE($16, notes),
       is_active        = COALESCE($17, is_active),
       cfdi_use         = COALESCE($18, cfdi_use),
       payment_method   = COALESCE($19, payment_method),
       payment_form     = COALESCE($20, payment_form),
       preferred_currency = COALESCE($21, preferred_currency),
       requires_po      = COALESCE($22, requires_po),
       auto_send_invoice = COALESCE($23, auto_send_invoice),
       auto_send_remission = COALESCE($24, auto_send_remission),
       billing_notes    = COALESCE($25, billing_notes),
       supplier_credit_days       = COALESCE($26, supplier_credit_days),
       supplier_credit_limit      = COALESCE($27, supplier_credit_limit),
       supplier_lead_time_days    = COALESCE($28, supplier_lead_time_days),
       supplier_min_order_amount  = COALESCE($29, supplier_min_order_amount),
       supplier_bank_name         = COALESCE($30, supplier_bank_name),
       supplier_account_holder    = COALESCE($31, supplier_account_holder),
       supplier_account_number    = COALESCE($32, supplier_account_number),
       supplier_clabe             = COALESCE($33, supplier_clabe),
       supplier_swift             = COALESCE($34, supplier_swift),
       website                    = COALESCE($35, website),
       supplier_rating            = COALESCE($36, supplier_rating),
       type                       = COALESCE($37, type)
     WHERE id = $38 AND tenant_id = $39
     RETURNING id, type, name, rfc, person_type, is_active`,
    [name || null, rfc?.toUpperCase().trim() || null, resolvedPersonType,
     taxName || null, taxRegime || null, taxRegimeCode || null,
     creditType || null,
     numericOrNull(creditDays), numericOrNull(creditLimit), internalCode || null,
     address || null, neighborhood || null, city || null, state || null, zipCode || null,
     notes || null, isActive !== undefined ? isActive : null,
     cfdiUse || null, paymentMethod || null, paymentForm || null,
     preferredCurrency || null,
     requiresPo !== undefined ? requiresPo : null,
     autoSendInvoice !== undefined ? autoSendInvoice : null,
     autoSendRemission !== undefined ? autoSendRemission : null,
     billingNotes !== undefined ? (billingNotes || null) : null,
     numericOrNull(supplierCreditDays),
     numericOrNull(supplierCreditLimit),
     numericOrNull(supplierLeadTimeDays),
     numericOrNull(supplierMinOrderAmount),
     supplierBankName || null,
     supplierAccountHolder || null,
     supplierAccountNumber || null,
     supplierClabe || null,
     supplierSwift || null,
     website || null,
     numericOrNull(supplierRating),
     normalizedType,
     partnerId, tenantId]
  )
  if (rows.length === 0) return null

  // Sync de contactos: el form de EDICIÓN manda el arreglo COMPLETO (sin ids) como
  // fuente de verdad. Antes updatePartner no recibía `contacts` → editar contactos
  // de un cliente no guardaba nada (solo createPartner los insertaba). Reemplazo
  // total (delete+insert). Solo si `contacts` viene definido: otros flujos (p. ej.
  // togglear is_active) NO lo mandan y no deben borrar los contactos existentes.
  // billing_contact_id (FK ON DELETE SET NULL) no se usa en ningún flujo, así que el
  // borrado no rompe nada.
  if (Array.isArray(contacts)) {
    await client.query(
      `DELETE FROM business_partner_contacts WHERE business_partner_id = $1`,
      [partnerId]
    )
    let primaryUsed = false
    for (const c of contacts) {
      if (!c || !c.name) continue   // nombre es obligatorio (schema del form)
      // Booleano explícito: c.isPrimary suele venir undefined → `undefined && x`
      // es undefined → NULL → viola el NOT NULL de is_primary.
      const isPrimary = c.isPrimary === true && !primaryUsed
      if (isPrimary) primaryUsed = true
      await client.query(
        `INSERT INTO business_partner_contacts
           (business_partner_id, name, position, email, phone, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [partnerId, c.name, c.position || null, c.email || null, c.phone || null, isPrimary]
      )
    }
  }

  await audit({
    tenantId, userId, action: 'business_partner.updated',
    resource: 'business_partners', resourceId: partnerId,
    payload: { name, isActive }, ipAddress, userAgent,
  })

  return rows[0]
  })
}

// ─── Contactos ───────────────────────────────────────────────────────────────

async function addContact({ partnerId, tenantId, name, position, email, phone, isPrimary }) {
  const { rows: partner } = await query(
    `SELECT id FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  if (partner.length === 0) return null

  if (isPrimary) {
    await query(
      `UPDATE business_partner_contacts SET is_primary = false WHERE business_partner_id = $1`,
      [partnerId]
    )
  }

  const { rows } = await query(
    `INSERT INTO business_partner_contacts
       (business_partner_id, name, position, email, phone, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [partnerId, name, position || null, email || null, phone || null, isPrimary || false]
  )
  return rows[0]
}

async function deleteContact({ partnerId, tenantId, contactId }) {
  const { rows } = await query(
    `DELETE FROM business_partner_contacts bpc
     USING business_partners bp
     WHERE bpc.id = $1 AND bpc.business_partner_id = bp.id
       AND bp.id = $2 AND bp.tenant_id = $3
     RETURNING bpc.id`,
    [contactId, partnerId, tenantId]
  )
  return rows.length > 0
}

// ─── Domicilios de entrega ───────────────────────────────────────────────────

async function listDeliveryAddresses({ partnerId, tenantId }) {
  const { rows } = await query(
    `SELECT da.* FROM delivery_addresses da
     JOIN business_partners bp ON bp.id = da.business_partner_id
     WHERE da.business_partner_id = $1 AND bp.tenant_id = $2
     ORDER BY da.is_default DESC, da.alias ASC`,
    [partnerId, tenantId]
  )
  return rows
}

async function addDeliveryAddress({
  partnerId, tenantId, alias, contactName, phone,
  address, neighborhood, city, state, zipCode,
  freightIncluded, isDefault, notes,
}) {
  const { rows: partner } = await query(
    `SELECT id FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  if (partner.length === 0) return null

  if (isDefault) {
    await query(
      `UPDATE delivery_addresses SET is_default = false WHERE business_partner_id = $1`,
      [partnerId]
    )
  }

  const { rows } = await query(
    `INSERT INTO delivery_addresses
       (business_partner_id, tenant_id, alias, contact_name, phone,
        address, neighborhood, city, state, zip_code,
        freight_included, is_default, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [partnerId, tenantId, alias, contactName || null, phone || null,
     address, neighborhood || null, city, state, zipCode || null,
     freightIncluded || false, isDefault || false, notes || null]
  )
  return rows[0]
}

async function updateDeliveryAddress({ addressId, partnerId, tenantId, ...fields }) {
  const { rows } = await query(
    `UPDATE delivery_addresses SET
       alias           = COALESCE($1, alias),
       contact_name    = COALESCE($2, contact_name),
       phone           = COALESCE($3, phone),
       address         = COALESCE($4, address),
       neighborhood    = COALESCE($5, neighborhood),
       city            = COALESCE($6, city),
       state           = COALESCE($7, state),
       zip_code        = COALESCE($8, zip_code),
       freight_included= COALESCE($9, freight_included),
       is_default      = COALESCE($10, is_default),
       notes           = COALESCE($11, notes),
       is_active       = COALESCE($12, is_active)
     WHERE id = $13 AND business_partner_id = $14
     RETURNING *`,
    [fields.alias || null, fields.contactName || null, fields.phone || null,
     fields.address || null, fields.neighborhood || null,
     fields.city || null, fields.state || null, fields.zipCode || null,
     fields.freightIncluded ?? null, fields.isDefault ?? null,
     fields.notes || null, fields.isActive ?? null,
     addressId, partnerId]
  )
  return rows[0] || null
}

// ─── Precios por cliente ─────────────────────────────────────────────────────

async function listCustomerPrices({ partnerId, tenantId, onlyActive = true }) {
  const { rows: partner } = await query(
    `SELECT id FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  if (partner.length === 0) return null

  const activeClause = onlyActive
    ? `AND cp.valid_from <= CURRENT_DATE AND (cp.valid_until IS NULL OR cp.valid_until >= CURRENT_DATE)`
    : ''

  // DISTINCT ON (product_id) deja UNA fila por producto: la versión vigente
  // (mayor valid_from). Sin esto, editar un precio creado otro día dejaba dos
  // filas activas para el mismo producto y aparecía duplicado en la tabla.
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (cp.product_id)
              cp.id, cp.tenant_id, cp.business_partner_id, cp.product_id,
              cp.currency, cp.unit_price, cp.valid_from, cp.valid_until,
              cp.notes, cp.created_at,
              p.sku, p.name AS product_name, p.type AS product_type,
              p.base_price, p.base_currency
       FROM customer_prices cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.tenant_id = $1 AND cp.business_partner_id = $2 ${activeClause}
       ORDER BY cp.product_id, cp.valid_from DESC, cp.created_at DESC
     ) t
     ORDER BY t.sku`,
    [tenantId, partnerId]
  )
  return rows
}

async function setCustomerPrice({
  tenantId, partnerId, productId, currency, unitPrice,
  validFrom, validUntil, notes, userId, ipAddress, userAgent,
}) {
  const { rows: partner } = await query(
    `SELECT id, type FROM business_partners WHERE id = $1 AND tenant_id = $2`,
    [partnerId, tenantId]
  )
  if (partner.length === 0) throw createError(404, 'Cliente no encontrado.')

  const effectiveValidFrom = validFrom || new Date().toISOString().split('T')[0]

  // Leer precio anterior (si existe) para registrarlo en la auditoría
  const { rows: prevRows } = await query(
    `SELECT unit_price, currency, valid_until, notes
       FROM customer_prices
      WHERE tenant_id = $1 AND business_partner_id = $2
        AND product_id = $3 AND valid_from = $4`,
    [tenantId, partnerId, productId, effectiveValidFrom]
  )
  const before = prevRows[0] || null

  const { rows } = await query(
    `INSERT INTO customer_prices
       (tenant_id, business_partner_id, product_id, currency, unit_price,
        valid_from, valid_until, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, business_partner_id, product_id, valid_from)
     DO UPDATE SET
       currency   = EXCLUDED.currency,
       unit_price = EXCLUDED.unit_price,
       valid_until= EXCLUDED.valid_until,
       notes      = EXCLUDED.notes
     RETURNING *`,
    [tenantId, partnerId, productId, currency || 'MXN', unitPrice,
     effectiveValidFrom,
     validUntil || null, notes || null, userId]
  )
  const after = rows[0]

  await audit({
    tenantId, userId,
    action:     before ? 'customer_price.updated' : 'customer_price.created',
    resource:   'customer_prices',
    resourceId: after.id,
    payload: {
      partnerId, productId,
      before: before ? {
        unitPrice: Number(before.unit_price),
        currency:  before.currency,
        notes:     before.notes,
      } : null,
      after: {
        unitPrice: Number(after.unit_price),
        currency:  after.currency,
        notes:     after.notes,
      },
    },
    ipAddress, userAgent,
  })

  return after
}

/**
 * Actualiza UNA fila de precio por su id (no upsert por valid_from). Esto evita
 * el bug donde editar un precio creado otro día creaba una versión nueva en vez
 * de modificar la existente. Sólo toca los campos provistos (undefined = sin
 * cambio). Registra auditoría customer_price.updated con antes/después.
 */
async function updateCustomerPrice({
  priceId, tenantId, currency, unitPrice,
  validFrom, validUntil, notes, userId, ipAddress, userAgent,
}) {
  const { rows: prevRows } = await query(
    `SELECT * FROM customer_prices WHERE id = $1 AND tenant_id = $2`,
    [priceId, tenantId]
  )
  if (prevRows.length === 0) return null
  const before = prevRows[0]

  // Merge: undefined = conservar; '' en fechas/notas = limpiar a NULL.
  const nextUnitPrice  = unitPrice  !== undefined ? unitPrice  : before.unit_price
  const nextCurrency   = currency   !== undefined ? currency   : before.currency
  const nextValidFrom  = validFrom  !== undefined ? (validFrom || before.valid_from) : before.valid_from
  const nextValidUntil = validUntil !== undefined ? (validUntil || null) : before.valid_until
  const nextNotes      = notes      !== undefined ? (notes || null) : before.notes

  if (nextUnitPrice == null || Number(nextUnitPrice) <= 0) {
    throw createError(400, 'El precio debe ser mayor a 0.')
  }

  let after
  try {
    const { rows } = await query(
      `UPDATE customer_prices
          SET unit_price = $1, currency = $2, valid_from = $3,
              valid_until = $4, notes = $5
        WHERE id = $6 AND tenant_id = $7
        RETURNING *`,
      [nextUnitPrice, nextCurrency, nextValidFrom, nextValidUntil, nextNotes, priceId, tenantId]
    )
    after = rows[0]
  } catch (err) {
    if (err.code === '23505') {
      throw createError(409, 'Ya existe un precio para ese producto con esa fecha de inicio de vigencia.')
    }
    throw err
  }

  await audit({
    tenantId, userId,
    action:     'customer_price.updated',
    resource:   'customer_prices',
    resourceId: after.id,
    payload: {
      partnerId: after.business_partner_id,
      productId: after.product_id,
      before: {
        unitPrice:  Number(before.unit_price),
        currency:   before.currency,
        validFrom:  before.valid_from,
        validUntil: before.valid_until,
        notes:      before.notes,
      },
      after: {
        unitPrice:  Number(after.unit_price),
        currency:   after.currency,
        validFrom:  after.valid_from,
        validUntil: after.valid_until,
        notes:      after.notes,
      },
    },
    ipAddress, userAgent,
  })

  return after
}

async function deleteCustomerPrice({ priceId, tenantId, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `DELETE FROM customer_prices WHERE id = $1 AND tenant_id = $2
     RETURNING business_partner_id, product_id, unit_price, currency, valid_from`,
    [priceId, tenantId]
  )
  if (rows.length === 0) return false

  const deleted = rows[0]
  await audit({
    tenantId, userId,
    action:     'customer_price.deleted',
    resource:   'customer_prices',
    resourceId: priceId,
    payload: {
      partnerId:  deleted.business_partner_id,
      productId:  deleted.product_id,
      unitPrice:  Number(deleted.unit_price),
      currency:   deleted.currency,
      validFrom:  deleted.valid_from,
    },
    ipAddress, userAgent,
  })

  return true
}

function mapPriceChangeRow(r) {
  return {
    id:           r.id,
    action:       r.action,
    createdAt:    r.created_at,
    userName:     r.user_name,
    partnerId:    r.partner_id,
    partnerName:  r.partner_name,
    productId:    r.product_id,
    productSku:   r.product_sku,
    productName:  r.product_name,
    before:       r.payload?.before || null,
    after:        r.payload?.after  || null,
    unitPrice:    r.payload?.unitPrice != null ? Number(r.payload.unitPrice) : null,
    currency:     r.payload?.currency || null,
  }
}

/**
 * Historial de cambios de precios desde audit_logs, con filtros opcionales y
 * paginación. Sirve para el panel "por cliente" (partnerId) y la vista completa
 * (filtros + páginas). Devuelve { rows, total }.
 */
async function listPriceChanges({
  tenantId, partnerId = null, productId = null, action = null,
  from = null, to = null, limit = 10, offset = 0,
}) {
  const params = [tenantId]
  const where  = [`al.tenant_id = $1`, `al.resource = 'customer_prices'`]

  if (partnerId) { params.push(partnerId); where.push(`(al.payload->>'partnerId')::uuid = $${params.length}`) }
  if (productId) { params.push(productId); where.push(`(al.payload->>'productId')::uuid = $${params.length}`) }
  if (action)    { params.push(action);    where.push(`al.action = $${params.length}`) }
  if (from)      { params.push(from);       where.push(`al.created_at >= $${params.length}::date`) }
  if (to)        { params.push(to);         where.push(`al.created_at < ($${params.length}::date + 1)`) }
  const whereSql = where.join(' AND ')

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS total FROM audit_logs al WHERE ${whereSql}`,
    params
  )
  const total = countRows[0]?.total || 0

  params.push(limit);  const limIdx = params.length
  params.push(offset); const offIdx = params.length
  const { rows } = await query(
    `SELECT al.id, al.action, al.created_at, al.payload,
            u.full_name        AS user_name,
            bp.id              AS partner_id,
            bp.name            AS partner_name,
            p.id               AS product_id,
            p.sku              AS product_sku,
            p.name             AS product_name
       FROM audit_logs al
       LEFT JOIN users             u  ON u.id  = al.user_id
       LEFT JOIN business_partners bp ON bp.id = (al.payload->>'partnerId')::uuid
       LEFT JOIN products          p  ON p.id  = (al.payload->>'productId')::uuid
      WHERE ${whereSql}
      ORDER BY al.created_at DESC
      LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  )
  return { rows: rows.map(mapPriceChangeRow), total }
}

async function getCustomerPricesSummary({ tenantId }) {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(DISTINCT business_partner_id)
          FROM customer_prices
         WHERE tenant_id = $1
           AND valid_from <= CURRENT_DATE
           AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)) AS partners_with_prices,
       (SELECT COUNT(*)
          FROM customer_prices
         WHERE tenant_id = $1
           AND valid_from <= CURRENT_DATE
           AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)) AS total_prices,
       (SELECT COUNT(*) FROM products
         WHERE tenant_id = $1 AND base_price IS NOT NULL AND base_price > 0 AND is_active = true) AS products_with_base,
       (SELECT COUNT(*) FROM products
         WHERE tenant_id = $1 AND (base_price IS NULL OR base_price = 0) AND is_active = true) AS products_without_base,
       (SELECT COUNT(*) FROM business_partners
         WHERE tenant_id = $1 AND type IN ('customer','both') AND is_active = true) AS total_customers`,
    [tenantId]
  )
  const r = rows[0] || {}
  return {
    partnersWithPrices:   parseInt(r.partners_with_prices   || 0, 10),
    totalPrices:          parseInt(r.total_prices           || 0, 10),
    productsWithBase:     parseInt(r.products_with_base     || 0, 10),
    productsWithoutBase:  parseInt(r.products_without_base  || 0, 10),
    totalCustomers:       parseInt(r.total_customers        || 0, 10),
  }
}

// ─── Proveedores de materia prima ────────────────────────────────────────────

async function listSupplierMaterials({ partnerId, tenantId }) {
  const { rows } = await query(
    `SELECT sm.*, rm.name AS material_name, rm.resin_type
     FROM supplier_materials sm
     JOIN raw_materials rm ON rm.id = sm.raw_material_id
     WHERE sm.tenant_id = $1 AND sm.business_partner_id = $2
     ORDER BY rm.name`,
    [tenantId, partnerId]
  )
  return rows
}

async function setSupplierMaterial({
  tenantId, partnerId, rawMaterialId, isPrimary,
  lastPricePerKg, currency, leadTimeDays, notes,
}) {
  if (isPrimary) {
    await query(
      `UPDATE supplier_materials SET is_primary = false
       WHERE tenant_id = $1 AND raw_material_id = $2`,
      [tenantId, rawMaterialId]
    )
  }

  const { rows } = await query(
    `INSERT INTO supplier_materials
       (tenant_id, business_partner_id, raw_material_id, is_primary,
        last_price_per_kg, currency, lead_time_days, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, business_partner_id, raw_material_id)
     DO UPDATE SET
       is_primary       = EXCLUDED.is_primary,
       last_price_per_kg= EXCLUDED.last_price_per_kg,
       currency         = EXCLUDED.currency,
       lead_time_days   = EXCLUDED.lead_time_days,
       notes            = EXCLUDED.notes
     RETURNING *`,
    [tenantId, partnerId, rawMaterialId, isPrimary || false,
     lastPricePerKg || null, currency || 'MXN', leadTimeDays || null, notes || null]
  )
  return rows[0]
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  listPartners, getPartner, createPartner, updatePartner,
  addContact, deleteContact,
  listDeliveryAddresses, addDeliveryAddress, updateDeliveryAddress,
  listCustomerPrices, setCustomerPrice, updateCustomerPrice, deleteCustomerPrice,
  getCustomerPricesSummary, listPriceChanges,
  listSupplierMaterials, setSupplierMaterial,
}
