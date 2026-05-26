// ── Formateo compartido en todo el proyecto ────────────────────────────────

export const fmtMXN = (n, currency = 'MXN') => {
  if (n == null || n === '') return '—'
  const sym = currency === 'USD' ? 'US$' : '$'
  return `${sym}${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export const fmtNum = (n, decimals = 3) =>
  n == null ? '—' : Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

export const fmtDateInput = (d) => {
  if (!d) return ''
  const date = new Date(d)
  return date.toISOString().split('T')[0]
}
