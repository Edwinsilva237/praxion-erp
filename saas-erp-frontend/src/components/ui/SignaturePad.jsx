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
  const [empty, setEmpty] = useState(true)

  // Ajusta el tamaño real del lienzo al de su contenedor, respetando el
  // devicePixelRatio para que el trazo se vea nítido. Re-pinta el fondo blanco.
  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr  = window.devicePixelRatio || 1
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
    ctxRef.current = ctx
  }, [])

  useEffect(() => {
    setupCanvas()
    const onResize = () => {
      // Al redimensionar se pierde el trazo (re-setup limpia). Aceptable: el
      // teclado virtual o el giro de pantalla es raro durante la firma.
      setupCanvas()
      if (dirty.current) { dirty.current = false; setEmpty(true); onChange?.(true) }
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
