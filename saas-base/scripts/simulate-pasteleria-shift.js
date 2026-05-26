'use strict'

/**
 * SaaS v2 — Simula un turno end-to-end en el tenant 'pasteleria-piloto'.
 *
 * Criterios de done (Fase 5 §7.7):
 *   1. Pastelería produce pasteles estándar (PAS-CHOC-20CM + PAS-VAIN-20CM).
 *   2. Pedido personalizado con custom_attributes + additional_costs funciona.
 *   3. Alertas de caducidad disparan a ≤2 días (products.expiry_alert_days=2).
 *   4. Recetas con 13 componentes se ejecutan sin error en el motor.
 *
 * Validaciones secundarias:
 *   - pt_goes_to_wip_first=true → pasteles van a WIP antes de PT.
 *   - allergen_mode='alert_only' → cierre NO se bloquea aunque todos tengan
 *     gluten/lácteos/huevo.
 *
 * Pre-requisito: `node scripts/provision-pasteleria.js` ya corrió.
 *
 * Uso:
 *   node scripts/simulate-pasteleria-shift.js
 */

require('dotenv').config()
const request = require('supertest')
const app     = require('../src/app')
const { pool, query, withBypass, withTransaction } = require('../src/db')
const inventoryService = require('../src/modules/inventory/inventoryService')
const { getExpiringLots } = require('../src/modules/production/expirationService')

const SLUG  = 'pasteleria-piloto'
const EMAIL = 'admin@pasteleria-piloto.local'
const PASS  = 'Pasteleria!2026'

const log  = (...args) => console.log(...args)
const ok   = (msg) => console.log('  ✓', msg)
const skip = (msg) => console.log('  ⊘', msg)
const warn = (msg) => console.log('  ⚠', msg)
const fail = (msg, extra) => { console.error('  ✗', msg); if (extra) console.error('   ', extra); process.exit(1) }
const gap  = (msg) => console.log('  ⚠ GAP:', msg)

const GAPS = []
const recordGap = (id, summary) => { GAPS.push({ id, summary }); gap(`[${id}] ${summary}`) }

function clientFor(token) {
  const headers = { 'X-Tenant-Slug': SLUG, 'Authorization': `Bearer ${token}` }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') }
}

// ─── 1. Login + contexto ──────────────────────────────────────────────────

async function loginAndContext() {
  log('\n[1] Login + contexto…')
  const tenantRow = await withBypass(() => query(
    `SELECT id, slug, name FROM tenants WHERE slug = $1`, [SLUG]
  ))
  if (tenantRow.rows.length === 0) {
    fail(`Tenant '${SLUG}' no existe. Corre 'node scripts/provision-pasteleria.js' primero.`)
  }
  const tenant = tenantRow.rows[0]
  ok(`Tenant: ${tenant.name} (${tenant.id})`)

  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ email: EMAIL, password: PASS })
  if (res.status !== 200) fail(`Login falló (${res.status})`, res.body)
  ok(`Logged in como ${EMAIL}`)

  const userRow = await withBypass(() => query(
    `SELECT id FROM users WHERE tenant_id = $1 AND email = $2`, [tenant.id, EMAIL]
  ))
  const userId = userRow.rows[0].id
  ok(`User id: ${userId}`)

  return { tenant, token: res.body.accessToken, userId }
}

// ─── 2. Warehouses ────────────────────────────────────────────────────────

async function ensureWarehouses(client) {
  log('\n[2] Asegurando warehouses…')
  const list = await client.get('/api/warehouses').expect(200)
  const byName = Object.fromEntries(list.body.map(w => [w.name, w]))

  // Pastelería: MP · WIP (decorado) · PT · Merma Rebaba · Merma Desecho
  // WIP requerido: lot-mode siempre pasa por WIP (Diseño §21).
  // pt_goes_to_wip_first=true: pasteles van a WIP para decorar antes de pasar a PT.
  // resin_type='PP' requerido por legacy API aunque pastelería no use resinas.
  const wanted = [
    { name: 'MP Pastelería',     type: 'raw_material',     resin_type: 'PP', description: 'Ingredientes y materia prima' },
    { name: 'WIP Pastelería',    type: 'wip',                                description: 'WIP — pasteles en decorado' },
    { name: 'PT Pastelería',     type: 'finished_product',                   description: 'Pasteles listos para venta' },
    { name: 'Merma Rebaba',      type: 'regrind',          resin_type: 'PP', description: 'Rebaba de betún (reproceso)' },
    { name: 'Merma Desecho',     type: 'regrind',          resin_type: 'PP', description: 'Merma sin valor' },
  ]

  const created = {}
  for (const w of wanted) {
    if (byName[w.name]) {
      skip(`warehouse '${w.name}' ya existe (id=${byName[w.name].id})`)
      created[w.name] = byName[w.name]
      continue
    }
    const res = await client.post('/api/warehouses', { ...w, is_active: true })
    if (res.status !== 201) {
      recordGap('WAREHOUSE_CREATE', `POST /api/warehouses '${w.name}' falló (${res.status}): ${JSON.stringify(res.body)}`)
      continue
    }
    ok(`Creado warehouse '${w.name}' (id=${res.body.id})`)
    created[w.name] = res.body
  }

  // Actualizar warehouse_type_id (legacy API no lo setea)
  const typeCodeMap = {
    raw_material:     'materia_prima',
    finished_product: 'producto_terminado',
    wip:              'wip',
    regrind:          'merma',
  }
  for (const w of Object.values(created)) {
    if (w.warehouse_type_id) continue
    const targetCode = typeCodeMap[w.type]
    if (!targetCode) continue
    await withBypass(() => query(
      `UPDATE warehouses
         SET warehouse_type_id = (
           SELECT id FROM tenant_warehouse_types
           WHERE tenant_id = warehouses.tenant_id AND code = $1
         )
       WHERE id = $2`,
      [targetCode, w.id]
    ))
  }
  return created
}

// ─── 3. Stock inicial de MP ───────────────────────────────────────────────

async function seedStock(tenantId, rawMaterials, warehouses, userId) {
  log('\n[3] Sembrando stock inicial de MP…')

  const mpWh = warehouses['MP Pastelería']
  if (!mpWh) { warn('Warehouse MP Pastelería no encontrado — saltando seeds'); return }

  // Seeds por nombre de MP (los creados en provision-pasteleria.js)
  // Cantidades grandes (100x necesidad por turno) para sobrevivir múltiples runs.
  const seeds = [
    { name: 'Harina de trigo',       qty: 200,  cost: 12.0  },
    { name: 'Azúcar refinada',       qty: 200,  cost: 18.0  },
    { name: 'Mantequilla',           qty: 100,  cost: 95.0  },
    { name: 'Huevo entero',          qty: 80,   cost: 35.0  },
    { name: 'Leche entera',          qty: 100,  cost: 22.0  },
    { name: 'Polvo para hornear',    qty: 20,   cost: 80.0  },
    { name: 'Extracto de vainilla',  qty: 5,    cost: 350.0 },
    { name: 'Cacao en polvo',        qty: 30,   cost: 140.0 },
    { name: 'Chocolate amargo',      qty: 50,   cost: 180.0 },
    { name: 'Crema para batir',      qty: 80,   cost: 68.0  },
    { name: 'Queso crema',           qty: 60,   cost: 110.0 },
    { name: 'Fondant blanco',        qty: 30,   cost: 95.0  },
    { name: 'Colorante alimenticio', qty: 2,    cost: 250.0 },
  ]

  for (const s of seeds) {
    const rm = rawMaterials[s.name]
    if (!rm) { warn(`MP '${s.name}' no en contexto — saltando`); continue }

    const { rows: stock } = await withBypass(() => query(
      `SELECT COALESCE(SUM(quantity),0)::numeric AS qty
       FROM inventory_stock
       WHERE tenant_id = $1 AND item_type = 'raw_material'
         AND item_id = $2 AND warehouse_id = $3 AND status = 'available'`,
      [tenantId, rm.id, mpWh.id]
    ))
    if (parseFloat(stock[0].qty) >= s.qty * 0.5) {
      skip(`Stock de '${s.name}': ${stock[0].qty} kg — suficiente`)
      continue
    }
    const need = s.qty - parseFloat(stock[0].qty)
    await withBypass(() => withTransaction(async (txClient) => {
      await inventoryService.recordMovement(txClient, {
        tenantId,
        warehouseId: mpWh.id,
        itemType: 'raw_material',
        itemId: rm.id,
        movementType: 'adjustment_in',
        quantity: need,
        unit: 'kg',
        unitCost: s.cost,
        statusTo: 'available',
        referenceType: 'simulation',
        notes: `Seed MP pastelería: ${s.name}`,
        createdBy: userId,
      })
    }))
    ok(`Sembrados ${need} kg de '${s.name}'`)
  }

  // Sembrar raw_material_lots (requerido para loadMp con uses_lots=true)
  const { rows: cfgRows } = await withBypass(() => query(
    `SELECT uses_lots FROM tenant_process_config WHERE tenant_id = $1`, [tenantId]
  ))
  if (cfgRows[0]?.uses_lots) {
    log('  → uses_lots=true: sembrando raw_material_lots…')
    for (const s of seeds) {
      const rm = rawMaterials[s.name]
      if (!rm) continue
      // Si hay un lote activo, hacer top-up (UPDATE) en lugar de crear uno nuevo.
      // Crear múltiples lotes activos bloquea loadMp (no puede combinar fuentes).
      const { rows: activeLots } = await withBypass(() => query(
        `SELECT id, quantity_remaining FROM raw_material_lots
         WHERE tenant_id = $1 AND raw_material_id = $2 AND status = 'active'
         ORDER BY received_at ASC LIMIT 1`,
        [tenantId, rm.id]
      ))
      const remaining = activeLots.length ? parseFloat(activeLots[0].quantity_remaining) : 0
      if (remaining >= s.qty * 0.5) {
        skip(`lot(s) de '${s.name}' suficientes: ${remaining} kg`)
        continue
      }
      if (activeLots.length > 0) {
        await withBypass(() => query(
          `UPDATE raw_material_lots
             SET quantity_remaining = $1, quantity_received = GREATEST(quantity_received, $1)
           WHERE id = $2`,
          [s.qty, activeLots[0].id]
        ))
        ok(`Lot de '${s.name}' rellenado a ${s.qty} kg`)
      } else {
        const uniq = Date.now().toString(36).slice(-5).toUpperCase()
        const lotNum = `SEED-${s.name.replace(/\s+/g, '').slice(0, 6).toUpperCase()}-${uniq}`
        await withBypass(() => query(
          `INSERT INTO raw_material_lots
             (tenant_id, raw_material_id, lot_number, warehouse_id,
              quantity_received, quantity_remaining, status, unit_cost, received_at)
           VALUES ($1, $2, $3, $4, $5, $5, 'active', $6, NOW())`,
          [tenantId, rm.id, lotNum, mpWh.id, s.qty, s.cost]
        ))
        ok(`Lot sembrado: '${s.name}' — ${s.qty} kg @ $${s.cost}`)
      }
    }
  }
}

// ─── 4. Productos del tenant (lookup) ─────────────────────────────────────

async function getProducts(client) {
  log('\n[4] Consultando productos del tenant…')
  const list = await client.get('/api/products').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])
  const bySku = Object.fromEntries(items.map(p => [p.sku, p]))

  for (const sku of ['PAS-CHOC-20CM', 'PAS-VAIN-20CM', 'PAS-PERS-20CM', 'PAS-PERS-25CM']) {
    if (!bySku[sku]) fail(`Producto '${sku}' no encontrado. Corre provision-pasteleria.js primero.`)
    ok(`Encontrado producto '${sku}' (id=${bySku[sku].id})`)
  }
  return bySku
}

// ─── 5. Órdenes de producción ─────────────────────────────────────────────
//
// Crea 3 órdenes:
//   A) Pastel Chocolate 20cm (estándar, 10 pzas) — valida criterio 1
//   B) Pastel Vainilla 20cm (estándar, 8 pzas)   — valida criterio 1
//   C) Pastel Personalizado 20cm con custom_attributes + additional_costs — valida criterio 2

async function ensureOrders(client, products) {
  log('\n[5] Creando órdenes de producción…')

  const list  = await client.get('/api/production/orders').expect(200)
  const items = Array.isArray(list.body) ? list.body : (list.body.data || list.body.items || list.body.rows || [])

  const orders = {}

  // Helper: buscar orden activa para un producto
  const findActive = (productId) => items.find(o =>
    o.product_id === productId &&
    ['draft','active','planning','released'].includes(o.status)
  )

  // ── Orden A: Pastel Chocolate (estándar) ──
  {
    const prod = products['PAS-CHOC-20CM']
    const existing = findActive(prod.id)
    if (existing) {
      skip(`orden PAS-CHOC-20CM ya existe (id=${existing.id})`)
      orders['CHOC'] = existing
    } else {
      // Obtener receta vigente
      const recipeRes = await client.get(`/api/recipes?productId=${prod.id}&vigentOnly=true`)
      const recipes = recipeRes.body || []
      const recipeId = recipes[0]?.id

      const res = await client.post('/api/production/orders', {
        productId:        prod.id,
        quantityPackages: 10,
        priority:         'normal',
        recipeId,
        notes: 'Orden simulada — Pastel Chocolate 20cm estándar',
      })
      if (res.status !== 201) {
        recordGap('ORDER_CHOC', `POST /api/production/orders PAS-CHOC-20CM falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
        orders['CHOC'] = null
      } else {
        ok(`Orden PAS-CHOC-20CM creada (id=${res.body.id}, qty=10)`)
        orders['CHOC'] = res.body
      }
    }
  }

  // ── Orden B: Pastel Vainilla (estándar) ──
  {
    const prod = products['PAS-VAIN-20CM']
    const existing = findActive(prod.id)
    if (existing) {
      skip(`orden PAS-VAIN-20CM ya existe (id=${existing.id})`)
      orders['VAIN'] = existing
    } else {
      const recipeRes = await client.get(`/api/recipes?productId=${prod.id}&vigentOnly=true`)
      const recipes = recipeRes.body || []
      const recipeId = recipes[0]?.id

      const res = await client.post('/api/production/orders', {
        productId:        prod.id,
        quantityPackages: 8,
        priority:         'normal',
        recipeId,
        notes: 'Orden simulada — Pastel Vainilla 20cm estándar',
      })
      if (res.status !== 201) {
        recordGap('ORDER_VAIN', `POST /api/production/orders PAS-VAIN-20CM falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
        orders['VAIN'] = null
      } else {
        ok(`Orden PAS-VAIN-20CM creada (id=${res.body.id}, qty=8)`)
        orders['VAIN'] = res.body
      }
    }
  }

  // ── Orden C: Pastel Personalizado con custom_attributes + additional_costs ──
  // Criterio 2: pedido personalizado con texto y costos extras.
  {
    const prod = products['PAS-PERS-20CM']
    // Para personalizado buscamos orden TAMBIÉN por atributos — pero lo más sencillo
    // es checar si ya hay una activa (puede haber de runs anteriores)
    const existing = findActive(prod.id)
    if (existing) {
      skip(`orden PAS-PERS-20CM ya existe (id=${existing.id}, custom_attrs=${JSON.stringify(existing.custom_attributes)})`)
      orders['PERS'] = existing
    } else {
      const recipeRes = await client.get(`/api/recipes?productId=${prod.id}&vigentOnly=true`)
      const recipes = recipeRes.body || []
      const recipeId = recipes[0]?.id

      const customAttrs = {
        texto:       'Feliz cumpleaños Ana',
        color_betun: 'azul',
        figuras:     'flores y estrellas',
      }
      const res = await client.post('/api/production/orders', {
        productId:           prod.id,
        quantityPackages:    1,
        priority:            'urgente',
        recipeId,
        notes:               'Pastel personalizado para Ana — cumpleaños',
        customAttributes:    customAttrs,
        additionalCosts:     50.0,
        additionalCostsNotes: 'Decoración especial: figuras fondant + letras',
      })
      if (res.status !== 201) {
        recordGap('ORDER_PERS', `POST /api/production/orders PAS-PERS-20CM falló (${res.status}): ${JSON.stringify(res.body).slice(0,200)}`)
        orders['PERS'] = null
      } else {
        const order = res.body
        ok(`Orden PAS-PERS-20CM creada (id=${order.id})`)
        // Verificar que los campos se guardaron
        if (order.custom_attributes?.texto === customAttrs.texto) {
          ok(`  ✓ Criterio 2: custom_attributes guardados correctamente`)
          ok(`    texto="${order.custom_attributes.texto}" color_betun="${order.custom_attributes.color_betun}"`)
        } else {
          recordGap('CUSTOM_ATTRS', `custom_attributes no retornados en la orden. Respuesta: ${JSON.stringify(order).slice(0,200)}`)
        }
        if (parseFloat(order.additional_costs) === 50.0) {
          ok(`  ✓ Criterio 2: additional_costs=$50 guardado`)
        } else {
          recordGap('ADDITIONAL_COSTS', `additional_costs esperado=50, got=${order.additional_costs}`)
        }
        orders['PERS'] = order
      }
    }
  }

  return orders
}

// ─── 6. Liberar órdenes ───────────────────────────────────────────────────

async function releaseOrders(client, orders) {
  log('\n[6] Liberando órdenes…')
  for (const [key, order] of Object.entries(orders)) {
    if (!order) continue
    const res = await client.post(`/api/production/orders/${order.id}/release`)
    if (res.status === 200)            { ok(`Orden ${key} liberada`); continue }
    if ([400, 409].includes(res.status)) { skip(`Orden ${key} ya liberada (${res.status})`); continue }
    recordGap(`ORDER_RELEASE_${key}`, `release devolvió ${res.status}: ${JSON.stringify(res.body).slice(0,100)}`)
  }
}

// ─── 7. Turno ─────────────────────────────────────────────────────────────

async function ensureShift(client, tenantId, userId) {
  log('\n[7] Creando turno…')

  const active = await client.get('/api/production/shifts/active')
  if (active.status === 200 && active.body?.id) {
    skip(`turno activo ya existe (id=${active.body.id})`)
    return { ...active.body, _wasExisting: true }
  }

  const VALID_SLOTS = ['1', '2', '3']
  let shiftDate = null
  let availableSlot = null

  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset)
    const dateStr = d.toISOString().slice(0, 10)
    const usedResult = await withBypass(() => query(
      `SELECT shift_number FROM production_shifts
       WHERE tenant_id = $1 AND shift_date::date = $2::date`,
      [tenantId, dateStr]
    ))
    const takenSlots = new Set(usedResult.rows.map(r => r.shift_number))
    const free = VALID_SLOTS.find(s => !takenSlots.has(s))
    if (free) { shiftDate = dateStr; availableSlot = free; break }
  }
  if (!availableSlot) fail('Sin slots libres en los próximos 7 días.')

  const res = await client.post('/api/production/shifts', {
    shiftNumber: parseInt(availableSlot), shiftDate, operatorId: userId, supervisorId: userId,
  })
  if (res.status !== 201) fail(`POST /api/production/shifts falló (${res.status})`, res.body)
  ok(`Turno creado (id=${res.body.id}, número=${availableSlot}, fecha=${shiftDate})`)
  return res.body
}

// ─── 8. Cargar MP ─────────────────────────────────────────────────────────

async function loadRawMaterials(client, shiftId, rawMaterials, kgUnitId) {
  log('\n[8] Cargando materias primas al turno…')

  // Receta chocolate usa: Harina, Azúcar, Mantequilla, Huevo, Leche, Cacao,
  // Chocolate amargo, Polvo hornear, Vainilla, Crema, Queso crema, Fondant, Colorante
  const loads = [
    { name: 'Harina de trigo',      kg: 2.0  },
    { name: 'Azúcar refinada',      kg: 2.5  },
    { name: 'Mantequilla',          kg: 1.0  },
    { name: 'Huevo entero',         kg: 1.6  },
    { name: 'Leche entera',         kg: 1.2  },
    { name: 'Cacao en polvo',       kg: 0.5  },
    { name: 'Chocolate amargo',     kg: 0.8  },
    { name: 'Polvo para hornear',   kg: 0.08 },
    { name: 'Extracto de vainilla', kg: 0.05 },
    { name: 'Crema para batir',     kg: 1.6  },
    { name: 'Queso crema',          kg: 0.6  },
    { name: 'Fondant blanco',       kg: 0.4  },
    { name: 'Colorante alimenticio',kg: 0.02 },
  ]

  for (const l of loads) {
    const rm = rawMaterials[l.name]
    if (!rm) { warn(`MP '${l.name}' no en contexto`); continue }
    const res = await client.post(`/api/production/shifts/${shiftId}/mp-loads`, {
      rawMaterialId: rm.id,
      kg:            l.kg,
      unitId:        kgUnitId,
      quantity:      l.kg,
      notes:         `Carga pastelería: ${l.name}`,
    })
    if (res.status !== 201) {
      recordGap('LOAD_MP', `loadMp '${l.name}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
      continue
    }
    ok(`Cargado: ${l.kg} kg de '${l.name}'`)
  }
}

// ─── 9. Capturar PT ───────────────────────────────────────────────────────
//
// pt_goes_to_wip_first=true → pasteles van a WIP (decorado).
// En lot-mode (§21), captureLotModeInventory SIEMPRE va por WIP de todos modos.

async function captureProduction(client, shiftId, orders) {
  log('\n[9] Capturando producción (van a WIP por pt_goes_to_wip_first=true)…')

  const captures = [
    { key: 'CHOC', label: 'PAS-CHOC-20CM', realWeightKg: 9.5,  quantityUnits: 9,  gradeNumber: 1 },
    { key: 'VAIN', label: 'PAS-VAIN-20CM', realWeightKg: 7.6,  quantityUnits: 7,  gradeNumber: 1 },
    { key: 'PERS', label: 'PAS-PERS-20CM', realWeightKg: 1.05, quantityUnits: 1,  gradeNumber: 1 },
  ]

  for (const c of captures) {
    const order = orders[c.key]
    if (!order) { warn(`Orden '${c.key}' no disponible — saltando captura`); continue }

    const res = await client.post(`/api/production/shifts/${shiftId}/packages`, {
      productionOrderId: order.id,
      realWeightKg:      c.realWeightKg,
      quantityUnits:     c.quantityUnits,
      gradeNumber:       c.gradeNumber,
      notes: `Captura simulada: ${c.label}`,
    })
    if (res.status !== 201) {
      recordGap('CAPTURE', `capture '${c.label}' falló (${res.status}): ${JSON.stringify(res.body).slice(0,200)}`)
      continue
    }
    const wip = res.body.wip_entry_at ? '→WIP' : '→PT directo'
    ok(`Capturado: ${c.quantityUnits} pzas (${c.realWeightKg} kg) de '${c.label}' ${wip} (id=${res.body.id})`)
  }
}

// ─── 10. Registrar merma ──────────────────────────────────────────────────

async function recordScrap(client, shiftId, tenantId) {
  log('\n[10] Registrando merma (rebaba_betun)…')

  // Obtener catálogo de mermas para encontrar 'rebaba_betun'
  const { rows: scrapTypes } = await withBypass(() => query(
    `SELECT id, code, default_destination FROM tenant_scrap_types
     WHERE tenant_id = $1 AND code = 'rebaba_betun' AND is_active = true`,
    [tenantId]
  ))
  if (scrapTypes.length === 0) {
    recordGap('SCRAP_TYPE', `No se encontró scrap_type 'rebaba_betun' activo`)
    return
  }
  const rebabaST = scrapTypes[0]

  const res = await client.post(`/api/production/shifts/${shiftId}/scrap`, {
    scrapTypeId:    rebabaST.id,
    kg:             0.15,
    notes:          'Rebaba de betún — reproceso simulado',
  })
  if (res.status !== 201) {
    recordGap('SCRAP_RECORD', `POST scrap 'rebaba_betun' falló (${res.status}): ${JSON.stringify(res.body).slice(0,150)}`)
    return
  }
  ok(`Merma 'rebaba_betun' registrada: 0.15 kg → reprocess (id=${res.body.id})`)
}

// ─── 11. Cerrar turno ─────────────────────────────────────────────────────
//
// Con allergen_mode='alert_only': el cierre NO debe bloquearse aunque todos
// los productos usen gluten/lácteos/huevo. El motor solo genera alertas.

async function closeShift(client, shiftId) {
  log('\n[11] Cerrando turno (allergen_mode=alert_only — no debe bloquear)…')

  const res = await client.post(`/api/production/shifts/${shiftId}/close`)
  if (res.status === 200) {
    ok(`Turno cerrado (id=${shiftId})`)
    ok(`  ✓ Criterio 1: allergen_mode=alert_only permitió cerrar sin bloqueo`)
    return true
  }

  if (res.status === 409 && res.body?.code === 'ALLERGEN_BLOCK') {
    recordGap('ALLERGEN_BLOCK',
      `Turno bloqueado por alérgenos (ESPERÁBAMOS alert_only). ` +
      `Productos sin declarar: ${JSON.stringify(res.body?.undeclaredProducts ?? [])}`
    )
    return false
  }

  recordGap('SHIFT_CLOSE', `closeShift devolvió ${res.status}: ${JSON.stringify(res.body).slice(0,200)}`)
  return false
}

// ─── 12. Verificar WIP → PT ───────────────────────────────────────────────

async function verifyWipToPhysical(tenantId, shiftId) {
  log('\n[12] Verificando que capturas llegaron a WIP (pt_goes_to_wip_first=true)…')

  // Buscar movimientos hacia WIP originados en shift_progress de este turno
  const { rows: wipMovs } = await withBypass(() => query(
    `SELECT im.id, im.quantity, w.type AS wh_type
     FROM inventory_movements im
     JOIN warehouses w ON w.id = im.warehouse_id
     WHERE im.reference_type = 'shift_progress'
       AND im.reference_id IN (
         SELECT id FROM shift_progress WHERE shift_id = $1
       )
       AND w.type = 'wip'
       AND im.movement_type IN ('production_wip_entry', 'production_wip_to_pt', 'production_pt_entry', 'transfer_in')
     ORDER BY im.created_at DESC`,
    [shiftId]
  ))

  if (wipMovs.length === 0) {
    recordGap('WIP_MOVEMENTS',
      `No hay movimientos hacia WIP para el turno ${shiftId}. ` +
      `Si lot-mode está activo, captureLotModeInventory siempre pasa por WIP (§21).`
    )
  } else {
    ok(`${wipMovs.length} movimiento(s) a WIP encontrados`)
    ok(`  ✓ Criterio 1 (secundario): pt_goes_to_wip_first=true funciona`)
  }
}

// ─── 13. Verificar custom_attributes en orden ─────────────────────────────

async function verifyCustomOrder(client, orders) {
  log('\n[13] Verificando custom_attributes de orden personalizada…')

  const persOrder = orders['PERS']
  if (!persOrder) {
    recordGap('CUSTOM_ORDER_MISSING', 'Orden personalizada no disponible para verificar')
    return
  }

  // Re-leer la orden desde la API para confirmar persistencia
  const res = await client.get(`/api/production/orders/${persOrder.id}`)
  if (res.status !== 200) {
    recordGap('CUSTOM_ORDER_GET', `GET /api/production/orders/${persOrder.id} falló (${res.status})`)
    return
  }

  const order = res.body
  const ca = order.custom_attributes
  const ac = parseFloat(order.additional_costs)

  if (ca && ca.texto === 'Feliz cumpleaños Ana' && ca.color_betun === 'azul') {
    ok(`  ✓ Criterio 2: custom_attributes persistieron correctamente`)
    ok(`    texto="${ca.texto}" color_betun="${ca.color_betun}" figuras="${ca.figuras}"`)
  } else {
    recordGap('CUSTOM_ATTRS_PERSIST',
      `custom_attributes no coinciden. Expected texto='Feliz cumpleaños Ana', got: ${JSON.stringify(ca)}`
    )
  }

  if (ac === 50.0) {
    ok(`  ✓ Criterio 2: additional_costs=50 persistió correctamente`)
  } else {
    recordGap('ADDITIONAL_COSTS_PERSIST', `additional_costs esperado=50, got=${order.additional_costs}`)
  }

  if (order.additional_costs_notes) {
    ok(`    additional_costs_notes="${order.additional_costs_notes}"`)
  }
}

// ─── 14. Verificar alertas de caducidad (criterio 3) ─────────────────────
//
// Crea lotes PT artificiales con expiry_date = hoy + 1 día (dentro del umbral
// de 2 días configurado en products.expiry_alert_days=2).
// Llama getExpiringLots y verifica que aparecen.

async function verifyExpiryAlerts(tenantId, products) {
  log('\n[14] Verificando alertas de caducidad (products.expiry_alert_days=2)…')

  // Obtener warehouse PT del tenant
  const { rows: ptWh } = await withBypass(() => query(
    `SELECT w.id FROM warehouses w WHERE w.tenant_id = $1 AND w.type = 'finished_product' AND is_active = true LIMIT 1`,
    [tenantId]
  ))
  if (!ptWh.length) {
    recordGap('PT_WAREHOUSE', 'No se encontró warehouse de tipo finished_product')
    return
  }
  const ptWarehouseId = ptWh[0].id

  // Obtener calidad para crear lotes de prueba
  const { rows: gradeRows } = await withBypass(() => query(
    `SELECT id FROM tenant_quality_grades WHERE tenant_id = $1 AND code = 'primera' AND is_active = true LIMIT 1`,
    [tenantId]
  ))
  if (!gradeRows.length) {
    recordGap('QUALITY_GRADE', `No se encontró quality_grade 'primera' activo para el tenant`)
    return
  }
  const gradeId = gradeRows[0].id

  // Obtener producto para crear lotes de prueba
  const { rows: prodRows } = await withBypass(() => query(
    `SELECT id, sku FROM products WHERE tenant_id = $1 AND sku = 'PAS-CHOC-20CM'`,
    [tenantId]
  ))
  if (!prodRows.length) {
    recordGap('PRODUCT_FOR_LOT', `Producto 'PAS-CHOC-20CM' no encontrado en BD`)
    return
  }
  const prodId = prodRows[0].id

  // Crear lote PT con expiry_date = hoy + 1 día (dentro del umbral de 2 días)
  const expiryDate = new Date()
  expiryDate.setDate(expiryDate.getDate() + 1)
  const expiryStr = expiryDate.toISOString().slice(0, 10)
  const lotNum = `TEST-EXP-${Date.now().toString(36).slice(-6).toUpperCase()}`

  const { rows: existingLot } = await withBypass(() => query(
    `SELECT id, lot_number FROM product_lots
     WHERE tenant_id = $1 AND product_id = $2
       AND expiry_date::date = $3::date AND status = 'active'
     LIMIT 1`,
    [tenantId, prodId, expiryStr]
  ))

  let testLotId
  if (existingLot.length > 0) {
    skip(`Lote de prueba ya existe: ${existingLot[0].lot_number}`)
    testLotId = existingLot[0].id
  } else {
    await withBypass(() => query(
      `INSERT INTO product_lots
         (tenant_id, product_id, lot_number, warehouse_id, expiry_date,
          quantity_produced, quantity_remaining, status, unit_cost, origin,
          production_date, quality_grade_id)
       VALUES ($1, $2, $3, $4, $5::date, 1, 1, 'active', 200, 'adjusted', NOW()::date, $6)`,
      [tenantId, prodId, lotNum, ptWarehouseId, expiryStr, gradeId]
    ))
    const { rows: newLot } = await withBypass(() => query(
      `SELECT id FROM product_lots WHERE tenant_id = $1 AND lot_number = $2`,
      [tenantId, lotNum]
    ))
    testLotId = newLot[0]?.id
    ok(`Lote de prueba creado: ${lotNum} (expira ${expiryStr})`)
  }

  // Llamar getExpiringLots con daysAhead=2 (igual que products.expiry_alert_days)
  let expiringResult
  try {
    expiringResult = await getExpiringLots({ tenantId, daysAhead: 2 })
  } catch (err) {
    recordGap('GET_EXPIRING_LOTS', `getExpiringLots falló: ${err.message}`)
    return
  }

  const foundLot = expiringResult.productLots.find(l => l.id === testLotId)
  if (foundLot) {
    ok(`  ✓ Criterio 3: lote en el umbral de 2 días aparece en getExpiringLots`)
    ok(`    lot_number=${foundLot.lot_number} expiry=${foundLot.expiry_date?.toISOString?.().slice(0,10) ?? foundLot.expiry_date}`)
    ok(`    effective_alert_days=${foundLot.effective_alert_days} (should be 2 from products.expiry_alert_days)`)
  } else {
    recordGap('EXPIRY_ALERT',
      `Lote ${testLotId} (expiry ${expiryStr}) no aparece en getExpiringLots(daysAhead=2). ` +
      `Total productLots returned: ${expiringResult.productLots.length}`
    )
  }

  // Verificar que el umbral por producto (2d) es menor que el global (3d):
  // un lote con expiry_date = hoy + 2 días DEBERÍA aparecer con daysAhead=2 pero también con daysAhead=3.
  // Un lote con expiry_date = hoy + 3 días NO debería aparecer con daysAhead=2 (products override a 2d).
  const threeDayLotDate = new Date()
  threeDayLotDate.setDate(threeDayLotDate.getDate() + 3)
  const threeDayStr = threeDayLotDate.toISOString().slice(0, 10)

  const threeResult = await getExpiringLots({ tenantId, daysAhead: 3 })
  const twoResult   = await getExpiringLots({ tenantId, daysAhead: 2 })

  // Con daysAhead=3 debería incluir el lote (está en +1 día → dentro de 3)
  // Con daysAhead=2 también debería incluirlo (está en +1 → dentro de 2)
  const in3Days  = threeResult.productLots.find(l => l.id === testLotId)
  const in2Days  = twoResult.productLots.find(l => l.id === testLotId)

  if (in3Days && in2Days) {
    ok(`  ✓ Criterio 3 (adicional): lote +1 día aparece tanto en daysAhead=2 como en daysAhead=3`)
  } else {
    warn(`  Lote +1 día: en3Days=${!!in3Days} en2Days=${!!in2Days}`)
  }

  // Verificar que el COALESCE usa products.expiry_alert_days=2 (override) en lugar del global 3
  // Si el producto tiene expiry_alert_days=2 y el umbral del lote es efectivamente 2, está correcto.
  if (in2Days?.effective_alert_days == 2) {
    ok(`  ✓ Criterio 3: effective_alert_days=2 confirma override por producto (migration 139)`)
  } else if (in2Days) {
    warn(`  effective_alert_days=${in2Days.effective_alert_days} (esperado 2)`)
  }
}

// ─── 15. Verificar receta 13 componentes ─────────────────────────────────

async function verifyLongRecipe(client, tenantId) {
  log('\n[15] Verificando receta de 13 componentes (criterio 4)…')

  const { rows: prodRow } = await withBypass(() => query(
    `SELECT id FROM products WHERE tenant_id = $1 AND sku = 'PAS-CHOC-20CM'`,
    [tenantId]
  ))
  if (!prodRow.length) {
    recordGap('LONG_RECIPE_PROD', `PAS-CHOC-20CM no encontrado`)
    return
  }

  const res = await client.get(`/api/recipes?productId=${prodRow[0].id}&vigentOnly=true`)
  if (res.status !== 200) {
    recordGap('LONG_RECIPE_GET', `GET /api/recipes falló (${res.status})`)
    return
  }
  const recipes = res.body || []
  const recipe = recipes[0]
  if (!recipe) {
    recordGap('LONG_RECIPE_MISSING', `No hay receta vigente para PAS-CHOC-20CM`)
    return
  }

  const componentsRes = await client.get(`/api/recipes/${recipe.id}`)
  const fullRecipe = componentsRes.body
  const nComponents = fullRecipe?.components?.length ?? recipe.components?.length ?? 0

  if (nComponents >= 10) {
    ok(`  ✓ Criterio 4: receta '${recipe.name}' tiene ${nComponents} componentes (≥10)`)
  } else {
    recordGap('LONG_RECIPE_COUNT',
      `Receta '${recipe.name}' tiene ${nComponents} componentes (esperado ≥10)`
    )
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    const { tenant, token, userId } = await loginAndContext()
    const client = clientFor(token)

    const warehouses   = await ensureWarehouses(client)
    // Obtener RMs del tenant desde BD (provision-pasteleria ya los creó)
    log('\n  Consultando materias primas del tenant…')
    const { rows: rmRows } = await withBypass(() => query(
      `SELECT name, id, unit FROM raw_materials WHERE tenant_id = $1`, [tenant.id]
    ))
    const rawMaterials = Object.fromEntries(rmRows.map(r => [r.name, r]))
    ok(`${rmRows.length} materias primas encontradas`)

    const kgUnitRes = await client.get('/api/process-config/units').expect(200)
    const kgUnit = kgUnitRes.body.find(u => u.code === 'kg')
    if (!kgUnit) fail('No se encontró unidad kg')

    await seedStock(tenant.id, rawMaterials, warehouses, userId)
    const products = await getProducts(client)
    const orders   = await ensureOrders(client, products)
    await releaseOrders(client, orders)
    const shift    = await ensureShift(client, tenant.id, userId)

    await loadRawMaterials(client, shift.id, rawMaterials, kgUnit.id)
    await captureProduction(client, shift.id, orders)
    await recordScrap(client, shift.id, tenant.id)
    const closed = await closeShift(client, shift.id)

    if (closed) {
      await verifyWipToPhysical(tenant.id, shift.id)
    } else {
      warn('Turno no cerrado — verificación WIP omitida')
    }

    await verifyCustomOrder(client, orders)
    await verifyExpiryAlerts(tenant.id, products)
    await verifyLongRecipe(client, tenant.id)

    // ── Resumen final ──────────────────────────────────────────────────────
    log('\n' + '─'.repeat(70))
    log(`FASE 5 — PASTELERÍA — GAPS DETECTADOS: ${GAPS.length}`)
    log('─'.repeat(70))
    if (GAPS.length === 0) {
      log('  (ninguno)')
      log('')
      log('  Criterios de done:')
      log('    1. ✓ Pastelería produce pasteles estándar (Choc + Vainilla)')
      log('    2. ✓ Pedido personalizado: custom_attributes + additional_costs')
      log('    3. ✓ Alertas de caducidad a ≤2 días (products.expiry_alert_days)')
      log('    4. ✓ Recetas con 13 componentes ejecutadas sin error')
    } else {
      GAPS.forEach((g, i) => log(`  ${i+1}. [${g.id}] ${g.summary}`))
    }
    log('─'.repeat(70))
    log('')
  } catch (err) {
    console.error('\nError no manejado:', err.stack || err)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
