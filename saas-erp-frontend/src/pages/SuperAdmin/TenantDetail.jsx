import { useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { platformAdminApi } from '@/api/platformAdmin'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'
import ProcesoTab from './tenant-process/ProcesoTab'

// Módulos del sistema, etiqueta legible y descripción para el editor.
const MODULE_LABELS = {
  invoicing:   { title: 'Facturación',  desc: 'Emisión y timbrado de CFDI, complementos de pago, NCs.' },
  production:  { title: 'Producción',   desc: 'Órdenes, turnos, captura, costos y validación.' },
  inventory:   { title: 'Inventario',   desc: 'Stock, kardex, conteos físicos, almacenes.' },
  purchases:   { title: 'Compras',      desc: 'OC, recepciones, comprobantes de proveedor, CXP.' },
  quotations:  { title: 'Cotizaciones', desc: 'Pre-pedidos enviables al cliente con PDF.' },
  sales:       { title: 'Ventas',       desc: 'Pedidos, remisiones, precios por cliente, CXC.' },
  petty_cash:  { title: 'Caja chica',   desc: 'Cajas, salidas con comprobante, categorías.' },
  reports:     { title: 'Reportes',     desc: 'Ventas, producción, contable, estado de cuenta.' },
}

const SUB_LABELS = {
  trialing:  { label: 'Periodo de prueba', variant: 'blue' },
  active:    { label: 'Activa',            variant: 'green' },
  past_due:  { label: 'Cobro vencido',     variant: 'amber' },
  canceled:  { label: 'Cancelada',         variant: 'red' },
}

export default function TenantDetail() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState('info')

  // Polling cada 30s en detalle — más fino que la lista, porque aquí estás
  // observando un cliente en particular (ej. acabas de mandar el link de pago
  // y esperas que Stripe lo cobre y se auto-reactive).
  const { data: tenant, isLoading } = useQuery({
    queryKey: ['platform-admin', 'tenant', id],
    queryFn:  () => platformAdminApi.getTenant(id),
    refetchInterval: 30 * 1000,
  })

  if (isLoading || !tenant) {
    return <div className="flex justify-center py-10"><Spinner /></div>
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-admin'] })

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <Link to="/superadmin" className="text-xs text-ink-muted hover:text-ink-primary">← Volver a organizaciones</Link>
        <div className="flex items-start justify-between gap-3 flex-wrap mt-2">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">
              {tenant.display_name || tenant.name}
            </h1>
            <div className="text-xs text-ink-muted font-mono mt-1">{tenant.slug}.praxionops.com</div>
          </div>
          <div className="flex items-center gap-2">
            {tenant.is_active
              ? <Badge variant="green">Activa</Badge>
              : <Badge variant="red">Suspendida</Badge>}
            <span className="text-xs px-2 py-1 rounded bg-surface-elevated/60 text-ink-secondary capitalize">
              Plan: {tenant.plan}
            </span>
          </div>
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div className="border-b border-line-subtle flex gap-1 overflow-x-auto">
        <TabBtn active={tab === 'info'}    onClick={() => setTab('info')}>    Información</TabBtn>
        <TabBtn active={tab === 'modules'} onClick={() => setTab('modules')}> Módulos</TabBtn>
        <TabBtn active={tab === 'proceso'} onClick={() => setTab('proceso')}> Proceso</TabBtn>
        <TabBtn active={tab === 'sub'}     onClick={() => setTab('sub')}>     Suscripción</TabBtn>
        <TabBtn active={tab === 'users'}   onClick={() => setTab('users')}>   Usuarios</TabBtn>
        <TabBtn active={tab === 'members'} onClick={() => setTab('members')}> Miembros</TabBtn>
      </div>

      {tab === 'info'    && <InfoTab    tenant={tenant} onSaved={invalidate} />}
      {tab === 'modules' && <ModulesTab tenant={tenant} onSaved={invalidate} />}
      {tab === 'proceso' && <ProcesoTab tenantId={tenant.id} />}
      {tab === 'sub'     && <SubTab     tenant={tenant} />}
      {tab === 'users'   && <UsersTab   tenantId={tenant.id} />}
      {tab === 'members' && <MembersTab tenantId={tenant.id} tenantName={tenant.name} />}
    </div>
  )
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={clsx(
        'px-4 py-2 text-sm border-b-2 transition-colors',
        active
          ? 'border-brand-500 text-ink-primary font-medium'
          : 'border-transparent text-ink-secondary hover:text-ink-primary'
      )}>
      {children}
    </button>
  )
}

// ── Tab: Información general ────────────────────────────────────────────────
function InfoTab({ tenant, onSaved }) {
  const [form, setForm] = useState({
    name:                 tenant.name || '',
    displayName:          tenant.display_name || '',
    plan:                 tenant.plan || 'free',
    brandColorPrimary:    tenant.brand_color_primary || '',
    brandColorSecondary:  tenant.brand_color_secondary || '',
    notificationEmail:    tenant.notification_email || '',
  })
  const [error, setError] = useState(null)
  const [msg,   setMsg]   = useState(null)

  const save = useMutation({
    mutationFn: () => platformAdminApi.updateTenant(tenant.id, form),
    onSuccess: () => { setMsg('Cambios guardados.'); onSaved() },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  const suspend = useMutation({
    mutationFn: (reason) => platformAdminApi.suspendTenant(tenant.id, reason),
    onSuccess: (_, reason) => {
      const msg = reason === 'payment'
        ? 'Suspendida por pago vencido. Se reactivará sola cuando se complete el cobro.'
        : 'Suspendida manualmente. Requerirá tu acción para reactivarla.'
      setMsg(msg)
      onSaved()
    },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  const reactivate = useMutation({
    mutationFn: () => platformAdminApi.reactivateTenant(tenant.id),
    onSuccess: () => { setMsg('Organización reactivada.'); onSaved() },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  // Impersonar tenant: emite JWT temporal y nos lleva al ERP del cliente
  // con un banner rojo encima. Audit log obligatorio en backend.
  const navigate = useNavigate()
  const startImpersonation = useAuthStore((s) => s.startImpersonation)
  const [impersonating, setImpersonating] = useState(false)

  const handleImpersonate = async () => {
    const reason = prompt(
      `Vas a entrar a "${tenant.name}" como su admin.\n\n` +
      `Esta acción queda registrada en el audit log permanente.\n` +
      `La sesión de impersonación dura 30 minutos.\n\n` +
      `Razón (opcional, recomendado — ej. "soporte ticket #234"):`
    )
    if (reason === null) return // cancelado
    setImpersonating(true)
    setError(null)
    setMsg(null)
    try {
      await startImpersonation(tenant.id, reason || null)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'No se pudo impersonar.')
      setImpersonating(false)
    }
  }

  // Reset de datos sandbox — solo aparece si tenant.is_sandbox = true.
  const [resetPreview, setResetPreview] = useState(null)
  const [keepInventory, setKeepInventory] = useState(false)

  const previewReset = useMutation({
    mutationFn: () => platformAdminApi.sandboxResetPreview(tenant.id, keepInventory),
    onSuccess: (data) => { setResetPreview(data); setError(null) },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  const doReset = useMutation({
    mutationFn: () => platformAdminApi.sandboxReset(tenant.id, { keepInventory }),
    onSuccess: (data) => {
      setMsg(`✓ Reset completo: ${data.total} registros eliminados de ${data.deletedBy.length} tabla(s).`)
      setResetPreview(null)
      onSaved()
    },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  function update(k, v) { setForm(f => ({ ...f, [k]: v })) }

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="alert-error">{error}</div>}
      {msg && !error && <div className="alert-success">{msg}</div>}

      <section className="card p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-ink-primary">Datos generales</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Nombre legal</label>
            <input className="input" value={form.name} onChange={e => update('name', e.target.value)} />
          </div>
          <div>
            <label className="label">Nombre comercial (sidebar)</label>
            <input className="input" value={form.displayName}
              onChange={e => update('displayName', e.target.value)}
              placeholder="(usa el legal si está vacío)" />
          </div>
          <div>
            <label className="label">Plan</label>
            <select className="input" value={form.plan} onChange={e => update('plan', e.target.value)}>
              <option value="free">Gratis</option>
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Empresa</option>
              <option value="owner">Owner (interno)</option>
            </select>
          </div>
          <div>
            <label className="label">Email para notificaciones</label>
            <input type="email" className="input" value={form.notificationEmail}
              onChange={e => update('notificationEmail', e.target.value)} />
          </div>
          <div>
            <label className="label">Color primario (#RRGGBB)</label>
            <div className="flex gap-2">
              <input className="input font-mono flex-1" value={form.brandColorPrimary}
                onChange={e => update('brandColorPrimary', e.target.value)}
                placeholder="#5E9F32" />
              {form.brandColorPrimary && (
                <div className="w-10 h-10 rounded border border-line-subtle"
                  style={{ backgroundColor: form.brandColorPrimary }} />
              )}
            </div>
          </div>
          <div>
            <label className="label">Color secundario</label>
            <div className="flex gap-2">
              <input className="input font-mono flex-1" value={form.brandColorSecondary}
                onChange={e => update('brandColorSecondary', e.target.value)}
                placeholder="#1B1F1A" />
              {form.brandColorSecondary && (
                <div className="w-10 h-10 rounded border border-line-subtle"
                  style={{ backgroundColor: form.brandColorSecondary }} />
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button className="btn-primary" disabled={save.isPending}
            onClick={() => { setError(null); setMsg(null); save.mutate() }}>
            {save.isPending ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </section>

      {/* ── Impersonar tenant ───────────────────────────────────────────── */}
      <section className="card p-5 flex flex-col gap-3 border-status-info/30">
        <div>
          <h2 className="text-sm font-semibold text-status-info">🎭 Soporte · Impersonar</h2>
          <p className="text-xs text-ink-muted mt-1 max-w-2xl">
            Entra al ERP de <strong>{tenant.name}</strong> como su admin para reproducir
            problemas, verificar configuración o soporte general. La sesión dura <strong>30 minutos</strong> y
            todo queda registrado en bitácora auditable que el cliente puede consultar.
          </p>
        </div>
        <button
          className="btn-secondary w-fit text-status-info border-status-info/40"
          disabled={impersonating}
          onClick={handleImpersonate}
        >
          {impersonating ? 'Entrando…' : '🎭 Impersonar este tenant'}
        </button>
      </section>

      {/* ── Reset de datos sandbox — solo visible si is_sandbox ────────── */}
      {tenant.is_sandbox && (
        <section className="card p-5 flex flex-col gap-3 border-status-warning/30">
          <div>
            <h2 className="text-sm font-semibold text-status-warning">🧪 Reset de datos sandbox</h2>
            <p className="text-xs text-ink-muted mt-1">
              Vacía los movimientos transaccionales de este tenant (pedidos, facturas,
              remisiones, turnos de producción, cotizaciones, caja chica, AR/AP, auditoría).
              <strong> Preserva</strong> usuarios, clientes/proveedores, productos,
              almacenes, datos fiscales y configuración. Solo funciona en tenants con
              <code className="text-[11px] bg-surface-elevated px-1 rounded ml-1">is_sandbox=true</code>.
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
            <input type="checkbox" checked={keepInventory}
              onChange={(e) => setKeepInventory(e.target.checked)} />
            Preservar inventario (movimientos + saldos)
          </label>

          {!resetPreview && (
            <button className="btn-secondary w-fit text-status-warning border-status-warning/40"
              disabled={previewReset.isPending}
              onClick={() => { setError(null); setMsg(null); previewReset.mutate() }}>
              {previewReset.isPending ? 'Calculando…' : 'Ver qué se borraría'}
            </button>
          )}

          {resetPreview && (
            <div className="bg-surface-elevated/40 border border-line-subtle rounded-lg p-3 text-xs">
              {resetPreview.total === 0 ? (
                <p className="text-ink-muted">No hay datos transaccionales que borrar.</p>
              ) : (
                <>
                  <p className="text-ink-secondary mb-2">
                    Se eliminarán <strong className="text-status-warning">{resetPreview.total} registros</strong> de las siguientes tablas:
                  </p>
                  <ul className="space-y-0.5 max-h-48 overflow-y-auto font-mono text-[11px] text-ink-secondary">
                    {resetPreview.counts.map(c => (
                      <li key={c.table} className="flex justify-between border-b border-line-subtle/40 py-0.5">
                        <span>{c.table}</span>
                        <span className="text-ink-muted">{c.count}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2 mt-3">
                    <button className="btn-secondary btn-sm" onClick={() => setResetPreview(null)}>
                      Cancelar
                    </button>
                    <button className="btn-danger btn-sm"
                      disabled={doReset.isPending}
                      onClick={() => {
                        if (!confirm(`¿Eliminar ${resetPreview.total} registros del tenant "${tenant.name}"?\n\nEsta acción NO se puede deshacer.`)) return
                        setError(null); setMsg(null); doReset.mutate()
                      }}>
                      {doReset.isPending ? 'Ejecutando…' : `Eliminar ${resetPreview.total} registros`}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      )}

      <section className="card p-5 flex flex-col gap-3 border-status-danger/30">
        <h2 className="text-sm font-semibold text-status-danger">Zona de riesgo</h2>

        {tenant.is_active ? (
          <>
            <p className="text-xs text-ink-muted">
              Suspender bloquea el acceso al sistema. El cliente podrá entrar
              solo al panel de pagos para regularizar. Sus datos NO se borran.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 mt-1">
              <button className="btn-secondary text-status-warning border-status-warning/40"
                disabled={suspend.isPending}
                onClick={() => {
                  if (!confirm(`¿Suspender "${tenant.name}" por pago vencido?\n\nSe reactivará SOLA cuando Stripe confirme el pago.`)) return
                  setError(null); setMsg(null); suspend.mutate('payment')
                }}>
                Suspender por pago vencido
              </button>
              <button className="btn-danger"
                disabled={suspend.isPending}
                onClick={() => {
                  if (!confirm(`¿Suspender "${tenant.name}" manualmente?\n\nNO se reactivará automáticamente — requerirá tu acción desde este panel.`)) return
                  setError(null); setMsg(null); suspend.mutate('manual')
                }}>
                Suspender manualmente
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bg-surface-elevated/50 rounded p-3 text-xs text-ink-secondary">
              <div className="font-semibold text-ink-primary mb-1">
                {tenant.suspended_reason === 'payment'
                  ? '⏳ Suspendida por pago vencido'
                  : '🔒 Suspendida manualmente'}
              </div>
              {tenant.suspended_reason === 'payment'
                ? 'Se reactivará automáticamente cuando Stripe confirme el pago. Si quieres adelantarte, puedes reactivar manual aquí abajo.'
                : 'No se reactivará sola — debes hacerlo desde este botón cuando lo decidas.'}
            </div>
            <button className="btn-primary w-fit" disabled={reactivate.isPending}
              onClick={() => { setError(null); setMsg(null); reactivate.mutate() }}>
              {reactivate.isPending ? 'Reactivando...' : 'Reactivar organización ahora'}
            </button>
          </>
        )}
      </section>
    </div>
  )
}

// ── Tab: Módulos (prender/apagar) ────────────────────────────────────────────
function ModulesTab({ tenant, onSaved }) {
  // Lista negativa en BD: missing|true = encendido, false = apagado.
  // Frontend trabaja con la inversa para que el switch sea "encendido".
  const initial = {}
  for (const k of Object.keys(MODULE_LABELS)) {
    initial[k] = tenant.modules?.[k] !== false
  }
  const [enabled, setEnabled] = useState(initial)
  const [error, setError] = useState(null)
  const [msg, setMsg]     = useState(null)

  const save = useMutation({
    mutationFn: () => {
      // Solo enviamos los apagados (false). Encendidos = ausentes.
      const modulesPatch = {}
      for (const [k, on] of Object.entries(enabled)) {
        if (!on) modulesPatch[k] = false
      }
      return platformAdminApi.updateTenant(tenant.id, { modules: modulesPatch })
    },
    onSuccess: () => { setMsg('Cambios aplicados. Los usuarios verán el efecto al recargar.'); onSaved() },
    onError:   (e) => setError(e.response?.data?.error || e.message),
  })

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="alert-error">{error}</div>}
      {msg && !error && <div className="alert-success">{msg}</div>}

      <div className="alert-info text-xs">
        Apagar un módulo oculta su menú al cliente y rechaza las llamadas a sus endpoints con
        un mensaje claro. Los datos no se borran — al reactivar el módulo queda como estaba.
      </div>

      <section className="card divide-y divide-line-subtle">
        {Object.entries(MODULE_LABELS).map(([key, meta]) => {
          const on = enabled[key]
          return (
            <div key={key} className="p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink-primary">{meta.title}</div>
                <div className="text-xs text-ink-muted mt-0.5">{meta.desc}</div>
              </div>
              <Toggle on={on} onChange={(v) => setEnabled(s => ({ ...s, [key]: v }))} />
            </div>
          )
        })}
      </section>

      <div className="flex justify-end">
        <button className="btn-primary" disabled={save.isPending}
          onClick={() => { setError(null); setMsg(null); save.mutate() }}>
          {save.isPending ? 'Guardando...' : 'Guardar módulos'}
        </button>
      </div>
    </div>
  )
}

function Toggle({ on, onChange }) {
  return (
    <button type="button"
      role="switch" aria-checked={on}
      onClick={() => onChange(!on)}
      className={clsx(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0',
        on ? 'bg-status-success' : 'bg-surface-elevated border border-line-subtle'
      )}>
      <span className={clsx(
        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
        on ? 'translate-x-6' : 'translate-x-1'
      )} />
    </button>
  )
}

// ── Tab: Suscripción (read-only — solo lectura desde el panel) ───────────────
function SubTab({ tenant }) {
  const status = SUB_LABELS[tenant.subscription_status] || { label: tenant.subscription_status || '—', variant: 'gray' }

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-ink-muted">Estado</div>
            <div className="text-2xl font-semibold text-ink-primary mt-1">
              {tenant.subscription_plan_name || '—'}
            </div>
          </div>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Cell label="Precio" value={tenant.subscription_price_cents
            ? `${(tenant.subscription_price_cents / 100).toLocaleString('es-MX')} MXN`
            : '—'} />
          <Cell label="Inicio periodo" value={tenant.current_period_start ? fmtDate(tenant.current_period_start) : '—'} />
          <Cell label="Vence" value={tenant.current_period_end ? fmtDate(tenant.current_period_end) : '—'} />
          <Cell label="Fin trial" value={tenant.trial_end ? fmtDate(tenant.trial_end) : '—'} />
          <Cell label="Cancelar al cierre" value={tenant.cancel_at_period_end ? 'Sí' : 'No'} />
          <Cell label="Máx usuarios" value={tenant.subscription_max_users ?? 'Ilimitado'} />
          <Cell label="Facturas/mes" value={tenant.subscription_max_invoices ?? 'Ilimitado'} />
          <Cell label="Stripe customer" value={tenant.stripe_customer_id || '—'} mono />
        </div>

        <p className="text-xs text-ink-muted pt-3 border-t border-line-subtle">
          Los cambios de plan, cobros y métodos de pago se gestionan desde el portal del cliente
          en Stripe — esta vista es solo de lectura.
        </p>
      </section>
    </div>
  )
}

function Cell({ label, value, mono }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={clsx('text-ink-primary mt-0.5', mono && 'font-mono text-xs break-all')}>{value}</div>
    </div>
  )
}

// ── Tab: Usuarios del tenant ─────────────────────────────────────────────────
function UsersTab({ tenantId }) {
  const { data: users, isLoading } = useQuery({
    queryKey: ['platform-admin', 'tenant', tenantId, 'users'],
    queryFn:  () => platformAdminApi.listTenantUsers(tenantId),
  })

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated/50 text-ink-muted text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Usuario</th>
              <th className="px-4 py-3 text-left">Roles</th>
              <th className="px-4 py-3 text-left">Último login</th>
              <th className="px-4 py-3 text-left">Estado</th>
            </tr>
          </thead>
          <tbody>
            {(users || []).map(u => (
              <tr key={u.id} className="border-t border-line-subtle">
                <td className="px-4 py-3">
                  <div className="font-medium text-ink-primary">{u.full_name}</div>
                  <div className="text-xs text-ink-muted">{u.email}</div>
                  {u.is_platform_admin && (
                    <div className="text-[10px] text-status-info uppercase tracking-wide mt-0.5">Platform admin</div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-ink-secondary">
                  {(u.roles || []).join(', ') || <span className="italic text-ink-muted">sin roles</span>}
                </td>
                <td className="px-4 py-3 text-xs text-ink-secondary">
                  {u.last_login_at ? fmtDate(u.last_login_at) : '—'}
                </td>
                <td className="px-4 py-3">
                  {u.is_active
                    ? <Badge variant="green">Activo</Badge>
                    : <Badge variant="red">Deshabilitado</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!users?.length && (
        <div className="p-6 text-center text-ink-muted text-sm">Sin usuarios.</div>
      )}
    </div>
  )
}

// ── Tab: Miembros (membresías cross-tenant) ─────────────────────────────────
// Lista todos los usuarios con membresía activa en este tenant — tanto los
// "nativos" (cuyo home tenant es éste) como los invitados desde otros tenants.
// Permite agregar un user existente como miembro (por email) y quitar
// miembros invitados. La membresía del usuario home no se puede quitar
// (se controla en el backend con 400).
function MembersTab({ tenantId, tenantName }) {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [email, setEmail]     = useState('')
  const [role, setRole]       = useState('member')
  const [err, setErr]         = useState(null)

  const { data: members, isLoading } = useQuery({
    queryKey: ['platform-admin', 'tenant', tenantId, 'members'],
    queryFn:  () => platformAdminApi.listTenantMembers(tenantId),
  })

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['platform-admin', 'tenant', tenantId, 'members'] })

  // Para agregar, primero hay que resolver el userId por email. Reusamos
  // /api/platform-admin/tenants/:id/users de OTROS tenants no — mejor un
  // endpoint dedicado de búsqueda. Por ahora pedimos userId directo:
  // el platform admin puede copiarlo de la lista del otro tenant.
  const [userIdInput, setUserIdInput] = useState('')

  const addMut = useMutation({
    mutationFn: () => platformAdminApi.addTenantMember(tenantId, { userId: userIdInput.trim(), role }),
    onSuccess: () => {
      invalidate()
      setShowAdd(false)
      setUserIdInput('')
      setEmail('')
      setRole('member')
      setErr(null)
    },
    onError: (e) => setErr(e.response?.data?.error || 'No se pudo agregar.'),
  })

  const removeMut = useMutation({
    mutationFn: (userId) => platformAdminApi.removeTenantMember(tenantId, userId),
    onSuccess: invalidate,
    onError: (e) => alert(e.response?.data?.error || 'No se pudo quitar.'),
  })

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="font-semibold text-ink-primary text-sm">
              Miembros de {tenantName}
            </h3>
            <p className="text-xs text-ink-muted mt-1">
              Personas con acceso a este tenant. Incluye usuarios creados aquí (home)
              e invitados desde otros tenants. Los invitados pueden cambiar a este
              tenant desde el selector de empresas.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="btn btn-secondary text-xs"
          >
            {showAdd ? 'Cancelar' : '+ Agregar miembro'}
          </button>
        </div>

        {showAdd && (
          <div className="border border-line-subtle rounded-md p-3 space-y-2 bg-bg-secondary/40">
            <div className="text-[11px] text-ink-muted">
              Pega el ID del usuario que quieres invitar. Lo encuentras en la pestaña
              <em> Usuarios </em> de su tenant home.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
              <input
                type="text"
                placeholder="user id (UUID)"
                value={userIdInput}
                onChange={(e) => setUserIdInput(e.target.value)}
                className="input text-xs font-mono"
              />
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="input text-xs"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
              <button
                type="button"
                disabled={!userIdInput || addMut.isPending}
                onClick={() => addMut.mutate()}
                className="btn btn-primary text-xs"
              >
                {addMut.isPending ? 'Agregando…' : 'Agregar'}
              </button>
            </div>
            {err && <div className="text-xs text-status-danger">{err}</div>}
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated/50 text-ink-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Usuario</th>
                <th className="px-4 py-3 text-left">Rol</th>
                <th className="px-4 py-3 text-left">Tipo</th>
                <th className="px-4 py-3 text-left">Estado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {(members || []).map((m) => (
                <tr key={m.user_id} className="border-t border-line-subtle">
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink-primary">{m.full_name}</div>
                    <div className="text-xs text-ink-muted">{m.email}</div>
                    <div className="text-[10px] text-ink-muted font-mono mt-0.5">{m.user_id}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">
                    <Badge variant={m.role === 'owner' ? 'blue' : m.role === 'admin' ? 'amber' : 'gray'}>
                      {m.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-ink-secondary">
                    {m.is_home
                      ? <Badge variant="green">Home</Badge>
                      : <Badge variant="gray">Invitado</Badge>}
                  </td>
                  <td className="px-4 py-3">
                    {m.is_active
                      ? <Badge variant="green">Activo</Badge>
                      : <Badge variant="red">Deshabilitado</Badge>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!m.is_home && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`¿Quitar a ${m.full_name} de ${tenantName}?`)) {
                            removeMut.mutate(m.user_id)
                          }
                        }}
                        disabled={removeMut.isPending}
                        className="text-xs text-status-danger hover:underline disabled:opacity-50"
                      >
                        Quitar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!members?.length && (
          <div className="p-6 text-center text-ink-muted text-sm">Sin miembros.</div>
        )}
      </div>
    </div>
  )
}
