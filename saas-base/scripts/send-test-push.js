'use strict'

/**
 * Manda un push de PRUEBA (broadcast) a toda la empresa — para la "primera luz".
 *
 * Inicia sesión como admin contra el API de producción y llama
 * POST /api/push/broadcast. Las credenciales se pasan por argumentos (se quedan
 * en tu terminal, no en ningún archivo).
 *
 * Uso:
 *   node scripts/send-test-push.js <tenantSlug> <email> <password> ["Título"] ["Cuerpo"]
 *
 * Ejemplo:
 *   node scripts/send-test-push.js gh-insumos-prod admin@empresa.com "MiPass" "Hola" "Prueba de push"
 *
 * Resultado esperado:
 *   { sent: N, skipped: false }   → se mandó a N dispositivos (¡revisa el teléfono!)
 *   { skipped: true }             → no hay tokens registrados aún (¿iniciaste sesión en la app?)
 */

const API = process.env.PUSH_TEST_API || 'https://praxion-api.onrender.com/api'

const [, , slug, email, password, title = 'Prueba Praxion', body = 'El push ya funciona 🎉'] = process.argv

if (!slug || !email || !password) {
  console.error('Uso: node scripts/send-test-push.js <tenantSlug> <email> <password> ["Título"] ["Cuerpo"]')
  process.exit(1)
}

// Headers que usa la app (Origin para pasar el borde de Render/Cloudflare).
const baseHeaders = {
  'Content-Type': 'application/json',
  'Origin': 'https://localhost',
  'X-Tenant-Slug': slug,
}

;(async () => {
  try {
    console.log(`→ Login en ${API} (tenant: ${slug})...`)
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({ email, password }),
    })
    const loginData = await loginRes.json().catch(() => ({}))
    if (!loginRes.ok || !loginData.accessToken) {
      console.error(`❌ Login falló (HTTP ${loginRes.status}):`, loginData.error || loginData)
      process.exit(1)
    }
    console.log('✓ Login OK')

    // Diagnóstico antes de enviar.
    try {
      const stRes = await fetch(`${API}/push/status`, {
        headers: { ...baseHeaders, Authorization: `Bearer ${loginData.accessToken}` },
      })
      if (stRes.ok) {
        const st = await stRes.json()
        console.log('── Status push ──')
        console.log(`  Firebase activo : ${st.firebaseEnabled}`)
        console.log(`  Tokens en tenant: ${st.deviceCount}`)
        console.log(`  Audiencia 'all' : ${st.audienceAllCount} usuarios`)
        if (!st.firebaseEnabled) {
          console.log('  ⚠️  Firebase NO está activo en prod → revisa las 3 env FIREBASE_* en Render + redeploy.')
        } else if (st.deviceCount === 0) {
          console.log('  ⚠️  No hay tokens en este tenant → la app no registró bajo este slug.')
        }
      }
    } catch { /* status es opcional */ }

    console.log('→ Enviando broadcast...')
    const bcRes = await fetch(`${API}/push/broadcast`, {
      method: 'POST',
      headers: { ...baseHeaders, Authorization: `Bearer ${loginData.accessToken}` },
      body: JSON.stringify({ title, body }),
    })
    const bcData = await bcRes.json().catch(() => ({}))
    if (bcRes.status === 403) {
      console.error('❌ 403: tu usuario no tiene el permiso push:broadcast. Cierra sesión y vuelve a entrar (re-login) para refrescar el JWT.')
      process.exit(1)
    }
    if (!bcRes.ok) {
      console.error(`❌ Broadcast falló (HTTP ${bcRes.status}):`, bcData.error || bcData)
      process.exit(1)
    }

    console.log('── Resultado ──')
    console.log(JSON.stringify(bcData, null, 2))
    if (bcData.skipped) {
      console.log('\nℹ️  skipped=true → no hay tokens registrados. Inicia sesión en la APP primero (eso registra el token) y vuelve a correr esto.')
    } else {
      console.log(`\n✅ Enviado a ${bcData.sent} dispositivo(s). ¡Revisa el teléfono (mejor con la app en segundo plano)!`)
    }
  } catch (err) {
    console.error('❌ Error:', err.message)
    process.exit(1)
  }
})()
