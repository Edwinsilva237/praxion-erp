'use strict'

// Setup global de jest. Se ejecuta antes de cualquier require de la app.
// Ajusta variables de entorno para que el sistema corra en modo "test".

process.env.NODE_ENV = 'test'

// Rounds bajos = bcrypt rápido = tests rápidos. Solo en test.
process.env.BCRYPT_ROUNDS = '4'

// Silenciar el rate limit en tests (no queremos que los tests rápidos se auto-bloqueen).
process.env.RATE_LIMIT_MAX        = '100000'
process.env.AUTH_RATE_LIMIT_MAX   = '100000'
process.env.AUTH_REFRESH_MAX      = '100000'
process.env.AUTH_FORGOT_MAX       = '100000'

// JWT secret garantizado válido en test (evita el fail-fast de prod).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jest_runs_only_min_64_characters_xxxxxxxxxxxxxx'

// REDIS, STRIPE, R2, SMTP deshabilitados — los tests son self-contained y NO
// deben tocar servicios externos.
//
// ⚠️ SMTP SE VACÍA A PROPÓSITO. Varios flujos cubiertos SÍ disparan correo
// (provisión de tenant manda bienvenida, invitar usuario, enviar cotización…).
// Como en test no hay Redis, `enqueueEmail` cae al envío SÍNCRONO real. Si el
// `.env` local tiene credenciales reales (ej. Workspace), CADA test que crea un
// tenant enviaría un correo real a una dirección `@test.local` que rebota —
// quemando la cuota de envío diaria y la reputación del dominio. Vaciando
// SMTP_USER/PASS, `sendEmail` lanza "SMTP no configurado" y los callers
// (best-effort, todos con try/catch) lo ignoran → CERO envíos reales en tests.
process.env.REDIS_URL          = ''
process.env.STRIPE_SECRET_KEY  = ''
process.env.R2_BUCKET          = ''
process.env.SMTP_USER          = ''
process.env.SMTP_PASS          = ''

// Firebase/FCM deshabilitado en test: sin las 3 env, pushService queda en no-op
// (no carga firebase-admin, no manda nada) → el hook de alertas no envía push.
process.env.FIREBASE_PROJECT_ID   = ''
process.env.FIREBASE_CLIENT_EMAIL = ''
process.env.FIREBASE_PRIVATE_KEY  = ''
