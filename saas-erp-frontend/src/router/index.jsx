import { lazy, Suspense, useState, useEffect } from 'react'
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom'
import useAuthStore from '@/store/useAuthStore'
import { ensureFreshToken, accessTokenNeedsRefresh } from '@/api/axios'
import AppShell from '@/components/layout/AppShell'
import Spinner from '@/components/ui/Spinner'

const Login          = lazy(() => import('@/pages/Login'))
const ResetPassword  = lazy(() => import('@/pages/ResetPassword'))
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const Socios    = lazy(() => import('@/pages/Socios'))
const Productos      = lazy(() => import('@/pages/Productos'))
const PreciosCliente = lazy(() => import('@/pages/PreciosCliente'))
const Paquetes       = lazy(() => import('@/pages/Paquetes'))
const PreciosProveedor = lazy(() => import('@/pages/Compras/PreciosProveedor'))
const MateriasPrimas       = lazy(() => import('@/pages/MateriasPrimas'))
const ProduccionOrdenes    = lazy(() => import('@/pages/Produccion/ProduccionOrdenes'))
const ProduccionCaptura    = lazy(() => import('@/pages/Produccion/ProduccionCaptura'))
const ProduccionValidacion = lazy(() => import('@/pages/Produccion/ProduccionValidacion'))
const ProduccionRecetas    = lazy(() => import('@/pages/Produccion/Recetas'))
const ProduccionEspecificaciones = lazy(() => import('@/pages/Produccion/Especificaciones'))
const TrazabilidadLotes          = lazy(() => import('@/pages/Trazabilidad/Lotes'))
const ProduccionResumen       = lazy(() => import('@/pages/Produccion/ProduccionResumen'))
const ProduccionHistorico     = lazy(() => import('@/pages/Produccion/ProduccionHistorico'))
const ProduccionProgramacion  = lazy(() => import('@/pages/Produccion/ProduccionProgramacion'))
const MisTurnos               = lazy(() => import('@/pages/Produccion/MisTurnos'))
const Inventario              = lazy(() => import('@/pages/Inventario'))
const ConteosLista            = lazy(() => import('@/pages/Inventario/ConteosLista'))
const ConteoDetalle           = lazy(() => import('@/pages/Inventario/ConteoDetalle'))
const ComprasOrdenes          = lazy(() => import('@/pages/Compras/ComprasOrdenes'))
const ComprasRecepciones      = lazy(() => import('@/pages/Compras/ComprasRecepciones'))
const ComprasDevoluciones     = lazy(() => import('@/pages/Compras/Devoluciones'))
const ComprasFacturas         = lazy(() => import('@/pages/Compras/ComprasFacturas'))
const VentasPedidos           = lazy(() => import('@/pages/Ventas/VentasPedidos'))
const VentasRemisiones        = lazy(() => import('@/pages/Ventas/VentasRemisiones'))
const VentasCotizaciones      = lazy(() => import('@/pages/Ventas/VentasCotizaciones'))
const CuentasPorCobrar        = lazy(() => import('@/pages/Finanzas/CuentasPorCobrar'))
const CuentasPorPagar         = lazy(() => import('@/pages/Finanzas/CuentasPorPagar'))
const PagosRecibidos          = lazy(() => import('@/pages/Finanzas/PagosRecibidos'))
const PagosEmitidos           = lazy(() => import('@/pages/Finanzas/PagosEmitidos'))
const AnticiposProveedor      = lazy(() => import('@/pages/Finanzas/AnticiposProveedor'))
const Facturacion             = lazy(() => import('@/pages/Finanzas/Facturacion'))
const ReporteContable         = lazy(() => import('@/pages/Finanzas/ReporteContable'))
const ReportesVentas          = lazy(() => import('@/pages/Reportes/ReportesVentas'))
const ReportesInventario      = lazy(() => import('@/pages/Reportes/ReportesInventario'))
const ReportesProduccion      = lazy(() => import('@/pages/Reportes/ReportesProduccion'))
const EstadoDeCuenta          = lazy(() => import('@/pages/Reportes/EstadoDeCuenta'))
const RhEmpleados             = lazy(() => import('@/pages/RH/Empleados'))
const RhVacaciones            = lazy(() => import('@/pages/RH/Vacaciones'))
const ConfigNotificaciones    = lazy(() => import('@/pages/Configuracion/Notificaciones'))
const ConfigCuentasBancarias  = lazy(() => import('@/pages/Configuracion/CuentasBancarias'))
const ConfigTarjetasCredito   = lazy(() => import('@/pages/Configuracion/TarjetasCredito'))
const ConfigAlmacenes         = lazy(() => import('@/pages/Configuracion/Almacenes'))
const ConfigUsuarios          = lazy(() => import('@/pages/Configuracion/Usuarios'))
const ConfigRoles             = lazy(() => import('@/pages/Configuracion/Roles'))
const ConfigDatosFiscales     = lazy(() => import('@/pages/Configuracion/DatosFiscales'))
const ConfigSeriesFolios      = lazy(() => import('@/pages/Configuracion/SeriesFolios'))
const ConfigNomenclatura      = lazy(() => import('@/pages/Configuracion/NomenclaturaCodigos'))
const ConfigTareasFallidas    = lazy(() => import('@/pages/Configuracion/TareasFallidas'))
const ConfigPlanes            = lazy(() => import('@/pages/Configuracion/Planes'))
const ConfigSuscripcion       = lazy(() => import('@/pages/Configuracion/Suscripcion'))
const ConfigIdentidadMarca    = lazy(() => import('@/pages/Configuracion/IdentidadMarca'))
const ConfigProcesos          = lazy(() => import('@/pages/Configuracion/Procesos'))
const ConfigProcesosFlags     = lazy(() => import('@/pages/Configuracion/procesos/Flags'))
const ConfigTiposMerma        = lazy(() => import('@/pages/Configuracion/procesos/TiposMerma'))
const ConfigCalidades         = lazy(() => import('@/pages/Configuracion/procesos/Calidades'))
const ConfigUnidades          = lazy(() => import('@/pages/Configuracion/procesos/Unidades'))
const ConfigRolesTurno        = lazy(() => import('@/pages/Configuracion/procesos/RolesTurno'))
const ConfigTiposProducto     = lazy(() => import('@/pages/Configuracion/procesos/TiposProducto'))
const ConfigAlergenos         = lazy(() => import('@/pages/Configuracion/procesos/Alergenos'))
const VencimientosProximos    = lazy(() => import('@/pages/Trazabilidad/VencimientosProximos'))
const CosteoOverview          = lazy(() => import('@/pages/Costeo/CosteoOverview'))
const CosteoGastosIndirectos  = lazy(() => import('@/pages/Costeo/GastosIndirectos'))
const CosteoPeriodos          = lazy(() => import('@/pages/Costeo/PeriodosOverhead'))
const CosteoCierre            = lazy(() => import('@/pages/Costeo/CierreDeMes'))
const CosteoVarianza          = lazy(() => import('@/pages/Costeo/VarianceReport'))
const CajaChica               = lazy(() => import('@/pages/CajaChica'))
const CajaChicaFondos         = lazy(() => import('@/pages/Configuracion/CajaChicaFondos'))
const CajaChicaCategorias     = lazy(() => import('@/pages/Configuracion/CajaChicaCategorias'))
const Gastos                  = lazy(() => import('@/pages/Gastos'))
const ConfigCategoriasGasto   = lazy(() => import('@/pages/Configuracion/CategoriasGasto'))
const MiPerfil                = lazy(() => import('@/pages/MiPerfil'))
const PlatformTenantsList     = lazy(() => import('@/pages/SuperAdmin/TenantsList'))
const PlatformTenantDetail    = lazy(() => import('@/pages/SuperAdmin/TenantDetail'))
const PlatformTenantNew       = lazy(() => import('@/pages/SuperAdmin/TenantNew'))
const PlatformPlansList       = lazy(() => import('@/pages/SuperAdmin/PlansList'))
const PlatformSystemMessages  = lazy(() => import('@/pages/SuperAdmin/SystemMessages'))
const Suspendido              = lazy(() => import('@/pages/Suspendido'))

const ComingSoon = ({ label }) => (
  <div className="page-enter flex flex-col items-center justify-center min-h-[60vh] text-center gap-3">
    <div className="w-12 h-12 rounded-xl bg-surface-elevated/60 flex items-center justify-center">
      <svg className="w-6 h-6 text-ink-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    </div>
    <p className="text-ink-secondary font-medium">{label}</p>
    <p className="text-sm text-ink-muted">Módulo próximamente</p>
  </div>
)

const RequireAuth = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const tenant = useAuthStore((s) => s.tenant)
  const user   = useAuthStore((s) => s.user)
  const { pathname } = useLocation()

  // Refresh proactivo: si el access token llegó vencido (sesión de ayer), lo
  // renovamos ANTES de montar las páginas (que disparan sus consultas). Así la
  // primera pantalla de la mañana no encadena 401 → refresh → reintento. Si el
  // token ya estaba fresco, bootReady arranca en true y no hay espera visible.
  const [bootReady, setBootReady] = useState(() => !isAuthenticated || !accessTokenNeedsRefresh())
  useEffect(() => {
    if (bootReady) return
    let alive = true
    ensureFreshToken().finally(() => { if (alive) setBootReady(true) })
    return () => { alive = false }
  }, [bootReady])

  if (!isAuthenticated) return <Navigate to="/login" replace />

  if (!bootReady) {
    return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>
  }

  // Tenant suspendido: encerramos al usuario en /suspendido. Excepción: los
  // platform admins pueden navegar a /superadmin (para reactivarse a sí
  // mismos o gestionar otros tenants).
  const tenantSuspended = tenant?.is_active === false
  const allowed = pathname === '/suspendido'
    || (user?.isPlatformAdmin && pathname.startsWith('/superadmin'))
  if (tenantSuspended && !allowed) {
    return <Navigate to="/suspendido" replace />
  }

  return (
    <AppShell>
      <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh]"><Spinner /></div>}>
        <Outlet />
      </Suspense>
    </AppShell>
  )
}

// Variante autenticada SIN AppShell — para la pantalla /suspendido, que es
// full-screen y no debe mostrar sidebar/topbar.
const RequireAuthBare = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Spinner /></div>}>
      <Outlet />
    </Suspense>
  )
}

// Gate para rutas del panel cross-tenant. El backend valida con
// requirePlatformAdmin; aquí solo evitamos enseñar la pantalla si no lo es.
const RequirePlatformAdmin = () => {
  const user = useAuthStore((s) => s.user)
  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />
  return <Outlet />
}


const RequireGuest = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (isAuthenticated) return <Navigate to="/" replace />
  return <Suspense fallback={null}><Outlet /></Suspense>
}

const router = createBrowserRouter([
  {
    element: <RequireGuest />,
    children: [
      { path: '/login',          element: <Login /> },
      { path: '/reset-password', element: <ResetPassword /> },
    ],
  },
  {
    element: <RequireAuthBare />,
    children: [
      { path: '/suspendido', element: <Suspendido /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      { path: '/',                    element: <Dashboard /> },
      { path: '/socios',              element: <Socios /> },
      { path: '/clientes',            element: <Socios /> },
      { path: '/productos',           element: <Productos /> },
      { path: '/precios-cliente',     element: <PreciosCliente /> },
      { path: '/paquetes',            element: <Paquetes /> },
      { path: '/precios-proveedor',   element: <PreciosProveedor /> },
      { path: '/materias-primas',         element: <MateriasPrimas /> },
      { path: '/produccion/ordenes',      element: <ProduccionOrdenes /> },
      { path: '/produccion/captura',      element: <ProduccionCaptura /> },
      { path: '/produccion/validacion',   element: <ProduccionValidacion /> },
      { path: '/produccion/recetas',           element: <ProduccionRecetas /> },
      { path: '/produccion/especificaciones',  element: <ProduccionEspecificaciones /> },
      { path: '/produccion/turno/:id/resumen', element: <ProduccionResumen /> },
      { path: '/produccion/mis-turnos',        element: <MisTurnos /> },
      { path: '/produccion/historico',         element: <ProduccionHistorico /> },
      { path: '/produccion/programacion',    element: <ProduccionProgramacion /> },
      { path: '/ventas',              element: <VentasPedidos /> },
      { path: '/ventas/:id',          element: <VentasPedidos /> },     // deep-link a un pedido (nueva pestaña)
      { path: '/cotizaciones',        element: <VentasCotizaciones /> },
      { path: '/remisiones',          element: <VentasRemisiones /> },
      { path: '/remisiones/:id',      element: <VentasRemisiones /> },  // deep-link a una remisión
      { path: '/compras/ordenes',     element: <ComprasOrdenes /> },
      { path: '/compras/recepciones', element: <ComprasRecepciones /> },
      { path: '/compras/devoluciones', element: <ComprasDevoluciones /> },
      { path: '/compras/facturas',    element: <ComprasFacturas /> },
      { path: '/facturacion',         element: <Facturacion /> },
      { path: '/facturacion/:id',     element: <Facturacion /> },       // deep-link a una factura
      { path: '/finanzas/reporte-contable', element: <ReporteContable /> },
      { path: '/reportes/ventas',           element: <ReportesVentas /> },
      { path: '/reportes/inventario',       element: <ReportesInventario /> },
      { path: '/reportes/produccion',       element: <ReportesProduccion /> },
      { path: '/reportes/cuentas-por-cobrar', element: <EstadoDeCuenta direction="cuentas-por-cobrar" /> },
      { path: '/reportes/cuentas-por-pagar',  element: <EstadoDeCuenta direction="cuentas-por-pagar" /> },
      { path: '/cxc',                 element: <CuentasPorCobrar /> },
      { path: '/cxp',                 element: <CuentasPorPagar /> },
      { path: '/pagos-recibidos',     element: <PagosRecibidos /> },
      { path: '/pagos-emitidos',      element: <PagosEmitidos /> },
      { path: '/cxp/anticipos',       element: <AnticiposProveedor /> },
      { path: '/inventario',          element: <Inventario /> },
      { path: '/inventario/conteos',     element: <ConteosLista /> },
      { path: '/inventario/conteos/:id', element: <ConteoDetalle /> },
      { path: '/rh/empleados',        element: <RhEmpleados /> },
      { path: '/rh/vacaciones',       element: <RhVacaciones /> },
      { path: '/rh/vacaciones/:id',   element: <RhVacaciones /> },
      { path: '/configuracion/notificaciones',    element: <ConfigNotificaciones /> },
      { path: '/configuracion/cuentas-bancarias', element: <ConfigCuentasBancarias /> },
      { path: '/configuracion/tarjetas-credito',  element: <ConfigTarjetasCredito /> },
      { path: '/configuracion/almacenes',         element: <ConfigAlmacenes /> },
      { path: '/configuracion/usuarios',          element: <ConfigUsuarios /> },
      { path: '/configuracion/roles',             element: <ConfigRoles /> },
      { path: '/configuracion/datos-fiscales',    element: <ConfigDatosFiscales /> },
      { path: '/configuracion/series-folios',     element: <ConfigSeriesFolios /> },
      { path: '/configuracion/nomenclatura',      element: <ConfigNomenclatura /> },
      { path: '/configuracion/tareas-fallidas',   element: <ConfigTareasFallidas /> },
      { path: '/configuracion/planes',            element: <ConfigPlanes /> },
      { path: '/configuracion/suscripcion',       element: <ConfigSuscripcion /> },
      { path: '/configuracion/identidad-marca',   element: <ConfigIdentidadMarca /> },
      { path: '/configuracion/caja-chica',           element: <CajaChicaFondos /> },
      { path: '/configuracion/caja-chica/categorias', element: <CajaChicaCategorias /> },
      { path: '/configuracion/procesos',                     element: <ConfigProcesos /> },
      { path: '/configuracion/procesos/flags',               element: <ConfigProcesosFlags /> },
      { path: '/configuracion/procesos/tipos-merma',         element: <ConfigTiposMerma /> },
      { path: '/configuracion/procesos/calidades',           element: <ConfigCalidades /> },
      { path: '/configuracion/procesos/unidades',            element: <ConfigUnidades /> },
      { path: '/configuracion/procesos/roles-turno',         element: <ConfigRolesTurno /> },
      { path: '/configuracion/procesos/tipos-producto',      element: <ConfigTiposProducto /> },
      { path: '/configuracion/procesos/alergenos',           element: <ConfigAlergenos /> },
      { path: '/trazabilidad/lotes',         element: <TrazabilidadLotes /> },
      { path: '/trazabilidad/vencimientos',  element: <VencimientosProximos /> },
      { path: '/costeo',                    element: <CosteoOverview /> },
      { path: '/costeo/gastos-indirectos',  element: <CosteoGastosIndirectos /> },
      { path: '/costeo/periodos',           element: <CosteoPeriodos /> },
      { path: '/costeo/cierre',             element: <CosteoCierre /> },
      { path: '/costeo/varianza',           element: <CosteoVarianza /> },
      { path: '/caja-chica',                      element: <CajaChica /> },
      { path: '/gastos',                          element: <Gastos /> },
      { path: '/configuracion/categorias-gasto',  element: <ConfigCategoriasGasto /> },
      { path: '/mi-perfil',                       element: <MiPerfil /> },

      // Panel cross-tenant (dueños de Praxion)
      {
        element: <RequirePlatformAdmin />,
        children: [
          { path: '/superadmin',                  element: <PlatformTenantsList /> },
          { path: '/superadmin/tenants/nuevo',    element: <PlatformTenantNew /> },
          { path: '/superadmin/tenants/:id',      element: <PlatformTenantDetail /> },
          { path: '/superadmin/plans',            element: <PlatformPlansList /> },
          { path: '/superadmin/mensajes',         element: <PlatformSystemMessages /> },
        ],
      },

      { path: '*',                    element: <Navigate to="/" replace /> },
    ],
  },
])

export default router
