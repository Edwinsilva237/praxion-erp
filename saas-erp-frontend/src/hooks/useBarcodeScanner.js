import { useState, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'

// En Android el escaneo usa un módulo de Google Play Services que se descarga
// bajo demanda. Hay que ESPERAR a que termine de instalarse antes de escanear,
// si no, scan() falla. (En iOS no aplica.)
async function ensureGoogleModule(BarcodeScanner) {
  if (Capacitor.getPlatform() !== 'android') return
  let available = false
  try {
    const res = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
    available = !!res.available
  } catch {
    return // método no disponible en esta plataforma → seguimos
  }
  if (available) return

  await new Promise((resolve, reject) => {
    let handle
    BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', (e) => {
      // Estados del plugin: 5 = COMPLETED, 6 = FAILED.
      if (e.state === 5) { handle?.remove?.(); resolve() }
      else if (e.state === 6) { handle?.remove?.(); reject(new Error('No se pudo instalar el módulo de escaneo de Google.')) }
    }).then(l => { handle = l })
    BarcodeScanner.installGoogleBarcodeScannerModule().catch(reject)
  })
}

/**
 * Escaneo de código de barras / QR.
 *  - App nativa (Capacitor): cámara con MLKit.
 *  - Web: captura manual (window.prompt) para probar el flujo sin dispositivo.
 *
 * `scan()` devuelve el código (string) o null si se cancela. Lanza Error con
 * mensaje claro si algo falla (sin soporte, sin permiso, etc.) para que el
 * llamador lo muestre.
 */
export function useBarcodeScanner() {
  const [isScanning, setIsScanning] = useState(false)
  const isNative = Capacitor.isNativePlatform()

  const scan = useCallback(async () => {
    if (!isNative) {
      const v = window.prompt('Escanear / capturar código de barras:')
      return v ? v.trim() : null
    }

    setIsScanning(true)
    try {
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning')

      const { supported } = await BarcodeScanner.isSupported()
      if (!supported) {
        throw new Error('Este teléfono no soporta el escáner (requiere Servicios de Google Play).')
      }

      // El permiso de cámara es "mejor esfuerzo": el escáner de Google (scan())
      // funciona aunque no se conceda. Pedimos, pero no bloqueamos si falla.
      try { await BarcodeScanner.requestPermissions() } catch { /* ignorar */ }

      await ensureGoogleModule(BarcodeScanner)

      const { barcodes } = await BarcodeScanner.scan()
      return barcodes?.[0]?.rawValue || null
    } finally {
      setIsScanning(false)
    }
  }, [isNative])

  return { scan, isScanning, isNative }
}
