/* Genera el ÍCONO DE NOTIFICACIÓN de Android (small icon / status bar).
 *
 * Android renderiza el small icon como SILUETA: toma solo el canal alfa y lo
 * pinta de blanco (el color real lo da `default_notification_color`). Por eso el
 * ícono de la app (a color/adaptativo) sale como un cuadro blanco. Aquí pintamos
 * el isotipo de Praxion TODO en blanco sobre transparente → la silueta correcta.
 *
 * Salida: android/app/src/main/res/drawable-<densidad>/ic_stat_notify.png
 * Referenciado en AndroidManifest.xml vía
 *   com.google.firebase.messaging.default_notification_icon.
 *
 * Correr desde saas-erp-frontend/:  node scripts/gen-notification-icon.cjs
 */
'use strict'
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const AR = 403.98 / 497.32 // aspecto del isotipo (portrait)

// Inline de los fills del SVG, TODOS en blanco → silueta plana (sólo importa el alfa).
const svg = fs.readFileSync('public/praxion-isotipo.svg', 'utf8')
  .replace(/<defs>[\s\S]*?<\/defs>/, '')
  .replace(/class="cls-[123]"/g, 'fill="#FFFFFF"')

const RES = 'android/app/src/main/res'
// Tamaños estándar del status-bar icon por densidad (px).
const DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 }

async function main() {
  for (const [density, size] of Object.entries(DENSITIES)) {
    const innerH = Math.round(size * 0.88)        // arte al ~88% → margen ~6% por lado
    const innerW = Math.round(innerH * AR)
    const dir = path.join(RES, `drawable-${density}`)
    fs.mkdirSync(dir, { recursive: true })

    // Isotipo blanco al tamaño interno (4× + downscale = bordes nítidos).
    const mark = await sharp(Buffer.from(svg))
      .resize(innerW * 4, innerH * 4, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(innerW, innerH)
      .png().toBuffer()

    // Centrar en un cuadro transparente size×size con padding simétrico exacto.
    const padX = Math.floor((size - innerW) / 2)
    const padY = Math.floor((size - innerH) / 2)
    await sharp(mark)
      .extend({
        top: padY, bottom: size - innerH - padY,
        left: padX, right: size - innerW - padX,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png().toFile(path.join(dir, 'ic_stat_notify.png'))
  }
  console.log('✓ ic_stat_notify.png generado en 5 densidades (mdpi…xxxhdpi)')
}

main().catch((e) => { console.error(e); process.exit(1) })
