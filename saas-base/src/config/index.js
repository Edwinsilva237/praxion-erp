'use strict'

require('dotenv').config()

function optional(key, defaultValue) {
  return process.env[key] ?? defaultValue
}

const DEFAULT_JWT_SECRET = 'dev_secret_change_in_production_min_64_chars_long'

const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),

  db: {
    host: optional('DB_HOST', 'localhost'),
    port: parseInt(optional('DB_PORT', '5432'), 10),
    name: optional('DB_NAME', 'saas_base'),
    user: optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', ''),
    pool: {
      min: parseInt(optional('DB_POOL_MIN', '2'), 10),
      max: parseInt(optional('DB_POOL_MAX', '10'), 10),
    },
  },

  jwt: {
    secret: optional('JWT_SECRET', DEFAULT_JWT_SECRET),
    // Default a la par de producción (render.yaml). Un access token corto (15m)
    // hacía que cualquier entorno sin la env explícita encadenara refresh cada
    // pocos minutos; 8h cubre una jornada. El refresh proactivo del frontend
    // renueva sin fricción cuando sí vence (sesión de un día para otro).
    expiresIn: optional('JWT_EXPIRES_IN', '8h'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  bcrypt: {
    rounds: parseInt(optional('BCRYPT_ROUNDS', '12'), 10),
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    // General — todas las rutas excepto /health. 10000 / 15 min ≈ 11 req/seg sostenidos.
    // Suficiente para 20+ operadores en una misma IP de LAN con polling cada 15s.
    max:        parseInt(optional('RATE_LIMIT_MAX', '10000'), 10),
    // Login — sólo intentos FALLIDOS cuentan (skipSuccessfulRequests=true).
    // 30 fallos por ventana es más que suficiente para typos múltiples sin permitir brute force real
    // (bcrypt rounds=12 hace cada intento muy costoso en CPU).
    authMax:    parseInt(optional('AUTH_RATE_LIMIT_MAX', '30'), 10),
    // Refresh — el token JWT expira cada 15min y el frontend lo renueva automáticamente.
    // Con varias pestañas / operadores en la misma IP, esto sube rápido. Mantenemos generoso.
    refreshMax: parseInt(optional('AUTH_REFRESH_MAX', '2000'), 10),
    // Forgot/Reset password — más estricto porque son acciones sensibles que dependen de email.
    forgotMax:  parseInt(optional('AUTH_FORGOT_MAX', '20'), 10),
  },

  email: (() => {
    const user = optional('SMTP_USER', '')
    const rawFrom = optional('EMAIL_FROM', '')
    // Fallback: si EMAIL_FROM quedó con el placeholder del .env.example
    // o vacío, usamos el SMTP_USER autenticado (Gmail rechaza un From
    // distinto al usuario salvo alias verificados).
    const from = (!rawFrom || rawFrom === 'tu_cuenta@gmail.com') ? user : rawFrom
    return {
      host:     optional('SMTP_HOST', 'smtp.gmail.com'),
      port:     parseInt(optional('SMTP_PORT', '465'), 10),
      secure:   optional('SMTP_SECURE', 'true') === 'true',
      user,
      pass:     optional('SMTP_PASS', ''),
      from,
      fromName: optional('EMAIL_FROM_NAME', 'SaaS Base'),
    }
  })(),

  // URL pública del FRONTEND. Se usa para construir los links en correos
  // (reset password, invitación, bienvenida) y el allowlist de CORS.
  // OJO: NO es la URL del backend (Express) — esa es PORT + bind local.
  appUrl: optional('APP_URL', 'http://localhost:5173'),

  // URL pública del BACKEND (Express) — para links que apuntan al propio API,
  // como la descarga de la app Android en correos de invitación/bienvenida.
  apiPublicUrl: optional('API_PUBLIC_URL', 'https://praxion-api.onrender.com'),

  // App Android: cuando la app esté en Play Store, setear ANDROID_APP_URL a su
  // liga y el endpoint /app/android redirige ahí (los correos viejos también).
  // Vacío => /app/android sirve el APK auto-hospedado en R2.
  androidAppUrl: optional('ANDROID_APP_URL', ''),

  sentry: {
    // Si vacío, Sentry queda en no-op (seguro por defecto en dev/test).
    dsn:               optional('SENTRY_DSN', ''),
    // Muestreo de traces (performance). 0 = solo errores.
    tracesSampleRate:  parseFloat(optional('SENTRY_TRACES_SAMPLE_RATE', '0')),
    // Identificador del release/deploy — útil para correlacionar errores con commits.
    release:           optional('SENTRY_RELEASE', ''),
  },

  uploads: {
    dir:        optional('UPLOAD_DIR', 'uploads'),
    maxSizeMb:  parseInt(optional('UPLOAD_MAX_SIZE_MB', '20'), 10),
    // MIME types globalmente permitidos. La validación FINA por categoría
    // (PDF para ficha técnica, imagen para foto de producto) la hace
    // attachmentService.saveAttachment vía MIME_BY_CATEGORY.
    allowedMimeTypes: [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp',
    ],
  },

  // Pagos y suscripciones (Stripe). Si STRIPE_SECRET_KEY está vacío el módulo
  // billing responde 503 — el sistema funciona como hoy sin cobros.
  stripe: {
    secretKey:      optional('STRIPE_SECRET_KEY', ''),
    webhookSecret:  optional('STRIPE_WEBHOOK_SECRET', ''),
    // URL pública del frontend para construir success/cancel URLs de Checkout.
    appUrl:         optional('APP_PUBLIC_URL', 'http://localhost:5173'),
    // Días de trial al crear tenant nuevo. Si tu producto requiere onboarding
    // más largo, sube esto.
    trialDays:      parseInt(optional('STRIPE_TRIAL_DAYS', '14'), 10),
    // Días de gracia tras un cobro rechazado (past_due) antes de bloquear.
    // Durante este periodo el usuario tiene tiempo de actualizar tarjeta.
    graceDays:      parseInt(optional('STRIPE_GRACE_DAYS', '7'), 10),
  },

  // Cola de tareas en segundo plano (BullMQ sobre Redis). Si REDIS_URL está
  // vacío, los enqueue* caen a ejecución sincrónica — el sistema sigue
  // funcionando como antes pero sin reintentos automáticos.
  queue: {
    // URL de conexión Redis. Para Upstash es 'rediss://...' (TLS obligatorio).
    // Para Redis local de dev: 'redis://localhost:6379'.
    redisUrl:        optional('REDIS_URL', ''),
    // Cuántas veces reintentar un job que falló antes de marcarlo como muerto.
    maxAttempts:     parseInt(optional('QUEUE_MAX_ATTEMPTS', '3'), 10),
    // Cuánto esperar entre reintentos (ms). Crece exponencial: 1s, 5s, 25s.
    backoffMs:       parseInt(optional('QUEUE_BACKOFF_MS', '1000'), 10),
    // Cuánto tiempo conservar jobs completados (segundos) — útil para auditoría.
    keepCompletedSec: parseInt(optional('QUEUE_KEEP_COMPLETED_SEC', '86400'), 10),
    // Jobs fallidos: conservar más tiempo para que el admin los pueda revisar.
    keepFailedSec:    parseInt(optional('QUEUE_KEEP_FAILED_SEC', '604800'), 10),
  },

  // Object storage (Cloudflare R2 — S3-compatible). Si R2_BUCKET está vacío,
  // storageService cae a disco local (UPLOAD_DIR) — útil en dev sin credenciales.
  storage: {
    bucket:          optional('R2_BUCKET', ''),
    accountId:       optional('R2_ACCOUNT_ID', ''),
    accessKeyId:     optional('R2_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('R2_SECRET_ACCESS_KEY', ''),
    region:          optional('R2_REGION', 'auto'),
    // TTL del signed URL en segundos. 5 minutos basta para que el browser haga
    // el redirect y descargue; tampoco queremos URLs guardables/compartibles.
    signedUrlTtl:    parseInt(optional('R2_SIGNED_URL_TTL', '300'), 10),
  },

  // Firebase Cloud Messaging (push notifications a la app móvil). Si las 3
  // credenciales no están, `pushService` queda en NO-OP silencioso (igual que
  // SMTP/R2 vacíos): no se manda nada, no se carga firebase-admin, los tests
  // siguen verde y el arranque nunca se rompe. Se habilita seteando las 3 env.
  // Las credenciales salen de la Service Account del proyecto Firebase
  // (Configuración → Cuentas de servicio → Generar nueva clave privada).
  firebase: (() => {
    const projectId   = optional('FIREBASE_PROJECT_ID', '')
    const clientEmail = optional('FIREBASE_CLIENT_EMAIL', '')
    // Render (y otros) entregan la clave en una sola línea con `\n` literales.
    // La normalizamos a saltos de línea reales para que admin.credential.cert
    // la acepte. Si se pega multilínea tal cual, el replace es inofensivo.
    const privateKey  = optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n')
    return {
      projectId,
      clientEmail,
      privateKey,
      enabled: !!(projectId && clientEmail && privateKey),
    }
  })(),

  isProd: () => config.env === 'production',
  isDev: () => config.env === 'development',
  isTest: () => config.env === 'test',
}

// ── Validación de seguridad al arranque ─────────────────────────────────────
// En producción abortamos si detectamos config insegura (secretos default,
// claves demasiado cortas, credenciales vacías). En dev solo advertimos.
function validateStartupConfig() {
  const problems = []

  if (config.jwt.secret === DEFAULT_JWT_SECRET) {
    problems.push('JWT_SECRET está usando el valor por defecto inseguro. Asigna un valor aleatorio fuerte (≥32 caracteres).')
  } else if (config.jwt.secret.length < 32) {
    problems.push(`JWT_SECRET es demasiado corto (${config.jwt.secret.length} chars). Usa ≥32 caracteres de aleatoriedad.`)
  }

  if (config.env === 'production') {
    if (!config.db.password) problems.push('DB_PASSWORD está vacío en producción.')
    if (config.email.user && !config.email.pass) problems.push('SMTP_USER configurado pero SMTP_PASS vacío.')
  }

  if (problems.length === 0) return

  if (config.env === 'production') {
    // Sin logger todavía (este módulo se carga antes que logger).
    console.error('\n[config] Arranque bloqueado por configuración insegura:')
    for (const p of problems) console.error('  • ' + p)
    console.error('')
    process.exit(1)
  } else {
    // En dev/test solo avisamos — útil mientras se desarrolla.
    for (const p of problems) console.warn('[config] Advertencia: ' + p)
  }
}

validateStartupConfig()

module.exports = config
