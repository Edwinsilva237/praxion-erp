import { useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { partnersApi } from '@/api/partners'
import { productsApi } from '@/api/products'
import Autocomplete from '@/components/ui/Autocomplete'
import Spinner from '@/components/ui/Spinner'
import { fmtMXN, fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

export default function PreciosCliente() {
  const queryClient = useQueryClient()
  const [partner, setPartner] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [msg, setMsg] = useState(null)
  const [search, setSearch] = useState('')

  const searchPartners = useCallback(async (q) => {
    const res = await partnersApi.list({ search: q, type: 'customer', limit: 20 })
    return (res.data || res).map(p => ({ id: p.id, label: p.name, sub: p.rfc || '' }))
  }, [])

  const { data: prices = [], isLoading, isFetching } = useQuery({
    queryKey: ['customer-prices', partner?.id],
    queryFn:  () => partnersApi.listPrices(partner.id, { onlyActive: true }),
    enabled:  !!partner?.id,
  })

  const {
    data: globalSummary,
    isLoading: summaryLoading,
    error: summaryError,
  } = useQuery({
    queryKey: ['customer-prices-summary'],
    queryFn:  () => partnersApi.pricesSummary(),
    retry: false,
  })

  const { data: recentChanges = [] } = useQuery({
    queryKey: ['customer-prices-history'],
    queryFn:  () => partnersApi.pricesHistory(10),
    retry: false,
  })

  const updateMutation = useMutation({
    mutationFn: (body) => partnersApi.setPrice(partner.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer-prices', partner.id] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-summary'] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-history'] })
      setMsg('Precio actualizado.')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (priceId) => partnersApi.deletePrice(partner.id, priceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer-prices', partner.id] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-summary'] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-history'] })
      setMsg('Precio eliminado.')
    },
  })

  const filtered = useMemo(() => {
    if (!search.trim()) return prices
    const q = search.trim().toLowerCase()
    return prices.filter(p =>
      (p.sku || '').toLowerCase().includes(q) ||
      (p.product_name || '').toLowerCase().includes(q)
    )
  }, [prices, search])

  const summary = useMemo(() => {
    const withBase = prices.filter(p => Number(p.base_price) > 0)
    const sumPct = withBase.reduce((s, p) =>
      s + (Number(p.unit_price) / Number(p.base_price) - 1) * 100, 0)
    return {
      count: prices.length,
      withBase: withBase.length,
      avgPct: withBase.length ? sumPct / withBase.length : 0,
    }
  }, [prices])

  function exportCSV() {
    if (!prices.length || !partner) return
    const header = ['SKU', 'Producto', 'Tipo', 'Precio cliente', 'Moneda', 'Precio base', 'Moneda base', 'Diferencia %']
    const lines = prices.map(p => {
      const diff = p.base_price > 0
        ? ((Number(p.unit_price) / Number(p.base_price) - 1) * 100).toFixed(2)
        : ''
      return [
        p.sku,
        `"${(p.product_name || '').replace(/"/g, '""')}"`,
        p.product_type,
        p.unit_price,
        p.currency,
        p.base_price || '',
        p.base_currency || '',
        diff,
      ].join(',')
    })
    const csv = [header.join(','), ...lines].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `precios-${(partner.label || 'cliente').replace(/[^\w-]/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="page-enter flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Precios por cliente</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Consulta y edita los precios especiales que cada cliente tiene negociados.
            <span className="text-status-warning"> Captura el precio por unidad base del producto</span>
            <span className="text-ink-muted"> — al usar una presentación con factor &gt;1 se multiplica automáticamente.</span>
          </p>
        </div>
        {partner && prices.length > 0 && (
          <div className="flex gap-2">
            <button onClick={exportCSV} className="btn-ghost btn-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Exportar CSV
            </button>
            <button onClick={() => setShowAdd(true)} className="btn-primary btn-sm">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
              Agregar precio
            </button>
          </div>
        )}
      </div>

      {msg && (
        <div className="flex items-center gap-2 bg-status-success/10 border border-status-success/40 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-status-success shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
          <p className="text-sm text-status-success flex-1">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-status-success hover:text-status-success">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      )}

      {/* Selector de cliente */}
      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div className="min-w-[280px] flex-1 max-w-md">
          <label className="label">Cliente</label>
          <Autocomplete value={partner}
            onChange={(p) => { setPartner(p); setSearch('') }}
            onSearch={searchPartners}
            placeholder="Buscar cliente..." />
        </div>
        {partner && (
          <div className="flex-1 min-w-[200px]">
            <label className="label">Buscar producto</label>
            <input className="input" placeholder="SKU o nombre..."
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}
      </div>

      {/* Contenido */}
      {!partner ? (
        <GlobalSummary
          summary={globalSummary}
          loading={summaryLoading}
          error={summaryError}
          recentChanges={recentChanges}
          onSelectPartner={setPartner}
        />
      ) : isLoading ? (
        <div className="card flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {/* Resumen */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="card p-3">
              <p className="text-[10px] text-ink-muted uppercase tracking-wide">Productos con precio especial</p>
              <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.count}</p>
            </div>
            <div className="card p-3">
              <p className="text-[10px] text-ink-muted uppercase tracking-wide">Con precio base de referencia</p>
              <p className="text-lg font-semibold text-ink-primary mt-0.5">{summary.withBase}</p>
            </div>
            <div className={clsx('card p-3',
              summary.avgPct < 0 ? 'bg-status-success/10/40' : summary.avgPct > 0 ? 'bg-status-warning/10/40' : '')}>
              <p className={clsx('text-[10px] uppercase tracking-wide',
                summary.avgPct < 0 ? 'text-green-500' : summary.avgPct > 0 ? 'text-amber-500' : 'text-ink-muted')}>
                Diferencia promedio vs base
              </p>
              <p className={clsx('text-lg font-mono font-semibold mt-0.5',
                summary.avgPct < 0 ? 'text-status-success' : summary.avgPct > 0 ? 'text-status-warning' : 'text-ink-primary')}>
                {summary.withBase > 0 ? `${summary.avgPct > 0 ? '+' : ''}${summary.avgPct.toFixed(1)}%` : '—'}
              </p>
            </div>
          </div>

          {/* Tabla */}
          <div className="card overflow-hidden">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <p className="text-sm font-medium text-ink-secondary">
                  {search ? 'Sin resultados para los filtros' : 'Este cliente no tiene precios especiales registrados'}
                </p>
                {!search && (
                  <button onClick={() => setShowAdd(true)} className="btn-primary btn-sm">
                    Agregar primer precio
                  </button>
                )}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="text-right">Precio cliente</th>
                    <th>Moneda</th>
                    <th className="text-right">Precio base</th>
                    <th className="text-right">Dif. %</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => (
                    <PriceRow key={p.id} row={p}
                      busy={updateMutation.isPending || deleteMutation.isPending}
                      onSave={(price, currency) => updateMutation.mutate({
                        productId: p.product_id, unitPrice: price, currency,
                      })}
                      onDelete={() => {
                        if (confirm(`Eliminar precio especial de ${p.sku} para este cliente?`)) {
                          deleteMutation.mutate(p.id)
                        }
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {isFetching && !isLoading && (
              <p className="text-xs italic text-ink-muted px-4 py-2 border-t border-line-subtle">Actualizando…</p>
            )}
          </div>
        </>
      )}

      {showAdd && partner && (
        <AddPriceModal
          partnerId={partner.id}
          existingProductIds={prices.map(p => p.product_id)}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['customer-prices', partner.id] })
            queryClient.invalidateQueries({ queryKey: ['customer-prices-summary'] })
      queryClient.invalidateQueries({ queryKey: ['customer-prices-history'] })
            setMsg('Precio agregado.')
            setShowAdd(false)
          }}
        />
      )}
    </div>
  )
}

// ── Resumen global (cuando no hay cliente seleccionado) ─────────────────────
function GlobalSummary({ summary, loading, error, recentChanges = [], onSelectPartner }) {
  if (loading) {
    return <div className="card flex justify-center py-16"><Spinner /></div>
  }
  if (error || !summary) {
    return (
      <div className="card p-6 text-center space-y-2">
        <p className="text-sm font-medium text-ink-secondary">No se pudo cargar el resumen.</p>
        <p className="text-xs text-ink-muted">
          {error?.response?.status === 404
            ? 'El endpoint /business-partners/prices-summary no responde — reinicia el backend para tomar los cambios recientes.'
            : (error?.response?.data?.error || error?.message || 'Error desconocido')}
        </p>
      </div>
    )
  }

  const {
    partnersWithPrices, totalPrices,
    productsWithBase, productsWithoutBase,
    totalCustomers,
  } = summary

  const totalProducts = productsWithBase + productsWithoutBase
  const partnersCoverage = totalCustomers > 0
    ? Math.round((partnersWithPrices / totalCustomers) * 100)
    : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4">
          <p className="text-[10px] text-ink-muted uppercase tracking-wide">Clientes con precios</p>
          <p className="text-2xl font-semibold text-ink-primary mt-1">{partnersWithPrices}</p>
          <p className="text-xs text-ink-muted mt-1">
            de {totalCustomers} clientes activos
            {totalCustomers > 0 && <span className="text-ink-muted"> · {partnersCoverage}%</span>}
          </p>
        </div>

        <div className="card p-4">
          <p className="text-[10px] text-ink-muted uppercase tracking-wide">Precios negociados</p>
          <p className="text-2xl font-semibold text-ink-primary mt-1">{totalPrices}</p>
          <p className="text-xs text-ink-muted mt-1">combinaciones cliente × producto</p>
        </div>

        <div className="card p-4 bg-status-success/10/30">
          <p className="text-[10px] text-green-500 uppercase tracking-wide">Productos con precio base</p>
          <p className="text-2xl font-semibold text-status-success mt-1">{productsWithBase}</p>
          <p className="text-xs text-ink-muted mt-1">de {totalProducts} productos activos</p>
        </div>

        <div className={clsx('card p-4', productsWithoutBase > 0 ? 'bg-status-warning/10/40' : 'bg-surface-elevated/40/30')}>
          <p className={clsx('text-[10px] uppercase tracking-wide',
            productsWithoutBase > 0 ? 'text-amber-500' : 'text-ink-muted')}>
            Productos sin precio base
          </p>
          <p className={clsx('text-2xl font-semibold mt-1',
            productsWithoutBase > 0 ? 'text-status-warning' : 'text-ink-secondary')}>
            {productsWithoutBase}
          </p>
          <p className="text-xs text-ink-muted mt-1">
            {productsWithoutBase > 0
              ? 'Configúralos en Productos para ver comparativa'
              : 'Todos configurados'}
          </p>
        </div>
      </div>

      {/* Últimos cambios */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-line-subtle flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-primary">Últimos cambios en precios</h2>
          <span className="text-[10px] text-ink-muted uppercase tracking-wide">
            {recentChanges.length} {recentChanges.length === 1 ? 'registro' : 'registros'}
          </span>
        </div>
        {recentChanges.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-ink-muted">Aún no hay movimientos registrados.</p>
            <p className="text-xs text-ink-muted mt-1">
              Crea, edita o elimina un precio para empezar el historial.
            </p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Acción</th>
                <th>Cliente</th>
                <th>Producto</th>
                <th className="text-right">Antes</th>
                <th className="text-right">Ahora</th>
                <th>Usuario</th>
              </tr>
            </thead>
            <tbody>
              {recentChanges.map(c => (
                <ChangeRow key={c.id} change={c} onSelectPartner={onSelectPartner} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="text-center py-2">
        <p className="text-xs text-ink-muted">
          Usa el buscador de arriba para elegir un cliente y gestionar sus precios especiales.
        </p>
      </div>
    </div>
  )
}

function ChangeRow({ change, onSelectPartner }) {
  const isCreate = change.action === 'customer_price.created'
  const isUpdate = change.action === 'customer_price.updated'
  const isDelete = change.action === 'customer_price.deleted'

  const beforePrice = isUpdate ? change.before?.unitPrice : (isDelete ? change.unitPrice : null)
  const afterPrice  = isUpdate ? change.after?.unitPrice  : (isCreate ? change.after?.unitPrice : null)
  const currency    = change.after?.currency || change.before?.currency || change.currency || 'MXN'

  const label = isCreate ? 'Creó' : isUpdate ? 'Editó' : 'Eliminó'
  const badgeClass = isCreate ? 'bg-status-success/15 text-status-success'
    : isUpdate ? 'bg-status-info/15 text-status-info'
    : 'bg-status-danger/15 text-status-danger'

  return (
    <tr>
      <td className="text-xs text-ink-muted whitespace-nowrap">
        {fmtDate(change.createdAt)}
        <span className="text-ink-muted ml-1">
          {new Date(change.createdAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </td>
      <td>
        <span className={clsx('text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full', badgeClass)}>
          {label}
        </span>
      </td>
      <td>
        {change.partnerName ? (
          <button
            onClick={() => onSelectPartner({ id: change.partnerId, label: change.partnerName })}
            className="text-brand-300 hover:underline text-sm font-medium">
            {change.partnerName}
          </button>
        ) : (
          <span className="text-xs text-ink-muted italic">cliente eliminado</span>
        )}
      </td>
      <td>
        {change.productSku && (
          <p className="font-mono text-[10px] text-ink-muted">{change.productSku}</p>
        )}
        <p className="text-xs text-ink-secondary">{change.productName || <span className="italic text-ink-muted">producto eliminado</span>}</p>
      </td>
      <td className="text-right font-mono tabular-nums text-xs text-ink-muted">
        {beforePrice != null ? fmtMXN(beforePrice, currency) : '—'}
      </td>
      <td className={clsx('text-right font-mono tabular-nums text-xs font-semibold',
        isDelete ? 'text-status-danger' : 'text-ink-primary')}>
        {isDelete ? '—' : (afterPrice != null ? fmtMXN(afterPrice, currency) : '—')}
      </td>
      <td className="text-xs text-ink-muted">
        {change.userName || <span className="italic text-ink-muted">desconocido</span>}
      </td>
    </tr>
  )
}

// ── Fila editable inline ────────────────────────────────────────────────────
function PriceRow({ row, busy, onSave, onDelete }) {
  const [price, setPrice]       = useState(Number(row.unit_price))
  const [currency, setCurrency] = useState(row.currency || 'MXN')
  const [dirty, setDirty]       = useState(false)

  const basePrice  = row.base_price ? Number(row.base_price) : null
  const diffPct    = basePrice ? ((price / basePrice) - 1) * 100 : null

  const commit = () => {
    if (!dirty) return
    if (!price || price <= 0) {
      setPrice(Number(row.unit_price))
      setDirty(false)
      return
    }
    onSave(price, currency)
    setDirty(false)
  }

  return (
    <tr>
      <td>
        <p className="font-mono text-xs text-brand-300">{row.sku}</p>
        <p className="font-medium text-ink-primary">{row.product_name}</p>
      </td>
      <td className="text-right">
        <input type="number" step="0.01" min="0"
          value={price}
          onChange={e => { setPrice(parseFloat(e.target.value) || 0); setDirty(true) }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          disabled={busy}
          className="input w-28 text-right font-mono tabular-nums" />
      </td>
      <td>
        <select value={currency}
          onChange={e => { setCurrency(e.target.value); setDirty(true) }}
          onBlur={commit}
          disabled={busy}
          className="select w-20">
          <option value="MXN">MXN</option>
          <option value="USD">USD</option>
        </select>
      </td>
      <td className="text-right font-mono tabular-nums text-ink-muted text-xs">
        {basePrice ? fmtMXN(basePrice, row.base_currency) : '—'}
      </td>
      <td className={clsx('text-right font-mono tabular-nums text-xs',
        diffPct == null ? 'text-ink-muted' :
          diffPct < 0 ? 'text-status-success' :
          diffPct > 0 ? 'text-status-warning' : 'text-ink-muted')}>
        {diffPct == null ? '—' : `${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%`}
      </td>
      <td>
        <button onClick={onDelete} disabled={busy}
          className="btn-ghost btn-icon btn-sm text-ink-muted hover:text-status-danger disabled:opacity-40">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </td>
    </tr>
  )
}

// ── Modal: agregar precio ───────────────────────────────────────────────────
function AddPriceModal({ partnerId, existingProductIds, onClose, onSaved }) {
  const [product, setProduct]   = useState(null)
  const [price, setPrice]       = useState('')
  const [currency, setCurrency] = useState('MXN')
  const [error, setError]       = useState(null)

  const searchProducts = useCallback(async (q) => {
    const res = await productsApi.list({ search: q, isActive: true, limit: 20 })
    return (res.data || res)
      .filter(p => !existingProductIds.includes(p.id))
      .map(p => ({
        id: p.id, label: p.name, sub: p.sku,
        basePrice: p.base_price, baseCurrency: p.base_currency,
        baseUnit: p.base_unit,
      }))
  }, [existingProductIds])

  const mutation = useMutation({
    mutationFn: () => partnersApi.setPrice(partnerId, {
      productId: product.id,
      unitPrice: parseFloat(price),
      currency,
    }),
    onSuccess: onSaved,
    onError: (err) => setError(err.response?.data?.error || err.message),
  })

  // Cuando seleccionas producto, sugerir precio y moneda base
  const handleProductChange = (p) => {
    setProduct(p)
    if (p?.basePrice) setPrice(p.basePrice)
    if (p?.baseCurrency) setCurrency(p.baseCurrency)
  }

  const submit = (e) => {
    e.preventDefault()
    setError(null)
    if (!product) return setError('Selecciona un producto.')
    if (!price || parseFloat(price) <= 0) return setError('Precio debe ser mayor a 0.')
    mutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-surface-primary rounded-xl shadow-card w-full max-w-md" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="px-5 py-4 border-b border-line-subtle flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink-primary">Agregar precio especial</h2>
            <button type="button" onClick={onClose} className="btn-ghost btn-icon btn-sm">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <div className="p-5 space-y-3">
            <div>
              <label className="label">Producto</label>
              <Autocomplete value={product}
                onChange={handleProductChange}
                onSearch={searchProducts}
                placeholder="Buscar por SKU o nombre..." />
            </div>
            {product?.basePrice && (
              <p className="text-xs text-ink-muted">
                Precio base: <span className="font-mono">{fmtMXN(product.basePrice, product.baseCurrency)}</span>
              </p>
            )}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className="label">Precio por unidad base</label>
                <input type="number" step="0.01" min="0"
                  value={price} onChange={e => setPrice(e.target.value)}
                  placeholder="0.00" className="input text-right font-mono" autoFocus />
                {product?.baseUnit && (
                  <p className="text-[10px] text-status-warning mt-1">
                    Captura el precio por <strong>1 {product.baseUnit}</strong>. Al facturar con
                    una presentación múltiple se multiplica automáticamente.
                  </p>
                )}
              </div>
              <div>
                <label className="label">Moneda</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)} className="select w-24">
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
            {error && <p className="text-xs text-status-danger">{error}</p>}
          </div>
          <div className="px-5 py-3 border-t border-line-subtle flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-ghost btn-sm">Cancelar</button>
            <button type="submit" disabled={mutation.isPending} className="btn-primary btn-sm">
              {mutation.isPending ? 'Guardando…' : 'Agregar'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}
