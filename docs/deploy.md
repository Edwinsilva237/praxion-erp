# Deploy y mantenimiento en Render

Guía operativa para actualizar el ERP en producción. Stack: Render Blueprint (`render.yaml`) con `praxion-api` (backend Docker), `praxion-web` (frontend Vite estático) y `praxion-db` (Postgres 16 managed).

## Resumen del pipeline

```
git push (rama por defecto)
       ↓
GitHub webhook
       ↓
Render detecta cambios
       ↓
praxion-api:
  1. docker build (saas-base/Dockerfile)
  2. preDeployCommand: node src/db/migrate.js   ← migraciones
  3. si falla → mantiene la versión anterior
  4. si pasa → cambia el tráfico al nuevo container
praxion-web:
  1. npm ci && npm run build
  2. publica dist/ en el CDN
```

`autoDeploy: true` en ambos servicios. **No hay que apretar nada** después del push.

## Update normal (cambios de código sin migraciones nuevas)

```bash
git add .
git commit -m "feat: describe el cambio"
git push origin <rama-por-defecto>
```

Render redeploya automáticamente. Tiempo típico: 2–5 minutos.

**Verificar en Render dashboard:**
- `praxion-api` → ver logs del deploy. Buscar `Server listening on port 10000` al final.
- `/health` debe responder `{"status":"ok"}` desde `https://api.praxionops.com/health`.

## Update con migraciones nuevas

Igual al flujo normal — el `preDeployCommand` ejecuta `node src/db/migrate.js` automáticamente antes de cambiar el tráfico.

**Si la migración falla:**
- El deploy se aborta.
- La versión anterior sigue corriendo (sin downtime).
- Hay que revisar logs en `praxion-api` → tab Deploys → ver output del preDeploy.
- Causas típicas: constraint violado por datos existentes, sintaxis SQL inválida, columna ya existía.
- Fix: ajustar la migración (idempotente / data-cleanup previo) y volver a empujar.

## Bootstrap inicial (BD limpia)

Cuando el deploy está corriendo contra una BD recién creada (sin tenants/usuarios), hay que provisionar el tenant principal manualmente. Usar **Render Shell** desde el dashboard del servicio `praxion-api`:

```bash
# Opcional: define el password del admin via env. Si no, usa el default.
export ADMIN_PASSWORD='ContraseñaFuerteAleatoria!2026'

node scripts/bootstrap-gh-insumos.js
```

Esto crea:
- `gh-insumos-prod` (sin datos, preset extrusión plástico)
- `gh-insumos-sandbox` (`is_sandbox=true`, separado de prod)
- Admin `administracion@ghinsumos.com` en ambos como cuenta espejo + platform admin
- Membresías cruzadas para que el admin pueda cambiar entre ambos desde el switcher

El script es **idempotente**: si lo corres dos veces, los pasos repetidos se saltan sin error.

## Variables de entorno críticas

Configuradas en el dashboard de cada servicio (las marcadas `sync: false` en `render.yaml` se piden manualmente):

**Backend (`praxion-api`):**
- `JWT_SECRET` — string aleatorio ≥32 chars. Generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `DB_*` — se autocompletan desde `praxion-db` (referencias `fromDatabase` en `render.yaml`).
- `R2_*` — credenciales Cloudflare R2 para uploads (logo del tenant, evidencias de entrega, etc.).
- `FACTURAPI_KEY`, `FACTURAPI_USER_KEY` — credenciales Facturapi (timbrado CFDI).
- `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` — Gmail SMTP para correos transaccionales.
- `BANXICO_TOKEN` — token público de Banxico para tipos de cambio.
- `SENTRY_DSN`, `SENTRY_RELEASE` — error tracking.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — vacíos por ahora (billing responde 503).
- `REDIS_URL` — vacío por ahora (modo síncrono fallback).

**Frontend (`praxion-web`):**
- `VITE_API_URL` — `https://api.praxionops.com/api`
- `VITE_SENTRY_DSN`, `VITE_SENTRY_ENV` — error tracking del browser.

## Comandos de mantenimiento en Render Shell

Render Shell es una terminal interactiva dentro del contenedor de prod. Acceso desde el dashboard del servicio → tab Shell.

```bash
# Ver migraciones aplicadas
node -e "const{query,pool}=require('./src/db');(async()=>{const r=await query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 10');console.log(r.rows);await pool.end()})()"

# Resetear password de un usuario (NO en prod sin razón fuerte)
node scripts/reset-password.js <email> <nuevo_password>

# Inspección rápida de tenants
node scripts/_inspect-tenants.js   # si existe — si no, query directo desde shell de psql

# Conexión psql interactiva (necesita instalar postgresql-client en el container)
psql "$DATABASE_URL"
```

## Rollback de emergencia

**Si un deploy rompe prod:**
1. Render dashboard → `praxion-api` → tab Deploys.
2. Buscar el deploy verde previo.
3. Click "Rollback to this deploy".
4. Render recompila ese commit y vuelve atrás el tráfico.

**Si la migración rompió la BD (no solo el código):**
1. Las migraciones tienen `down` en cada archivo (`saas-base/src/db/migrations/*.js`).
2. Por seguridad, el runner actual NO ejecuta downs automáticamente. Hay que correr manualmente:
   ```bash
   node scripts/migrate-down.js <numero_migracion>   # si existe
   # O directo desde psql ejecutando el SQL del bloque `down`.
   ```
3. **Siempre** hacer backup antes: Render → `praxion-db` → tab Backups → "Create backup".

## Dominio custom

`render.yaml` declara las URLs:
- Frontend: `https://praxionops.com`
- Backend: `https://api.praxionops.com`

Configuración DNS apunta al CNAME que Render asigna. Para detalles ver [docs/historia/HANDOFF_SESION_23.md](historia/HANDOFF_SESION_23.md) sección dominio.

## Checklist post-deploy

Después de cualquier deploy en prod:

- [ ] `/health` responde 200
- [ ] Login funciona con admin existente
- [ ] El switcher de tenant lista las empresas esperadas
- [ ] Las funciones que cambiaron en este deploy funcionan en el ERP real
- [ ] Sentry no muestra spike de errores nuevos
- [ ] Los logs de `praxion-api` no muestran errores recurrentes

## Próximos pasos pendientes para hardening

1. **Activar RLS** (Row-Level Security en Postgres) siguiendo [docs/RLS_ACTIVATION.md](RLS_ACTIVATION.md). Hoy está apagado por flag `app.rls_enforce`. El doble candado contra leaks cross-tenant solo aplica cuando se prende. Cuando haya >1 cliente real, **activar antes**.
2. **Upstash Redis** para colas BullMQ con reintentos. Hoy modo síncrono — un email que falle no se reintenta.
3. **Stripe live** cuando esté listo el flujo de cobro.
4. **Backups automáticos**: Render Postgres incluye backups, pero conviene también un job de pg_dump → R2 con retención de 30 días.
