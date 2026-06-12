import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { purchasesApi } from '@/api/purchases'
import { inventoryApi } from '@/api/inventory'
import { processConfigApi } from '@/api/processConfig'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import SignatureCaptureModal from '@/components/ui/SignatureCaptureModal'
import Can from '@/components/auth/Can'
import { fmtMXN, fmtDate, fmtNum, fmtDateOnly} from '@/utils/fmt'
import { downloadBlob, printBlob } from '@/utils/downloadBlob'
import { useDocumentScanner } from '@/hooks/useDocumentScanner'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import { LIVE_LIST } from '@/config/livePolling'
import clsx from 'clsx'
import api from '@/api/axios'
import { Capacitor } from '@capacitor/core'

// ── Helpers ────────────────────────────────────────────────────────────────────
const EMPTY_LINE = () => ({
  item_type: 'raw_material', item: null,
  qty_ordered: '', qty_received: '', unit: 'kg',
  unit_price: '', oc_line_id: null, oc_qty_original: null,
})

// Mapea una línea de una recepción existente (getReceipt) al shape del form,
// para precargar al EDITAR un borrador.
function mapReceiptLineToForm(l) {
  return {
    oc_line_id:       l.purchase_order_line_id || null,
    oc_qty_original:  l.ordered_qty != null ? parseFloat(l.ordered_qty) : null,
    item_type:        l.item_type || 'raw_material',
    item:             { id: l.item_id, label: l.item_name || l.description || '—' },
    unit:             l.unit || 'kg',
    unit_price:       l.unit_price != null ? String(l.unit_price) : '',
    qty_ordered:      l.ordered_qty != null ? String(parseFloat(l.ordered_qty)) : '',
    qty_received:     l.quantity_received != null ? String(parseFloat(l.quantity_received)) : '',
    lot_number:       l.lot_number || '',
    manufacturer_lot: l.manufacturer_lot || '',
    expiry_date:      l.lot_expiry_date ? String(l.lot_expiry_date).split('T')[0] : '',
  }
}

function DiffBadge({ ordered, received, unit }) {
  if (!ordered || !received) return null
  const diff = parseFloat(received) - parseFloat(ordered)
  if (Math.abs(diff) < 0.001) return (
    <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-status-success/10 text-status-success">= exacto</span>
  )
  return (
    <span className={clsx('text-xs font-medium px-1.5 py-0.5 rounded',
      diff > 0 ? 'bg-status-danger/10 text-status-danger' : 'bg-status-warning/10 text-status-warning')}>
      {diff > 0 ? '+' : ''}{fmtNum(diff, 3)} {unit}
    </span>
  )
}

// ── Sección de evidencia reutilizable ─────────────────────────────────────────
function EvidenciaSection({ receiptId, existingFilename, existingMimetype, onUploaded, onFileSelected, docLabel }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError]         = useState(null)
  const [preview, setPreview]     = useState(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [signOpen, setSignOpen]   = useState(false)
  const videoRef   = useRef(null)
  const streamRef  = useRef(null)
  const fileRef    = useRef(null)
  const { isSupported: scanSupported, scanToPdf } = useDocumentScanner()

  async function handleFile(file) {
    if (!file) return
    const maxMb = 20
    if (file.size > maxMb * 1024 * 1024) { setError(`Archivo muy grande (máx. ${maxMb} MB)`); return }
    setError(null)
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      setPreview({ url, type: 'image', name: file.name })
    } else {
      setPreview({ type: 'pdf', name: file.name })
    }

    if (receiptId) {
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        await purchasesApi.uploadEvidence(receiptId, fd)
        onUploaded?.()
      } catch (e) {
        setError(e.response?.data?.error || 'Error al subir el archivo')
      } finally {
        setUploading(false)
      }
    } else {
      // Modo creación: el receipt aún no existe. Entregamos el File al padre
      // para que lo suba después del INSERT (en el mutationFn).
      onFileSelected?.(file)
    }
  }

  // Escáner de documentos (ML Kit) → PDF, igual que en remisiones. Solo en nativo.
  async function handleScan() {
    setError(null)
    try {
      const res = await scanToPdf({ pageLimit: 5, fileName: 'evidencia-recepcion.pdf' })
      if (res?.file) handleFile(res.file)
    } catch (e) {
      const msg = String(e?.message || '')
      if (!/cancel/i.test(msg)) setError('No se pudo escanear: ' + (e?.message || 'inténtalo de nuevo'))
    }
  }

  // Firma capturada (PNG compuesto) → se trata igual que cualquier evidencia.
  function handleSigned(file) {
    setSignOpen(false)
    handleFile(file)
  }

  // Abre la evidencia ya guardada vía axios (preserva auth + funciona en móvil,
  // donde un <a href> no manda los headers y R2 no expone CORS).
  async function viewEvidence() {
    if (!receiptId) return
    setError(null)
    try {
      const r = await api.get(`/purchases/receipts/${receiptId}/evidence`, { responseType: 'blob' })
      const b = r.data
      const isPdf = b.type === 'application/pdf' || (existingMimetype || '').includes('pdf')
      const fname = existingFilename || `evidencia-${receiptId}${isPdf ? '.pdf' : '.png'}`
      if (Capacitor.isNativePlatform()) {
        await downloadBlob(b, fname)   // nativo: guardar / compartir
        return
      }
      const url = URL.createObjectURL(b)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      setError('No se pudo abrir la evidencia.')
    }
  }

  async function openCamera() {
    setCameraOpen(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setError('No se pudo acceder a la cámara')
      setCameraOpen(false)
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
    setCameraOpen(false)
  }

  function capturePhoto() {
    const video  = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      closeCamera()
      const file = new File([blob], `evidencia_${Date.now()}.jpg`, { type: 'image/jpeg' })
      handleFile(file)
    }, 'image/jpeg', 0.92)
  }

  const hasExisting = !!existingFilename
  const isImage = existingMimetype?.startsWith('image/')

  return (
    <div className="flex flex-col gap-3">
      {/* Evidencia existente */}
      {hasExisting && !preview && (
        <div className="flex items-center gap-3 bg-brand-500/10 border border-brand-100 rounded-xl px-3 py-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center shrink-0">
            {isImage
              ? <svg className="w-4 h-4 text-brand-300" fill="currentColor" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
              : <svg className="w-4 h-4 text-brand-300" fill="currentColor" viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5z"/></svg>
            }
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-brand-300 truncate">{existingFilename}</p>
            <p className="text-[10px] text-brand-500">Evidencia adjunta</p>
          </div>
          <div className="flex gap-1.5">
            <button type="button" onClick={viewEvidence}
              className="btn-ghost btn-sm text-xs text-brand-300">
              Ver
            </button>
          </div>
        </div>
      )}

      {/* Preview de nueva evidencia */}
      {preview && (
        <div className="flex items-center gap-3 bg-status-success/10 border border-status-success/40 rounded-xl px-3 py-2.5">
          {preview.type === 'image' && (
            <img src={preview.url} alt="preview" className="w-10 h-10 rounded-lg object-cover border border-status-success/40" />
          )}
          {preview.type === 'pdf' && (
            <div className="w-10 h-10 rounded-lg bg-status-success/15 flex items-center justify-center">
              <svg className="w-5 h-5 text-status-success" fill="currentColor" viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-status-success truncate">{preview.name}</p>
            {uploading
              ? <p className="text-[10px] text-green-500 flex items-center gap-1"><Spinner size="sm" /> Subiendo...</p>
              : <p className="text-[10px] text-green-500">✓ Lista para guardar</p>
            }
          </div>
          <button onClick={() => setPreview(null)} className="text-green-400 hover:text-status-success text-xs">✕</button>
        </div>
      )}

      {/* Botones de acción */}
      <div className="flex gap-2">
        <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden"
          onChange={e => handleFile(e.target.files[0])} />
        <button type="button" onClick={() => fileRef.current?.click()}
          className="btn-secondary btn-sm flex-1 justify-center">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          {hasExisting ? 'Reemplazar archivo' : 'Subir archivo'}
        </button>
        {scanSupported ? (
          <button type="button" onClick={handleScan}
            className="btn-secondary btn-sm flex-1 justify-center">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7V5a1 1 0 011-1h2M4 17v2a1 1 0 001 1h2m10-16h2a1 1 0 011 1v2m-3 13h2a1 1 0 001-1v-2M7 12h10"/>
            </svg>
            Escanear
          </button>
        ) : (
          <button type="button" onClick={openCamera}
            className="btn-secondary btn-sm flex-1 justify-center">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            Tomar foto
          </button>
        )}
      </div>

      {/* Firma en pantalla — proveedor entrega sin remisión y su repartidor firma el acuse */}
      <button type="button" onClick={() => setSignOpen(true)}
        className="btn-secondary btn-sm justify-center">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M3 21l3.6-.9a2 2 0 00.95-.53l11.4-11.4a2 2 0 000-2.83l-1.3-1.3a2 2 0 00-2.83 0L3.43 14.45a2 2 0 00-.53.95L2 19l1 2z"/>
        </svg>
        Firma del repartidor del proveedor
      </button>
      <p className="text-[11px] text-ink-muted -mt-1">
        El proveedor entrega sin remisión: que firme su repartidor como acuse. (Si llega por
        paquetería, mejor toma foto del paquete y su guía.)
      </p>

      {error && <p className="field-error">{error}</p>}

      {/* Captura de firma en pantalla */}
      {signOpen && (
        <SignatureCaptureModal
          docLabel={docLabel}
          onClose={() => setSignOpen(false)}
          onSigned={handleSigned}
        />
      )}

      {/* Modal de cámara */}
      {cameraOpen && createPortal(
        <div className="fixed inset-0 z-[10000] bg-black flex flex-col items-center justify-center gap-4 p-4">
          <video ref={videoRef} autoPlay playsInline className="w-full max-w-lg rounded-xl" />
          <div className="flex gap-4">
            <button onClick={closeCamera} className="btn-secondary">Cancelar</button>
            <button onClick={capturePhoto} className="btn-primary px-8">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              Capturar
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Panel de detalle lateral ──────────────────────────────────────────────────
function DetallePanel({ receiptId, onClose, onEdit }) {
  const qc = useQueryClient()
  const [confirming, setConf]   = useState(false)
  const [cancelling, setCancel] = useState(false)
  const [remitting, setRemit]   = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [actionErr, setActErr]  = useState(null)
  const [genPdf, setGenPdf]     = useState(false)

  const { data: receipt, isLoading, error } = useQuery({
    queryKey: ['receipt-detail', receiptId],
    queryFn: () => purchasesApi.getReceipt(receiptId),
    enabled: !!receiptId,
  })

  const confirmMutation = useMutation({
    mutationFn: () => purchasesApi.confirmReceipt(receiptId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      qc.invalidateQueries({ queryKey: ['receipt-detail', receiptId] })
      // Al confirmar, la recepción pasa a ser facturable → refrescar el selector
      // de "pendientes de facturar" del modal de Comprobantes recibidos.
      qc.invalidateQueries({ queryKey: ['receipts-pending'] })
      // Confirmar recepción reduce el inventario en tránsito y aumenta stock.
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-levels'] })
      qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-item-detail'] })
      setConf(false)
    },
    onError: (e) => setActErr(e.response?.data?.error || 'Error al confirmar'),
  })

  const cancelMutation = useMutation({
    mutationFn: () => purchasesApi.cancelReceipt(receiptId, { reason: cancelReason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['receipt-detail', receiptId] })
      // Cancelar saca la recepción del selector de "pendientes de facturar".
      qc.invalidateQueries({ queryKey: ['receipts-pending'] })
      // Cancelar un borrador borra sus lotes (que ya contaban como stock).
      qc.invalidateQueries({ queryKey: ['inv-stock'] })
      qc.invalidateQueries({ queryKey: ['inv-levels'] })
      qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      qc.invalidateQueries({ queryKey: ['inv-item-detail'] })
      setCancel(false)
      onClose()
    },
    onError: (e) => setActErr(e.response?.data?.error || 'Error al cancelar'),
  })

  // Fase 2: "no se espera factura" → genera CXP sin factura (remisión no fiscal).
  const remissionMutation = useMutation({
    mutationFn: () => purchasesApi.generateReceiptRemission(receiptId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['receipt-detail', receiptId] })
      qc.invalidateQueries({ queryKey: ['receipts-pending'] })
      qc.invalidateQueries({ queryKey: ['supplier-invoices'] })   // lista de CXP / facturas proveedor
      qc.invalidateQueries({ queryKey: ['accounts-payable'] })
      setRemit(false)
    },
    onError: (e) => setActErr(e.response?.data?.error || 'Error al generar la CXP'),
  })

  async function handlePDF() {
    if (!receipt) return
    setGenPdf(true)
    try {
      // PDF generado en el backend con branding del tenant (logo + colores) e
      // incrustando la firma/evidencia. downloadBlob: web descarga; nativo comparte.
      const blob = await purchasesApi.downloadReceiptPdf(receipt.id)
      await downloadBlob(blob, `${receipt.receipt_number}.pdf`)
    }
    catch (e) { alert('Error generando PDF: ' + (e.response?.data?.error || e.message)) }
    finally { setGenPdf(false) }
  }

  async function handlePrint() {
    if (!receipt) return
    setGenPdf(true)
    try {
      const blob = await purchasesApi.downloadReceiptPdf(receipt.id)
      await printBlob(blob, receipt.receipt_number || 'Recepcion')
    }
    catch (e) { alert('Error al imprimir: ' + (e.response?.data?.error || e.message)) }
    finally { setGenPdf(false) }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex">
      <div className="hidden sm:block flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-xl bg-surface-primary h-full shadow-card flex flex-col">

        {/* Header — fijo arriba, respeta el notch/barra de estado del móvil */}
        <div className="shrink-0 bg-surface-primary border-b border-line-subtle px-5 py-4 flex items-start gap-3"
          style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top))' }}>
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="skeleton h-5 w-40" />
            ) : receipt ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-base font-bold text-ink-primary">{receipt.receipt_number}</span>
                  <Badge status={receipt.status} />
                  {receipt.evidence_filename && (
                    <span title="Tiene evidencia adjunta" className="text-ink-muted">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
                      </svg>
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {receipt.partner_name || '—'} · {fmtDateOnly(receipt.received_date)} · {receipt.warehouse_name}
                </p>
              </>
            ) : null}
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : error || !receipt ? (
            <p className="text-sm text-center text-ink-muted py-8">No se pudo cargar la recepción</p>
          ) : (
            <>
              {/* Datos generales */}
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['OC referencia',   receipt.purchase_order_number || '—'],
                  ['Folio proveedor', receipt.document_type
                    ? `${receipt.document_type} ${receipt.document_number || ''}`.trim() : '—'],
                  ['Almacén',         receipt.warehouse_name || '—'],
                  ['Recibió',         receipt.created_by_name || '—'],
                  ['Confirmó',        receipt.confirmed_by_name || '—'],
                  ['Confirmado el',   receipt.confirmed_at ? fmtDate(receipt.confirmed_at) : '—'],
                ].map(([label, val]) => (
                  <div key={label} className="bg-surface-elevated/60 border border-line-strong rounded-lg px-3 py-2">
                    <p className="text-[10px] font-bold text-ink-secondary uppercase tracking-wide">{label}</p>
                    <p className="text-sm font-medium text-ink-primary mt-0.5">{val}</p>
                  </div>
                ))}
              </div>

              {/* Líneas */}
              {(receipt.lines || []).length > 0 && (
                <div className="border border-line-subtle rounded-xl overflow-hidden">
                  <table className="table text-xs">
                    <thead>
                      <tr>
                        <th>Artículo</th>
                        <th className="text-right">OC</th>
                        <th className="text-right">Recibido</th>
                        <th className="text-right">P. Unit.</th>
                        <th className="text-right">Importe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipt.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="font-medium">{l.item_name || l.description || '—'}</td>
                          <td className="text-right font-mono text-status-warning tabular-nums">
                            {l.ordered_qty ? `${fmtNum(l.ordered_qty, 3)} ${l.unit}` : '—'}
                          </td>
                          <td className="text-right font-mono font-semibold tabular-nums">
                            {fmtNum(l.quantity_received, 3)} {l.unit}
                          </td>
                          <td className="text-right font-mono tabular-nums">{fmtMXN(l.unit_price)}</td>
                          <td className="text-right font-mono font-medium tabular-nums">
                            {fmtMXN(parseFloat(l.quantity_received || 0) * parseFloat(l.unit_price || 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="bg-surface-elevated/40 border-t border-line-subtle px-4 py-2.5 flex justify-between">
                    <span className="text-sm font-semibold text-ink-secondary">Total</span>
                    <span className="font-mono text-sm font-bold text-brand-300">
                      {fmtMXN(receipt.lines.reduce((s, l) =>
                        s + parseFloat(l.quantity_received || 0) * parseFloat(l.unit_price || 0), 0))}
                    </span>
                  </div>
                </div>
              )}

              {/* Evidencia */}
              <div>
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider mb-3">
                  Evidencia
                </p>
                <EvidenciaSection
                  receiptId={receiptId}
                  existingFilename={receipt.evidence_filename}
                  existingMimetype={receipt.evidence_mimetype}
                  docLabel={receipt.receipt_number}
                  onUploaded={() => qc.invalidateQueries({ queryKey: ['receipt-detail', receiptId] })}
                />
              </div>

              {receipt.notes && (
                <div className="bg-status-info/10 border border-status-info/40 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-blue-400 uppercase tracking-wide mb-0.5">Notas</p>
                  <p className="text-sm text-status-info">{receipt.notes}</p>
                </div>
              )}

              {actionErr && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                  <p className="text-sm text-status-danger">{actionErr}</p>
                </div>
              )}

              {/* Confirmar modal */}
              {confirming && createPortal(
                <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
                  <div className="card w-full max-w-sm p-6 flex flex-col gap-4">
                    <div className="w-10 h-10 rounded-xl bg-brand-500/15 flex items-center justify-center">
                      <svg className="w-5 h-5 text-brand-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-ink-primary">Confirmar recepción</h2>
                      <p className="text-sm text-ink-secondary mt-1">
                        El material entrará al inventario con la cantidad real registrada. Esta acción no se puede deshacer.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setConf(false)} className="btn-secondary flex-1">Cancelar</button>
                      <button onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending} className="btn-primary flex-1">
                        {confirmMutation.isPending ? <Spinner size="sm" /> : 'Confirmar y mover a inventario'}
                      </button>
                    </div>
                  </div>
                </div>,
                document.body
              )}

              {/* Cancelar modal */}
              {cancelling && createPortal(
                <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
                  <div className="card w-full max-w-sm p-6 flex flex-col gap-4">
                    <div className="w-10 h-10 rounded-xl bg-status-danger/15 flex items-center justify-center">
                      <svg className="w-5 h-5 text-status-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z"/>
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-ink-primary">Cancelar recepción</h2>
                      <p className="text-sm text-ink-secondary mt-1">
                        El borrador quedará cancelado y no se podrá confirmar. Si había creado lotes, se
                        eliminarán (no movieron inventario). No se puede deshacer.
                      </p>
                    </div>
                    <div>
                      <label className="label">Motivo (opcional)</label>
                      <input className="input" placeholder="Ej: capturado por error, OC equivocada..."
                        value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setCancel(false)} className="btn-secondary flex-1">Volver</button>
                      <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}
                        className="btn-primary flex-1 bg-status-danger hover:bg-red-700">
                        {cancelMutation.isPending ? <Spinner size="sm" /> : 'Sí, cancelar'}
                      </button>
                    </div>
                  </div>
                </div>,
                document.body
              )}
            </>
          )}
        </div>

        {/* Footer de acciones — fijo abajo, respeta el safe-area inferior del móvil
            (antes las acciones quedaban tras la barra inferior / fuera de vista). */}
        {!isLoading && !error && receipt && (
          <div className="shrink-0 flex flex-wrap gap-2 border-t border-line-subtle bg-surface-primary px-5 pt-3"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
            <button onClick={handlePDF} disabled={genPdf} className="btn-secondary btn-sm">
              {genPdf ? <Spinner size="sm" /> : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
              )}
              Descargar PDF
            </button>
            <button onClick={handlePrint} disabled={genPdf} className="btn-secondary btn-sm">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
              </svg>
              Imprimir
            </button>
            {receipt.status === 'draft' && (
              <>
                <Can do="purchases:update">
                  <button onClick={() => onEdit?.(receipt)} className="btn-secondary btn-sm">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                    Editar
                  </button>
                </Can>
                <Can do="purchases:update">
                  <button onClick={() => { setActErr(null); setCancel(true) }}
                    className="btn-secondary btn-sm text-status-danger hover:bg-status-danger/10">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                    Cancelar recepción
                  </button>
                </Can>
                <button onClick={() => setConf(true)} className="btn-primary btn-sm">
                  Confirmar → Mover a inventario
                </button>
              </>
            )}
            {/* Fase 2: recepción confirmada SIN documento → generar CXP sin factura */}
            {receipt.status === 'confirmed' && !receipt.invoiced_at && (
              <Can do="purchases:create">
                <button onClick={() => { setActErr(null); setRemit(true) }}
                  className="btn-secondary btn-sm text-status-info hover:bg-status-info/10"
                  title="El proveedor no emitirá factura: reconoce la cuenta por pagar ahora (remisión no fiscal, sin IVA)">
                  💸 No se espera factura → CXP
                </button>
              </Can>
            )}
          </div>
        )}

        {/* Modal: confirmar "no se espera factura" */}
        {remitting && createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
            <div className="card w-full max-w-md p-5 space-y-4">
              <h2 className="text-base font-semibold text-ink-primary">Generar CXP sin factura</h2>
              <p className="text-sm text-ink-secondary">
                Se creará una <strong>cuenta por pagar</strong> por el valor de la recepción
                {receipt?.total_mxn != null ? <> (<span className="font-mono">{fmtMXN(receipt.total_mxn)}</span>)</> : null},
                como <strong>remisión no fiscal (sin IVA)</strong>, con vencimiento según el crédito del proveedor.
              </p>
              <p className="text-xs text-ink-muted">
                Úsalo cuando el proveedor <strong>no</strong> va a emitir CFDI. Si después llega la factura,
                al registrarla esta CXP se anula sola y se reemplaza por la factura.
              </p>
              {actionErr && (
                <div className="rounded-lg bg-status-danger/10 border border-status-danger/40 px-3 py-2 text-sm text-status-danger">
                  {actionErr}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => { setRemit(false); setActErr(null) }} className="btn-secondary flex-1">Cancelar</button>
                <button onClick={() => remissionMutation.mutate()} disabled={remissionMutation.isPending} className="btn-primary flex-1">
                  {remissionMutation.isPending ? <Spinner size="sm" /> : 'Generar CXP'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>,
    document.body
  )
}

// ── Modal nueva recepción ─────────────────────────────────────────────────────
function NuevaRecepcionModal({ preselectedOcId, editReceipt = null, onClose, onCreated }) {
  const qc = useQueryClient()
  const isEdit = !!editReceipt

  const [ocId, setOcId]           = useState(editReceipt?.purchase_order_id || preselectedOcId || '')
  const [ocData, setOcData]       = useState(null)
  const [ocLoading, setOcLoading] = useState(false)
  const [warehouseId, setWH]      = useState(editReceipt?.warehouse_id || '')
  const [docType, setDocType]     = useState(editReceipt?.document_type || 'remision')
  const [docNumber, setDocNumber] = useState(editReceipt?.document_number || '')
  const [receiptDate, setDate]    = useState(String(editReceipt?.received_date || new Date().toISOString()).split('T')[0])
  const [notes, setNotes]         = useState(editReceipt?.notes || '')
  const [lines, setLines]         = useState(() => isEdit ? (editReceipt.lines || []).map(mapReceiptLineToForm) : [])
  const [evidence, setEvidence]   = useState(null)  // File
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [error, setError]         = useState(null)
  const [excessWarning, setExcess] = useState(null)

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn: inventoryApi.getWarehouses,
  })

  const { data: openOrders = [] } = useQuery({
    queryKey: ['purchase-orders-open'],
    queryFn: () => purchasesApi.listOrders({ limit: 100 }).then(r =>
      (r.data || r).filter(o => ['sent', 'partially_received'].includes(o.status))
    ),
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn: processConfigApi.getConfig,
    staleTime: 300000,
  })
  const usesLots   = tenantConfig?.uses_lots   ?? false
  const usesExpiry = tenantConfig?.uses_expiry ?? false

  async function loadOC(id) {
    setOcId(id); setOcData(null); setLines([]); setError(null)
    if (!id) return
    setOcLoading(true)
    try {
      const oc = await purchasesApi.getOrder(id)
      setOcData(oc)
      const pending = (oc.lines || []).filter(l => {
        const ordered  = parseFloat(l.quantity || 0)
        const received = parseFloat(l.quantity_received || 0)
        return ordered - received > 0.001
      })
      setLines((pending.length > 0 ? pending : oc.lines || []).map(l => ({
        oc_line_id:      l.id,
        oc_qty_original: parseFloat(l.quantity || 0),
        item_type:       l.item_type || 'raw_material',
        item:            { id: l.item_id, label: l.item_name || l.description || '—' },
        unit:            l.unit || 'kg',
        unit_price:      l.unit_price?.toString() || '',
        qty_ordered:     (parseFloat(l.quantity || 0) - parseFloat(l.quantity_received || 0)).toString(),
        qty_received:    '',
        // Campos opcionales para trazabilidad por lote (uses_lots / uses_expiry)
        lot_number:      '',
        manufacturer_lot: '',
        expiry_date:     '',
      })))
    } catch { setError('No se pudo cargar la OC.') }
    finally { setOcLoading(false) }
  }

  useEffect(() => { if (preselectedOcId) loadOC(preselectedOcId) }, [preselectedOcId])

  // En edición: las líneas ya vienen precargadas del borrador; solo cargamos la
  // OC para la tarjeta de referencia y el partner (NO re-derivamos las líneas).
  useEffect(() => {
    if (!isEdit || !editReceipt.purchase_order_id) return
    setOcLoading(true)
    purchasesApi.getOrder(editReceipt.purchase_order_id)
      .then(setOcData).catch(() => {}).finally(() => setOcLoading(false))
  }, [])

  function updateLine(idx, key, val) {
    setLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, [key]: val }))
  }

  const subtotal = lines.reduce((s, l) =>
    s + (parseFloat(l.qty_received || l.qty_ordered || 0) * parseFloat(l.unit_price || 0)), 0)

  function getExcess() {
    return lines.filter(l => {
      const r = parseFloat(l.qty_received || l.qty_ordered || 0)
      const p = parseFloat(l.qty_ordered || 0)
      return r > p + 0.001
    })
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!ocId && !isEdit) throw new Error('Selecciona una OC.')
      if (!warehouseId) throw new Error('Selecciona el almacén de destino.')
      const validLines = lines.filter(l => l.item?.id && (l.qty_received || l.qty_ordered))
      if (!validLines.length) throw new Error('Sin líneas con cantidad.')

      const body = {
        partnerId:       ocData?.partner_id || null,
        purchaseOrderId: ocId || null,
        warehouseId,
        receivedDate:    receiptDate,
        documentType:    docType,
        documentNumber:  docNumber || null,
        notes:           notes || null,
        lines: validLines.map(l => ({
          itemType:            l.item_type,
          itemId:              l.item.id,
          purchaseOrderLineId: l.oc_line_id || null,
          quantityOrdered:     parseFloat(l.qty_ordered || 0),
          quantityReceived:    l.qty_received !== '' ? parseFloat(l.qty_received) : parseFloat(l.qty_ordered),
          unitPrice:           parseFloat(l.unit_price || 0),
          unit:                l.unit,
          warehouseId,
          // Trazabilidad por lote — el backend solo los usa si uses_lots=true
          lotNumber:       l.lot_number       ? l.lot_number.trim()       : null,
          manufacturerLot: l.manufacturer_lot ? l.manufacturer_lot.trim() : null,
          expiryDate:      l.expiry_date || null,
        })),
      }

      // Editar un borrador: reemplaza líneas + encabezado. La evidencia se
      // gestiona aparte (en el panel de detalle), por eso aquí no se sube.
      if (isEdit) return purchasesApi.updateReceipt(editReceipt.id, body)

      const receipt = await purchasesApi.createReceipt(body)
      // Subir evidencia si hay
      if (evidence) {
        const fd = new FormData()
        fd.append('file', evidence)
        await purchasesApi.uploadEvidence(receipt.id, fd)
      }
      return receipt
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] })
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      if (isEdit) {
        qc.invalidateQueries({ queryKey: ['receipt-detail', editReceipt.id] })
        // Editar reemplaza los lotes del borrador → refrescar inventario.
        qc.invalidateQueries({ queryKey: ['inv-stock'] })
        qc.invalidateQueries({ queryKey: ['inv-levels'] })
        qc.invalidateQueries({ queryKey: ['inv-levels-summary'] })
      }
      onCreated()
      onClose()
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  function handleSubmit(e) {
    e.preventDefault(); setError(null)
    if (!ocId && !isEdit) { setError('Selecciona una OC.'); return }
    if (!warehouseId) { setError('Selecciona el almacén.'); return }
    const excess = getExcess()
    if (excess.length > 0) { setExcess(excess); return }
    mutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-2xl p-6 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">{isEdit ? 'Editar recepción' : 'Nueva recepción'}</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {isEdit ? `${editReceipt.receipt_number} · borrador` : 'El inventario se actualiza al confirmar'}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Alerta de exceso */}
        {excessWarning && (
          <div className="mb-5 bg-status-warning/10 border border-status-warning/40 rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-status-warning/15 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-status-warning" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-status-warning mb-2">⚠️ Cantidad mayor a lo pendiente en OC</p>
                <div className="flex flex-col gap-1.5">
                  {excessWarning.map((l, i) => {
                    const r = parseFloat(l.qty_received || l.qty_ordered || 0)
                    const p = parseFloat(l.qty_ordered || 0)
                    return (
                      <div key={i} className="bg-surface-primary border border-status-warning/40 rounded-lg px-3 py-2 text-xs">
                        <p className="font-semibold text-ink-primary">{l.item?.label}</p>
                        <div className="flex gap-4 mt-1 text-ink-secondary">
                          <span>Pendiente: <strong>{fmtNum(p, 3)} {l.unit}</strong></span>
                          <span>A recibir: <strong className="text-status-warning">{fmtNum(r, 3)} {l.unit}</strong></span>
                          <span className="text-status-danger font-semibold">Exceso: +{fmtNum(r - p, 3)} {l.unit}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-2 border-t border-status-warning/40 pt-3">
              <button type="button" onClick={() => setExcess(null)} className="btn-secondary flex-1 text-sm">
                Revisar cantidades
              </button>
              <button type="button" onClick={() => { setExcess(null); mutation.mutate() }}
                disabled={mutation.isPending}
                className="btn-primary flex-1 text-sm bg-amber-600 hover:bg-amber-700">
                {mutation.isPending ? <Spinner size="sm" /> : 'Confirmar de todas formas'}
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {/* OC obligatoria */}
          <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
            <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">
              Orden de compra <span className="text-status-danger">*</span>
            </p>
            <div>
              <label className="label">{isEdit ? 'OC de la recepción' : 'Selecciona la OC a recibir'}</label>
              {isEdit ? (
                <div className="input bg-surface-elevated/40 text-ink-secondary cursor-default flex items-center gap-2">
                  <span className="font-mono">{editReceipt.purchase_order_number || ocData?.order_number || '—'}</span>
                  <span className="text-ink-muted text-xs">(no se puede cambiar al editar)</span>
                </div>
              ) : openOrders.length === 0 ? (
                <div className="input bg-status-warning/10 border-status-warning/40 text-status-warning text-sm">
                  No hay OC enviadas pendientes de recepción
                </div>
              ) : (
                <select className={clsx('select', !ocId && 'border-status-danger/40 bg-status-danger/10')}
                  value={ocId} onChange={e => loadOC(e.target.value)}>
                  <option value="">— Selecciona una OC —</option>
                  {openOrders.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.order_number} · {o.partner_name || 'Sin proveedor'} · {fmtMXN(o.total_mxn)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {ocLoading && (
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <Spinner size="sm" /> Cargando líneas...
              </div>
            )}
            {ocData && !ocLoading && (
              <div className="bg-brand-500/10 border border-brand-100 rounded-lg px-3 py-2 flex items-center gap-3">
                <svg className="w-4 h-4 text-brand-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
                <div className="flex-1 text-xs">
                  <span className="font-semibold text-brand-300">{ocData.order_number}</span>
                  <span className="text-ink-muted ml-2">
                    {ocData.partner_name} · {lines.length} línea{lines.length !== 1 ? 's' : ''} pendiente{lines.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <Badge status={ocData.status} />
              </div>
            )}
          </div>

          {/* Solo si hay OC cargada (o estamos editando un borrador) */}
          {(ocId || isEdit) && lines.length > 0 && (
            <>
              {/* Documento */}
              <div className="bg-surface-elevated/60 border border-line-subtle rounded-xl p-4 flex flex-col gap-3">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Datos del documento</p>
                <div>
                  <label className="label">Almacén destino <span className="text-status-danger">*</span></label>
                  <select className="select" value={warehouseId} onChange={e => setWH(e.target.value)}>
                    <option value="">Seleccionar almacén...</option>
                    {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Fecha de recepción</label>
                    <input type="date" className="input" value={receiptDate} onChange={e => setDate(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Tipo de documento</label>
                    <select className="select" value={docType} onChange={e => setDocType(e.target.value)}>
                      <option value="remision">Remisión</option>
                      <option value="factura">Factura</option>
                      <option value="otro">Otro</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">Número de documento (folio del proveedor)</label>
                    <input className="input" placeholder="Ej: R-00123, F-0045..."
                      value={docNumber} onChange={e => setDocNumber(e.target.value)} />
                  </div>
                </div>
              </div>

              {/* Líneas */}
              <div className="flex flex-col gap-3">
                <p className="text-xs font-bold text-brand-300 uppercase tracking-wider">Material a recibir</p>
                {lines.map((line, idx) => {
                  const recibido  = parseFloat(line.qty_received || 0)
                  const pendiente = parseFloat(line.qty_ordered || 0)
                  const hayExceso = recibido > pendiente + 0.001
                  const hayFalta  = recibido > 0 && recibido < pendiente - 0.001
                  return (
                    <div key={idx} className={clsx('border rounded-xl p-4 flex flex-col gap-3',
                      hayExceso ? 'border-status-warning/40 bg-status-warning/10/30' : 'border-line-subtle')}>
                      <div className="flex items-center gap-2">
                        <span className={clsx('text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0',
                          line.item_type === 'raw_material' ? 'bg-status-warning/15 text-status-warning' : 'bg-brand-500/15 text-brand-300')}>
                          {line.item_type === 'raw_material' ? 'MP' : 'PT'}
                        </span>
                        <p className="text-sm font-semibold text-ink-primary flex-1">{line.item?.label}</p>
                        {hayExceso && <span className="text-[10px] font-bold text-status-warning bg-status-warning/15 px-2 py-0.5 rounded-full">⚠ exceso</span>}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label text-status-warning">Pendiente OC</label>
                          <div className="input bg-status-warning/10 border-status-warning/40 text-status-warning font-mono text-sm cursor-default">
                            {fmtNum(pendiente, 3)} {line.unit}
                          </div>
                        </div>
                        <div>
                          <label className="label flex items-center gap-2">
                            Cantidad real recibida
                            <DiffBadge ordered={line.qty_ordered} received={line.qty_received} unit={line.unit} />
                          </label>
                          <input type="number" step="0.001" min="0" value={line.qty_received}
                            onChange={e => updateLine(idx, 'qty_received', e.target.value)}
                            className={clsx('input',
                              hayExceso && 'border-amber-400 bg-status-warning/10',
                              hayFalta && 'border-status-info/40',
                              !hayExceso && !hayFalta && line.qty_received && 'border-status-success/40',
                            )}
                            placeholder={`máx. ${fmtNum(pendiente, 3)} ${line.unit}`}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label">Precio unitario</label>
                          <input type="number" step="0.0001" min="0" value={line.unit_price}
                            onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                            className="input" placeholder="0.0000" />
                        </div>
                        <div>
                          <label className="label">Subtotal</label>
                          <div className="input bg-surface-elevated/40 text-ink-muted font-mono text-sm cursor-default">
                            {fmtMXN(parseFloat(line.qty_received || line.qty_ordered || 0) * parseFloat(line.unit_price || 0))}
                          </div>
                        </div>
                      </div>

                      {/* Trazabilidad por lote — solo si el tenant maneja lotes */}
                      {usesLots && line.item_type === 'raw_material' && (
                        <div className="border-t border-line-subtle pt-3 mt-1">
                          <p className="text-[10px] uppercase tracking-wide font-semibold text-ink-muted mb-2">Trazabilidad del lote</p>
                          <div className={clsx('grid gap-3', usesExpiry ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
                            <div>
                              <label className="label">Número de lote</label>
                              <input type="text" value={line.lot_number || ''}
                                onChange={e => updateLine(idx, 'lot_number', e.target.value)}
                                className="input" placeholder="(se autogenerará)" />
                            </div>
                            <div>
                              <label className="label">Lote del proveedor</label>
                              <input type="text" value={line.manufacturer_lot || ''}
                                onChange={e => updateLine(idx, 'manufacturer_lot', e.target.value)}
                                className="input" placeholder="opcional" />
                            </div>
                            {usesExpiry && (
                              <div>
                                <label className="label">Caducidad</label>
                                <input type="date" value={line.expiry_date || ''}
                                  onChange={e => updateLine(idx, 'expiry_date', e.target.value)}
                                  className="input" />
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                {subtotal > 0 && (
                  <div className="flex justify-end">
                    <div className="bg-brand-500/10 border border-brand-100 rounded-xl px-4 py-2.5 flex items-center gap-3">
                      <span className="text-sm text-ink-muted">Total recepción</span>
                      <span className="text-base font-bold text-brand-300">{fmtMXN(subtotal)}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Notas */}
              <div>
                <label className="label">Notas</label>
                <input className="input" placeholder="Observaciones de la recepción..."
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>

              {/* Evidencia (solo al crear; al editar se gestiona en el detalle) */}
              {!isEdit && (
              <div className="border border-line-subtle rounded-xl overflow-hidden">
                <button type="button" onClick={() => setEvidenceOpen(p => !p)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-surface-elevated/40 hover:bg-surface-elevated/60 transition-colors">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
                    </svg>
                    <span className="text-sm font-medium text-ink-secondary">
                      Adjuntar evidencia <span className="text-ink-muted font-normal">(opcional)</span>
                    </span>
                    {evidence && <span className="text-xs text-status-success font-medium">✓ {evidence.name}</span>}
                  </div>
                  <svg className={clsx('w-4 h-4 text-ink-muted transition-transform', evidenceOpen && 'rotate-180')}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                {evidenceOpen && (
                  <div className="p-4">
                    <EvidenciaSection
                      receiptId={null}
                      existingFilename={evidence?.name}
                      onFileSelected={setEvidence}
                    />
                  </div>
                )}
              </div>
              )}
            </>
          )}

          {error && (
            <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
              <p className="text-sm text-status-danger">{error}</p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
            <button type="submit"
              disabled={mutation.isPending || (!ocId && !isEdit) || lines.length === 0 || !!excessWarning}
              className="btn-primary flex-1">
              {mutation.isPending ? <Spinner size="sm" /> : (isEdit ? 'Guardar cambios' : 'Guardar recepción')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// ── Página principal ──────────────────────────────────────────────────────────
export default function ComprasRecepciones() {
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const preselectedOcId = searchParams.get('oc')

  const [showNew, setShowNew]   = useState(!!preselectedOcId)
  const [detailId, setDetailId] = useState(null)
  const [editReceipt, setEditReceipt] = useState(null)
  const [success, setSuccess]   = useState(null)

  // Filtros
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatus]   = useState('')
  const [warehouseFilter, setWH]    = useState('')
  const [fromDate, setFrom]         = useState('')
  const [toDate, setTo]             = useState('')
  const [evidenceFilter, setEvidence] = useState('')
  const [invoiceFilter, setInvoiceFilter] = useState('')
  const [page, setPage]             = useState(1)

  const hasFilters = search || statusFilter || warehouseFilter || fromDate || toDate || evidenceFilter || invoiceFilter

  useEffect(() => {
    if (preselectedOcId && showNew) {
      const t = setTimeout(() => setSearchParams({}, { replace: true }), 500)
      return () => clearTimeout(t)
    }
  }, [preselectedOcId, showNew])

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn: inventoryApi.getWarehouses,
  })

  const { sortBy, sortDir, onSort } = useTableSort('fecha', 'desc')
  useEffect(() => { setPage(1) }, [sortBy, sortDir])

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['purchase-receipts', search, statusFilter, warehouseFilter, evidenceFilter, invoiceFilter, fromDate, toDate, sortBy, sortDir, page],
    queryFn: () => purchasesApi.listReceipts({
      search:        search || undefined,
      status:        statusFilter || undefined,
      warehouseId:   warehouseFilter || undefined,
      hasEvidence:   evidenceFilter || undefined,
      invoiceStatus: invoiceFilter || undefined,
      from:          fromDate || undefined,
      to:            toDate || undefined,
      sortBy, sortDir,
      page, limit: 20,
    }),
    keepPreviousData: true,
    ...LIVE_LIST,
  })

  const receipts = data?.data || []
  const total    = data?.total || 0

  function resetFilters() {
    setSearch(''); setStatus(''); setWH(''); setFrom(''); setTo(''); setEvidence(''); setInvoiceFilter(''); setPage(1)
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Recepciones</h1>
          <p className="page-subtitle">Entrada de material al almacén</p>
        </div>
        <Can do="purchases:create">
          <button onClick={() => setShowNew(true)} className="btn-primary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/>
            </svg>
            Nueva recepción
          </button>
        </Can>
      </div>

      {success && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
            <p className="text-sm text-status-success">{success}</p>
          </div>
          <button onClick={() => setSuccess(null)} className="text-green-400 text-xs">✕</button>
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Buscador (siempre visible — en móvil es el único control) */}
        <div className="relative flex-1 min-w-[200px] sm:max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input type="text" className="input pl-9" placeholder="Número, folio o proveedor..."
            value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
        </div>

        {/* Filtros adicionales — ocultos en móvil (allí solo se busca) */}
        <div className="hidden sm:contents">
          <select className="select w-44" value={statusFilter}
            onChange={e => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Todos los estados</option>
            <option value="draft">Borrador</option>
            <option value="confirmed">Confirmada</option>
            <option value="cancelled">Cancelada</option>
          </select>

          <select className="select w-44" value={warehouseFilter}
            onChange={e => { setWH(e.target.value); setPage(1) }}>
            <option value="">Todos los almacenes</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>

          <select className="select w-44" value={evidenceFilter}
            onChange={e => { setEvidence(e.target.value); setPage(1) }}>
            <option value="">Con y sin evidencia</option>
            <option value="yes">📎 Con evidencia</option>
            <option value="no">Sin evidencia</option>
          </select>

          <select className="select w-44" value={invoiceFilter}
            onChange={e => { setInvoiceFilter(e.target.value); setPage(1) }}>
            <option value="">Facturadas y sin factura</option>
            <option value="pending">🟡 Sin factura</option>
            <option value="invoiced">🟢 Facturadas</option>
          </select>

          <input type="date" className="input w-36" value={fromDate}
            onChange={e => { setFrom(e.target.value); setPage(1) }} title="Desde" />
          <input type="date" className="input w-36" value={toDate}
            onChange={e => { setTo(e.target.value); setPage(1) }} title="Hasta" />

          {hasFilters && (
            <button onClick={resetFilters} className="btn-ghost btn-sm text-ink-muted">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
              </svg>
              Limpiar
            </button>
          )}
        </div>
        {isFetching && !isLoading && <div className="ml-auto"><Spinner size="sm" /></div>}
      </div>

      {/* Tabla */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : !receipts.length ? (
        <div className="empty-state">
          {hasFilters ? (
            <>
              <p className="font-medium text-ink-secondary">Sin resultados</p>
              <button onClick={resetFilters} className="btn-secondary btn-sm mt-3">Limpiar filtros</button>
            </>
          ) : (
            <>
              <p className="font-medium text-ink-secondary">Sin recepciones</p>
              <p className="text-sm text-ink-muted">Al confirmar una recepción el inventario se actualiza automáticamente.</p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <SortableHeader sortKey="folio"     sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Número</SortableHeader>
                  <th>OC</th>
                  <th>Folio proveedor</th>
                  <SortableHeader sortKey="proveedor" sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Proveedor</SortableHeader>
                  <th>Almacén</th>
                  <th>Recibió</th>
                  <th>Confirmó</th>
                  <SortableHeader sortKey="estatus"   sortBy={sortBy} sortDir={sortDir} onSort={onSort} initialDir="asc">Estado</SortableHeader>
                  <th>Factura</th>
                  <SortableHeader sortKey="fecha"     sortBy={sortBy} sortDir={sortDir} onSort={onSort}>Fecha</SortableHeader>
                  <th className="text-right">Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold text-brand-300">{r.receipt_number}</span>
                        {r.evidence_filename && (
                          <span title={`Evidencia: ${r.evidence_filename}`}>
                            <svg className="w-3.5 h-3.5 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
                            </svg>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="font-mono text-xs text-ink-muted">{r.purchase_order_number || '—'}</td>
                    <td className="text-sm text-ink-secondary">
                      {r.document_type && r.document_number
                        ? <span className="font-medium">{r.document_type} <span className="font-mono">{r.document_number}</span></span>
                        : <span className="text-ink-muted">—</span>
                      }
                    </td>
                    <td className="font-medium text-ink-secondary">
                      {r.partner_name || r.generic_supplier || <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="text-sm text-ink-muted">{r.warehouse_name || '—'}</td>
                    <td className="text-sm text-ink-secondary">{r.created_by_name || '—'}</td>
                    <td className="text-sm text-ink-muted">{r.confirmed_by_name || <span className="text-ink-muted">—</span>}</td>
                    <td><Badge status={r.status} /></td>
                    <td>
                      {r.status !== 'confirmed' ? (
                        <span className="text-ink-muted text-xs">—</span>
                      ) : r.invoiced_at && r.invoice_type === 'remission' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-info/15 text-status-info"
                          title={`CXP sin factura${r.invoice_number ? ` ${r.invoice_number}` : ''} — remisión no fiscal`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-status-info shrink-0" />
                          CXP s/f{r.invoice_number ? ` · ${r.invoice_number}` : ''}
                        </span>
                      ) : r.invoiced_at ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-success/15 text-status-success"
                          title={r.invoice_number ? `Factura ${r.invoice_number}` : 'Facturada'}>
                          <span className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0" />
                          Facturada{r.invoice_number ? ` · ${r.invoice_number}` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-warning/15 text-status-warning">
                          <span className="w-1.5 h-1.5 rounded-full bg-status-warning shrink-0" />
                          Sin factura
                        </span>
                      )}
                    </td>
                    <td className="text-sm text-ink-muted">{fmtDateOnly(r.received_date)}</td>
                    <td className="text-right font-mono text-sm font-medium">{fmtMXN(r.total_mxn)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      {r.status === 'draft' && (
                        <button onClick={() => setDetailId(r.id)} className="btn-primary btn-sm">
                          Confirmar →
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > 20 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                Mostrando {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} de {total}
              </p>
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                  className="btn-secondary btn-sm disabled:opacity-40">← Anterior</button>
                <button disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)}
                  className="btn-secondary btn-sm disabled:opacity-40">Siguiente →</button>
              </div>
            </div>
          )}
        </>
      )}

      {detailId && (
        <DetallePanel
          receiptId={detailId}
          onClose={() => setDetailId(null)}
          onEdit={(r) => { setDetailId(null); setEditReceipt(r) }}
        />
      )}

      {showNew && (
        <NuevaRecepcionModal
          preselectedOcId={preselectedOcId || undefined}
          onClose={() => setShowNew(false)}
          onCreated={() => setSuccess('Recepción guardada. Confírmala para actualizar el inventario.')}
        />
      )}

      {editReceipt && (
        <NuevaRecepcionModal
          editReceipt={editReceipt}
          onClose={() => setEditReceipt(null)}
          onCreated={() => setSuccess('Recepción actualizada.')}
        />
      )}
    </div>
  )
}
