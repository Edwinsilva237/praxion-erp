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

// REDIS, STRIPE, R2 deshabilitados — los tests son self-contained, no requieren
// servicios externos. enqueueEmail cae a fallback síncrono; el SMTP real igual
// fallaría con credenciales de test, pero no se invoca en los flujos cubiertos.
process.env.REDIS_URL          = ''
process.env.STRIPE_SECRET_KEY  = ''
process.env.R2_BUCKET          = ''
