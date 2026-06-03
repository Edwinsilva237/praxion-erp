// Enlace de documento para las celdas de folio en las tablas.
//
//  - Clic normal (izquierdo, sin modificadores) → abre el panel de detalle IN-APP
//    (onOpen), igual que hoy; no recarga ni navega.
//  - Ctrl/Cmd/Shift+clic, botón central, o clic derecho → "Abrir en nueva pestaña"
//    NATIVO del navegador, porque es un <a href> real al deep-link del documento.
//
// stopPropagation evita que también dispare el onClick de la fila (doble acción).
export default function DocLink({ to, onOpen, className = '', title, children }) {
  function handleClick(e) {
    e.stopPropagation()
    // Cualquier variante "abrir en otra pestaña/ventana" → deja que el navegador
    // siga el href (no preventDefault).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    onOpen?.()
  }
  return (
    <a href={to} onClick={handleClick} title={title}
       className={`text-inherit hover:underline ${className}`}>
      {children}
    </a>
  )
}
