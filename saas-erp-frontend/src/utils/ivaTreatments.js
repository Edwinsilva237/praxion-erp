// Mapeo entre el menú amigable "Tratamiento de IVA" y los códigos SAT que
// viajan en el CFDI (objeto de impuesto + tipo de factor + tasa).
//
// El capturista elige en lenguaje normal; el sistema arma objeto_imp +
// tax_factor + tax_rate por debajo. El backend (lineTax.js) interpreta esa
// misma combinación al timbrar.

export const IVA_TREATMENTS = [
  { key: '16',       label: 'IVA 16% (general)',              objetoImp: '02', taxFactor: 'Tasa',   taxRate: 16 },
  { key: '8',        label: 'IVA 8% (región fronteriza)',     objetoImp: '02', taxFactor: 'Tasa',   taxRate: 8 },
  { key: '0',        label: 'IVA 0% (tasa cero — agro/alimentos)', objetoImp: '02', taxFactor: 'Tasa', taxRate: 0 },
  { key: 'exento',   label: 'Exento',                         objetoImp: '02', taxFactor: 'Exento', taxRate: 0 },
  { key: 'noobjeto', label: 'No objeto de impuesto',          objetoImp: '01', taxFactor: 'Tasa',   taxRate: 0 },
]

const DEFAULT_KEY = '16'

/** Deriva la opción del menú a partir de objeto_imp + factor + tasa. */
export function treatmentKeyFromFields({ objetoImp, taxFactor, taxRate } = {}) {
  const obj  = String(objetoImp ?? '02')
  const fac  = taxFactor || 'Tasa'
  const rate = taxRate == null || taxRate === '' ? 16 : Number(taxRate)

  if (obj === '01' || obj === '03') return 'noobjeto'
  if (fac === 'Exento') return 'exento'
  if (rate === 8) return '8'
  if (rate === 0) return '0'
  return '16'
}

/** Devuelve los campos SAT { objetoImp, taxFactor, taxRate } de una opción. */
export function fieldsFromTreatmentKey(key) {
  const t = IVA_TREATMENTS.find(o => o.key === key)
    || IVA_TREATMENTS.find(o => o.key === DEFAULT_KEY)
  return { objetoImp: t.objetoImp, taxFactor: t.taxFactor, taxRate: t.taxRate }
}
