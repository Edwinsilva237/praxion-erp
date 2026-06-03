import { Capacitor } from '@capacitor/core'

/**
 * Escáner de documentos nativo (Google ML Kit) — estilo CamScanner:
 * encuadre + detección de bordes + corrección de perspectiva + mejora de
 * legibilidad + multi-página, exportando a PDF.
 *
 * Reutilizable: evidencia de entrega, facturas de proveedor, recepciones, etc.
 *
 * Disponible SOLO en Android: Google ML Kit Document Scanner no tiene
 * implementación en iOS, así que en iOS (y en web de escritorio) `isSupported`
 * es false y el caller cae al input de cámara/archivo normal como respaldo
 * (que en iOS abre la cámara nativa con `capture`).
 *
 * El plugin se importa de forma diferida (dynamic import) para que NO entre al
 * bundle web (es nativo, solo Android).
 */
export function useDocumentScanner() {
  // ⚠️ Solo Android: el plugin no existe en iOS (reventaría con "not
  // implemented"). En iOS el caller usa el respaldo de cámara/archivo HTML.
  const isSupported = Capacitor.getPlatform() === 'android'

  // Devuelve { file, pageCount } con un PDF listo para subir, o { cancelled }
  // si el usuario cerró el escáner. Lanza si algo falla (el caller decide).
  async function scanToPdf({ pageLimit = 5, fileName = 'documento-escaneado.pdf' } = {}) {
    if (!isSupported) return { unsupported: true }

    const { DocumentScanner } = await import('@capacitor-mlkit/document-scanner')
    const { pdf } = await DocumentScanner.scanDocument({
      resultFormats: 'PDF',
      scannerMode: 'FULL',       // encuadre + auto-crop + perspectiva + filtros
      galleryImportAllowed: true, // permite importar de galería en el mismo flujo
      pageLimit,
    })

    if (!pdf?.uri) return { cancelled: true }

    // El plugin devuelve un URI nativo (file://...). Lo convertimos a una URL que
    // el webview puede leer y lo bajamos a un File para subirlo en el FormData.
    const src = Capacitor.convertFileSrc(pdf.uri)
    const blob = await fetch(src).then((r) => r.blob())
    const file = new File([blob], fileName, { type: 'application/pdf' })
    return { file, pageCount: pdf.pageCount ?? null }
  }

  return { isSupported, scanToPdf }
}
