import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { createPortal } from 'react-dom'
import { platformAdminApi } from '@/api/platformAdmin'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'

// Helper para mostrar precio. Stripe maneja centavos internamente, pero en
// MXN normalmente se ve sin decimales para suscripciones redondas.
function fmtPrice(cents, currency = 'MXN') {
  const v = (cents || 0) / 100
  return new Intl.NumberFormat('es-MX', {
    style: 'currency', currency, maximumFractionDigits: 0,
  }).format(v)
}

export default function PlansList() {
  const [editing, setEditing] = useState(null)

  const { data: plans, isLoading } = useQuery({
    queryKey: ['platform-admin', 'plans'],
    queryFn:  platformAdminApi.listPlans,
  })

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Plataforma · Planes</h1>
        <p className="text-sm text-ink-muted mt-1">
          Configura los planes que ofrecen a los tenants. Los precios aquí son <strong>solo display</strong>:
          Stripe es la fuente de verdad para cobros vía <code className="text-[11px] bg-surface-elevated px-1 rounded">stripe_price_id</code>.
        </p>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Precio (display)</th>
                <th>Límites</th>
                <th>Stripe</th>
                <th>Suscripciones</th>
                <th>Estado</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-12 text-ink-muted">
                  <Spinner size="sm" /> Cargando planes…
                </td></tr>
              )}
              {!isLoading && plans?.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-ink-muted text-sm">
                  No hay planes configurados.
                </td></tr>
              )}
              {plans?.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-medium text-ink-primary">{p.name}</div>
                    <div className="text-xs text-ink-muted font-mono">{p.slug}</div>
                    {p.description && (
                      <div className="text-xs text-ink-muted mt-0.5 max-w-xs truncate" title={p.description}>
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="text-ink-primary font-medium">
                    {p.price_mxn_cents > 0 ? `${fmtPrice(p.price_mxn_cents, p.currency)}/mes` : 'Gratis'}
                  </td>
                  <td className="text-xs text-ink-secondary">
                    <div>{p.max_users ?? '∞'} usuarios</div>
                    <div>{p.max_invoices_per_month ?? '∞'} facturas/mes</div>
                  </td>
                  <td>
                    {p.slug === 'owner' ? (
                      <Badge variant="gray" label="Interno" />
                    ) : p.stripe_price_id ? (
                      <span title={p.stripe_price_id}>
                        <Badge variant="green" label="Configurado" />
                      </span>
                    ) : p.price_mxn_cents > 0 ? (
                      <Badge variant="amber" label="Falta price_id" />
                    ) : (
                      <Badge variant="gray" label="No aplica" />
                    )}
                  </td>
                  <td className="text-center font-mono text-sm">
                    {p.active_subscriptions_count}
                  </td>
                  <td>
                    <Badge
                      variant={p.active ? 'green' : 'gray'}
                      label={p.active ? 'Activo' : 'Inactivo'}
                    />
                  </td>
                  <td>
                    <button onClick={() => setEditing(p)}
                      className="btn-ghost btn-sm btn-icon text-ink-muted hover:text-ink-secondary"
                      title="Editar plan">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <PlanEditModal
          plan={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ─── Modal de edición ────────────────────────────────────────────────────────
function PlanEditModal({ plan, onClose }) {
  const qc = useQueryClient()
  const [serverError, setServerError] = useState(null)

  const { register, handleSubmit, watch, setValue, formState: { errors, isDirty } } = useForm({
    defaultValues: {
      name:                   plan.name || '',
      description:            plan.description || '',
      price_mxn_cents:        plan.price_mxn_cents ?? 0,
      currency:               plan.currency || 'MXN',
      stripe_price_id:        plan.stripe_price_id || '',
      max_users:              plan.max_users ?? '',
      max_invoices_per_month: plan.max_invoices_per_month ?? '',
      sort_order:             plan.sort_order ?? 0,
      active:                 plan.active !== false,
    },
  })

  const isOwner = plan.slug === 'owner'

  const mutation = useMutation({
    mutationFn: (data) => platformAdminApi.updatePlan(plan.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-admin', 'plans'] })
      onClose()
    },
    onError: (e) => {
      setServerError(e.response?.data?.error || e.message || 'Error al guardar')
    },
  })

  const onSubmit = (raw) => {
    setServerError(null)
    // Normalizar: vacío → null, números a int.
    const patch = {
      name:                   raw.name?.trim() || plan.name,
      description:            raw.description?.trim() || null,
      price_mxn_cents:        parseInt(raw.price_mxn_cents, 10) || 0,
      currency:               raw.currency || 'MXN',
      stripe_price_id:        raw.stripe_price_id?.trim() || null,
      max_users:              raw.max_users === '' || raw.max_users == null ? null : parseInt(raw.max_users, 10),
      max_invoices_per_month: raw.max_invoices_per_month === '' || raw.max_invoices_per_month == null
                                ? null
                                : parseInt(raw.max_invoices_per_month, 10),
      sort_order:             parseInt(raw.sort_order, 10) || 0,
      active:                 !!raw.active,
    }
    mutation.mutate(patch)
  }

  // Convertir centavos ↔ pesos para que el input se muestre amigable.
  const pesos = (watch('price_mxn_cents') || 0) / 100

  const content = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-line-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">Editar plan: {plan.name}</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Slug: <code className="font-mono">{plan.slug}</code> · {plan.active_subscriptions_count} suscripción(es) activa(s)
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-ink-muted hover:text-ink-secondary hover:bg-surface-elevated/60">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

          {/* Datos visibles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Nombre *</label>
              <input className={`input ${errors.name ? 'input-error' : ''}`}
                {...register('name', { required: true })} />
            </div>
            <div>
              <label className="label">Orden de lista</label>
              <input type="number" className="input" {...register('sort_order')} />
            </div>
          </div>

          <div>
            <label className="label">Descripción</label>
            <textarea className="input h-16 resize-none" {...register('description')} />
          </div>

          {/* Precio */}
          {!isOwner && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="label">Precio mensual (display)</label>
                <div className="flex gap-2 items-stretch">
                  <span className="inline-flex items-center px-3 rounded-lg bg-surface-elevated border border-line-subtle text-ink-muted text-sm">
                    {watch('currency')}
                  </span>
                  <input type="number" min="0" step="100" className="input flex-1"
                    value={pesos}
                    onChange={(e) => setValue('price_mxn_cents', Math.round(parseFloat(e.target.value || 0) * 100))} />
                  <span className="inline-flex items-center px-2 rounded-lg text-ink-muted text-xs">/mes</span>
                </div>
                <p className="text-[11px] text-ink-muted mt-1">
                  {watch('price_mxn_cents')} centavos en BD
                </p>
              </div>
              <div>
                <label className="label">Moneda</label>
                <select className="select" {...register('currency')}>
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          )}

          {/* Stripe price ID */}
          {!isOwner && (
            <div>
              <label className="label">Stripe Price ID</label>
              <input className="input font-mono text-sm" placeholder="price_1Q..."
                {...register('stripe_price_id')} />
              <p className="text-[11px] text-ink-muted mt-1">
                El ID del <code>Price</code> en el dashboard de Stripe que se cobrará al cliente.
                Si está vacío, el plan no será comprable vía Checkout.
              </p>
            </div>
          )}

          {/* Límites */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Máximo de usuarios</label>
              <input type="number" min="1" className="input" placeholder="Sin límite si vacío"
                {...register('max_users')} />
            </div>
            <div>
              <label className="label">Máximo de facturas/mes</label>
              <input type="number" min="1" className="input" placeholder="Sin límite si vacío"
                {...register('max_invoices_per_month')} />
            </div>
          </div>

          {/* Activo */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" {...register('active')} disabled={isOwner} />
              <span className="text-sm text-ink-secondary">
                Activo (visible en la lista de planes que se pueden contratar)
              </span>
            </label>
            {isOwner && (
              <p className="text-[11px] text-status-info mt-1">
                El plan "owner" es del sistema y siempre debe quedar activo.
              </p>
            )}
          </div>

          {/* Aviso de Stripe pricing */}
          {!isOwner && (
            <div className="p-3 bg-status-warning/10 border border-status-warning/30 rounded-lg text-xs text-status-warning">
              <strong>Sobre cambiar el precio:</strong> el precio aquí es solo display.
              Para cobrar diferente debes crear un Price nuevo en el dashboard de Stripe,
              pegar el <code>price_XXX</code> arriba, y decidir qué hacer con los clientes existentes
              (mantener al precio viejo o migrar al nuevo).
            </div>
          )}

          {serverError && (
            <div className="p-3 bg-status-danger/10 border border-status-danger/40 rounded-lg text-sm text-status-danger">
              {serverError}
            </div>
          )}
        </form>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-line-subtle shrink-0">
          <button type="button" className="btn-secondary" onClick={onClose}
            disabled={mutation.isPending}>Cancelar</button>
          <button type="button" className="btn-primary"
            onClick={handleSubmit(onSubmit)}
            disabled={mutation.isPending || !isDirty}>
            {mutation.isPending ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
