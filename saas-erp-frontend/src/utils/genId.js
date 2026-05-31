// Genera un identificador único con fallback robusto.
//
// `crypto.randomUUID()` solo existe en contexto seguro (https o localhost). En
// modo live reload la app corre sobre http://<ip-lan>, donde NO está disponible
// y lanzaría "crypto.randomUUID is not a function". Este helper cae a
// getRandomValues (sí disponible en contexto inseguro) y, en último caso, a un
// id basado en tiempo + aleatorio. Suficiente para keys de UI / ids en memoria.
export function genId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = [...b].map(x => x.toString(16).padStart(2, '0'))
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h.slice(10).join('')}`
    }
  } catch { /* cae al fallback de abajo */ }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
