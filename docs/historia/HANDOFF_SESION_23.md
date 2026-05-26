# HANDOFF — Sesión 23 (2026-05-20)

## Módulo trabajado
**Sistema de roles y permisos avanzado + saneamiento previo al deploy**. Sesión muy larga. Cierre del modelo de control de acceso end-to-end y arranque del proyecto de deploy a la nube.

## Estado al cierre
**Pausa intencional en setup de Cloudflare R2** antes de continuar con el deploy a Render. El usuario tomó el plan paso a paso para crear cuenta + bucket + credenciales R2. Próxima sesión reanuda con: recibir credenciales R2, aplicar cambios de código de Fase A (CORS, SSL en pool PG, JWT secret), crear render.yaml + Dockerfile, primer deploy.

## Migraciones aplicadas (105–109)

- **105** `petty_cash_movements.paid_to VARCHAR(150)` + CHECK requerido en `kind='out'`. Beneficiario del movimiento de caja chica para auditoría.
- **106** Permisos granulares de reportes (`reports:sales`, `reports:cxc`, `reports:cxp`, `reports:production`, `reports:accounting`) + columnas `roles.mobile_tabs JSONB` (max 5) y `roles.home_route VARCHAR(150)`. CHECK constraints incluidos.
- **107** `users.primary_role_id UUID REFERENCES roles(id) ON DELETE SET NULL`. Desempata mobile_tabs/home_route cuando un usuario tiene varios roles.
- **108** Permiso `billing:manage` para gestión de Stripe (Suscripción + Planes). Asignado al super_admin global.
- **109** Permisos faltantes `financials:read/create/update/delete` — **bug histórico**: el backend usaba `checkPermission('financials',...)` pero esos permisos nunca se habían insertado en la BD. Por eso CxC, CxP, Anticipos y Cuentas bancarias solo funcionaban para super_admin.

## Funcionalidad nueva sesión 23

### Caja chica
- Botones header de Entrada → verde (`btn-primary`), Salida → rojo (`btn-danger`). Antes estaban invertidos visualmente.
- Campo "Entregado a" (`paid_to`) obligatorio en salidas, opcional en entradas. Backend valida required en `kind='out'`. UI: input texto libre con placeholder + sub-línea bajo descripción en la tabla.

### Sidebar
- Items colapsables con persistencia en `localStorage` (`praxion.sidebar.collapsed`).
- Detección automática de jerarquía padre/hijo via prefijo `└` en label.
- Auto-expand del grupo/padre que contenga la ruta activa.
- Default colapsado en primer ingreso (sin localStorage). Después respeta el estado del usuario.
- **Refactor importante**: extraje `NAV_SECTIONS` a `src/config/sidebarNav.js` (sin JSX, con `iconKey` string). Sidebar inyecta SVG iconos al renderizar. Editor de roles lee la misma fuente.
- **Bugs corregidos**: "Almacenes" usaba `inventario:manage` (español, no existe) → `warehouses:read`. "Notificaciones" tenía `permission: null` (visible para todos) → `settings:read`. "Mi suscripción" y "Planes y precios" → `billing:manage`.

### Componente `<Can>` reusable
- `src/components/auth/Can.jsx`. Sintaxis: `<Can do="resource:action">…</Can>`. Acepta array `do={['a:b','c:d']}` para OR. Prop `fallback` para mostrar versión gris.
- Hook compañero `useCan(perm)` para condicionales fuera de JSX.
- Aplicado a ~25 botones en producción, ventas, compras, inventario, configuración. Patrón de **ocultar** lo que es ajeno al rol; **disabled + tooltip** lo que es parte del flujo pero excede el nivel.

### Catálogo de botones controlables (`src/config/buttonCatalog.js`)
- 30+ entradas con `{ key, label, screen, permission, accessPermission }`.
- Función `groupedByScreen(accessSet)` filtra por permisos de lectura.
- Función `buttonsSharingPermission(btn)` detecta interruptores compartidos.

### Editor de rol con 4 pestañas (Roles.jsx)
1. **Permisos** — matriz técnica resource:action (lo que ya existía).
2. **Botones** — vista por pantalla del catálogo, filtrada por accessPermission del rol.
3. **Menú lateral** — replica del sidebar con checkboxes; marcar item activa el permiso de lectura que lo controla. Items con `permission:null` (Inicio) se muestran como "siempre visible".
4. **Inicio y móvil** — ventana de inicio (select de 15 rutas curadas) + tabs móvil con reordenamiento.
- Nav superior en pill style con borde brand-500 y altura mínima 48px (después de iteración por bug de visibilidad).
- Plantillas sugeridas + nombre/descripción quedan fuera de pestañas, siempre visibles arriba.

### Pantallas de Configuración con patrón read-only / editable
- **Notificaciones**: input `disabled={!canEdit}`, botones Guardar/Cancelar envueltos en `<Can do="settings:update">`.
- **Identidad de marca**: inputs de nombre + colores `disabled`, color pickers con prop `disabled`, botones subir/eliminar logo + Guardar + Sincronizar Facturapi con `<Can>`.
- **Datos fiscales**: botón Editar y Subir/Reemplazar CSD con `<Can do="settings:update">`.
- **Cuentas bancarias**: Nueva cuenta con `financials:create`, Editar con `financials:update`, Desactivar con `financials:delete`.
- **Mi suscripción / Planes**: Cambiar plan + Portal Stripe con `<Can do="billing:manage">`. Botón "Suscribirme" en Planes muestra fallback "Sin permiso" para no-dueños.

### Rol principal del usuario
- `users.primary_role_id` desempata cuando un usuario tiene 2+ roles con preferencias distintas (mobile_tabs / home_route).
- `getUserUiPrefs(userId)` en permissionService consulta primero `primary_role_id`; sin él, cae al fallback (rol propio del tenant más reciente con valor).
- Combo "Rol principal" en modal de edición de usuario, solo visible cuando hay ≥2 roles seleccionados. Default: "Sin elegir".
- Backend (`PUT /users/:id/roles`) acepta `primaryRoleId` y valida que esté entre los roleIds asignados.
- Frontend filtra roles "fantasma" del usuario (asignados pero ya no existentes en lista del tenant) antes de mandar al backend.

### Backend reforzado (defense in depth)
- Tres endpoints de Producción subidos de `create`/`update` a `manage` para alinear con frontend:
  - `POST /production/orders` (Nueva orden)
  - `POST /production/scheduled-shifts` (Programar turno)
  - `PATCH /production/scheduled-shifts/:id` (Editar turno programado)
  - `PUT /production/shift-config` (Configurar horarios)

### Mejora de error en `PUT /users/:id/roles`
- Dedup de `roleIds` por si llega duplicado.
- Respuesta de error ahora incluye `missingRoleIds` específicos cuando la validación falla — diagnóstico claro de roles fantasma.

### Tabs móvil ampliados
- Catálogo `src/config/mobileTabs.js` con 12+ entradas: home, captura, órdenes prod, programación, histórico, pedidos, cotizaciones, remisiones, facturación, compras, CxC (label renombrado), CxP nuevo, inventario, caja chica.
- BottomNav respeta `uiPrefs.mobile_tabs` del usuario (orden incluido); fallback al filtrado dinámico por permiso si no hay config.

### Plantillas de roles actualizadas (`permissionsMeta.js`)
- Vendedor → +reports:sales
- Facturista → +reports:sales, reports:accounting
- Cobranza → +reports:sales, reports:cxc
- Compras → +reports:cxp
- Supervisor de producción → +reports:production
- Solo lectura → ahora incluye todos los reports (action !== 'read' pero resource === 'reports')

## Discusiones estratégicas (sin código)

### Sobre generalizar el módulo de producción
Usuario sin cliente concreto de otro giro pero quiere abrir a otros mercados. **Recomendación dada**: NO generalizar especulativamente. El producto **ya vende sin producción** (ventas + compras + inventario + facturación CFDI 4.0 sirven a distribuidoras, dulcerías, tortillerías chiquitas, papelerías, etc.). Estrategia propuesta:
1. **Fase 1 — Cimientos no invasivos** (cuando llegue el momento): `process_type` y `unit_of_measure` en productos, mover `length_mm` a JSON de atributos. No rompe esquineros.
2. Vender el sistema sin producción a 2-3 giros distintos primero.
3. Conseguir piloto barato/gratis con panadería local para diseñar Fase 2-4 con base real.

**Decisión del usuario**: pausar generalización de producción, ir a deploy primero.

### Sobre deploy a la nube
Decisiones tomadas:
- **Plataforma**: Render (backend Web Service + frontend Static Site + Postgres managed).
- **BD**: Render Postgres (la que viene con la plataforma).
- **Dominio**: tiene dominio (no me dijo cuál todavía), multi-tenant por subdominio (`*.dominio.com`).
- **Cloudflare R2**: **SÍ, MUST antes de deploy** — disco efímero de Render perdería todos los uploads.
- **Upstash Redis**: postergado, modo síncrono OK para arrancar.
- **Stripe live**: postergado, sin cobros mientras no haya clientes.
- **Facturapi**: **YA en modo live**.

## Gaps detectados en audit pre-deploy

| Tema | Estado | Acción próxima sesión |
|---|---|---|
| Archivos de despliegue (Dockerfile, render.yaml) | No existen | Crear |
| CORS | Abierto a cualquier origen | Whitelist con APP_URL |
| SSL a la BD | Sin config en pool | Activar cuando `NODE_ENV=production` |
| `trust proxy` | Sin config | Setear para que helmet/rate-limit funcionen tras Render |
| RLS | Apagado por default, doc en `docs/RLS_ACTIVATION.md` | Activar después del primer deploy |
| JWT_SECRET | Default detectado y bloqueado en startup en prod | Generar 64+ chars para Render env vars |

## Pendiente inmediato para próxima sesión

**Usuario está configurando Cloudflare R2 ahora.** Debe mandar al inicio de la próxima sesión:
```
R2_BUCKET        = (nombre del bucket)
R2_ACCOUNT_ID    = (account ID de Cloudflare)
R2_ACCESS_KEY_ID = (del API token con permisos Object Read & Write)
R2_SECRET_ACCESS_KEY = (mismo token)
```

Plus su **dominio** (`praxion.mx` u otro) y si está gestionado en Cloudflare DNS o en otro registrar.

## Plan reanudación (Fase A de deploy)

1. Recibir R2 creds + dominio del usuario.
2. Cambios de código:
   - Generar JWT_SECRET de 64 chars (script `crypto.randomBytes(32).toString('hex')`).
   - Agregar middleware CORS con whitelist (`origin: process.env.APP_URL`).
   - Configurar SSL en pool de PG cuando `NODE_ENV=production` (`ssl: { rejectUnauthorized: false }` para Render managed).
   - `app.set('trust proxy', 1)` en express.
   - Actualizar `.env.example` con comentarios para producción.
3. Crear `render.yaml` con backend + frontend + Postgres + variables de entorno declaradas.
4. Crear `Dockerfile` del backend (multi-stage Node 20 alpine).
5. Smoke test local del build de producción del backend antes de subir.

Sesión 24 (subir a Render):
6. Crear servicios en Render dashboard (o via render.yaml).
7. Configurar variables de entorno con credenciales reales (R2, Facturapi, JWT, DB url de Render).
8. Correr migraciones contra BD de Render (job o ejecutar manualmente).
9. Configurar dominios custom (apex + wildcard + api).
10. Smoke test `/health` y login del super_admin.

Sesión 25 (endurecer):
11. Activar RLS siguiendo `docs/RLS_ACTIVATION.md` (crear rol `app_runtime`, cambiar DB_USER).
12. Configurar Sentry en producción.
13. Validar multi-tenant con un tenant secundario de prueba.

## Archivos clave creados/modificados sesión 23

**Backend:**
- `src/db/migrations/105_petty_cash_paid_to.js`
- `src/db/migrations/106_reports_perms_role_prefs.js`
- `src/db/migrations/107_users_primary_role.js`
- `src/db/migrations/108_billing_manage_permission.js`
- `src/db/migrations/109_financials_permissions.js`
- `src/modules/pettyCash/pettyCashService.js`
- `src/modules/roles/routes.js`
- `src/modules/roles/permissionService.js` (nuevo: `getUserUiPrefs`)
- `src/modules/users/routes.js`
- `src/modules/users/userService.js`
- `src/modules/auth/routes.js`
- `src/modules/auth/authService.js`
- `src/modules/reports/routes.js` (permisos granulares + middleware `reportsStatementPermission`)
- `src/modules/production/routes.js` (3 endpoints subidos a `manage`)

**Frontend:**
- `src/components/auth/Can.jsx` (nuevo)
- `src/config/buttonCatalog.js` (nuevo)
- `src/config/mobileTabs.js` (ampliado)
- `src/config/sidebarNav.js` (nuevo, extraído de Sidebar)
- `src/config/permissionsMeta.js` (grupo reports + plantillas actualizadas)
- `src/components/layout/Sidebar.jsx` (colapsable + default colapsado + bugs corregidos)
- `src/components/layout/BottomNav.jsx` (respeta mobile_tabs del rol)
- `src/pages/CajaChica.jsx` (botones rojo/verde + paid_to)
- `src/pages/Dashboard.jsx` (respeta home_route)
- `src/pages/Login.jsx` (recibe uiPrefs)
- `src/pages/Configuracion/Roles.jsx` (4 pestañas + catálogo + filtrado)
- `src/pages/Configuracion/Usuarios.jsx` (combo Rol principal + filtro de roles fantasma)
- `src/pages/Configuracion/Notificaciones.jsx` (read-only)
- `src/pages/Configuracion/IdentidadMarca.jsx` (read-only)
- `src/pages/Configuracion/DatosFiscales.jsx` (Can en Editar + CSD)
- `src/pages/Configuracion/CuentasBancarias.jsx` (CRUD con financials:*)
- `src/pages/Configuracion/Suscripcion.jsx` (Can con billing:manage)
- `src/pages/Configuracion/Planes.jsx` (Can con billing:manage)
- `src/pages/Produccion/ProduccionOrdenes.jsx` (Can con production:manage)
- `src/pages/Produccion/ProduccionProgramacion.jsx` (3 botones con production:manage)
- `src/pages/Ventas/VentasPedidos.jsx` (Can con sales:create)
- `src/pages/Ventas/VentasCotizaciones.jsx` (Can con sales:create)
- `src/pages/Ventas/VentasRemisiones.jsx` (Can con sales:create)
- `src/pages/Finanzas/Facturacion.jsx` (Can con invoicing:create)
- `src/pages/Finanzas/CuentasPorCobrar.jsx` (Can con financials:create)
- `src/pages/Finanzas/CuentasPorPagar.jsx` (Can con financials:create)
- `src/pages/Finanzas/AnticiposProveedor.jsx` (Can con financials:create)
- `src/pages/Compras/ComprasOrdenes.jsx` (Can con purchases:create)
- `src/pages/Compras/ComprasRecepciones.jsx` (Can con purchases:create)
- `src/pages/Compras/ComprasFacturas.jsx` (Can con purchases:create x2)
- `src/pages/Inventario.jsx` (Can con inventory:adjust)
- `src/pages/Inventario/ConteosLista.jsx` (Can con inventory:create)
- `src/pages/Inventario/ConteoDetalle.jsx` (Can con inventory:adjust)
- `src/api/users.js` (setRoles acepta primaryRoleId)
- `src/store/useAuthStore.js` (uiPrefs persistido)

## Decisiones de arquitectura importantes

1. **Modelo de permisos**: cada UI debe usar `<Can>` o `useCan`. Backend debe usar `checkPermission` en cada endpoint. Defense in depth — ambas capas.
2. **Catálogo de botones es código, no BD**: el admin no crea botones, solo activa permisos. Los botones son `<Can>` puestos por el desarrollador y registrados en `buttonCatalog.js`.
3. **`accessPermission` vs `permission` en catálogo**: el primero filtra qué pantallas aparecen en el editor; el segundo es el permiso que el botón activa. Permite UI más limpia (no muestra pantallas que el rol no tiene acceso de lectura).
4. **Rol principal explícito** para desempatar mobile_tabs/home_route. Antes era arbitrario (rol propio más reciente). Ahora el admin decide.
5. **Settings pattern**: lectura con `*:read` (permite ver la pantalla), edición con `*:update` o permiso específico del recurso. UI muestra modo read-only con inputs disabled + botones ocultos.
