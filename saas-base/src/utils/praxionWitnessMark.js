'use strict'

const COPY = 'Powered by Praxion · praxionsystems.mx'

const GRAY  = '#9CA3AF'
const GREEN = '#82a926'
const DARK  = '#506612'

const VIEW_W = 403.98
const VIEW_H = 497.32

const POLYS = [
  { fill: GRAY,  points: [[0,357.63],[0,114.44],[204.85,0],[403.98,112.72],[403.98,342.18],[213.43,446.89],[213.43,369.07],[342.18,298.69],[343.32,148.2],[204.85,68.09],[60.08,147.63],[59.51,390.82],[0,357.63]] },
  { fill: GREEN, points: [[129.46,457.36],[129.46,327.76],[201.99,368.96],[201.99,495.56],[129.46,457.36]] },
  { fill: GRAY,  points: [[280.38,178.91],[203.99,136.86],[123.6,181.49],[201.7,223.83],[280.38,178.91]] },
  { fill: DARK,  points: [[201.99,311.66],[123.6,267.89],[123.6,181.49],[201.7,223.83],[201.99,311.66]] },
  { fill: GREEN, points: [[280.38,270.46],[201.99,311.66],[201.7,223.83],[280.38,178.91],[280.38,270.46]] },
]

function drawWitnessMark(doc, { x, y, isotopeH = 9, fontSize = 7 } = {}) {
  const scale = isotopeH / VIEW_H
  const isotopeW = VIEW_W * scale
  const oldX = doc.x, oldY = doc.y

  doc.save()
  for (const p of POLYS) {
    const args = p.points.map(([px, py]) => [x + px * scale, y + py * scale])
    doc.polygon(...args).fillColor(p.fill).fill()
  }
  doc.restore()

  doc.fillColor(GRAY).fontSize(fontSize).font('Helvetica')
     .text(COPY, x + isotopeW + 4, y + (isotopeH - fontSize) / 2, { lineBreak: false })

  doc.x = oldX
  doc.y = oldY
}

function addPraxionFooterPDF(doc, opts = {}) {
  const { margin = 40, bottomOffset = 22, isotopeH = 9, fontSize = 7 } = opts
  const scale = isotopeH / VIEW_H
  const isotopeW = VIEW_W * scale

  const text = COPY
  doc.save().fontSize(fontSize).font('Helvetica')
  const textW = doc.widthOfString(text)
  doc.restore()

  const blockW = isotopeW + 4 + textW
  const x = (doc.page.width - blockW) / 2
  const y = doc.page.height - bottomOffset

  drawWitnessMark(doc, { x, y, isotopeH, fontSize })
}

function htmlWitnessMark() {
  return `
    <div style="padding:14px 40px 18px;text-align:center;font-size:11px;color:#9ca3af;background:#fafafa;border-top:1px solid #f3f4f6;line-height:1;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr>
          <td style="vertical-align:middle;padding-right:6px;">
            <svg width="12" height="14" viewBox="0 0 403.98 497.32" xmlns="http://www.w3.org/2000/svg" style="display:block;">
              <polygon fill="${GRAY}"  points="0 357.63 0 114.44 204.85 0 403.98 112.72 403.98 342.18 213.43 446.89 213.43 369.07 342.18 298.69 343.32 148.2 204.85 68.09 60.08 147.63 59.51 390.82 0 357.63"/>
              <polygon fill="${GREEN}" points="129.46 457.36 129.46 327.76 201.99 368.96 201.99 495.56 129.46 457.36"/>
              <polygon fill="${GRAY}"  points="280.38 178.91 203.99 136.86 123.6 181.49 201.7 223.83 280.38 178.91"/>
              <polygon fill="${DARK}"  points="201.99 311.66 123.6 267.89 123.6 181.49 201.7 223.83 201.99 311.66"/>
              <polygon fill="${GREEN}" points="280.38 270.46 201.99 311.66 201.7 223.83 280.38 178.91 280.38 270.46"/>
            </svg>
          </td>
          <td style="vertical-align:middle;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#9ca3af;">
            Powered by <a href="https://praxionsystems.mx" style="color:#6b7280;text-decoration:none;">Praxion</a> · praxionsystems.mx
          </td>
        </tr>
      </table>
    </div>`
}

function addPraxionFooterAllPagesPDF(doc, opts = {}) {
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    addPraxionFooterPDF(doc, opts)
  }
}

module.exports = { addPraxionFooterPDF, addPraxionFooterAllPagesPDF, drawWitnessMark, htmlWitnessMark, COPY }
