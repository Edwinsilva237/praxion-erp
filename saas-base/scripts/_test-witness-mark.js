'use strict'
const fs = require('fs')
const PDFDocument = require('pdfkit')
const { addPraxionFooterPDF, drawWitnessMark } = require('../src/utils/praxionWitnessMark')

const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
const out = fs.createWriteStream(__dirname + '/_witness-test.pdf')
doc.pipe(out)

doc.fontSize(18).fillColor('#1A3A5C').text('REMISIÓN DE PRUEBA · REM-2026-0518', 40, 60)
doc.moveDown()
doc.fontSize(10).fillColor('#222').text('Cliente: Empaques del Norte\nFecha: 21 / mayo / 2026\nTotal: MXN $ 28,512.80')
doc.moveDown(2)
doc.fontSize(7).fillColor('#666').text(
  'Este documento es una remisión no fiscal. Para efectos fiscales se emite el CFDI correspondiente.',
  40, 700, { width: 532, align: 'center' }
)

// Probamos también un witness mark inline (no anclado al pie) para ver el render
doc.moveDown(3)
doc.fillColor('#222').fontSize(10).text('Render explícito de drawWitnessMark a 12 px:', 40, 200)
drawWitnessMark(doc, { x: 40, y: 220, isotopeH: 12, fontSize: 8 })

doc.fillColor('#222').fontSize(10).text('Render explícito de drawWitnessMark a 20 px:', 40, 260)
drawWitnessMark(doc, { x: 40, y: 280, isotopeH: 20, fontSize: 10 })

addPraxionFooterPDF(doc)
doc.end()

out.on('finish', () => {
  console.log('PDF generado:', __dirname + '/_witness-test.pdf')
})
