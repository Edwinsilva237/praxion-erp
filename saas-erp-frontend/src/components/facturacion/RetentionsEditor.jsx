// Editor de retenciones (ISR/IVA) reutilizable entre factura ocasional, directa
// y desde remisión. La venta de bienes normalmente no lleva retención; aplica a
// servicios (honorarios, fletes, arrendamiento).

// Presets de retención (estilo Alegra). El último valor de tasa se puede editar.
export const RETENTION_PRESETS = [
  { key: 'isr10',          label: 'ISR (10%)',                         taxType: 'ISR', rate: 10 },
  { key: 'iva_ret',        label: 'IVA retenido (10.67%)',             taxType: 'IVA', rate: 10.6667 },
  { key: 'autotransporte', label: 'Retención autotransporte (IVA 4%)', taxType: 'IVA', rate: 4 },
  { key: 'isr_otra',       label: 'Otra retención de ISR',             taxType: 'ISR', rate: 0 },
  { key: 'iva_otra',       label: 'Otra retención de IVA',             taxType: 'IVA', rate: 0 },
]

export const EMPTY_RETENTION = { presetKey: 'isr10', taxType: 'ISR', rate: 10 }

export default function RetentionsEditor({ retentions, setRetentions }) {
  function addRetention() { setRetentions(rs => [...rs, { ...EMPTY_RETENTION }]) }
  function removeRetention(i) { setRetentions(rs => rs.filter((_, idx) => idx !== i)) }
  function patchRetention(i, patch) {
    setRetentions(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function pickPreset(i, key) {
    const p = RETENTION_PRESETS.find(x => x.key === key) || RETENTION_PRESETS[0]
    patchRetention(i, { presetKey: p.key, taxType: p.taxType, rate: p.rate })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="label mb-0">
          Retenciones <span className="text-ink-muted font-normal">(opcional — servicios, fletes, honorarios)</span>
        </label>
        <button type="button" onClick={addRetention} className="btn-ghost btn-sm text-teal-300">
          + Agregar retención
        </button>
      </div>

      {retentions.length === 0 ? (
        <p className="text-[11px] text-ink-muted italic">
          Sin retenciones. La venta de productos normalmente no lleva.
        </p>
      ) : (
        retentions.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <select className="select flex-1" value={r.presetKey}
              onChange={e => pickPreset(i, e.target.value)}>
              {RETENTION_PRESETS.map(p => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
            <div className="relative w-28 shrink-0">
              <input className="input pr-6 text-right" type="number" min="0" max="100" step="0.0001"
                value={r.rate}
                onChange={e => patchRetention(i, { rate: e.target.value })} />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">%</span>
            </div>
            <button type="button" onClick={() => removeRetention(i)}
              className="btn-ghost btn-icon text-ink-muted hover:text-status-danger shrink-0" title="Quitar">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        ))
      )}
    </div>
  )
}
