import clsx from 'clsx'
import { IVA_TREATMENTS, treatmentKeyFromFields, fieldsFromTreatmentKey } from '@/utils/ivaTreatments'

/**
 * Menú "Tratamiento de IVA" — una sola lista clara que el capturista entiende,
 * mapeada por debajo a objeto_imp + tax_factor + tax_rate (códigos SAT).
 *
 * Props:
 *   - objetoImp, taxFactor, taxRate : valores actuales (los 3 campos SAT).
 *   - onChange : ({ objetoImp, taxFactor, taxRate }) => void
 *   - disabled, error
 */
export default function IvaTreatmentSelect({
  objetoImp, taxFactor, taxRate, onChange, disabled, error,
}) {
  const current = treatmentKeyFromFields({ objetoImp, taxFactor, taxRate })

  return (
    <select
      value={current}
      disabled={disabled}
      onChange={e => onChange(fieldsFromTreatmentKey(e.target.value))}
      className={clsx('select', error && 'input-error')}
    >
      {IVA_TREATMENTS.map(t => (
        <option key={t.key} value={t.key}>{t.label}</option>
      ))}
    </select>
  )
}
