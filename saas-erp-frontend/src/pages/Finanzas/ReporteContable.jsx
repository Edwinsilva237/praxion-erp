import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import Spinner from '@/components/ui/Spinner'

// ── Fechas locales (nunca toISOString sobre new Date(): corre el día en UTC) ──
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number)
  return fmt(new Date(y, m - 1, d + n))
}

// Presets → { del, al } INCLUSIVOS. El backend recibe to = al + 1 (exclusivo).
function presetRange(key) {
  const now = new Date()
  const today = fmt(now)
  switch (key) {
    case 'hoy':
      return { del: today, al: today }
    case 'semana_pasada': {
      // Lunes a domingo de la semana anterior
      const dow = now.getDay() || 7 // 1=lunes … 7=domingo
      const mondayThis = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow - 1))
      return { del: fmt(new Date(mondayThis.getFullYear(), mondayThis.getMonth(), mondayThis.getDate() - 7)),
               al:  fmt(new Date(mondayThis.getFullYear(), mondayThis.getMonth(), mondayThis.getDate() - 1)) }
    }
    case 'quincena_anterior': {
      if (now.getDate() <= 15) {
        // 16 → fin del mes pasado
        const lastPrev = new Date(now.getFullYear(), now.getMonth(), 0)
        return { del: fmt(new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 16)), al: fmt(lastPrev) }
      }
      // 1 → 15 de este mes
      return { del: fmt(new Date(now.getFullYear(), now.getMonth(), 1)),
               al:  fmt(new Date(now.getFullYear(), now.getMonth(), 15)) }
    }
    case 'mes_actual':
      return { del: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), al: today }
    case 'mes_anterior':
    default:
      return { del: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
               al:  fmt(new Date(now.getFullYear(), now.getMonth(), 0)) }
  }
}

const PRESETS = [
  { key: 'mes_anterior',      label: 'Mes anterior' },
  { key: 'mes_actual',        label: 'Mes actual' },
  { key: 'quincena_anterior', label: 'Quincena anterior' },
  { key: 'semana_pasada',     label: 'Semana pasada' },
  { key: 'hoy',               label: 'Hoy' },
]

async function readBlobError(e, fallback) {
  let msg = e.message
  const data = e.response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      msg = JSON.parse(text).error || text
    } catch (_) { /* mantener msg */ }
  } else if (data?.error) {
    msg = data.error
  }
  return msg || fallback
}

function triggerDownload(blobData, mime, filename) {
  const blob = new Blob([blobData], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function ReporteContable() {
  // Por defecto el mes pasado (los contadores piden el cierre del mes anterior)
  const initial = presetRange('mes_anterior')
  const [del, setDel] = useState(initial.del)
  const [al, setAl]   = useState(initial.al)
  const [activePreset, setActivePreset] = useState('mes_anterior')
  const [fiscalOnly, setFiscalOnly] = useState(true)
  const [error, setError] = useState(null)

  const rangeValid = del && al && del <= al
  const from = del
  const to   = rangeValid ? addDays(al, 1) : null // exclusivo para el backend

  const applyPreset = (key) => {
    const r = presetRange(key)
    setDel(r.del); setAl(r.al); setActivePreset(key); setError(null)
  }

  const onManualChange = (setter) => (e) => {
    setter(e.target.value)
    setActivePreset(null)
    setError(null)
  }

  const excel = useMutation({
    mutationFn: () => reportsApi.downloadAccounting({ from, to, fiscalOnly }),
    onSuccess: (response) => triggerDownload(
      response.data,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `reporte-contable-${del}-a-${al}.xlsx`),
    onError: async (e) => setError(await readBlobError(e, 'No se pudo generar el reporte.')),
  })

  const paquete = useMutation({
    mutationFn: () => reportsApi.downloadAccountingPackage({ from, to }),
    onSuccess: (response) => triggerDownload(
      response.data, 'application/zip', `paquete-contable-${del}-a-${al}.zip`),
    onError: async (e) => setError(await readBlobError(e, 'No se pudo generar el paquete.')),
  })

  const busy = excel.isPending || paquete.isPending

  return (
    <div className="page-enter max-w-3xl mx-auto py-6 px-4 flex flex-col gap-6">
      <div>
        <p className="eyebrow">FINANZAS · REPORTES</p>
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Reporte contable</h1>
        <p className="text-sm text-ink-muted mt-1">
          Todo el movimiento fiscal del periodo, listo para tu contador: el Excel para conciliar
          y el paquete ZIP con los XML organizados.
        </p>
      </div>

      {/* ── Periodo ─────────────────────────────────────────────────────── */}
      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Periodo</h2>
          <p className="text-xs text-ink-muted mt-1">
            Usa un atajo o elige las fechas a mano — diario, semanal, quincenal o mensual, como lo pida tu contador.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              className={activePreset === p.key
                ? 'px-3 py-1.5 rounded-full text-xs font-medium bg-brand-500 text-white'
                : 'px-3 py-1.5 rounded-full text-xs font-medium bg-surface-secondary text-ink-secondary hover:bg-surface-elevated'}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 max-w-sm">
          <div>
            <label className="label">Del</label>
            <input type="date" className="input" value={del} onChange={onManualChange(setDel)} />
          </div>
          <div>
            <label className="label">Al (inclusive)</label>
            <input type="date" className="input" value={al} onChange={onManualChange(setAl)} />
          </div>
        </div>

        {!rangeValid && (
          <div className="alert-error text-sm">La fecha inicial debe ser igual o anterior a la final.</div>
        )}
        {error && <div className="alert-error text-sm">{error}</div>}
      </section>

      {/* ── Paquete ZIP para el contador ────────────────────────────────── */}
      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Paquete para tu contador (ZIP)</h2>
          <p className="text-xs text-ink-muted mt-1">
            Una sola descarga con todos los XML fiscales del periodo, organizados en carpetas,
            más el Reporte Contable en Excel adentro. Listo para cargarse al sistema contable
            (CONTPAQi, Aspel u otro).
          </p>
        </div>
        <ul className="space-y-1.5 text-sm text-ink-secondary">
          <SheetRow title="Emitidos" desc="facturas, notas de crédito y complementos de pago timbrados." />
          <SheetRow title="Recibidos" desc="facturas de proveedores con UUID SAT y sus complementos de pago." />
          <SheetRow title="Cancelados" desc="documentos cancelados ante el SAT, en carpeta aparte." />
          <SheetRow title="FALTANTES.txt" desc="si algún documento del periodo no tiene XML recuperable, se lista en lugar de detener la descarga." />
        </ul>
        <div>
          <button
            onClick={() => { setError(null); paquete.mutate() }}
            disabled={busy || !rangeValid}
            className="btn-primary justify-center">
            {paquete.isPending ? (
              <><Spinner size="sm" /> Armando paquete…</>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
                Descargar ZIP del periodo
              </>
            )}
          </button>
        </div>
      </section>

      {/* ── Excel solo ──────────────────────────────────────────────────── */}
      <section className="card flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Solo el Excel</h2>
          <p className="text-xs text-ink-muted mt-1">
            El mismo Reporte Contable del ZIP, por separado: Resumen IVA, Ventas, Notas de crédito,
            Cobros, Compras y Pagos — con filtros automáticos en cada hoja.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 accent-brand-500 shrink-0"
            checked={fiscalOnly}
            onChange={e => setFiscalOnly(e.target.checked)}
          />
          <div>
            <span className="text-sm font-medium text-ink-primary">
              Solo documentos con valor fiscal (recomendado para contador)
            </span>
            <p className="text-xs text-ink-muted mt-0.5">
              Excluye borradores no timbrados y registros de gasto sin CFDI. Quítalo para
              análisis interno. El ZIP siempre incluye únicamente documentos fiscales.
            </p>
          </div>
        </label>

        <div>
          <button
            onClick={() => { setError(null); excel.mutate() }}
            disabled={busy || !rangeValid}
            className="btn-secondary justify-center">
            {excel.isPending ? (
              <><Spinner size="sm" /> Generando…</>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                Descargar Excel
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  )
}

function SheetRow({ title, desc }) {
  return (
    <li className="flex items-start gap-3">
      <span className="w-1.5 h-1.5 bg-brand-500 rounded-full mt-2 shrink-0"></span>
      <div>
        <strong className="text-ink-primary">{title}</strong>{' — '}
        <span>{desc}</span>
      </div>
    </li>
  )
}
