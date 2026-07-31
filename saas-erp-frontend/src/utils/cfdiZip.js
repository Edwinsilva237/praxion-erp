import { unzipSync } from 'fflate'

// Muchos proveedores/portales entregan la factura como un .zip con el par
// XML + PDF adentro. Este helper lo abre EN EL NAVEGADOR y devuelve qué archivo
// parsear y qué archivos guardar como respaldo, para alimentar los flujos de
// documento único (Registrar gasto / Nueva factura de proveedor) sin tocar el
// backend. Un ZIP con varias facturas se rechaza: para eso está
// Gastos → Importar XML en lote (que ya acepta ZIP con varias).

const MAX_ENTRIES      = 50
const MAX_UNCOMPRESSED = 60 * 1024 * 1024 // 60MB descomprimidos (protección zip-bomb)

export function isZipFile(file) {
  return /\.zip$/i.test(file?.name || '')
}

/**
 * @param {File} file — el .zip que eligió el usuario
 * @returns {{ parseTarget: File, backups: File[] }}
 *   parseTarget — el archivo a mandar al parser (el XML; PDF solo si no hay XML)
 *   backups     — todos los XML/PDF útiles del ZIP (incluye parseTarget), para
 *                 adjuntarlos como respaldo del documento creado
 * @throws {Error} con mensaje listo para mostrar al usuario
 */
export async function expandCfdiZip(file) {
  let entries
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  } catch {
    throw new Error('No se pudo abrir el ZIP. ¿El archivo está dañado o protegido con contraseña?')
  }

  const names = Object.keys(entries).filter(n =>
    !n.endsWith('/') && !n.startsWith('__MACOSX') && !/(^|\/)\./.test(n))
  if (names.length > MAX_ENTRIES) {
    throw new Error(`El ZIP contiene demasiados archivos (${names.length}; máximo ${MAX_ENTRIES}).`)
  }
  const totalBytes = names.reduce((s, n) => s + entries[n].length, 0)
  if (totalBytes > MAX_UNCOMPRESSED) {
    throw new Error('El contenido del ZIP es demasiado grande (máximo 60MB descomprimidos).')
  }

  const toFile = (name, type) => new File([entries[name]], name.split('/').pop(), { type })
  const xmls = names.filter(n => /\.xml$/i.test(n)).map(n => toFile(n, 'text/xml'))
  const pdfs = names.filter(n => /\.pdf$/i.test(n)).map(n => toFile(n, 'application/pdf'))

  if (xmls.length === 0 && pdfs.length === 0) {
    throw new Error('El ZIP no contiene ningún XML ni PDF.')
  }
  if (xmls.length > 1) {
    throw new Error(`El ZIP contiene ${xmls.length} archivos XML. Aquí se carga una sola factura — para varias usa Gastos → Importar XML (en lote), que acepta ZIP con varias.`)
  }
  if (xmls.length === 0 && pdfs.length > 1) {
    throw new Error(`El ZIP contiene ${pdfs.length} PDF y ningún XML. Sube un ZIP con una sola factura.`)
  }

  const parseTarget = xmls[0] || pdfs[0]
  return { parseTarget, backups: [...xmls, ...pdfs] }
}
