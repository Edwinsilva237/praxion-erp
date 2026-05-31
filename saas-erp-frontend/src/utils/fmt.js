// ── Formateo compartido en todo el proyecto ────────────────────────────────

export const fmtMXN = (n, currency = 'MXN') => {
  if (n == null || n === '') return '—'
  const sym = currency === 'USD' ? 'US$' : '$'
  return `${sym}${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

// Para columnas DATE (sin hora): fecha de entrega/programada, emisión,
// vencimiento, etc. El backend las serializa como "2026-06-01T00:00:00.000Z"
// (medianoche UTC). Usar new Date() + toLocaleDateString las desfasa −1 día en
// zonas detrás de UTC (México UTC−6). Aquí tomamos SOLO el año-mes-día y
// formateamos en UTC, así la fecha de calendario nunca se mueve. NO usar para
// timestamps con hora real (created_at, confirmed_at) — esos sí quieren hora local.
export const fmtDateOnly = (d) => {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number)
  if (!y || !m || !day) return '—'
  return new Date(Date.UTC(y, m - 1, day))
    .toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export const fmtNum = (n, decimals = 3) =>
  n == null ? '—' : Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

export const fmtDateInput = (d) => {
  if (!d) return ''
  const date = new Date(d)
  return date.toISOString().split('T')[0]
}
