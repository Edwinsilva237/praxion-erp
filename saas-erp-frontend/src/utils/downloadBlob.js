/**
 * Descarga un blob como archivo con el nombre indicado.
 * Funciona con responses de axios que vienen como blob (responseType: 'blob').
 *
 * @param {Blob}   data      — el blob a descargar
 * @param {string} filename  — nombre del archivo final
 */
export function downloadBlob(data, filename) {
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
