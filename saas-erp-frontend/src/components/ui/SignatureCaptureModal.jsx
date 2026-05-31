import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import SignaturePad from './SignaturePad'
import Spinner from './Spinner'

// Carga un data URL en un <img> para poder dibujarlo en un canvas.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('No se pudo leer la firma'))
    img.src = src
  })
}

function fmtNow() {
  return new Date().toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Modal para capturar la firma del REPARTIDOR DEL PROVEEDOR en la pantalla del
 * celular. Pensado para cuando el proveedor entrega mercancía SIN una remisión
 * que la respalde: su repartidor (que sí sabe qué entrega) firma como acuse.
 * NO es para paquetería — ahí el mensajero no puede dar fe del contenido y la
 * evidencia adecuada es la foto del paquete + su guía.
 *
 * Compone un PNG tipo comprobante (firma + nombre de quien entrega + fecha/hora)
 * y lo devuelve como File vía `onSigned(file)` para subirlo como evidencia de la
 * recepción (reutiliza la infraestructura de evidencia existente).
 *
 * Props:
 *   title     — encabezado del modal (default "Firma del repartidor del proveedor")
 *   docLabel  — folio/identificador a estampar en el comprobante (ej. folio de recepción)
 *   onClose() — cerrar sin firmar
 *   onSigned(file) — recibe el File PNG compuesto
 */
export default function SignatureCaptureModal({ title = 'Firma del repartidor del proveedor', docLabel, onClose, onSigned }) {
  const padRef = useRef(null)
  const [name, setName]       = useState('')
  const [sigEmpty, setSigEmpty] = useState(true)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState(null)

  async function compose() {
    const sigDataUrl = padRef.current?.toDataURL()
    if (!sigDataUrl) throw new Error('Dibuja la firma antes de continuar.')
    const sigImg = await loadImage(sigDataUrl)

    const W = 1000, H = 640
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const ctx = c.getContext('2d')
    const FONT = 'Helvetica, Arial, sans-serif'

    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)

    // Encabezado
    ctx.fillStyle = '#111827'
    ctx.font = `bold 34px ${FONT}`
    ctx.fillText('COMPROBANTE DE ENTREGA', 40, 56)
    ctx.fillStyle = '#6b7280'
    ctx.font = `20px ${FONT}`
    ctx.fillText(docLabel ? `Documento: ${docLabel}` : 'Recepción sin documento de respaldo', 40, 90)

    // Marco de la firma
    const boxX = 40, boxY = 120, boxW = W - 80, boxH = 360
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1
    ctx.strokeRect(boxX, boxY, boxW, boxH)

    // Firma centrada dentro del marco, conservando proporción
    const pad = 14
    const availW = boxW - pad * 2, availH = boxH - pad * 2
    const ratio = Math.min(availW / sigImg.width, availH / sigImg.height)
    const dw = sigImg.width * ratio, dh = sigImg.height * ratio
    ctx.drawImage(sigImg, boxX + pad + (availW - dw) / 2, boxY + pad + (availH - dh) / 2, dw, dh)

    // Pie: nombre, fecha
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(40, 540); ctx.lineTo(W - 40, 540); ctx.stroke()

    ctx.fillStyle = '#111827'; ctx.font = `bold 24px ${FONT}`
    ctx.fillText(`Entregó: ${name.trim()}`, 40, 576)
    ctx.fillStyle = '#6b7280'; ctx.font = `18px ${FONT}`; ctx.textAlign = 'right'
    ctx.fillText(`Fecha: ${fmtNow()}`, W - 40, 576)
    ctx.textAlign = 'left'

    const blob = await new Promise((resolve, reject) =>
      c.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png'))
    return new File([blob], 'firma-entrega.png', { type: 'image/png' })
  }

  async function handleConfirm() {
    setError(null)
    if (!name.trim()) { setError('Captura el nombre de quien entrega.'); return }
    if (sigEmpty)     { setError('Falta la firma.'); return }
    setBusy(true)
    try {
      const file = await compose()
      onSigned?.(file)
    } catch (e) {
      setError(e?.message || 'No se pudo procesar la firma.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-3 sm:p-4">
      <div className="card w-full max-w-2xl p-4 sm:p-5 max-h-[95vh] overflow-y-auto flex flex-col gap-4"
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink-primary">{title}</h3>
            {docLabel && <p className="text-xs text-ink-muted mt-0.5 font-mono">{docLabel}</p>}
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <p className="text-xs text-ink-secondary">
          Para cuando el <strong>proveedor entrega sin remisión</strong>. Pide a su repartidor que
          firme aquí como acuse de la entrega. (Para paquetería usa mejor foto del paquete y su guía.)
        </p>

        <div>
          <label className="label">Firma de quien entrega <span className="text-status-danger">*</span></label>
          <div className="h-56 sm:h-64">
            <SignaturePad ref={padRef} onChange={setSigEmpty} />
          </div>
          <div className="flex justify-end mt-1">
            <button type="button" onClick={() => padRef.current?.clear()}
              className="btn-ghost btn-sm text-xs text-ink-muted">
              Limpiar
            </button>
          </div>
        </div>

        <div>
          <label className="label">Nombre de quien entrega <span className="text-status-danger">*</span></label>
          <input className="input text-base" value={name}
            onChange={e => setName(e.target.value)} placeholder="Ej: Juan Pérez" />
        </div>

        {error && <p className="field-error">{error}</p>}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={busy}>
            Cancelar
          </button>
          <button type="button" onClick={handleConfirm} className="btn-primary flex-1" disabled={busy}>
            {busy ? <Spinner size="sm" /> : 'Usar firma'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
