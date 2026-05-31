import { Capacitor } from '@capacitor/core'

/**
 * Descarga (o comparte) un blob como archivo.
 *
 * - **Web:** dispara una descarga normal con `<a download>`.
 * - **Nativo (Capacitor):** el webview NO soporta descargas del navegador, así
 *   que guardamos el archivo en disco y abrimos el menú nativo de compartir /
 *   guardar (el usuario puede "Guardar en Archivos", abrirlo en un visor de PDF,
 *   mandarlo por WhatsApp, etc.).
 *
 * Funciona con responses de axios que vienen como blob (responseType: 'blob').
 *
 * @param {Blob}   data      — el blob a descargar
 * @param {string} filename  — nombre del archivo final (con extensión)
 * @returns {Promise<void>}
 */
export async function downloadBlob(data, filename) {
  if (Capacitor.isNativePlatform()) {
    await saveAndShareNative(data, filename)
    return
  }

  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)
}

/**
 * Imprime un blob (PDF).
 *
 * - **Web:** lo abre en una pestaña nueva — el usuario imprime desde el visor.
 * - **Nativo (Capacitor):** abre el diálogo de impresión de Android con el PDF
 *   (descubre las impresoras WiFi de la red vía Mopria / plugin del fabricante,
 *   o "Guardar como PDF").
 *
 * @param {Blob}   data  — el blob PDF a imprimir
 * @param {string} name  — nombre del trabajo de impresión
 * @returns {Promise<void>}
 */
export async function printBlob(data, name = 'Documento') {
  if (Capacitor.isNativePlatform()) {
    const { Printer } = await import('@capgo/capacitor-printer')
    const base64 = await blobToBase64(data)
    await Printer.printBase64({ data: base64, mimeType: 'application/pdf', name: safeName(name) })
    return
  }

  const url = URL.createObjectURL(data)
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ── Nativo: guardar en disco + compartir ──────────────────────────────────────
async function saveAndShareNative(blob, filename) {
  // Imports diferidos: solo cargan en nativo, no entran al bundle web.
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')

  const base64 = await blobToBase64(blob)
  const written = await Filesystem.writeFile({
    path: safeName(filename),
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  })

  try {
    await Share.share({
      title: filename,
      url: written.uri,
      dialogTitle: 'Guardar o compartir',
    })
  } catch {
    // El usuario canceló el menú de compartir — el archivo ya quedó guardado,
    // no es un error real.
  }
}

function safeName(name) {
  return String(name).replace(/[^\w.\- ]+/g, '_')
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result
      // result = "data:<mime>;base64,XXXX" — Filesystem espera solo el base64.
      resolve(typeof result === 'string' ? result.split(',')[1] || '' : '')
    }
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'))
    reader.readAsDataURL(blob)
  })
}
