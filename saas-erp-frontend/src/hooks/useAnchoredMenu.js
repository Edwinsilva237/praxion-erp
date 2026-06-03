import { useState, useRef, useEffect, useLayoutEffect } from 'react'

/**
 * Posiciona un menú flotante (renderizado en un portal) anclado a un elemento,
 * escapando de cualquier `overflow-hidden`/scroll ancestro.
 *
 * Resuelve el bug donde los desplegables custom (comboboxes SAT, Autocomplete)
 * quedaban recortados por el `overflow-hidden` de las secciones colapsables o
 * por el scroll de los modales: los campos del fondo de cada sección quedaban
 * tapados por la sección siguiente.
 *
 * Uso:
 *   const { anchorRef, menuRef, menuPos } = useAnchoredMenu(open, () => setOpen(false))
 *   <input ref={anchorRef} … />
 *   {open && menuPos && createPortal(
 *     <div ref={menuRef} style={{ position:'fixed', zIndex:10000, ...menuPos }}>…</div>,
 *     document.body)}
 *
 * @param open       — bool. Si el menú está abierto.
 * @param onOutside  — () => void. Se llama al hacer mousedown fuera del ancla y del menú.
 * @param options    — { maxHeight?: number } alto máximo deseado del menú en px.
 * @returns { anchorRef, menuRef, menuPos } — refs y estilos `fixed` del menú
 *          (null mientras está cerrado o aún no se mide).
 */
export function useAnchoredMenu(open, onOutside, { maxHeight = 256 } = {}) {
  const anchorRef = useRef(null)
  const menuRef = useRef(null)
  const [menuPos, setMenuPos] = useState(null)

  // Calcular la posición respecto al ancla. Recalcula al abrir y en cada
  // scroll/resize (el modal es scrollable, así que el ancla se mueve).
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return }
    function update() {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const gap = 4
      // iOS: con el teclado abierto, el viewport VISUAL se desplaza dentro del de
      // LAYOUT (al que está anclado `position:fixed`). getBoundingClientRect da
      // coords del viewport visual, así que el menú fixed se descolocaba "hacia
      // arriba, fuera del formulario". Compensamos con visualViewport.offset*.
      // En Android/escritorio (sin visualViewport o sin teclado) offset = 0 → no-op.
      const vv = window.visualViewport
      const offTop = vv ? vv.offsetTop : 0
      const offLeft = vv ? vv.offsetLeft : 0
      const visH = vv ? vv.height : window.innerHeight // alto VISIBLE (descuenta teclado)
      const below = visH - r.bottom - gap
      const above = r.top - gap
      // Abrir hacia arriba sólo si abajo no cabe razonablemente y arriba hay más espacio.
      const openUp = below < 200 && above > below
      setMenuPos({
        left: r.left + offLeft,
        width: r.width,
        ...(openUp
          ? { bottom: window.innerHeight - r.top - offTop + gap, maxHeight: Math.min(maxHeight, above) }
          : { top: r.bottom + offTop + gap, maxHeight: Math.min(maxHeight, below) }),
      })
    }
    update()
    window.addEventListener('scroll', update, true) // capture: capta scroll de cualquier ancestro
    window.addEventListener('resize', update)
    // El teclado de iOS dispara eventos en visualViewport (no en window): sin
    // esto el menú no se reubicaría al abrir/cerrar el teclado.
    const vv = window.visualViewport
    if (vv) {
      vv.addEventListener('resize', update)
      vv.addEventListener('scroll', update)
    }
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      if (vv) {
        vv.removeEventListener('resize', update)
        vv.removeEventListener('scroll', update)
      }
    }
  }, [open, maxHeight])

  // Click fuera. El menú vive en un portal, así que comprobamos ancla Y menú.
  // onOutside se guarda en un ref para no re-suscribir el listener cada render.
  const cbRef = useRef(onOutside)
  useEffect(() => { cbRef.current = onOutside })
  useEffect(() => {
    function onDoc(e) {
      if (anchorRef.current && anchorRef.current.contains(e.target)) return
      if (menuRef.current && menuRef.current.contains(e.target)) return
      cbRef.current?.(e)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return { anchorRef, menuRef, menuPos }
}
