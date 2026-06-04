'use strict'

/**
 * Poll del endpoint /api/push/status hasta que el deploy lo exponga, luego
 * imprime { firebaseEnabled, deviceCount, audienceAllCount }.
 *
 * Uso: node scripts/poll-push-status.js <tenantSlug> <email> <password>
 */

const API = process.env.PUSH_TEST_API || 'https://praxion-api.onrender.com/api'
const [, , slug, email, password] = process.argv
if (!slug || !email || !password) {
  console.error('Uso: node scripts/poll-push-status.js <tenantSlug> <email> <password>')
  process.exit(1)
}
const headers = { 'Content-Type': 'application/json', 'Origin': 'https://localhost', 'X-Tenant-Slug': slug }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email, password }) })
  const ld = await login.json().catch(() => ({}))
  if (!ld.accessToken) { console.error('Login falló:', ld.error || ld); process.exit(1) }
  const auth = { ...headers, Authorization: `Bearer ${ld.accessToken}` }

  for (let i = 1; i <= 24; i++) {
    const ts = new Date().toISOString().slice(11, 19)
    const res = await fetch(`${API}/push/status`, { headers: auth })
    if (res.ok) {
      const st = await res.json()
      console.log(`\n✅ /status VIVO (intento ${i}, ${ts}):`)
      console.log(JSON.stringify(st, null, 2))
      if (!st.firebaseEnabled) console.log('\n⚠️  firebaseEnabled=false → las env FIREBASE_* no están efectivas en prod.')
      else if (st.deviceCount > 0) console.log('\n✅ Firebase ON + ' + st.deviceCount + ' token(s). El broadcast debería funcionar.')
      return
    }
    console.log(`intento ${i} (${ts}): aún desplegando (HTTP ${res.status})`)
    await sleep(15000)
  }
  console.log('Se agotaron los intentos — el deploy tarda más de lo normal.')
})()
