import { forwardRef, useImperativeHandle, useRef, useEffect, useState, useCallback } from 'react'

/**
 * Lienzo para firmar con el dedo (o mouse). Usa Pointer Events, así que funciona
 * igual en táctil (Android/Capacitor) y en escritorio. No requiere librerías.
 *
 * Fondo BLANCO (no transparente) para que la firma se vea bien al incrustarse en
 * un PDF o al guardarse como evidencia (image/png).
 *
 * Métodos expuestos vía ref:
 *   - isEmpty()      → boolean
 *   - clear()        → limpia el lienzo
 *   - toDataURL()    → string PNG (data URL) o null si está vacío
 *
 * Props:
 *   onChange(isEmpty) — notifica al padre cuando cambia el estado (para habilitar
 *                       el botón "Usar firma").
 *   className         — clases extra para el contenedor.
 */
const SignaturePad = forwardRef(function SignaturePad({ onChange, className = '' }, ref) {
  const canvasRef = useRef(null)
  const ctxRef    = useRef(null)
  const drawing   = useRef(false)
  const lastPt    = useRef({ x: 0, y: 0 })
  const dirty     = useRef(false)
  const lastSize  = useRef({ w: 0, h: 0 })
  const [empty, setEmpty] = useState(true)

  // Ajusta el tamaño real del lienzo al de su contenedor, respetando el
  // devicePixelRatio para que el trazo se vea nítido.
  //
  // `preserve`: cuando es true conserva lo ya dibujado (lo recorta a un canvas
  // temporal y lo vuelve a pintar tras redimensionar). Crítico en móvil: al
  // enfocar un input aparece el teclado → la ventana hace `resize` → si no
  // preserváramos, se borraría la firma a medio capturar.
  const setupCanvas = useCallback((preserve = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return // en transición: no tocar

    // Snapshot del contenido actual (en píxeles de dispositivo).
    let snapshot = null
    if (preserve && canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement('canvas')
      snapshot.width  = canvas.width
      snapshot.height = canvas.height
      snapshot.getContext('2d').drawImage(canvas, 0, 0)
    }

    const dpr = window.devicePixelRatio || 1
    canvas.width  = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 2.5
    ctx.strokeStyle = '#111827'
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, rect.width, rect.height)
    // Re-pintamos el trazo previo escalado al nuevo tamaño (ctx ya está en
    // coordenadas CSS por el scale(dpr), por eso dibujamos a rect.width/height).
    if (snapshot) ctx.drawImage(snapshot, 0, 0, rect.width, rect.height)
    ctxRef.current = ctx
    lastSize.current = { w: rect.width, h: rect.height }
  }, [])

  useEffect(() => {
    setupCanvas()
    // Solo re-configuramos si el TAMAÑO del lienzo cambió de verdad. Así, cuando
    // el teclado aparece/desaparece sin reflujar el canvas, no hacemos nada
    // (no se borra ni se ve degradado). Si sí cambió (giro de pantalla), se
    // preserva el trazo.
    const onResize = () => {
      const c = canvasRef.current
      if (!c) return
      const r = c.getBoundingClientRect()
      if (Math.abs(r.width - lastSize.current.w) < 1 &&
          Math.abs(r.height - lastSize.current.h) < 1) return
      setupCanvas(true)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setupCanvas]) // eslint-disable-line react-hooks/exhaustive-deps

  function pointFromEvent(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function start(e) {
    e.preventDefault()
    drawing.current = true
    lastPt.current = pointFromEvent(e)
    try { canvasRef.current.setPointerCapture(e.pointerId) } catch { /* noop */ }
    if (empty) { setEmpty(false); onChange?.(false) }
    dirty.current = true
  }

  function move(e) {
    if (!drawing.current) return
    e.preventDefault()
    const ctx = ctxRef.current
    const p = pointFromEvent(e)
    ctx.beginPath()
    ctx.moveTo(lastPt.current.x, lastPt.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastPt.current = p
  }

  function end(e) {
    if (!drawing.current) return
    drawing.current = false
    try { canvasRef.current.releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  useImperativeHandle(ref, () => ({
    isEmpty: () => empty,
    clear: () => {
      setupCanvas()
      dirty.current = false
      setEmpty(true)
      onChange?.(true)
    },
    toDataURL: () => (empty ? null : canvasRef.current.toDataURL('image/png')),
  }), [empty, setupCanvas]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerLeave={end}
      onPointerCancel={end}
      className={`w-full h-full rounded-xl border border-line-subtle bg-white touch-none select-none cursor-crosshair ${className}`}
      style={{ touchAction: 'none' }}
    />
  )
})

export default SignaturePad
