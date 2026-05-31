import { useBarcodeScanner } from '@/hooks/useBarcodeScanner'
import Spinner from '@/components/ui/Spinner'
import clsx from 'clsx'

const BarcodeIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
    <path strokeLinecap="round" d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14" />
  </svg>
)

/**
 * Botón de escaneo reutilizable. En la app abre la cámara; en web cae a captura
 * manual. Llama a `onScan(code)` con el código leído (no llama si se cancela).
 */
export default function ScanButton({ onScan, className, title = 'Escanear código', onError }) {
  const { scan, isScanning } = useBarcodeScanner()

  async function handleClick() {
    try {
      const code = await scan()
      if (code) onScan?.(code)
    } catch (err) {
      const msg = err?.message || 'No se pudo abrir el escáner.'
      if (onError) onError(err)
      else window.alert(msg)   // visible en el dispositivo (no silencioso)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isScanning}
      title={title}
      aria-label={title}
      className={clsx('btn-secondary btn-icon shrink-0', className)}
    >
      {isScanning ? <Spinner size="sm" /> : <BarcodeIcon />}
    </button>
  )
}
