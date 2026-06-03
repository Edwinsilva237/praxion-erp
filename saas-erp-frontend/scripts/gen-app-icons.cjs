/* Genera las imágenes fuente del ícono de la app (carpeta assets/) a partir
 * del isotipo de Praxion. Luego `capacitor-assets generate` produce todos los
 * tamaños de Android (--android) e iOS (--ios). Marca blanca+verde sobre fondo
 * oscuro de marca (#0B0F12).
 *
 * iOS usa `icon-only.png` y NO admite canal alfa (App Store lo rechaza), por eso
 * ese archivo se APLANA (sin transparencia). El foreground sí queda transparente
 * (lo requiere la máscara adaptive de Android). */
'use strict'
const fs = require('fs')
const sharp = require('sharp')

const BG = '#0B0F12'           // bg-primary de la app
const AR = 403.98 / 497.32     // aspecto del isotipo (portrait)

// Aplanar el SVG: el original usa clases CSS en <defs>; las inlineamos para
// que el rasterizador las pinte sin depender de soporte de CSS.
const svg = fs.readFileSync('public/praxion-isotipo.svg', 'utf8')
  .replace(/<defs>[\s\S]*?<\/defs>/, '')
  .replace(/class="cls-1"/g, 'fill="#FFFFFF"')
  .replace(/class="cls-2"/g, 'fill="#82a926"')
  .replace(/class="cls-3"/g, 'fill="#506612"')

async function mark(height) {
  const h = height
  const w = Math.round(h * AR)
  return sharp(Buffer.from(svg)).resize(w, h, { fit: 'contain' }).png().toBuffer()
}

async function main() {
  fs.mkdirSync('assets', { recursive: true })

  // Foreground (adaptive): marca centrada con padding generoso (la máscara
  // adaptive recorta ~33% del borde, así que dejamos la marca al ~58% del alto).
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await mark(600), gravity: 'center' }])
    .png().toFile('assets/icon-foreground.png')

  // Background (adaptive): color sólido de marca.
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
    .png().toFile('assets/icon-background.png')

  // Icon "completo" (cuadrado/redondo Android + AppIcon iOS): marca sobre fondo
  // oscuro. `.flatten()` quita el canal alfa → válido para iOS/App Store.
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
    .composite([{ input: await mark(680), gravity: 'center' }])
    .flatten({ background: BG })
    .removeAlpha()
    .png().toFile('assets/icon-only.png')

  // Splash / launch screen: marca centrada sobre fondo de marca. 2732×2732 (lo
  // recorta capacitor-assets a cada aspecto). Mismo arte para claro y oscuro
  // (el fondo de marca ya es oscuro). El logo va pequeño (~28%) para no recortarse.
  const splash = await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } })
    .composite([{ input: await mark(760), gravity: 'center' }])
    .png().toBuffer()
  fs.writeFileSync('assets/splash.png', splash)
  fs.writeFileSync('assets/splash-dark.png', splash)

  console.log('✓ assets/: icon-foreground, icon-background, icon-only, splash, splash-dark')
}

main().catch(e => { console.error(e); process.exit(1) })
