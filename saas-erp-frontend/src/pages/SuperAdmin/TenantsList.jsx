import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { platformAdminApi } from '@/api/platformAdmin'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import { fmtDate } from '@/utils/fmt'
import clsx from 'clsx'

const SUBSCRIPTION_LABELS = {
  trialing:           { label: 'Prueba',       color: 'bg-status-info/15 text-status-info' },
  active:             { label: 'Activa',       color: 'bg-status-success/15 text-status-success' },
  past_due:           { label: 'Cobro venc.',  color: 'bg-status-warning/15 text-status-warning' },
  canceled:           { label: 'Cancelada',    color: 'bg-status-danger/15 text-status-danger' },
  incomplete:         { label: 'Incompleta',   color: 'bg-surface-elevated/60 text-ink-secondary' },
  incomplete_expired: { label: 'Expirada',     color: 'bg-surface-elevated/60 text-ink-secondary' },
}

export default function TenantsList() {
  const [q, setQ] = useState('')

  // Polling cada 60s para que cambios desde webhooks de Stripe (auto-suspender
  // / auto-reactivar) aparezcan en pantalla sin que tengas que recargar.
  const POLL_MS = 60 * 1000

  const { data: metrics } = useQuery({
    queryKey: ['platform-admin', 'metrics'],
    queryFn:  platformAdminApi.metrics,
    staleTime: 30 * 1000,
    refetchInterval: POLL_MS,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['platform-admin', 'tenants', q],
    queryFn:  () => platformAdminApi.listTenants({ q, limit: 100 }),
    keepPreviousData: true,
    refetchInterval: POLL_MS,
  })

  const tenants = data?.data || []

  return (
    <div className="page-enter max-w-7xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Plataforma · Organizaciones</h1>
          <p className="text-sm text-ink-muted mt-1">
            Panel del dueño de Praxion. Aquí ves a todos los clientes del sistema,
            su plan, su estado de pago y puedes prender o apagar módulos por cliente.
          </p>
        </div>
        <Link to="/superadmin/tenants/nuevo" className="btn-primary">
          + Nueva organización
        </Link>
      </div>

      {/* ── KPIs ──────────────────────────────────────────────────────── */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard title="Activas"   value={metrics.tenants?.active ?? 0}    tone="success" />
          <MetricCard title="Suspendidas" value={metrics.tenants?.suspended ?? 0} tone="warning" />
          <MetricCard title="MRR estimado"
            value={fmtMxn(metrics.mrr_cents)}
            sub="suma de planes activos / past_due"
            tone="info" />
          <MetricCard title="Facturas este mes" value={metrics.invoices_this_month ?? 0} sub="timbradas en plataforma" />
        </div>
      )}

      {/* ── Buscador ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <input
          className="input flex-1 max-w-md"
          placeholder="Buscar por nombre, slug o nombre comercial..."
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        {q && (
          <button className="btn-ghost" onClick={() => setQ('')}>Limpiar</button>
        )}
      </div>

      {/* ── Tabla ─────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !tenants.length ? (
        <div className="card p-6 text-center text-ink-muted">
          {q ? 'No hay organizaciones que coincidan con la búsqueda.' : 'Aún no hay organizaciones registradas.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-elevated/50 text-ink-muted text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Organización</th>
                  <th className="px-4 py-3 text-left">Plan</th>
                  <th className="px-4 py-3 text-left">Suscripción</th>
                  <th className="px-4 py-3 text-left">Vence</th>
                  <th className="px-4 py-3 text-right">Usuarios</th>
                  <th className="px-4 py-3 text-left">Estado</th>
                  <th className="px-4 py-3 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(t => {
                  const sub = SUBSCRIPTION_LABELS[t.subscription_status] || null
                  const moduleCount = Object.values(t.modules || {}).filter(v => v === false).length
                  return (
                    <tr key={t.id} className="border-t border-line-subtle hover:bg-surface-elevated/40">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink-primary">
                          {t.display_name || t.name}
                        </div>
                        <div className="text-xs text-ink-muted font-mono">{t.slug}</div>
                      </td>
                      <td className="px-4 py-3 capitalize text-ink-secondary">{t.plan}</td>
                      <td className="px-4 py-3">
                        {sub ? (
                          <span className={`text-xs px-2 py-1 rounded ${sub.color}`}>{sub.label}</span>
                        ) : (
                          <span className="text-xs text-ink-muted italic">sin sub.</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-secondary text-xs">
                        {t.current_period_end ? fmtDate(t.current_period_end) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-ink-secondary">{t.user_count}</td>
                      <td className="px-4 py-3">
                        {t.is_active ? (
                          <Badge variant="green">Activa</Badge>
                        ) : (
                          <Badge variant="red">Suspendida</Badge>
                        )}
                        {moduleCount > 0 && (
                          <span className="ml-1 text-[10px] text-status-warning">
                            {moduleCount} módulo{moduleCount > 1 ? 's' : ''} apagado{moduleCount > 1 ? 's' : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link to={`/superadmin/tenants/${t.id}`} className="text-status-info hover:underline text-xs">
                          Ver detalle →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({ title, value, sub, tone }) {
  const toneCls = tone === 'success' ? 'text-status-success'
               : tone === 'warning' ? 'text-status-warning'
               : tone === 'info'    ? 'text-status-info'
               : 'text-ink-primary'
  return (
    <div className="card p-4">
      <div className="text-xs text-ink-muted uppercase tracking-wide">{title}</div>
      <div className={clsx('text-2xl font-semibold mt-1', toneCls)}>{value}</div>
      {sub && <div className="text-[11px] text-ink-muted mt-1">{sub}</div>}
    </div>
  )
}

function fmtMxn(cents) {
  if (!cents) return '$0'
  const mxn = Number(cents) / 100
  return mxn.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 })
}
