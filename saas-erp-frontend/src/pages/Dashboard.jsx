import { useQuery } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router-dom'
import useAuthStore from '@/store/useAuthStore'
import { tenantsApi } from '@/api/tenants'
import { reportsApi } from '@/api/reports'
import { salesApi } from '@/api/sales'
import { purchasesApi } from '@/api/purchases'
import Badge from '@/components/ui/Badge'

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const fmtCurrency = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtCurrencyFull = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)

// ── Recent orders table ───────────────────────────────────────────────────
function RecentOrders({ data, loading }) {
  if (loading) return (
    <div className="space-y-3 mt-2">
      {[1,2,3,4].map(i => (
        <div key={i} className="flex justify-between items-center">
          <div className="space-y-1.5">
            <div className="skeleton h-3 w-36 rounded" />
            <div className="skeleton h-2.5 w-24 rounded" />
          </div>
          <div className="skeleton h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )

  if (!data?.length) return (
    <p className="text-sm text-ink-muted py-4 text-center">Sin órdenes recientes</p>
  )

  return (
    <div className="divide-y divide-line-subtle">
      {data.map((order) => (
        <div key={order.id} className="flex items-center justify-between py-2.5 gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-primary truncate">{order.partnerName}</p>
            <p className="text-xs text-ink-muted">{order.orderNumber}</p>
          </div>
          <Badge status={order.status} />
        </div>
      ))}
    </div>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const user = useAuthStore((s) => s.user)
  const can  = useAuthStore((s) => s.can)
  const homeRoute = useAuthStore((s) => s.uiPrefs?.home_route)

  // ── Override por rol ──────────────────────────────────────────────────
  // Si el rol del usuario define una ventana de inicio explícita, se respeta.
  // Esto le permite al admin mandar a "Ventas" al rol comercial, a "Captura"
  // al operador, etc. — sin tocar código.
  if (homeRoute && homeRoute !== '/') {
    return <Navigate to={homeRoute} replace />
  }

  // ── Redirección automática para operadores (fallback) ─────────────────
  // Si el usuario NO tiene acceso a ningún módulo comercial pero sí a
  // captura de producción, lo mandamos directo a su pantalla de trabajo.
  // Evita exponer datos comerciales (ventas, CXC, compras) a operadores.
  const hasCommercialAccess = can('sales','read') || can('financials','read') || can('purchases','read')
  const canCapture          = can('production','create')
  const canReadOrders       = can('production','read_orders')
  const canReadOwnShifts     = can('production','read_own_shifts')

  // Operador sin acceso comercial → su pantalla de trabajo. Orden de preferencia:
  // captura → órdenes → mis turnos (cada una gateada por su permiso, para no
  // aterrizar en una pantalla que el rol no puede ver tras separar permisos).
  if (!hasCommercialAccess && canCapture) {
    return <Navigate to="/produccion/captura" replace />
  }
  if (!hasCommercialAccess && canReadOrders) {
    return <Navigate to="/produccion/ordenes" replace />
  }
  if (!hasCommercialAccess && canReadOwnShifts) {
    return <Navigate to="/produccion/mis-turnos" replace />
  }

  const canReadSales     = can('sales', 'read')
  const canReadPurchases = can('purchases', 'read')

  const { data: recentOrders, isLoading: loadingOrders } = useQuery({
    queryKey: ['dashboard-recent-orders'],
    queryFn:  () => salesApi.listOrders({ limit: 5 }).then(r =>
      (r.data || []).map(o => ({
        id:          o.id,
        partnerName: o.partner_name,
        orderNumber: o.order_number,
        status:      o.status,
      }))
    ),
    staleTime: 2 * 60 * 1000,
    enabled:   canReadSales,
  })

  const { data: recentPurchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['dashboard-recent-purchases'],
    queryFn:  () => purchasesApi.listOrders({ limit: 5 }).then(r =>
      (r.data || []).map(o => ({
        id:          o.id,
        partnerName: o.is_generic ? (o.generic_supplier || 'Proveedor genérico') : o.partner_name,
        orderNumber: o.order_number,
        status:      o.status,
      }))
    ),
    staleTime: 2 * 60 * 1000,
    enabled:   canReadPurchases,
  })

  // Branding del tenant — logo + nombre comercial para el hero del dashboard.
  const { data: tenantInfo } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 5 * 60 * 1000,
  })
  const tenantLogo   = tenantInfo?.logo_url
  const companyName  = tenantInfo?.display_name || tenantInfo?.name || 'tu empresa'
  const accentColor  = tenantInfo?.brand_color_primary || '#5E9F32'

  // Snapshot financiero del mes en curso — refresca cada 60s.
  const { data: snapshot, isLoading: loadingSnapshot } = useQuery({
    queryKey: ['financial-snapshot'],
    queryFn:  () => reportsApi.getFinancialSnapshot(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: hasCommercialAccess, // solo se carga para usuarios con acceso a finanzas
  })

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'

  return (
    <div className="space-y-6">

      {/* Hero de bienvenida con branding del cliente */}
      <section className="card flex flex-col sm:flex-row items-center gap-4 sm:gap-6 relative overflow-hidden">
        {/* Halo sutil con el color primario del cliente */}
        <div className="pointer-events-none absolute -right-20 -top-20 w-60 h-60 rounded-full blur-3xl opacity-[0.10]"
             style={{ background: accentColor }} />

        {tenantLogo ? (
          <div className="w-24 h-24 sm:w-28 sm:h-28 shrink-0 rounded-lg border border-line-subtle bg-bg-tertiary flex items-center justify-center overflow-hidden">
            <img src={tenantLogo} alt={companyName} className="max-w-full max-h-full object-contain p-2" />
          </div>
        ) : (
          <div className="w-24 h-24 sm:w-28 sm:h-28 shrink-0 rounded-lg border border-line-subtle bg-bg-tertiary flex items-center justify-center">
            <img src="/praxion-isotipo.svg" alt="Praxion" className="w-16 h-16 object-contain opacity-90" />
          </div>
        )}

        <div className="min-w-0 flex-1 relative text-center sm:text-left">
          <p className="eyebrow">PANEL OPERATIVO</p>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink-primary mt-1">
            {greeting}, <span className="text-brand-300">{user?.fullName?.split(' ')[0] || 'usuario'}</span>
          </h1>
          <p className="text-sm text-ink-secondary mt-1">
            Bienvenido al sistema de <strong className="text-ink-primary">{companyName}</strong>.
          </p>
          <p className="text-xs text-ink-muted mt-1">
            {new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
      </section>

      {/* Tarjetas financieras del mes — tiempo real */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SalesMonthCard data={snapshot?.sales} loading={loadingSnapshot} month={snapshot?.period?.month} />
        <IvaMonthCard   data={snapshot?.iva}   loading={loadingSnapshot} month={snapshot?.period?.month} />
      </div>

      {/* Tablas recientes */}
      {(canReadSales || canReadPurchases) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Ventas */}
          {canReadSales && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink-primary">Últimas órdenes de venta</h3>
                <Link to="/ventas" className="text-xs text-brand-300 hover:underline">Ver todo</Link>
              </div>
              <RecentOrders data={recentOrders} loading={loadingOrders} />
            </div>
          )}

          {/* Compras */}
          {canReadPurchases && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink-primary">Compras recientes</h3>
                <Link to="/compras/ordenes" className="text-xs text-brand-300 hover:underline">Ver todo</Link>
              </div>
              <RecentOrders data={recentPurchases} loading={loadingPurchases} />
            </div>
          )}

        </div>
      )}
    </div>
  )
}

// ── Tarjeta: Ventas del mes con desglose facturado vs sin factura ─────────
function SalesMonthCard({ data, loading, month }) {
  if (loading) {
    return (
      <div className="card flex flex-col gap-3">
        <div className="skeleton h-3 w-32 rounded" />
        <div className="skeleton h-8 w-48 rounded" />
        <div className="skeleton h-2 w-full rounded" />
      </div>
    )
  }
  const d = data || { total: 0, invoiced: 0, invoiced_subtotal: 0, invoiced_iva: 0, uninvoiced: 0, pct_invoiced: 0, pct_uninvoiced: 0, count_invoiced: 0, count_uninvoiced: 0 }
  const monthLabel = monthLabelFromYM(month)

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="eyebrow">VENTAS · {monthLabel}</p>
          <h3 className="text-base font-semibold text-ink-primary mt-1">Acumulado del mes</h3>
        </div>
        <Link to="/finanzas/reporte-contable" className="text-xs text-brand-300 hover:underline shrink-0">
          Ver reporte
        </Link>
      </div>

      <div className="text-3xl font-bold text-ink-primary tabular-nums">
        {fmtCurrencyFull(d.total)}
      </div>

      {/* Barra de proporción facturado vs no facturado */}
      {d.total > 0 ? (
        <div>
          <div className="flex h-2 rounded-full overflow-hidden bg-surface-elevated">
            <div className="bg-brand-500" style={{ width: `${d.pct_invoiced}%` }} title={`Facturado: ${d.pct_invoiced.toFixed(0)}%`} />
            <div className="bg-status-warning/70" style={{ width: `${d.pct_uninvoiced}%` }} title={`Sin factura: ${d.pct_uninvoiced.toFixed(0)}%`} />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 bg-brand-500 rounded-sm mt-1.5 shrink-0"></span>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-ink-muted">Facturado <span className="normal-case">(con IVA)</span></p>
                <p className="text-base font-semibold text-ink-primary tabular-nums">{fmtCurrency(d.invoiced)}</p>
                <p className="text-[10px] text-ink-muted tabular-nums">
                  Subtotal {fmtCurrency(d.invoiced_subtotal)} · IVA {fmtCurrency(d.invoiced_iva)}
                </p>
                <p className="text-[10px] text-ink-muted">{d.count_invoiced} factura{d.count_invoiced === 1 ? '' : 's'} · {d.pct_invoiced.toFixed(0)}%</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 bg-status-warning/70 rounded-sm mt-1.5 shrink-0"></span>
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-ink-muted">Sin factura</p>
                <p className="text-base font-semibold text-ink-primary tabular-nums">{fmtCurrency(d.uninvoiced)}</p>
                <p className="text-[10px] text-ink-muted">{d.count_uninvoiced} remisi{d.count_uninvoiced === 1 ? 'ón' : 'ones'} · {d.pct_uninvoiced.toFixed(0)}%</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Aún no hay ventas registradas este mes.</p>
      )}
    </div>
  )
}

// ── Tarjeta: IVA del mes ───────────────────────────────────────────────────
function IvaMonthCard({ data, loading, month }) {
  if (loading) {
    return (
      <div className="card flex flex-col gap-3">
        <div className="skeleton h-3 w-32 rounded" />
        <div className="skeleton h-8 w-48 rounded" />
        <div className="skeleton h-3 w-2/3 rounded" />
      </div>
    )
  }
  const d = data || { transferred: 0, creditable: 0, withheld: 0, net: 0, direction: 'balanced' }
  const monthLabel = monthLabelFromYM(month)

  // Decimos al usuario en lenguaje claro qué significa el saldo.
  let label, color, helper
  if (d.direction === 'to_pay') {
    label  = 'IVA a pagar'
    color  = 'text-status-warning'
    helper = 'Llevas más IVA cobrado que pagado en este mes.'
  } else if (d.direction === 'in_favor') {
    label  = 'IVA a favor'
    color  = 'text-status-success'
    helper = 'Has pagado más IVA del que has cobrado en el mes.'
  } else {
    label  = 'IVA neto'
    color  = 'text-ink-muted'
    helper = 'Sin movimientos fiscales de IVA en el mes.'
  }

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="eyebrow">IVA · {monthLabel}</p>
          <h3 className="text-base font-semibold text-ink-primary mt-1">Balance del mes</h3>
        </div>
        <Link to="/finanzas/reporte-contable" className="text-xs text-brand-300 hover:underline shrink-0">
          Detalle
        </Link>
      </div>

      <div>
        <div className={`text-3xl font-bold tabular-nums ${color}`}>
          {fmtCurrencyFull(Math.abs(d.net))}
        </div>
        <p className={`text-xs font-semibold mt-1 uppercase tracking-wide ${color}`}>{label}</p>
      </div>

      <p className="text-xs text-ink-muted">{helper}</p>

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-line-subtle">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-ink-muted">Cobrado en ventas</p>
          <p className="text-base font-semibold text-ink-primary tabular-nums">{fmtCurrency(d.transferred)}</p>
          <p className="text-[10px] text-ink-muted">IVA trasladado</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-ink-muted">Pagado en compras</p>
          <p className="text-base font-semibold text-ink-primary tabular-nums">{fmtCurrency(d.creditable)}</p>
          <p className="text-[10px] text-ink-muted">IVA acreditable</p>
        </div>
      </div>
    </div>
  )
}

function monthLabelFromYM(ym) {
  if (!ym) {
    const now = new Date()
    return `${MONTHS_ES[now.getMonth()].toUpperCase()} ${now.getFullYear()}`
  }
  const [y, m] = ym.split('-').map(Number)
  return `${MONTHS_ES[m - 1].toUpperCase()} ${y}`
}
