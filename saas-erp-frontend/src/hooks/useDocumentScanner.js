import { Capacitor } from '@capacitor/core'

/**
 * Escáner de documentos nativo — estilo CamScanner: encuadre + detección de
 * bordes + corrección de perspectiva + multipágina, exportando a PDF.
 *
 * Reutilizable: evidencia de entrega, facturas de proveedor, recepciones, etc.
 *
 * Implementación por plataforma:
 *   - Android → Google ML Kit Document Scanner (@capacitor-mlkit/document-scanner)
 *   - iOS     → VisionKit (plugin local `visionkit-scanner`), el mismo escáner
 *               de Notas/Archivos de Apple.
 *   - Web de escritorio → no soportado: `isSupported` es false y el caller cae
 *               al input de cámara/archivo HTML como respaldo.
 *
 * Ambos plugins se importan de forma diferida (dynamic import) para que NO
 * entren al bundle web (son nativos).
 */
export function useDocumentScanner() {
  const platform = Capacitor.getPlatform()
  const isSupported = platform === 'android' || platform === 'ios'

  // Devuelve { file, pageCount } con un PDF listo para subir, { cancelled } si
  // el usuario cerró el escáner, o { unsupported } si la plataforma no lo
  // soporta. Lanza si algo falla (el caller decide).
  async function scanToPdf({ pageLimit = 5, fileName = 'documento-escaneado.pdf' } = {}) {
    if (!isSupported) return { unsupported: true }

    // URI nativo (file://...) del PDF generado, según plataforma.
    let pdfUri = null
    let pageCount = null

    if (platform === 'android') {
      const { DocumentScanner } = await import('@capacitor-mlkit/document-scanner')
      const { pdf } = await DocumentScanner.scanDocument({
        resultFormats: 'PDF',
        scannerMode: 'FULL',        // encuadre + auto-crop + perspectiva + filtros
        galleryImportAllowed: true, // permite importar de galería en el mismo flujo
        pageLimit,
      })
      if (!pdf?.uri) return { cancelled: true }
      pdfUri = pdf.uri
      pageCount = pdf.pageCount ?? null
    } else {
      // iOS → VisionKit (plugin local). Mismo contrato de salida que Android.
      const { VisionkitScanner } = await import('visionkit-scanner')
      const res = await VisionkitScanner.scanToPdf({ pageLimit, fileName })
      if (res?.unsupported) return { unsupported: true }
      if (res?.cancelled || !res?.uri) return { cancelled: true }
      pdfUri = res.uri
      pageCount = res.pageCount ?? null
    }

    // Convertimos el URI nativo a una URL que el webview puede leer y lo bajamos
    // a un File para subirlo en el FormData.
    const src = Capacitor.convertFileSrc(pdfUri)
    const blob = await fetch(src).then((r) => r.blob())
    const file = new File([blob], fileName, { type: 'application/pdf' })
    return { file, pageCount }
  }

  return { isSupported, scanToPdf }
}
