'use strict'

// Helpers para crear datos de prueba y limpiarlos. Cada test debería:
//   1) Llamar createTenant() en beforeAll/beforeEach
//   2) Hacer su lógica
//   3) Llamar cleanupTestTenants() en afterAll
//
// Todos los slugs creados llevan prefix "test_" + timestamp para que no
// haya conflicto si quedan residuos por tests interrumpidos.

const request = require('supertest')
const { query, withBypass } = require('../../src/db')
const app = require('../../src/app')

// Prefijo para identificar tenants creados por tests y poder limpiarlos.
// IMPORTANTE: usar guiones (no underscores) — el endpoint /provision valida
// el formato del slug: solo lowercase + dígitos + guiones.
const TEST_PREFIX = 'test-'

let counter = 0

function makeSlug(label = '') {
  counter += 1
  const t = Date.now().toString(36)
  return `${TEST_PREFIX}${label}-${t}-${counter}`.toLowerCase().replace(/[^a-z0-9-]/g, '')
}

/**
 * Crea un tenant + admin via el endpoint público /api/tenants/provision.
 * Devuelve { tenant, user, password } para poder hacer login después.
 */
async function createTenant({ label = 'tenant', planSlug = 'free' } = {}) {
  const slug  = makeSlug(label)
  const email = `${slug}@test.local`
  const password = 'TestPassword!2026'

  const res = await request(app)
    .post('/api/tenants/provision')
    .send({
      slug,
      name: slug,
      adminEmail: email,
      adminPassword: password,
      adminName: 'Test Admin',
    })
    .expect(201)

  // Si el plan deseado no es 'free', lo actualizamos directamente en BD.
  if (planSlug !== 'free') {
    await withBypass(() => query(
      `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE slug = $1)
        WHERE tenant_id = $2`,
      [planSlug, res.body.tenant.id]
    ))
  }

  return {
    tenant: res.body.tenant,
    user:   res.body.user,
    email,
    password,
  }
}

/**
 * Hace login y devuelve { token, refreshToken, user } listo para usar
 * en headers de subsiguientes requests.
 */
async function loginAs({ slug, email, password }) {
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Tenant-Slug', slug)
    .send({ email, password })
    .expect(200)
  return {
    token:        res.body.accessToken,
    refreshToken: res.body.refreshToken,
    user:         res.body.user,
    tenant:       res.body.tenant,
  }
}

/**
 * Helper para hacer una request HTTP autenticada como cierto tenant+usuario.
 * Devuelve un cliente con métodos get/post/put/patch/delete listos.
 */
function authedClient({ slug, token }) {
  const headers = {
    'X-Tenant-Slug': slug,
    'Authorization': `Bearer ${token}`,
  }
  const wrap = (method) => (path, body) => {
    const r = request(app)[method](path).set(headers)
    if (body) r.send(body)
    return r
  }
  return {
    get:    wrap('get'),
    post:   wrap('post'),
    put:    wrap('put'),
    patch:  wrap('patch'),
    delete: wrap('delete'),
  }
}

/**
 * Borra TODOS los tenants con prefix test_*. Idempotente.
 * Ejecutar en afterAll de cada suite (y también desde `npm run test:clean`).
 *
 * Pre-borra tablas con FK no-cascade a raw_materials/products para evitar
 * violaciones de FK durante el CASCADE de tenants. Si en el futuro se agregan
 * más tablas con FK sin ON DELETE CASCADE, agregarlas aquí.
 */
async function cleanupTestTenants() {
  await withBypass(async () => {
    // Tablas hijas de production_orders / production_shifts cuyas FK a
    // raw_materials u otros catálogos NO tienen ON DELETE CASCADE. Hay que
    // borrar a mano antes del DELETE FROM tenants.
    //
    // Algunas de estas tablas NO llevan tenant_id directo (shift_progress,
    // shift_scrap, shift_incidents, shift_mp_loads, order_mp_formula) — solo
    // shift_id o production_order_id. Por eso vamos via JOIN al padre.
    const slugPattern = `${TEST_PREFIX}%`

    // Hijas de production_shifts (link por shift_id)
    const shiftIdsSubq = `
      shift_id IN (
        SELECT ps.id FROM production_shifts ps
        JOIN tenants t ON t.id = ps.tenant_id
        WHERE t.slug LIKE $1
      )
    `
    await query(`DELETE FROM shift_progress       WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_scrap          WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_incidents      WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_mp_loads       WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_handovers      WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_cost_snapshot  WHERE ${shiftIdsSubq}`, [slugPattern])
    await query(`DELETE FROM shift_corrections    WHERE ${shiftIdsSubq}`, [slugPattern])

    // Hijas de production_orders (link por production_order_id)
    await query(`
      DELETE FROM order_mp_formula
      WHERE production_order_id IN (
        SELECT po.id FROM production_orders po
        JOIN tenants t ON t.id = po.tenant_id
        WHERE t.slug LIKE $1
      )
    `, [slugPattern])

    // SaaS v2: recipe_components.raw_material_id es RESTRICT — debemos pre-borrar
    // recetas (que CASCADE a recipe_components) antes de que el CASCADE del tenant
    // intente borrar raw_materials, porque el orden CASCADE no es determinístico.
    await query(`
      DELETE FROM recipes WHERE tenant_id IN (
        SELECT id FROM tenants WHERE slug LIKE $1
      )
    `, [slugPattern])

    // Líneas de documentos cuya FK product_id es RESTRICT (no CASCADE). Si el
    // CASCADE del tenant borra `products` antes que estas líneas, viola la FK.
    // Pre-borrarlas (vía su documento padre del tenant) evita el problema.
    await query(`
      DELETE FROM invoice_lines il USING invoices iv, tenants t
       WHERE il.invoice_id = iv.id AND iv.tenant_id = t.id AND t.slug LIKE $1
    `, [slugPattern])
    await query(`
      DELETE FROM delivery_note_lines dnl USING delivery_notes dn, tenants t
       WHERE dnl.delivery_note_id = dn.id AND dn.tenant_id = t.id AND t.slug LIKE $1
    `, [slugPattern])
    await query(`
      DELETE FROM sales_order_lines sol USING sales_orders so, tenants t
       WHERE sol.sales_order_id = so.id AND so.tenant_id = t.id AND t.slug LIKE $1
    `, [slugPattern])

    // Finalmente el tenant — CASCADE limpia el resto
    await query(`DELETE FROM tenants WHERE slug LIKE $1`, [slugPattern])
  })
}

// El email tampoco soporta el prefix con guión bien; usamos uno fijo + slug.
function emailFor(slug) {
  return `${slug}@test.local`
}

module.exports = {
  createTenant,
  loginAs,
  authedClient,
  cleanupTestTenants,
  makeSlug,
}
