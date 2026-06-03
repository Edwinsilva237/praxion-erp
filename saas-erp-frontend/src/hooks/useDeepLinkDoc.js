import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

/**
 * Deep-link de documentos: permite abrir el detalle por URL (`/<base>/:id`) para
 * que el folio en la tabla soporte "abrir en nueva pestaña" del navegador.
 *
 * - Si la ruta trae `:id` (entraste por la URL / nueva pestaña), el panel abre
 *   automáticamente para ese documento.
 * - `setSelectedId` se sigue usando igual para abrir el panel IN-APP (clic normal).
 * - `close` cierra el panel y, si veníamos por URL con :id, regresa a la lista
 *   (limpia la URL).
 * - `href(docId)` arma el deep-link para el <a> del folio.
 *
 * @param {string} basePath  Ruta base de la lista, ej. '/remisiones'.
 */
export function useDeepLinkDoc(basePath) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState(id || null)

  // Sincroniza si cambia el :id de la URL (navegación cliente o carga directa).
  useEffect(() => { setSelectedId(id || null) }, [id])

  const close = useCallback(() => {
    setSelectedId(null)
    if (id) navigate(basePath, { replace: true })
  }, [id, basePath, navigate])

  const href = useCallback((docId) => `${basePath}/${docId}`, [basePath])

  return { selectedId, setSelectedId, close, href }
}
