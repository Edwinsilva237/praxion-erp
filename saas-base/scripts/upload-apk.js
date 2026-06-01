'use strict'

/**
 * Sube el APK de la app Android a R2 (key `public/praxion-app.apk`) para que el
 * endpoint público GET /app/android lo sirva (botón "Descargar app Android" de
 * los correos de invitación/bienvenida).
 *
 * Correr LOCAL (usa las credenciales R2 del .env, mismo bucket que prod):
 *   node scripts/upload-apk.js [ruta-al-apk]
 *
 * Sin argumento usa el APK debug del build de Capacitor por defecto. Tras
 * recompilar la app (npm run sync:android + gradlew assembleDebug) re-correr esto
 * para publicar la versión nueva. Cuando la app esté en Play Store, setear
 * ANDROID_APP_URL en Render y este paso deja de ser necesario.
 */

const fs = require('fs')
const path = require('path')
const storage = require('../src/utils/storage')

const DEFAULT_APK = path.resolve(
  __dirname,
  '../../saas-erp-frontend/android/app/build/outputs/apk/debug/app-debug.apk'
)
const R2_KEY = 'public/praxion-app.apk'

async function main() {
  const apkPath = process.argv[2] || DEFAULT_APK
  if (!fs.existsSync(apkPath)) {
    console.error(`No se encontró el APK en: ${apkPath}`)
    console.error('Pasa la ruta como argumento o compílalo primero.')
    process.exit(1)
  }
  const buf = fs.readFileSync(apkPath)
  console.log(`APK: ${apkPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`)

  await storage.put(R2_KEY, buf, { contentType: 'application/vnd.android.package-archive' })
  const back = await storage.fetchBuffer(R2_KEY)
  const ok = back.length === buf.length
  console.log(ok
    ? `✓ Subido y verificado en R2: ${R2_KEY}`
    : `✗ El tamaño en R2 no coincide (${back.length} vs ${buf.length})`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1) })
