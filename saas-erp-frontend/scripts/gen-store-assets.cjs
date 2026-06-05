/* Genera los gráficos requeridos por Google Play Store a partir del isotipo de
 * Praxion (marca blanca+verde sobre fondo oscuro #0B0F12):
 *   - icono 512×512 (hi-res icon, sin alfa)
 *   - feature graphic 1024×500 (gráfico destacado de la ficha)
 * Salida: ../docs/play-store/assets/. Reproducible: `node scripts/gen-store-assets.cjs`. */
'use strict'
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const BG = '#0B0F12'           // bg-primary de la app / marca
const GREEN = '#82a926'
const AR = 403.98 / 497.32     // aspecto del isotipo (portrait)
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'play-store', 'assets')

// Inlinear el SVG del isotipo (usa clases CSS en <defs>; las pintamos directo).
const svg = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'praxion-isotipo.svg'), 'utf8')
  .replace(/<defs>[\s\S]*?<\/defs>/, '')
  .replace(/class="cls-1"/g, 'fill="#FFFFFF"')
  .replace(/class="cls-2"/g, 'fill="#82a926"')
  .replace(/class="cls-3"/g, 'fill="#506612"')

async function mark(height) {
  const w = Math.round(height * AR)
  return sharp(Buffer.from(svg)).resize(w, height, { fit: 'contain' }).png().toBuffer()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // 1) Hi-res icon 512×512 — marca sobre fondo de marca, sin alfa (Play lo pide PNG 32-bit;
  //    fondo sólido se ve consistente en cualquier superficie de la tienda).
  await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
    .composite([{ input: await mark(330), gravity: 'center' }])
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(path.join(OUT, 'icon-512.png'))

  // 2) Feature graphic 1024×500 — banner: isotipo a la izquierda + nombre y claim a la derecha.
  const markBuf = await mark(300)
  const markW = Math.round(300 * AR)
  const textSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="500">
      <text x="0" y="232" font-family="Arial, Helvetica, sans-serif" font-size="104"
            font-weight="700" fill="#FFFFFF" letter-spacing="2">Praxion</text>
      <rect x="4" y="262" width="120" height="6" fill="${GREEN}"/>
      <text x="0" y="316" font-family="Arial, Helvetica, sans-serif" font-size="34"
            font-weight="400" fill="#C9D3C2">ERP para tu operación diaria</text>
      <text x="0" y="360" font-family="Arial, Helvetica, sans-serif" font-size="26"
            font-weight="400" fill="${GREEN}">Ventas · Inventario · Producción · Compras</text>
    </svg>`)

  await sharp({ create: { width: 1024, height: 500, channels: 4, background: BG } })
    .composite([
      { input: markBuf, left: 96, top: Math.round((500 - 300) / 2) },
      { input: textSvg, left: 96 + markW + 80, top: 0 },
    ])
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(path.join(OUT, 'feature-graphic-1024x500.png'))

  console.log('✓ docs/play-store/assets/: icon-512.png (512×512), feature-graphic-1024x500.png (1024×500)')
}

main().catch(e => { console.error(e); process.exit(1) })
