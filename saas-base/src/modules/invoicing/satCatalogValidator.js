'use strict'

const { query } = require('../../db')

/**
 * Valida una factura contra los catálogos oficiales del SAT (mig 170) ANTES
 * de mandarla al PAC. Devuelve un array de errores estructurados — vacío si
 * todo OK. Cada error tiene { field, code, message }.
 *
 * Validaciones cubiertas:
 *   - regimen_fiscal del emisor: existe + aplica al tipo de persona del RFC.
 *   - regimen_fiscal del receptor: idem.
 *   - uso_cfdi: existe + aplica al tipo de persona del receptor + compatible
 *     con su régimen fiscal (los regimenes_csv del catálogo definen
 *     qué regímenes lo aceptan).
 *   - forma_pago: existe en el catálogo.
 *   - metodo_pago: existe (PUE / PPD).
 *   - tipo_comprobante: existe (I, E, T, N, P, R).
 *   - país del receptor: existe (si receptor extranjero).
 *   - clave de unidad y clave de producto SAT por línea: existen en
 *     c_ClaveUnidad / c_ClaveProdServ (atrapa ej. "ROL" en vez de "XRO"=Rollo).
 *
 * No reemplaza la validación de "datos faltantes" (stampService), que se
 * ejecuta primero. Esto se ejecuta DESPUÉS de confirmar que los datos
 * están presentes — verifica que los valores capturados sean válidos.
 */

function personaTypeFromRFC(rfc) {
  if (!rfc) return null
  const len = rfc.replace(/\s/g, '').length
  // RFC física = 13 chars, moral = 12.
  if (len === 13) return 'fisica'
  if (len === 12) return 'moral'
  return null
}

async function validateAgainstSatCatalogs(inv, lines = null) {
  const errors = []

  // 1) Régimen fiscal del emisor.
  if (inv.emisor_regime) {
    const { rows } = await query(
      `SELECT fisica, moral FROM sat_regimen_fiscal WHERE code = $1 AND is_active = true`,
      [String(inv.emisor_regime).trim()]
    )
    if (!rows[0]) {
      errors.push({
        field: 'emisor_regime',
        code:  'SAT_REGIMEN_NOT_FOUND',
        message: `Régimen fiscal del emisor "${inv.emisor_regime}" no existe en c_RegimenFiscal del SAT.`,
      })
    } else {
      const emisorPersona = personaTypeFromRFC(inv.emisor_rfc)
      if (emisorPersona === 'fisica' && !rows[0].fisica) {
        errors.push({
          field: 'emisor_regime',
          code:  'SAT_REGIMEN_PERSONA_MISMATCH',
          message: `Régimen ${inv.emisor_regime} no aplica para persona física (RFC del emisor).`,
        })
      }
      if (emisorPersona === 'moral' && !rows[0].moral) {
        errors.push({
          field: 'emisor_regime',
          code:  'SAT_REGIMEN_PERSONA_MISMATCH',
          message: `Régimen ${inv.emisor_regime} no aplica para persona moral (RFC del emisor).`,
        })
      }
    }
  }

  // 2) Régimen fiscal del receptor.
  const receptorRegimen = inv.receptor_tax_regime || inv.partner_tax_regime
  let receptorRegimenRow = null
  if (receptorRegimen) {
    const { rows } = await query(
      `SELECT fisica, moral FROM sat_regimen_fiscal WHERE code = $1 AND is_active = true`,
      [String(receptorRegimen).trim()]
    )
    receptorRegimenRow = rows[0]
    if (!receptorRegimenRow) {
      errors.push({
        field: 'receptor_tax_regime',
        code:  'SAT_REGIMEN_NOT_FOUND',
        message: `Régimen fiscal del receptor "${receptorRegimen}" no existe en c_RegimenFiscal del SAT.`,
      })
    } else {
      const receptorPersona = personaTypeFromRFC(inv.partner_rfc)
      if (receptorPersona === 'fisica' && !receptorRegimenRow.fisica) {
        errors.push({
          field: 'receptor_tax_regime',
          code:  'SAT_REGIMEN_PERSONA_MISMATCH',
          message: `Régimen ${receptorRegimen} no aplica para persona física (RFC del receptor).`,
        })
      }
      if (receptorPersona === 'moral' && !receptorRegimenRow.moral) {
        errors.push({
          field: 'receptor_tax_regime',
          code:  'SAT_REGIMEN_PERSONA_MISMATCH',
          message: `Régimen ${receptorRegimen} no aplica para persona moral (RFC del receptor).`,
        })
      }
    }
  }

  // 3) Uso CFDI.
  if (inv.cfdi_use) {
    const { rows } = await query(
      `SELECT fisica, moral, regimenes_csv FROM sat_uso_cfdi
        WHERE code = $1 AND is_active = true`,
      [String(inv.cfdi_use).trim()]
    )
    if (!rows[0]) {
      errors.push({
        field: 'cfdi_use',
        code:  'SAT_USO_CFDI_NOT_FOUND',
        message: `Uso CFDI "${inv.cfdi_use}" no existe en c_UsoCFDI del SAT.`,
      })
    } else {
      const receptorPersona = personaTypeFromRFC(inv.partner_rfc)
      if (receptorPersona === 'fisica' && !rows[0].fisica) {
        errors.push({
          field: 'cfdi_use',
          code:  'SAT_USO_CFDI_PERSONA_MISMATCH',
          message: `Uso CFDI ${inv.cfdi_use} no aplica para persona física.`,
        })
      }
      if (receptorPersona === 'moral' && !rows[0].moral) {
        errors.push({
          field: 'cfdi_use',
          code:  'SAT_USO_CFDI_PERSONA_MISMATCH',
          message: `Uso CFDI ${inv.cfdi_use} no aplica para persona moral.`,
        })
      }
      // Verificar compatibilidad con régimen del receptor (si lo conocemos)
      if (receptorRegimen && rows[0].regimenes_csv) {
        const allowed = rows[0].regimenes_csv.split(',').map(s => s.trim())
        if (!allowed.includes(String(receptorRegimen).trim())) {
          errors.push({
            field: 'cfdi_use',
            code:  'SAT_USO_CFDI_REGIMEN_INCOMPATIBLE',
            message: `Uso CFDI ${inv.cfdi_use} no es compatible con régimen ${receptorRegimen}. Permite: ${rows[0].regimenes_csv}.`,
          })
        }
      }
    }
  }

  // 4) Forma de pago.
  if (inv.payment_form) {
    const { rows } = await query(
      `SELECT 1 FROM sat_forma_pago WHERE code = $1 AND is_active = true`,
      [String(inv.payment_form).trim()]
    )
    if (!rows[0]) {
      errors.push({
        field: 'payment_form',
        code:  'SAT_FORMA_PAGO_NOT_FOUND',
        message: `Forma de pago "${inv.payment_form}" no existe en c_FormaPago del SAT.`,
      })
    }
  }

  // 5) Método de pago (PUE / PPD).
  if (inv.payment_method) {
    const { rows } = await query(
      `SELECT 1 FROM sat_metodo_pago WHERE code = $1 AND is_active = true`,
      [String(inv.payment_method).trim()]
    )
    if (!rows[0]) {
      errors.push({
        field: 'payment_method',
        code:  'SAT_METODO_PAGO_NOT_FOUND',
        message: `Método de pago "${inv.payment_method}" no existe en c_MetodoPago del SAT (válidos: PUE, PPD).`,
      })
    }
  }

  // 6) Tipo de comprobante (típicamente 'I' para Ingreso).
  if (inv.cfdi_type) {
    const { rows } = await query(
      `SELECT 1 FROM sat_tipo_comprobante WHERE code = $1 AND is_active = true`,
      [String(inv.cfdi_type).trim()]
    )
    if (!rows[0]) {
      errors.push({
        field: 'cfdi_type',
        code:  'SAT_TIPO_COMPROBANTE_NOT_FOUND',
        message: `Tipo de comprobante "${inv.cfdi_type}" no existe en c_TipoDeComprobante del SAT.`,
      })
    }
  }

  // 7) Tratamiento fiscal por línea (objeto de impuesto + tipo de factor + tasa).
  //    Si no se pasan las líneas, se cargan de la factura (cuando hay id).
  let invLines = lines
  if (invLines == null && inv.id) {
    const { rows } = await query(
      `SELECT line_number, objeto_imp, tax_factor, tax_rate,
              sat_unit_code, sat_product_code
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number`,
      [inv.id]
    )
    invLines = rows
  }
  if (Array.isArray(invLines) && invLines.length) {
    // Cachear catálogos chicos una sola vez.
    const { rows: objetos } = await query(`SELECT code FROM sat_objeto_imp WHERE is_active = true`)
    const { rows: factores } = await query(`SELECT code FROM sat_tipo_factor WHERE is_active = true`)
    const validObjetos = new Set(objetos.map(r => r.code))
    const validFactores = new Set(factores.map(r => r.code))
    const VALID_IVA_RATES = new Set([0, 8, 16]) // tasa cero, frontera, general

    // Validar claves de UNIDAD y PRODUCTO del SAT por línea (1 query por catálogo).
    // Sin esto, una clave inválida (ej. "ROL" en vez de "XRO"=Rollo) llegaba hasta
    // el PAC y gastaba/rebotaba el timbre con un error críptico.
    const unitCodes = [...new Set(invLines.map(l => String(l.sat_unit_code || '').trim()).filter(Boolean))]
    const prodCodes = [...new Set(invLines.map(l => String(l.sat_product_code || '').trim()).filter(Boolean))]
    let validUnits = new Set()
    let validProds = new Set()
    if (unitCodes.length) {
      const { rows } = await query(`SELECT code FROM sat_unit_codes WHERE code = ANY($1)`, [unitCodes])
      validUnits = new Set(rows.map(r => r.code))
    }
    if (prodCodes.length) {
      const { rows } = await query(`SELECT code FROM sat_product_codes WHERE code = ANY($1)`, [prodCodes])
      validProds = new Set(rows.map(r => r.code))
    }

    for (const line of invLines) {
      const ln = line.line_number != null ? `línea ${line.line_number}` : 'una línea'
      const objeto = String(line.objeto_imp || '02')
      const factor = line.tax_factor || 'Tasa'

      const unitCode = String(line.sat_unit_code || '').trim()
      if (unitCode && !validUnits.has(unitCode)) {
        errors.push({
          field: 'sat_unit_code',
          code:  'SAT_UNIT_NOT_FOUND',
          message: `La clave de unidad SAT "${unitCode}" (${ln}) no existe en c_ClaveUnidad. Corrige la unidad SAT del producto o su presentación (ej. "XRO"=Rollo, "H87"=Pieza, "KGM"=Kilogramo, "MTR"=Metro).`,
        })
      }
      const prodCode = String(line.sat_product_code || '').trim()
      if (prodCode && !validProds.has(prodCode)) {
        errors.push({
          field: 'sat_product_code',
          code:  'SAT_PRODUCT_NOT_FOUND',
          message: `La clave de producto SAT "${prodCode}" (${ln}) no existe en c_ClaveProdServ. Corrige la clave SAT del producto.`,
        })
      }

      if (!validObjetos.has(objeto)) {
        errors.push({
          field: 'objeto_imp',
          code:  'SAT_OBJETO_IMP_NOT_FOUND',
          message: `Objeto de impuesto "${objeto}" (${ln}) no existe en c_ObjetoImp del SAT.`,
        })
      }
      // El factor solo aplica cuando la línea sí es objeto del impuesto y se desglosa.
      if (objeto !== '01' && objeto !== '03') {
        if (!validFactores.has(factor)) {
          errors.push({
            field: 'tax_factor',
            code:  'SAT_TIPO_FACTOR_NOT_FOUND',
            message: `Tipo de factor "${factor}" (${ln}) no existe en c_TipoFactor del SAT.`,
          })
        }
        if (factor === 'Tasa') {
          const rate = parseFloat(line.tax_rate)
          if (!VALID_IVA_RATES.has(rate)) {
            errors.push({
              field: 'tax_rate',
              code:  'SAT_TASA_INVALIDA',
              message: `Tasa de IVA ${line.tax_rate}% (${ln}) no es válida. Usa 16, 8 (frontera), 0 (tasa cero) o marca la línea como Exento / No objeto.`,
            })
          }
        }
      }
    }
  }

  return errors
}

module.exports = { validateAgainstSatCatalogs }
