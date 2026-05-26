# Deploy y operaciones en Render

Guía operativa práctica para mantener el ERP en producción. Pensada para el día a día: subir cambios, hacer hotfixes, correr scripts, debugging.

---

## 1. Arquitectura del deploy

### Stack en producción

| Componente | Servicio Render | URL pública | Plan |
|---|---|---|---|
| Backend Node/Express | `praxion-api` | https://praxion-api.onrender.com | Starter ($7/mes) |
| Frontend React/Vite | `praxion-web` | https://praxion-web.onrender.com | Static (gratis) |
| Base de datos PostgreSQL 16 | `praxion-db` | (interna) | basic-256mb ($6/mes) |

*Cuando configures los dominios custom, las URLs públicas serán `https://api.praxionops.com` y `https://praxionops.com` (ya declarados en `render.yaml`).*

### Repo y rama

- **GitHub:** https://github.com/Edwinsilva237/praxion-erp
- **Rama por defecto:** `main`
- **Local:** `C:\Users\admin\CLON ERP CLAUDE\` (Windows, Git bash o terminal)

### Servicios externos vinculados (env vars en Render dashboard)

- **Cloudflare R2:** object storage para logos, fotos de evidencia, PDFs adjuntos.
- **Facturapi:** timbrado CFDI (modo live).
- **Gmail SMTP:** correos transaccionales.
- **Banxico:** tipos de cambio diarios.
- **Sentry:** error tracking (opcional, puede quedar vacío).
- **Stripe:** desactivado por ahora — billing responde 503 hasta que estés listo para cobrar.
- **Upstash Redis:** desactivado por ahora — colas en modo síncrono fallback.

---

## 2. Subir cambios nuevos (flujo normal)

### Escenario A — Cambios solo de código (sin migraciones, sin scripts)

```bash
cd "C:/Users/admin/CLON ERP CLAUDE"

# Ver qué cambió
git status

# Agregar todo lo modificado
git add .

# Commit con mensaje descriptivo (qué + por qué)
git commit -m "feat: descripción corta del cambio"

# Pushear → Render redeploya automáticamente
git push origin main
```

**Tiempo de deploy:** 2–5 min. Render detecta el push, construye el container, lo deploya, cambia el tráfico.

**Verificar:** abre el ERP, refresca con `Ctrl+Shift+R` (hard refresh para invalidar cache del browser).

### Escenario B — Cambios que incluyen migraciones nuevas

Igual al escenario A. El `preDeployCommand` en `render.yaml` corre `node src/db/migrate.js` automáticamente antes de cambiar el tráfico al nuevo container.

**Si la migración falla:**
- El deploy se aborta automáticamente.
- La versión anterior sigue corriendo (sin downtime).
- Revisar logs en Render → `praxion-api` → tab "Events" → click en el deploy fallido → ver output del preDeploy.
- Causas típicas: constraint violado por datos existentes, sintaxis SQL inválida, columna ya existente.
- Fix: ajustar el archivo de migración (hacerla idempotente o agregar cleanup previo) y volver a pushear.

### Escenario C — Cambios que requieren correr un script one-off

Después del deploy, abre Render Shell (ver sección 3) y corre:

```bash
node scripts/<nombre-del-script>.js
```

**Importante:** los scripts que corras en producción NO pueden usar `devDependencies` (ej. `supertest`, `jest`). El Dockerfile corre `npm ci --omit=dev`. Si necesitas un script, debe usar solo lo que está en `dependencies` o llamar directo a los services del backend (ver `bootstrap-gh-insumos.js` como ejemplo).

---

## 3. Operaciones rápidas en Render

### Abrir Shell del backend

1. https://dashboard.render.com → click en `praxion-api`.
2. En la barra horizontal de pestañas (debajo del título): **Events | Logs | Shell | Environment | Settings | Metrics**.
3. Click en **Shell**.
4. Tarda 5–15 seg en conectar. Ya estás dentro del container con el código corriendo.

### Ver logs en vivo

1. `praxion-api` → pestaña **Logs**.
2. Logs en tiempo real. Filtro por nivel disponible arriba.
3. Para descargar histórico: botón "Download" arriba a la derecha.

### Cambiar una variable de entorno

1. `praxion-api` → pestaña **Environment**.
2. Edita el valor (las marcadas con candado son secretas).
3. Click "Save Changes".
4. Render **redeploya automáticamente** el servicio con la nueva variable (tarda 2–3 min).

⚠️ **No edites variables que vienen `fromDatabase`** (DB_HOST, DB_PORT, etc.) — son referencias automáticas a `praxion-db`.

### Forzar un redeploy manual

Útil si Render no detectó un push o quieres reintentar:

1. `praxion-api` → botón arriba a la derecha **"Manual Deploy ▾"**.
2. **"Deploy latest commit"** (usa el código actual del repo) o **"Clear build cache & deploy"** (si sospechas problema de cache).

### Rollback a una versión anterior

1. `praxion-api` → pestaña **Events**.
2. Busca un deploy verde anterior (badge ✅ Deploy live).
3. Click en el commit → botón **"Rollback to this deploy"**.
4. Render recompila ese commit y vuelve a poner ese código en vivo.

⚠️ Si el rollback es por una migración que rompió datos, el rollback **no revierte la migración** automáticamente — solo el código. Para revertir migración hay que correr el bloque `down` manualmente (ver sección 5).

### Conectar a la BD desde la máquina local

Para hacer queries directas, dumps, etc.:

1. Render dashboard → `praxion-db` → pestaña "Connect".
2. Copia **"External Database URL"** (empieza con `postgresql://...`, incluye credenciales).
3. En tu terminal local:
   ```bash
   psql "postgresql://<usuario>:<pass>@<host>/<db>"
   ```
   *Requiere `psql` instalado (parte del paquete `postgresql-client`).*

Para inspección rápida sin instalar psql, usa Render Shell + scripts Node:

```bash
# Dentro de Render Shell del praxion-api
node -e "const{query,pool}=require('./src/db');(async()=>{const r=await query('SELECT slug,name,is_sandbox FROM tenants ORDER BY slug');console.log(r.rows);await pool.end()})()"
```

---

## 4. Scripts one-off útiles

### Bootstrap inicial (solo se corre 1 vez, BD limpia)

```bash
# En Render Shell del praxion-api
export ADMIN_PASSWORD='TuPasswordFuerte!2026'
node scripts/bootstrap-gh-insumos.js
```

Crea `gh-insumos-prod` + `gh-insumos-sandbox` + admin con membership cruzada. Idempotente (puedes correrlo varias veces sin daño).

### Resetear password de un usuario

```bash
# En Render Shell
node scripts/reset_password.js <email> <nuevo_password>
```

### Inspeccionar tenants y usuarios

```bash
# En Render Shell
node -e "const{query,withBypass,pool}=require('./src/db');(async()=>{const r=await withBypass(()=>query('SELECT t.slug, t.is_sandbox, COUNT(u.id) AS users FROM tenants t LEFT JOIN users u ON u.tenant_id=t.id GROUP BY t.id ORDER BY t.slug'));console.log(r.rows);await pool.end()})()"
```

### Listar membresías de un usuario

```bash
# En Render Shell
node -e "const{query,withBypass,pool}=require('./src/db');(async()=>{const r=await withBypass(()=>query(\"SELECT u.email, t.slug, m.role FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE u.email='administracion@ghinsumos.com' ORDER BY t.slug\"));console.log(r.rows);await pool.end()})()"
```

---

## 5. Migraciones — operación avanzada

### Aplicar migraciones manualmente

Normalmente esto pasa automático en cada deploy (`preDeployCommand`). Si necesitas correrlas manual:

```bash
# En Render Shell
node src/db/migrate.js
```

Output: lista de migraciones pendientes y "Applied N migration(s)".

### Ver qué migraciones están aplicadas

```bash
# En Render Shell
node -e "const{query,pool}=require('./src/db');(async()=>{const r=await query('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10');console.table(r.rows);await pool.end()})()"
```

### Revertir una migración (rollback de BD)

⚠️ **Siempre hacer backup antes**: Render → `praxion-db` → "Backups" → "Create backup".

Cada archivo en `saas-base/src/db/migrations/` exporta un bloque `down` con el SQL de rollback. No hay runner automático de `down` (intencional, por seguridad). Para revertir:

1. Lee el archivo, ej. `145_tenant_memberships.js`.
2. Copia el SQL del `down`.
3. Ejecuta desde Render Shell o psql conectado a la BD.
4. Borra la fila correspondiente de `schema_migrations`:
   ```sql
   DELETE FROM schema_migrations WHERE version = '145_tenant_memberships';
   ```

---

## 6. Troubleshooting conocido

### "We are unable to access your GitHub repository" (al conectar Render)

**Causa:** Render no tiene permiso al repo privado.

**Solución que funcionó:**
1. GitHub → repo → Settings → Danger Zone → cambiar a **Public** temporalmente.
2. En Render conectar el repo (ya no da error).
3. Render → Settings → confirmar que el repo aparece correctamente conectado.
4. Volver a GitHub → Settings → Danger Zone → cambiar de vuelta a **Private**.
5. La conexión Render↔GitHub se mantiene (Render ya tiene la GitHub App instalada).

### "Cannot find module 'supertest'" (al correr un script)

**Causa:** el script usa una `devDependency` y Dockerfile corre `npm ci --omit=dev`.

**Solución:** refactorizar el script para usar solo `dependencies`. Llamar services directo (ej. `tenantService.provisionTenant()`) en vez de hacer requests HTTP via supertest. Ver `scripts/bootstrap-gh-insumos.js` como ejemplo.

### El dropdown / modal aparece detrás de otros elementos

**Causa:** `overflow: hidden` en contenedores padre + conflicto de z-index con sidebar (`z-30`).

**Solución:** usar React Portal con `createPortal` para renderizar el menú directo en `document.body`, con `position: fixed` y `z-index: 9999`. Ver `components/layout/TenantSwitcher.jsx`.

### Tras un deploy, el ERP sigue mostrando código viejo

**Causa:** cache del browser sirve el JS antiguo.

**Solución:** `Ctrl+Shift+R` (hard refresh). En móvil: cerrar y abrir el navegador, o limpiar cache del sitio en settings.

### "Token does not match tenant" (403) al cambiar de empresa

**Causa:** el refresh token previo está bound al tenant anterior.

**Solución:** ya está manejado por `useAuthStore.switchTenant()` — al cambiar emite nuevo par accessToken + refreshToken y revoca el anterior. Si pasa, hacer logout y login de nuevo.

### Errores 503 en `/api/billing/*`

**Causa esperada:** `STRIPE_SECRET_KEY` está vacío.

**Esto NO es un bug** — el sistema responde 503 a billing intencionalmente cuando Stripe no está configurado, hasta que decidas activar cobros.

---

## 7. Checklists

### Pre-push (antes de subir cambios)

- [ ] `cd saas-base && npm test -- --forceExit` → tests verdes (ideal 37/535/9 o lo que corresponda)
- [ ] `cd saas-erp-frontend && npx vite build --mode development` → build sin errores
- [ ] `git status` → revisar que no se cuele nada que no quieras (especialmente `.env`, archivos personales)
- [ ] `git diff --cached` → última pasada visual a lo que va al commit
- [ ] Mensaje de commit descriptivo y en imperativo (`feat:`, `fix:`, `chore:`, `docs:`)

### Post-deploy (después de pushear)

- [ ] Render → `praxion-api` → Events → confirmar "Deploy live for <commit>"
- [ ] `https://praxion-api.onrender.com/health` responde `{"status":"ok"}`
- [ ] Render → `praxion-web` → Events → confirmar deploy del frontend también
- [ ] Hard refresh del ERP (Ctrl+Shift+R)
- [ ] Smoke test rápido: login funciona, switcher de empresa muestra ambas, página que cambiaste funciona
- [ ] Sentry → revisar que NO haya spike de errores nuevos

---

## 8. Acceso a cuentas y credenciales

Lista de dónde viven las cuentas/secretos. **No están escritos en este doc por seguridad.**

| Servicio | Cuenta | Dónde encontrar credenciales |
|---|---|---|
| Render | (tu email/GitHub) | https://dashboard.render.com → Account Settings |
| GitHub | `Edwinsilva237` | Tu password / SSH key personal |
| Cloudflare R2 | (tu cuenta CF) | https://dash.cloudflare.com → R2 → API tokens |
| Facturapi | (tu cuenta Facturapi) | https://dashboard.facturapi.io → API Keys |
| Gmail SMTP | (cuenta de correos del ERP) | Google → App passwords |
| Banxico | Token público | https://www.banxico.org.mx → registro |
| Sentry | (tu cuenta Sentry) | https://sentry.io → Settings → Client Keys (DSN) |
| ERP Admin | `administracion@ghinsumos.com` | El password lo definiste al correr el bootstrap |

Para JWT_SECRET nuevo:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 9. Próximos pasos pendientes para hardening

1. **Dominio custom configurado**: hoy las URLs son `*.onrender.com`. Apuntar `praxionops.com` y `api.praxionops.com` desde DNS al CNAME de Render.
2. **Activar RLS** (Row-Level Security en Postgres) siguiendo `docs/RLS_ACTIVATION.md`. Hoy está apagado por flag `app.rls_enforce`. El doble candado contra leaks cross-tenant solo aplica cuando se prende. **Activar antes de tener más de 1 cliente real.**
3. **Upstash Redis** para colas BullMQ con reintentos. Hoy modo síncrono → emails que fallan no se reintentan.
4. **Stripe live** cuando esté listo el flujo de cobro.
5. **Backups automáticos extra**: Render Postgres incluye backups managed (revisar pestaña Backups en `praxion-db`), pero conviene también un job de `pg_dump → R2` con retención de 30 días.
6. **Migrar scripts de provisioning** (provision-frituras, provision-pasteleria, etc.) para que NO usen supertest — hoy mismo problema que tenía el bootstrap.

---

## 10. Resumen ultra-corto (cheatsheet)

```bash
# ── Subir un cambio ────────────────────────────────────────
git add . && git commit -m "tu mensaje" && git push origin main
# Espera 2-3 min, refresca el ERP con Ctrl+Shift+R

# ── Correr script en prod ──────────────────────────────────
# 1. Render dashboard → praxion-api → Shell
# 2. node scripts/<script>.js

# ── Ver logs ───────────────────────────────────────────────
# Render → praxion-api → Logs

# ── Cambiar env var ────────────────────────────────────────
# Render → praxion-api → Environment → editar → Save
# (redeploy automático)

# ── Rollback ───────────────────────────────────────────────
# Render → praxion-api → Events → click deploy verde anterior → Rollback

# ── Inspeccionar BD desde Shell ────────────────────────────
node -e "const{query,withBypass,pool}=require('./src/db');(async()=>{const r=await withBypass(()=>query('TU QUERY AQUI'));console.log(r.rows);await pool.end()})()"
```
