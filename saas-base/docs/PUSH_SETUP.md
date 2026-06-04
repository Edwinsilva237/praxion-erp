# Notificaciones Push (FCM) — Guía de configuración

El código de push **ya está en el repo**, pero queda en **no-op** hasta que existan
las credenciales de Firebase. Esta guía es el checklist para encenderlo.

Mientras las 3 env de Firebase estén vacías: el backend no manda nada, no carga
`firebase-admin`, no truena, y los tests siguen verde. Encender = setear las 3 env
en Render + poner `google-services.json` en la app + recompilar el APK.

---

## 1. Crear el proyecto Firebase (una vez)

1. Entra a <https://console.firebase.google.com> con la cuenta Google del negocio.
2. **Agregar proyecto** → nombre p.ej. `Praxion` → puedes desactivar Google Analytics.
3. Espera a que se cree y entra al proyecto.

## 2. Registrar la app Android

1. En el proyecto, ícono de **Android** ("Agregar app").
2. **Nombre del paquete Android**: debe ser EXACTAMENTE
   ```
   com.praxionops.erp
   ```
   (si no coincide, FCM no entrega nada). El apodo/SHA-1 son opcionales.
3. **Descarga `google-services.json`** y colócalo en:
   ```
   saas-erp-frontend/android/app/google-services.json
   ```
   El `android/app/build.gradle` ya aplica el plugin de Google Services
   automáticamente cuando ese archivo existe — no hay que tocar gradle.
   ⚠️ Ese archivo NO es secreto del todo, pero NO lo subas al repo público
   (déjalo local / en el `.gitignore` de android).

## 3. Credenciales del backend (Service Account)

1. Firebase → ⚙️ **Configuración del proyecto** → pestaña **Cuentas de servicio**.
2. **Generar nueva clave privada** → descarga un JSON. De ese JSON saca 3 valores:
   - `project_id`    → `FIREBASE_PROJECT_ID`
   - `client_email`  → `FIREBASE_CLIENT_EMAIL`
   - `private_key`   → `FIREBASE_PRIVATE_KEY`
3. En **Render** (servicio `praxion-api`) → **Environment** → agrega las 3 vars.
   - `FIREBASE_PRIVATE_KEY`: pega el valor TAL CUAL del JSON. Suele venir en una
     sola línea con `\n` literales (ej. `-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END...`).
     El backend convierte esos `\n` a saltos reales (`config/index.js`).
     - Si tu panel obliga a multilínea, también funciona pegada con saltos reales.
   - Guarda → Render redeploya. En el arranque, `pushService` detecta las 3 vars
     y se habilita (`firebase.enabled = true`).

> Verificación rápida (tras el deploy): como **owner/admin**, llama
> `POST /api/push/broadcast` con `{ "title": "Prueba" }`. Si push está activo y hay
> un teléfono registrado, la respuesta trae `{ "sent": N }`; si aún no hay token o
> Firebase no está, trae `{ "skipped": true }`.

## 4. Recompilar el APK (obligatorio)

El plugin nativo `@capacitor/push-notifications` + el `google-services.json` exigen
un **rebuild nativo** — el live reload / OTA NO los toman.

```bash
cd saas-erp-frontend
npm install                 # baja @capacitor/push-notifications (ya en package.json)
npm run sync:android        # vite build + cap sync android (copia dist + plugins)
# Build del APK con el JBR 21 de Android Studio (no el Java del PATH):
cd android
# PowerShell:
#   $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
#   .\gradlew.bat assembleDebug --console=plain
```
APK en `android/app/build/outputs/apk/debug/app-debug.apk`. Reinstala en el teléfono
(desinstala el anterior si Android se queja de firma) y vuelve a publicarlo a R2 con
`node saas-base/scripts/upload-apk.js` (correr DESDE `saas-base/`).

## 5. Probar de punta a punta

1. Abre la app y **inicia sesión** → debe registrarse el token
   (revisa que aparezca una fila en `device_tokens` para tu usuario).
2. **Primera luz**: `POST /api/push/broadcast { "title": "Hola" }` como admin →
   el teléfono recibe la notificación (mejor con la app en segundo plano: en primer
   plano Android no pinta la bandeja; la app emite el evento `push:received`).
3. Tocar la notificación abre la app (deep-link si el push trae `data.route`).
4. Desinstala la app y vuelve a mandar un broadcast → el token muerto se **poda**
   solo (FCM responde `registration-token-not-registered`).

## iOS (después)

Mismo plugin y mismo hook. Falta solo: registrar la app iOS en Firebase, descargar
`GoogleService-Info.plist` → `ios/App/App/`, y subir la **APNs Auth Key** (.p8) en
Firebase → Cloud Messaging. El build nativo es en la Mac (ver `docs/ios-app-setup.md`).

---

## Arquitectura (para mantenimiento)

- **Núcleo**: `saas-base/src/modules/push/pushService.js` (FCM, no-op sin Firebase,
  poda de tokens muertos), `deviceTokenService.js` (CRUD de `device_tokens`, UPSERT
  por `token`), `audienceService.js` (resuelve a quién: permiso / rol de membresía /
  userIds / 'all').
- **Endpoints**: `saas-base/src/modules/push/routes.js` →
  `POST /api/push/register`, `/unregister`, `/broadcast` (permiso `push:broadcast`).
- **Canal de alertas**: `alertService.dispatchAlert` manda push automático (vía
  `setImmediate`, fuera de la transacción) a la audiencia de la alerta — así toda
  alerta (`lot_expiring`, etc., y a futuro `low_stock`/`email_delivery_failed`) llega
  al teléfono sin código extra.
- **App**: `saas-erp-frontend/src/hooks/usePushNotifications.js` (registro + listeners,
  montado en `AppShell`), `src/api/push.js`, baja de token en `useAuthStore.logout`.
- **Migración**: `191_device_tokens.js` (tabla + permiso `push:broadcast`).

**Eventos pendientes de cablear (Fase 2)**: stock bajo/reorden, correo no entregado,
turno asignado, pedido de venta, recepción/OC. Cada uno = una llamada a
`dispatchAlert(...)` o `pushService.notify(...)` después del commit.
