'use strict'

// ⚠️ Sentry DEBE inicializarse antes de cargar Express y demás módulos
// para que la instrumentación automática (HTTP, Express, PG) se enganche.
const { Sentry, isInitialized: sentryReady } = require('./config/sentry')

const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const config = require('./config')
const logger = require('./config/logger')

const app = express()

// Render (y cualquier reverse proxy) inyecta X-Forwarded-* headers. Sin este
// flag, req.ip muestra la IP del proxy, lo cual rompe rate-limit y logging.
// '1' = confiar en 1 hop (el proxy de Render).
app.set('trust proxy', 1)

app.use(helmet())
app.disable('x-powered-by')

// ── CORS ─────────────────────────────────────────────────────────────────────
// En dev permitimos localhost / LAN libre. En prod whitelistamos el dominio
// del producto y todos sus subdominios (multi-tenant por subdominio).
const corsOrigin = (origin, callback) => {
  // Mismo-origen / curl / server-to-server: sin Origin header → permitir.
  if (!origin) return callback(null, true)

  const patterns = [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    // Apps nativas (Capacitor). El webview de iOS usa el origen `capacitor://localhost`:
    // NO se puede forzar `https` como iosScheme (WKWebView reserva ese scheme y
    // Capacitor lo descarta volviendo al default `capacitor://`). Android usa
    // `https://localhost` (androidScheme default) y ya cae en el primer patrón.
    // Sin esto, el preflight del iOS daba 500 ("CORS bloqueado") → la app no conectaba.
    /^capacitor:\/\/localhost$/,
    /^ionic:\/\/localhost$/,
  ]

  if (config.appUrl) {
    try {
      const host = new URL(config.appUrl).hostname.replace(/\./g, '\\.')
      patterns.push(new RegExp(`^https?:\\/\\/${host}$`))
      patterns.push(new RegExp(`^https?:\\/\\/[^.]+\\.${host}$`))
    } catch (_e) { /* APP_URL inválida — solo dev queda permitido */ }
  }

  if (patterns.some(re => re.test(origin))) return callback(null, true)
  return callback(new Error(`CORS bloqueado: ${origin}`))
}

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  exposedHeaders: ['X-Tenant-Id'],
}))

// ── Rate limit general ───────────────────────────────────────────────────────
// En desarrollo se multiplica ×10 para que las pruebas locales con múltiples
// pestañas no se auto-bloqueen. En producción usa el valor configurado.
const generalMax = config.isDev() ? config.rateLimit.max * 10 : config.rateLimit.max

app.use(rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: generalMax,
  standardHeaders: true,
  legacyHeaders: false,
  // No contar healthchecks ni preflight CORS hacia el límite general.
  skip: (req) => req.path === '/health' || req.method === 'OPTIONS',
  message: { error: 'Too many requests, please try again later.' },
}))

// Ingesta de correo entrante (Cloudflare Email Worker → API). Server-to-server,
// sin sesión de usuario: la protege un secret compartido. Va ANTES del express.json
// global (1mb) porque un PDF adjunto en base64 puede superarlo; usa su propio parser.
app.use('/api/inbound', express.json({ limit: '15mb' }), require('./modules/inbound/routes'))

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))

app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, { ip: req.ip })
  next()
})

// El tagging de Sentry (tenant_id, user_id) se aplica dentro de tenantResolver
// y authGuard — donde sí está poblado req.tenant / req.auth.

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), sentry: sentryReady() })
})

// Política de privacidad pública (sin auth) — URL ESTABLE para Google Play y
// App Store (campo obligatorio "Política de privacidad" / "Privacy Policy URL").
const { html: privacyHtml } = require('./legal/privacyPage')
app.get(['/privacidad', '/privacy'], (_req, res) => {
  res.type('html').send(privacyHtml)
})

// Descarga pública de la app Android (sin auth) — URL ESTABLE para los correos
// de invitación/bienvenida. Si ANDROID_APP_URL está configurada (la app ya está
// en Play Store) redirige ahí, así los correos viejos también llevan a la tienda.
// Si no, sirve el APK auto-hospedado en R2 (key public/praxion-app.apk). Swap a
// Play Store = setear la env var, sin tocar código ni reenviar invitaciones.
app.get('/app/android', async (_req, res, next) => {
  try {
    if (config.androidAppUrl) return res.redirect(302, config.androidAppUrl)
    const storage = require('./utils/storage')
    await storage.serve(res, 'public/praxion-app.apk', {
      filename: 'Praxion.apk',
      mimeType: 'application/vnd.android.package-archive',
      disposition: 'attachment',
      proxy: true,
    })
  } catch (err) { next(err) }
})

// Rutas
app.use('/api/auth',  require('./modules/auth/routes'))
app.use('/api/memberships', require('./modules/memberships/routes'))
app.use('/api/roles', require('./modules/roles/routes'))
app.use('/api/users',   require('./modules/users/routes'))
app.use('/api/hr',      require('./modules/hr/routes'))                  // Recursos Humanos (empleados + vacaciones)
app.use('/api/tenants',    require('./modules/tenants/routes'))
app.use('/api/audit-logs', require('./modules/audit/routes'))
app.use('/api/sat',               require('./modules/sat/routes'))         // catálogos SAT (CFDI 4.0)
app.use('/api/products',          require('./modules/products/routes'))
app.use('/api/raw-materials',     require('./modules/raw-materials/routes'))
app.use('/api/production',         require('./modules/production/routes'))
app.use('/api/process-config',     require('./modules/process-config/routes'))  // SaaS v2
app.use('/api/recipes',            require('./modules/recipes/routes'))           // SaaS v2
app.use('/api/lots',               require('./modules/lots/routes'))               // SaaS v2 §5h
app.use('/api/product-lots',       require('./modules/product-lots/routes'))       // SaaS v2 §143
app.use('/api/traceability',       require('./modules/traceability/routes'))       // SaaS v2 §D
app.use('/api/alerts',             require('./modules/alerts/routes'))             // SaaS v2 §5h
app.use('/api/overhead',           require('./modules/overhead-costing/routes'))   // SaaS v2 §Fase3
app.use('/api/business-partners', require('./modules/business-partners/routes'))
app.use('/api/exchange-rates',    require('./modules/exchange-rates/routes'))
app.use('/api/sales',             require('./modules/sales/routes'))
app.use('/api/quotations',        require('./modules/quotations/routes'))
app.use('/api/purchases',         require('./modules/purchases/routes'))
app.use('/api/financials', require('./modules/financials/routes'))
app.use('/api/bank-accounts', require('./modules/bank-accounts/routes'))
app.use('/api/credit-cards', require('./modules/credit-cards/routes'))
app.use('/api/invoicing', require('./modules/invoicing/routes'))
app.use('/api/fiscal-profiles', require('./modules/fiscal-profiles/routes'))
app.use('/api/invoice-series',  require('./modules/invoice-series/routes'))
app.use('/api/document-series', require('./modules/document-series/routes'))
app.use('/api/code-formats',    require('./modules/code-formats/routes'))
app.use('/api/inventory',  require('./modules/inventory/routes'))
app.use('/api/warehouses', require('./modules/inventory/warehouseRoutes'))
app.use('/api/admin',      require('./modules/admin/routes'))
app.use('/api/platform-admin', require('./modules/platformAdmin/routes'))
app.use('/api/system-messages', require('./modules/systemMessages/routes'))
app.use('/api/push',       require('./modules/push/routes'))                  // notificaciones push (FCM)
app.use('/api/billing',    require('./modules/billing/routes'))
app.use('/api/reports',    require('./modules/reports/routes'))
app.use('/api/petty-cash', require('./modules/pettyCash/routes'))


app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Sentry: enganche oficial para Express (v10). Debe registrarse DESPUÉS de
// las rutas pero ANTES del error handler propio. Solo captura cuando hay DSN
// Y no estamos en tests (en tests Sentry trona porque su instrumentación
// no se inicializa antes que express en el ciclo de jest).
if (sentryReady() && config.env !== 'test') {
  Sentry.setupExpressErrorHandler(app)
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack })
  const status = err.status || err.statusCode || 500
  const message = config.isProd() && status === 500 ? 'Internal server error' : err.message
  const payload = { error: message }
  if (err.code)    payload.code    = err.code
  if (err.details) payload.details = err.details
  res.status(status).json(payload)
})

// Tareas en cola (BullMQ) y tareas programadas (pg-boss). Los archivos se
// requieren primero para que registren sus workers/crons; luego se arrancan.
// En tests evitamos pg-boss (usa ESM, jest no lo transforma) y los crons
// (no aportan al testing y traen pg-boss como dependencia).
require('./queues/emailQueue')
require('./queues/invoicingQueue')
const queue = require('./utils/queue')

if (config.env !== 'test') {
  require('./crons')
}

if (require.main === module) {
  queue.startWorkers()
  if (config.env !== 'test') {
    const pgboss = require('./utils/pgboss')
    pgboss.startBoss().catch(err =>
      logger.error('Error iniciando pg-boss', { error: err.message })
    )
  }
  app.listen(config.port, () => {
    logger.info(`Server running on port ${config.port} [${config.env}]`)
  })
}

module.exports = app
