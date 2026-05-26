import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import Spinner from '@/components/ui/Spinner'

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

function rangeFromMonth(year, monthIdx) {
  // monthIdx 0-11. Devuelve { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } donde
  // `to` es el día 1 del mes siguiente (exclusivo).
  const from = new Date(year, monthIdx, 1)
  const to   = new Date(year, monthIdx + 1, 1)
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: fmt(from), to: fmt(to) }
}

export default function ReporteContable() {
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  // Por defecto el mes pasado (los contadores piden el cierre del mes anterior)
  const [month, setMonth] = useState(now.getMonth() === 0 ? 11 : now.getMonth() - 1)
  const [fiscalOnly, setFiscalOnly] = useState(true)
  const [error, setError] = useState(null)

  const { from, to } = rangeFromMonth(year, month)

  const download = useMutation({
    mutationFn: () => reportsApi.downloadAccounting({ from, to, fiscalOnly }),
    onSuccess: (response) => {
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `reporte-contable-${MONTHS_ES[month].toLowerCase()}-${year}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    },
    onError: async (e) => {
      // El error puede venir como blob — necesitamos leerlo como texto.
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
      setError(msg || 'No se pudo generar el reporte.')
    },
  })

  const years = []
  for (let y = now.getFullYear(); y >= now.getFullYear() - 4; y--) years.push(y)

  return (
    <div className="page-enter max-w-3xl mx-auto py-6 px-4 flex flex-col gap-6">
      <div>
        <p className="eyebrow">FINANZAS · REPORTES</p>
        <h1 className="text-xl font-semibold text-ink-primary mt-1">Reporte contable</h1>
        <p className="text-sm text-ink-muted mt-1">
          Descarga un archivo Excel con todo el movimiento fiscal del mes. Diseñado para que tu contador
          pueda conciliar contra el SAT, calcular IVA y revisar saldos.
        </p>
      </div>

      <section className="card flex flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Periodo</h2>
          <p className="text-xs text-ink-muted mt-1">Elige el mes que quieres exportar.</p>
        </div>

        <div className="grid grid-cols-2 gap-3 max-w-sm">
          <div>
            <label className="label">Mes</label>
            <select className="select" value={month} onChange={e => setMonth(Number(e.target.value))}>
              {MONTHS_ES.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Año</label>
            <select className="select" value={year} onChange={e => setYear(Number(e.target.value))}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        <div className="text-xs text-ink-muted">
          Periodo seleccionado: <strong className="text-ink-secondary font-mono">{from}</strong> al
          {' '}<strong className="text-ink-secondary font-mono">{to}</strong> (exclusivo)
        </div>

        <label className="flex items-start gap-3 cursor-pointer mt-1">
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
              Excluye borradores no timbrados, notas de crédito en draft y registros de gasto sin CFDI.
              {' '}Quítalo si quieres ver TODO lo del periodo para análisis interno.
            </p>
          </div>
        </label>

        {error && <div className="alert-error text-sm">{error}</div>}

        <div>
          <button
            onClick={() => { setError(null); download.mutate() }}
            disabled={download.isPending}
            className="btn-primary justify-center">
            {download.isPending ? (
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

      <section className="card">
        <h2 className="text-base font-semibold text-ink-primary mb-3">Qué incluye el archivo</h2>
        <ul className="space-y-2 text-sm text-ink-secondary">
          <SheetRow title="Resumen" desc="Totales del mes: subtotales, IVA trasladado, IVA acreditable, IVA neto a pagar/favor y conteos." />
          <SheetRow title="Ventas (Facturas)" desc="Cada CFDI emitido: UUID, RFC cliente, subtotal, IVA trasladado/retenido, total, método y forma de pago, status (vigente/cancelada)." />
          <SheetRow title="Notas de crédito" desc="Cada NC con su factura original ligada, motivo, montos, IVA." />
          <SheetRow title="Cobros recibidos" desc="Pagos del periodo: fecha, cliente, monto, forma de pago, banco y complemento de pago generado si aplica." />
          <SheetRow title="Compras (CFDI recibidos)" desc="Facturas de proveedores: UUID, RFC emisor, subtotal, IVA acreditable, total, vencimiento, saldo." />
          <SheetRow title="Pagos a proveedores" desc="Egresos del periodo: fecha, proveedor, método, monto, banco/cuenta de origen." />
        </ul>
        <p className="text-xs text-ink-muted mt-4">
          Todas las hojas tienen filtros automáticos activos para que tu contador pueda subdividir por cliente,
          proveedor, RFC o status sin tocar el archivo.
        </p>
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
