import { useState, useMemo, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { inventoryApi } from '@/api/inventory'
import Autocomplete from '@/components/ui/Autocomplete'
import Badge from '@/components/ui/Badge'
import Spinner from '@/components/ui/Spinner'
import SignaturePad from '@/components/ui/SignaturePad'
import Can from '@/components/auth/Can'
import { fmtNum, fmtDateOnly, fmtDate } from '@/utils/fmt'
import { downloadBlob, printBlob } from '@/utils/downloadBlob'
import { genId } from '@/utils/genId'
import clsx from 'clsx'

// ─────────────────────────────────────────────────────────────────────────────
//  Vales de salida — consumo interno a áreas (migs 245/246, firma mig 247).
//  El almacenista libera material a un área (producción, empaque, mantenimiento)
//  sin venta de por medio: baja el stock con costo promedio y queda quién recibió
//  (con firma en pantalla opcional). El VALOR del consumo se guarda en BD para
//  reportes, pero NO se muestra en pantalla ni en el PDF (pedido del usuario).
// ─────────────────────────────────────────────────────────────────────────────

export default function ValesSalida() {
  const qc = useQueryClient()

  // Filtros
  const [warehouseFilter, setWH] = useState('')
  const [areaFilter, setArea]    = useState('')
  const [statusFilter, setStatus] = useState('')
  const [dateFrom, setDateFrom]  = useState('')
  const [dateTo, setDateTo]      = useState('')
  const [search, setSearch]      = useState('')
  const [page, setPage]          = useState(1)

  // UI
  const [showCreate, setShowCreate]   = useState(false)
  const [showAreas, setShowAreas]     = useState(false)
  const [selectedId, setSelectedId]   = useState(null)
  const [createdMsg, setCreatedMsg]   = useState(null)

  const { data: warehouses = [] } = useQuery({
    queryKey: ['inv-warehouses'],
    queryFn:  inventoryApi.getWarehouses,
  })
  const { data: areas = [] } = useQuery({
    queryKey: ['consumption-areas'],
    queryFn:  () => inventoryApi.listConsumptionAreas(),
  })
  const { data: listData, isLoading } = useQuery({
    queryKey: ['consumption-vouchers', warehouseFilter, areaFilter, statusFilter, dateFrom, dateTo, search, page],
    queryFn:  () => inventoryApi.listConsumptionVouchers({
      warehouse_id: warehouseFilter || undefined,
      area_id:      areaFilter      || undefined,
      status:       statusFilter    || undefined,
      date_from:    dateFrom        || undefined,
      date_to:      dateTo          || undefined,
      search:       search          || undefined,
      page, limit: 25,
    }),
  })
  const { data: byArea = [] } = useQuery({
    queryKey: ['consumption-by-area', dateFrom, dateTo],
    queryFn:  () => inventoryApi.consumptionByArea({
      date_from: dateFrom || undefined,
      date_to:   dateTo   || undefined,
    }),
  })

  const rows = listData?.data || []
  const total = listData?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / 25))

  function flash(msg) {
    setCreatedMsg(msg)
    setTimeout(() => setCreatedMsg(null), 6000)
  }

  return (
    <div className="page-enter flex flex-col gap-6">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Vales de salida</h1>
          <p className="page-subtitle">Consumo interno: entregas de material a áreas sin venta de por medio</p>
        </div>
        <Can do="inventory:adjust">
          <div className="flex gap-2">
            <button onClick={() => setShowAreas(true)} className="btn-secondary">
              Áreas
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary">
              + Nuevo vale
            </button>
          </div>
        </Can>
      </div>

      {createdMsg && (
        <div className="bg-status-success/10 border border-status-success/40 rounded-xl px-4 py-2 text-sm text-status-success">
          {createdMsg}
        </div>
      )}

      {/* ── Resumen por área (respeta el rango de fechas filtrado) ──── */}
      {byArea.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {byArea.slice(0, 8).map(a => (
            <button key={a.area_id}
              onClick={() => { setArea(prev => prev === a.area_id ? '' : a.area_id); setPage(1) }}
              className={clsx(
                'card p-3 text-left transition-all',
                areaFilter === a.area_id ? 'ring-1 ring-brand-300' : 'hover:bg-surface-elevated/40'
              )}>
              <p className="text-[11px] uppercase tracking-wider text-ink-muted truncate">{a.area_name}</p>
              <p className="text-base font-bold font-mono text-ink-primary mt-1">{a.vouchers} vale{a.vouchers !== 1 && 's'}</p>
            </button>
          ))}
        </div>
      )}

      {/* ── Filtros ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="label">Almacén</label>
          <select className="select" value={warehouseFilter} onChange={e => { setWH(e.target.value); setPage(1) }}>
            <option value="">Todos</option>
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Área</label>
          <select className="select" value={areaFilter} onChange={e => { setArea(e.target.value); setPage(1) }}>
            <option value="">Todas</option>
            {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Estado</label>
          <select className="select" value={statusFilter} onChange={e => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Todos</option>
            <option value="active">Activos</option>
            <option value="cancelled">Cancelados</option>
          </select>
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1) }} />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Folio o quién recibió..."
            value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
        </div>
      </div>

      {/* ── Tabla ──────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-sm text-ink-secondary">No hay vales con esos filtros.</p>
          <Can do="inventory:adjust">
            <button onClick={() => setShowCreate(true)} className="btn-primary btn-sm mt-3">+ Nuevo vale</button>
          </Can>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Fecha</th>
                  <th>Almacén</th>
                  <th>Área</th>
                  <th>Recibió</th>
                  <th className="text-right">Líneas</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(v => (
                  <tr key={v.id} className="cursor-pointer hover:bg-surface-elevated/40"
                    onClick={() => setSelectedId(v.id)}>
                    <td className="font-mono text-xs">{v.voucher_number}</td>
                    <td className="text-xs">{fmtDateOnly(v.voucher_date)}</td>
                    <td className="text-xs">{v.warehouse_name}</td>
                    <td className="text-xs">{v.area_name}</td>
                    <td className="text-xs">{v.received_by}</td>
                    <td className="text-right text-xs">{v.total_lines}</td>
                    <td>
                      <Badge
                        variant={v.status === 'cancelled' ? 'red' : 'green'}
                        label={v.status === 'cancelled' ? 'Cancelado' : 'Activo'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-line-subtle text-xs text-ink-muted">
              <span>{total} vale{total !== 1 && 's'}</span>
              <div className="flex gap-2 items-center">
                <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>←</button>
                <span>Página {page} de {totalPages}</span>
                <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>→</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Modales ────────────────────────────────────────────────── */}
      {showCreate && (
        <NuevoValeModal
          warehouses={warehouses}
          areas={areas}
          onClose={() => setShowCreate(false)}
          onSaved={(v) => {
            qc.invalidateQueries({ queryKey: ['consumption-vouchers'] })
            qc.invalidateQueries({ queryKey: ['consumption-by-area'] })
            qc.invalidateQueries({ queryKey: ['inv-stock'] })
            qc.invalidateQueries({ queryKey: ['inv-summary'] })
            qc.invalidateQueries({ queryKey: ['inv-movements'] })
            flash(`Vale ${v.voucher_number} guardado — inventario descontado.`)
            setShowCreate(false)
          }}
        />
      )}
      {showAreas && (
        <AreasModal onClose={() => setShowAreas(false)} />
      )}
      {selectedId && (
        <ValeDetalleModal
          voucherId={selectedId}
          onClose={() => setSelectedId(null)}
          onCancelled={(v) => {
            qc.invalidateQueries({ queryKey: ['consumption-vouchers'] })
            qc.invalidateQueries({ queryKey: ['consumption-by-area'] })
            qc.invalidateQueries({ queryKey: ['inv-stock'] })
            qc.invalidateQueries({ queryKey: ['inv-summary'] })
            qc.invalidateQueries({ queryKey: ['inv-movements'] })
            flash(`Vale ${v.voucher_number} cancelado — material reingresado al almacén.`)
            setSelectedId(null)
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modal: nuevo vale
// ─────────────────────────────────────────────────────────────────────────────
const EMPTY_LINE = () => ({ uid: genId(), itemType: 'raw_material', item: null, quantity: '' })

function NuevoValeModal({ warehouses = [], areas = [], onClose, onSaved }) {
  const qc = useQueryClient()
  const usableWarehouses = useMemo(() => warehouses.filter(w => w.type !== 'wip'), [warehouses])

  const [warehouseId, setWarehouseId] = useState('')
  const [areaId, setAreaId]           = useState('')
  const [receivedBy, setReceivedBy]   = useState('')
  const [notes, setNotes]             = useState('')
  const [lines, setLines]             = useState([EMPTY_LINE()])
  const [newAreaName, setNewAreaName] = useState('')
  const [signature, setSignature]     = useState(null)   // data URL PNG (opcional)
  const [signOpen, setSignOpen]       = useState(false)
  const [serverError, setServerError] = useState(null)
  const [showFieldErrors, setShowFieldErrors] = useState(false)

  const buildSearchFn = useCallback((itemType) => async (q) => {
    const data = await inventoryApi.searchItems({
      q, type: itemType, warehouseId: warehouseId || undefined, limit: 10,
    })
    return data.map(it => ({
      id: it.id,
      label: it.name,
      sub: `${it.sku ? `SKU ${it.sku} · ` : ''}${it.unit}${warehouseId ? ` · stock: ${fmtNum(it.current_quantity)}` : ''}`,
      meta: it,
    }))
  }, [warehouseId])

  const createAreaMut = useMutation({
    mutationFn: inventoryApi.createConsumptionArea,
    onSuccess: (area) => {
      qc.invalidateQueries({ queryKey: ['consumption-areas'] })
      setAreaId(area.id)
      setNewAreaName('')
    },
    onError: (err) => setServerError(err.response?.data?.error || 'No se pudo crear el área.'),
  })

  const mutation = useMutation({
    mutationFn: inventoryApi.createConsumptionVoucher,
    onSuccess: (v) => onSaved?.(v),
    onError: (err) => setServerError(err.response?.data?.error || 'Error al guardar el vale.'),
  })

  function updateLine(uid, patch) { setLines(prev => prev.map(l => l.uid === uid ? { ...l, ...patch } : l)) }
  function removeLine(uid) { setLines(prev => prev.length === 1 ? prev : prev.filter(l => l.uid !== uid)) }

  function lineHasStockWarning(l) {
    if (!l.item) return false
    const q = parseFloat(l.quantity)
    if (!q || q <= 0) return false
    return q > parseFloat(l.item.current_quantity || 0)
  }

  const validation = useMemo(() => {
    const errors = []
    if (!warehouseId) errors.push('Selecciona el almacén de origen.')
    if (!areaId) errors.push('Selecciona el área destino.')
    if (!receivedBy.trim()) errors.push('Escribe quién recibe el material.')
    if (!lines.some(l => l.item && parseFloat(l.quantity) > 0)) errors.push('Agrega al menos una línea válida.')
    if (lines.some(lineHasStockWarning)) errors.push('Hay líneas que exceden el stock disponible.')
    return { errors, isValid: errors.length === 0 }
  }, [warehouseId, areaId, receivedBy, lines])

  function handleSubmit() {
    setShowFieldErrors(true)
    setServerError(null)
    if (!validation.isValid) return
    mutation.mutate({
      warehouseId, areaId,
      receivedBy: receivedBy.trim(),
      notes: notes.trim() || undefined,
      signatureDataUrl: signature || undefined,
      lines: lines
        .filter(l => l.item && parseFloat(l.quantity) > 0)
        .map(l => ({
          itemType: l.itemType,
          itemId:   l.item.id,
          quantity: parseFloat(l.quantity),
          unit:     l.item.unit,
        })),
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="card w-full max-w-3xl my-6 p-6 max-h-[95vh] flex flex-col">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Nuevo vale de salida</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              El stock baja con el costo promedio vigente y el consumo queda valorizado por área.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1">
          {/* Cabecera */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="label">Almacén origen *</label>
              <select
                className={clsx('select', showFieldErrors && !warehouseId && 'border-status-danger/40')}
                value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
                <option value="">Selecciona almacén</option>
                {usableWarehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name}{w.is_default ? ' ⭐' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Área destino *</label>
              <select
                className={clsx('select', showFieldErrors && !areaId && 'border-status-danger/40')}
                value={areaId} onChange={e => setAreaId(e.target.value)}>
                <option value="">Selecciona área</option>
                {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {areas.length === 0 && (
                <div className="flex gap-1 mt-1">
                  <input className="input input-sm flex-1" placeholder="Nombre de la primera área..."
                    value={newAreaName} onChange={e => setNewAreaName(e.target.value)} />
                  <button type="button" className="btn-secondary btn-sm"
                    disabled={!newAreaName.trim() || createAreaMut.isPending}
                    onClick={() => createAreaMut.mutate(newAreaName.trim())}>
                    Crear
                  </button>
                </div>
              )}
            </div>
            <div>
              <label className="label">Recibe (nombre) *</label>
              <input
                className={clsx('input', showFieldErrors && !receivedBy.trim() && 'border-status-danger/40')}
                placeholder="Quién recibe el material"
                value={receivedBy} onChange={e => setReceivedBy(e.target.value)} maxLength={150} />
            </div>
            <div className="md:col-span-3">
              <label className="label">Notas <span className="text-ink-muted font-normal">(opcional)</span></label>
              <input className="input" placeholder="Contexto de la entrega..."
                value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>

          {!warehouseId && (
            <div className="bg-status-warning/10 border border-status-warning/40 rounded-xl px-3 py-2 mb-4 text-xs text-status-warning">
              Selecciona primero el almacén para que el buscador muestre saldos y costos.
            </div>
          )}

          {/* Líneas */}
          <div className="border-t border-line-subtle pt-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-ink-secondary">Material a entregar</h3>
              <button type="button" onClick={() => setLines(prev => [...prev, EMPTY_LINE()])} className="btn-secondary btn-sm">
                + Agregar línea
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {lines.map((line, idx) => {
                const warn = lineHasStockWarning(line)
                return (
                  <div key={line.uid} className={clsx(
                    'border rounded-xl p-3',
                    warn ? 'border-status-danger/40' : 'border-line-subtle bg-surface-primary'
                  )}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex bg-surface-elevated/60 rounded-lg p-0.5 text-xs">
                        <button type="button" onClick={() => updateLine(line.uid, { itemType: 'raw_material', item: null })}
                          className={clsx('px-3 py-1 rounded-md font-medium transition-all',
                            line.itemType === 'raw_material' ? 'bg-surface-primary shadow text-status-warning' : 'text-ink-muted hover:text-ink-secondary')}>
                          Materia prima
                        </button>
                        <button type="button" onClick={() => updateLine(line.uid, { itemType: 'product', item: null })}
                          className={clsx('px-3 py-1 rounded-md font-medium transition-all',
                            line.itemType === 'product' ? 'bg-surface-primary shadow text-brand-300' : 'text-ink-muted hover:text-ink-secondary')}>
                          Producto
                        </button>
                      </div>
                      {lines.length > 1 && (
                        <button type="button" onClick={() => removeLine(line.uid)}
                          className="text-ink-muted hover:text-status-danger p-1" title="Eliminar línea">✕</button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
                      <div>
                        <label className="label">Artículo *</label>
                        <Autocomplete
                          value={line.item ? { id: line.item.id, label: line.item.name } : null}
                          onChange={(sel) => updateLine(line.uid, { item: sel?.meta || null })}
                          onSearch={buildSearchFn(line.itemType)}
                          placeholder={`Buscar ${line.itemType === 'raw_material' ? 'materia prima' : 'producto'}...`}
                        />
                        {line.item && warehouseId && (
                          <p className="text-[11px] text-ink-muted mt-1 ml-1">
                            Stock disponible: {fmtNum(line.item.current_quantity)} {line.item.unit}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="label">
                          Cantidad * {line.item && <span className="text-ink-muted font-normal">({line.item.unit})</span>}
                        </label>
                        <input type="number" step="0.0001" min="0.0001"
                          className={clsx('input', warn && 'border-status-danger/40 focus:ring-status-danger/40')}
                          placeholder="0.00" value={line.quantity}
                          onChange={e => updateLine(line.uid, { quantity: e.target.value })} />
                        {warn && (
                          <p className="text-[11px] text-status-danger mt-1">
                            Excede el stock ({fmtNum(line.item.current_quantity)} {line.item.unit}).
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Firma del receptor (opcional) */}
          <div className="border-t border-line-subtle pt-4 mt-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-ink-secondary">Firma del receptor <span className="text-ink-muted font-normal text-xs">(opcional)</span></p>
                <p className="text-[11px] text-ink-muted">Quien recibe puede firmar aquí; la firma sale en el PDF del vale.</p>
              </div>
              {!signature ? (
                <button type="button" className="btn-secondary btn-sm" onClick={() => setSignOpen(true)}>
                  ✍ Capturar firma
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <img src={signature} alt="Firma" className="h-12 bg-white rounded border border-line-subtle" />
                  <button type="button" className="btn-ghost btn-sm text-xs text-ink-muted" onClick={() => setSignature(null)}>
                    Quitar
                  </button>
                </div>
              )}
            </div>
          </div>

          {showFieldErrors && validation.errors.length > 0 && (
            <ul className="mt-4 bg-status-warning/10 border border-status-warning/40 rounded-xl px-4 py-3 text-xs text-status-warning list-disc list-inside space-y-0.5">
              {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {serverError && (
            <p className="mt-4 bg-status-danger/10 border border-status-danger/40 rounded-xl px-4 py-3 text-xs text-status-danger">
              {serverError}
            </p>
          )}
        </div>

        <div className="flex gap-2 pt-4 border-t border-line-subtle mt-4">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="button" disabled={mutation.isPending} onClick={handleSubmit}
            className="btn-primary flex-1 disabled:opacity-50">
            {mutation.isPending ? <Spinner size="sm" /> : 'Guardar vale y descontar stock'}
          </button>
        </div>

        {signOpen && (
          <FirmaReceptorModal
            receiverName={receivedBy}
            onClose={() => setSignOpen(false)}
            onSigned={(dataUrl) => { setSignature(dataUrl); setSignOpen(false) }}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mini-modal: firma en pantalla del receptor (pad simple, sin componer imagen)
// ─────────────────────────────────────────────────────────────────────────────
function FirmaReceptorModal({ receiverName, onClose, onSigned }) {
  const padRef = useRef(null)
  const [sigEmpty, setSigEmpty] = useState(true)

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-3 sm:p-4">
      <div className="card w-full max-w-xl p-4 sm:p-5 flex flex-col gap-3"
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink-primary">Firma del receptor</h3>
            {receiverName?.trim() && <p className="text-xs text-ink-muted mt-0.5">{receiverName}</p>}
          </div>
          <button type="button" onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>
        <div className="h-52 sm:h-60">
          <SignaturePad ref={padRef} onChange={setSigEmpty} />
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={() => padRef.current?.clear()}
            className="btn-ghost btn-sm text-xs text-ink-muted">Limpiar</button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancelar</button>
          <button type="button" disabled={sigEmpty} className="btn-primary flex-1 disabled:opacity-50"
            onClick={() => {
              const dataUrl = padRef.current?.toDataURL()
              if (dataUrl) onSigned(dataUrl)
            }}>
            Usar firma
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modal: detalle del vale (+ cancelar + PDF)
// ─────────────────────────────────────────────────────────────────────────────
function ValeDetalleModal({ voucherId, onClose, onCancelled }) {
  const [cancelling, setCancelling] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [error, setError] = useState(null)
  const [pdfBusy, setPdfBusy] = useState(false)

  const { data: v, isLoading } = useQuery({
    queryKey: ['consumption-voucher', voucherId],
    queryFn:  () => inventoryApi.getConsumptionVoucher(voucherId),
  })

  const cancelMut = useMutation({
    mutationFn: () => inventoryApi.cancelConsumptionVoucher(voucherId, cancelReason.trim()),
    onSuccess: (res) => onCancelled?.(res),
    onError: (err) => setError(err.response?.data?.error || 'Error al cancelar el vale.'),
  })

  async function handlePdf(print = false) {
    setPdfBusy(true)
    try {
      const blob = await inventoryApi.getConsumptionVoucherPdf(voucherId)
      if (print) printBlob(blob)
      else downloadBlob(blob, `vale-${v?.voucher_number || voucherId}.pdf`)
    } catch {
      setError('No se pudo generar el PDF.')
    } finally {
      setPdfBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}>
      <div className="card w-full max-w-2xl my-6 p-6 max-h-[95vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {isLoading || !v ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : (
          <>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-ink-primary font-mono">{v.voucher_number}</h2>
                  <Badge
                    variant={v.status === 'cancelled' ? 'red' : 'green'}
                    label={v.status === 'cancelled' ? 'Cancelado' : 'Activo'}
                  />
                </div>
                <p className="text-xs text-ink-muted mt-0.5">
                  {fmtDateOnly(v.voucher_date)} · {v.warehouse_name} → <strong>{v.area_name}</strong>
                </p>
              </div>
              <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-surface-secondary border border-line-subtle rounded-lg px-3 py-2">
                  <p className="text-[10px] uppercase text-ink-muted tracking-wider">Recibió</p>
                  <p className="font-medium text-ink-primary">{v.received_by}</p>
                </div>
                <div className="bg-surface-secondary border border-line-subtle rounded-lg px-3 py-2">
                  <p className="text-[10px] uppercase text-ink-muted tracking-wider">Entregó</p>
                  <p className="font-medium text-ink-primary">{v.created_by_name || '—'}</p>
                </div>
              </div>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Artículo</th>
                      <th className="text-right">Cantidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(v.lines || []).map(l => {
                      const qty = Math.abs(parseFloat(l.quantity))
                      return (
                        <tr key={l.id}>
                          <td className="text-xs">
                            {l.item_name}
                            {l.item_sku && <span className="text-ink-muted ml-1">#{l.item_sku}</span>}
                          </td>
                          <td className="text-right text-xs font-mono">{fmtNum(qty)} {l.unit}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {v.receiver_signature_path && <FirmaPreview voucherId={v.id} />}

              {v.notes && (
                <p className="text-xs text-ink-secondary bg-surface-secondary border border-line-subtle rounded-lg px-3 py-2">
                  {v.notes}
                </p>
              )}

              {v.status === 'cancelled' && (
                <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-xs text-status-danger">
                  Cancelado el {fmtDate(v.cancelled_at)}{v.cancelled_by_name ? ` por ${v.cancelled_by_name}` : ''}.
                  {v.cancellation_reason && <> Motivo: {v.cancellation_reason}</>}
                  {' '}El material fue reingresado al almacén.
                </div>
              )}

              {cancelling && v.status === 'active' && (
                <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-status-warning">
                    Cancelar el vale <strong>reingresa el material al almacén</strong>. Escribe el motivo:
                  </p>
                  <input className="input" placeholder="Motivo de la cancelación *"
                    value={cancelReason} onChange={e => setCancelReason(e.target.value)} autoFocus />
                  <div className="flex gap-2">
                    <button className="btn-secondary btn-sm flex-1" onClick={() => { setCancelling(false); setCancelReason('') }}>
                      No cancelar
                    </button>
                    <button className="btn-primary btn-sm flex-1 !bg-status-danger hover:!bg-status-danger/90"
                      disabled={!cancelReason.trim() || cancelMut.isPending}
                      onClick={() => { setError(null); cancelMut.mutate() }}>
                      {cancelMut.isPending ? <Spinner size="sm" /> : 'Confirmar cancelación'}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <p className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-xs text-status-danger">
                  {error}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 pt-4 border-t border-line-subtle mt-4">
              <button className="btn-secondary btn-sm" disabled={pdfBusy} onClick={() => handlePdf(false)}>
                {pdfBusy ? <Spinner size="sm" /> : '⬇ PDF'}
              </button>
              <button className="btn-secondary btn-sm" disabled={pdfBusy} onClick={() => handlePdf(true)}>
                🖨 Imprimir
              </button>
              <div className="flex-1" />
              {v.status === 'active' && !cancelling && (
                <Can do="inventory:adjust">
                  <button className="btn-secondary btn-sm text-status-danger hover:bg-status-danger/10"
                    onClick={() => setCancelling(true)}>
                    Cancelar vale
                  </button>
                </Can>
              )}
              <button className="btn-secondary btn-sm" onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

// Miniatura de la firma del receptor (el endpoint requiere Bearer → va por
// axios como blob y se muestra vía object URL).
function FirmaPreview({ voucherId }) {
  const { data: url } = useQuery({
    queryKey: ['voucher-signature', voucherId],
    queryFn: async () => {
      const blob = await inventoryApi.getConsumptionVoucherSignature(voucherId)
      return URL.createObjectURL(blob)
    },
    staleTime: Infinity,
  })
  if (!url) return null
  return (
    <div className="bg-surface-secondary border border-line-subtle rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase text-ink-muted tracking-wider mb-1">Firma del receptor</p>
      <img src={url} alt="Firma del receptor" className="h-16 bg-white rounded" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modal: administrar áreas de consumo
// ─────────────────────────────────────────────────────────────────────────────
function AreasModal({ onClose }) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)

  const { data: areas = [], isLoading } = useQuery({
    queryKey: ['consumption-areas', 'all'],
    queryFn:  () => inventoryApi.listConsumptionAreas(true),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['consumption-areas'] })
  }

  const createMut = useMutation({
    mutationFn: inventoryApi.createConsumptionArea,
    onSuccess: () => { invalidate(); setNewName(''); setError(null) },
    onError: (err) => setError(err.response?.data?.error || 'No se pudo crear el área.'),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, body }) => inventoryApi.updateConsumptionArea(id, body),
    onSuccess: () => { invalidate(); setError(null) },
    onError: (err) => setError(err.response?.data?.error || 'No se pudo actualizar el área.'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5 space-y-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-primary">Áreas de consumo</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">✕</button>
        </div>
        <p className="text-xs text-ink-muted">
          Destinos de los vales: producción, empaque, mantenimiento, oficinas... Las áreas
          desactivadas conservan su historial pero ya no aparecen al crear vales.
        </p>

        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Nueva área..."
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) createMut.mutate(newName.trim()) }} />
          <button className="btn-primary btn-sm" disabled={!newName.trim() || createMut.isPending}
            onClick={() => createMut.mutate(newName.trim())}>
            {createMut.isPending ? <Spinner size="sm" /> : 'Agregar'}
          </button>
        </div>

        {error && (
          <p className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2 text-xs text-status-danger">{error}</p>
        )}

        <div className="flex-1 overflow-y-auto space-y-1.5">
          {isLoading ? <div className="py-6 flex justify-center"><Spinner /></div> :
            areas.length === 0 ? <p className="text-xs text-ink-muted text-center py-4">Sin áreas todavía — crea la primera arriba.</p> :
            areas.map(a => (
              <div key={a.id} className={clsx(
                'flex items-center gap-2 border rounded-lg px-3 py-2',
                a.is_active ? 'border-line-subtle' : 'border-line-subtle opacity-50'
              )}>
                <span className="flex-1 text-sm text-ink-primary truncate">{a.name}</span>
                <button className="btn-secondary btn-sm text-xs" disabled={updateMut.isPending}
                  onClick={() => updateMut.mutate({ id: a.id, body: { isActive: !a.is_active } })}>
                  {a.is_active ? 'Desactivar' : 'Reactivar'}
                </button>
              </div>
            ))}
        </div>

        <button onClick={onClose} className="btn-secondary w-full">Cerrar</button>
      </div>
    </div>,
    document.body
  )
}
