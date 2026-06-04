'use strict'

/**
 * Lista TODAS las empresas (tenants) a las que pertenece un usuario, con su slug.
 * Sirve para saber bajo qué tenant pudo haberse registrado el token push de la app.
 *
 * Usa /auth/login-discover (descubrimiento por correo, igual que la app móvil) y
 * luego /auth/me en cada sesión. Más simple: login-discover ya devuelve la lista.
 *
 * Uso:
 *   node scripts/list-my-tenants.js <email> <password>
 */

const API = process.env.PUSH_TEST_API || 'https://praxion-api.onrender.com/api'
const [, , email, password] = process.argv

if (!email || !password) {
  console.error('Uso: node scripts/list-my-tenants.js <email> <password>')
  process.exit(1)
}

const headers = { 'Content-Type': 'application/json', 'Origin': 'https://localhost' }

;(async () => {
  try {
    // login-discover: por correo, sin pedir empresa (lo que usa la app).
    const res = await fetch(`${API}/auth/login-discover`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status}:`, data.error || data)
      process.exit(1)
    }

    if (data.needsTenantSelection && Array.isArray(data.tenants)) {
      console.log(`── Tienes acceso a ${data.tenants.length} empresas ──`)
      data.tenants.forEach((t, i) => {
        console.log(`  ${i + 1}. ${t.name}  →  slug: ${t.slug}${t.is_active === false ? '  (suspendida)' : ''}`)
      })
      console.log('\nℹ️  La app muestra un selector con estas empresas. El token push se registró')
      console.log('   bajo la que ELEGISTE al entrar. Para la prueba, usa ESE slug en send-test-push.js.')
    } else if (data.tenant) {
      // Un solo tenant → login directo (NO imprimo tokens).
      console.log('── Tienes UNA sola empresa (entró directo) ──')
      console.log(`  ${data.tenant.name}  →  slug: ${data.tenant.slug}`)
      console.log('\nℹ️  Solo hay una empresa, así que el token debió quedar bajo este slug.')
      console.log('   Si el broadcast a este slug da skipped, el problema es el REGISTRO en runtime (no el tenant).')
    } else {
      console.log('Respuesta inesperada (sin tenant ni lista):', JSON.stringify(Object.keys(data)))
    }
  } catch (err) {
    console.error('❌ Error:', err.message)
    process.exit(1)
  }
})()
