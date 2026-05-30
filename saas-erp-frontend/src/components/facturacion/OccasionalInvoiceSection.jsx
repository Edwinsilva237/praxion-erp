import SatProductCodeCombobox from '@/components/productos/SatProductCodeCombobox'
import SatUnitCombobox from '@/components/productos/SatUnitCombobox'
import SatCatalogSelect from '@/components/fiscal/SatCatalogSelect'
import IvaTreatmentSelect from '@/components/fiscal/IvaTreatmentSelect'
import RetentionsEditor from '@/components/facturacion/RetentionsEditor'
import { fmtMXN } from '@/utils/fmt'

export const EMPTY_OC_LINE = {
  description: '', satProductCode: '', satUnitCode: 'H87', unit: 'pieza',
  quantity: 1, unitPrice: '', discountPct: 0,
  objetoImp: '02', taxFactor: 'Tasa', taxRate: 16,
}

// Persona (física/moral) inferida de la longitud del RFC, para filtrar régimen/uso.
function personaFromRfc(rfc) {
  const len = (rfc || '').replace(/\s/g, '').length
  if (len === 13) return 'fisica'
  if (len === 12) return 'moral'
  return undefined
}

/**
 * Cuerpo del modo "Factura ocasional": captura del receptor (sin darlo de alta)
 * y de las líneas a mano. El bloque de datos fiscales del CFDI (uso/método/forma)
 * y el botón de crear viven en el modal contenedor.
 */
export default function OccasionalInvoiceSection({
  publico, setPublico, receptor, setReceptor, lines, setLines,
  retentions, setRetentions,
}) {
  const persona = publico ? undefined : personaFromRfc(receptor.rfc)

  function patchReceptor(patch) { setReceptor(r => ({ ...r, ...patch })) }
  function patchLine(i, patch) {
    setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() { setLines(ls => [...ls, { ...EMPTY_OC_LINE }]) }
  function removeLine(i) { setLines(ls => ls.filter((_, idx) => idx !== i)) }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Receptor ─────────────────────────────────────────────────── */}
      <div className="border border-line-subtle rounded-xl p-4 bg-surface-primary flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Cliente (sin darlo de alta)</p>
          <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-teal-600 rounded"
              checked={publico} onChange={e => setPublico(e.target.checked)} />
            Público en general
          </label>
        </div>

        {publico ? (
          <p className="text-xs text-ink-muted italic">
            Se usará el RFC genérico <span className="font-mono">XAXX010101000</span> (ventas de mostrador).
            El domicilio fiscal se toma del de tu empresa.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">RFC <span className="text-status-danger">*</span></label>
                <input className="input font-mono uppercase" value={receptor.rfc}
                  onChange={e => patchReceptor({ rfc: e.target.value.toUpperCase() })}
                  placeholder="XAXX010101000" maxLength={13} />
              </div>
              <div>
                <label className="label">Razón social <span className="text-status-danger">*</span></label>
                <input className="input" value={receptor.taxName}
                  onChange={e => patchReceptor({ taxName: e.target.value })}
                  placeholder="Como está en la Constancia de Situación Fiscal" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Régimen fiscal <span className="text-status-danger">*</span></label>
                <SatCatalogSelect endpoint="regimen-fiscal"
                  params={persona ? { persona } : {}}
                  value={receptor.taxRegimeCode}
                  onChange={code => patchReceptor({ taxRegimeCode: code })}
                  placeholder="Buscar régimen…" />
              </div>
              <div>
                <label className="label">Código postal <span className="text-status-danger">*</span></label>
                <input className="input font-mono" value={receptor.zipCode}
                  onChange={e => patchReceptor({ zipCode: e.target.value.replace(/\D/g, '') })}
                  placeholder="60014" maxLength={5} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Líneas / conceptos ───────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="label mb-0">Conceptos <span className="text-status-danger">*</span></label>
          <button type="button" onClick={addLine} className="btn-ghost btn-sm text-teal-300">
            + Agregar concepto
          </button>
        </div>

        {lines.map((l, i) => {
          const qty = parseFloat(l.quantity) || 0
          const price = parseFloat(l.unitPrice) || 0
          const disc = parseFloat(l.discountPct) || 0
          const lineSub = qty * price * (1 - disc / 100)
          return (
            <div key={i} className="border border-line-subtle rounded-xl p-3 bg-surface-primary flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <input className="input flex-1" value={l.description}
                  onChange={e => patchLine(i, { description: e.target.value })}
                  placeholder="Descripción del producto o servicio" />
                {lines.length > 1 && (
                  <button type="button" onClick={() => removeLine(i)}
                    className="btn-ghost btn-icon text-ink-muted hover:text-status-danger shrink-0" title="Quitar">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="label text-[10px]">Clave producto SAT</label>
                  <SatProductCodeCombobox value={l.satProductCode}
                    onChange={v => patchLine(i, { satProductCode: v })} />
                </div>
                <div>
                  <label className="label text-[10px]">Clave unidad SAT</label>
                  <SatUnitCombobox value={l.satUnitCode}
                    onChange={v => patchLine(i, { satUnitCode: v })} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                <div>
                  <label className="label text-[10px]">Cantidad</label>
                  <input className="input" type="number" min="0" step="0.0001" value={l.quantity}
                    onChange={e => patchLine(i, { quantity: e.target.value })} />
                </div>
                <div>
                  <label className="label text-[10px]">Precio unitario</label>
                  <input className="input" type="number" min="0" step="0.0001" value={l.unitPrice}
                    onChange={e => patchLine(i, { unitPrice: e.target.value })} placeholder="0.00" />
                </div>
                <div>
                  <label className="label text-[10px]">Desc. %</label>
                  <input className="input" type="number" min="0" max="100" step="0.01" value={l.discountPct}
                    onChange={e => patchLine(i, { discountPct: e.target.value })} />
                </div>
                <div>
                  <label className="label text-[10px]">Tratamiento IVA</label>
                  <IvaTreatmentSelect
                    objetoImp={l.objetoImp} taxFactor={l.taxFactor} taxRate={l.taxRate}
                    onChange={({ objetoImp, taxFactor, taxRate }) =>
                      patchLine(i, { objetoImp, taxFactor, taxRate })} />
                </div>
              </div>

              <div className="text-right text-[11px] text-ink-muted">
                Importe línea: <span className="font-mono text-ink-secondary">{fmtMXN(lineSub, 'MXN')}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Retenciones (opcional) ───────────────────────────────────── */}
      <RetentionsEditor retentions={retentions} setRetentions={setRetentions} />
    </div>
  )
}
