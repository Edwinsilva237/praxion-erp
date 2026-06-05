# iOS App (Praxion) — Setup en la Mac · Handoff desde Windows

> **Para el Claude que abra esto en la Mac:** la prep de código se hizo en una
> máquina Windows (iOS no compila en Windows). Tu trabajo es generar el proyecto
> nativo `ios/` y correrlo. La memoria del otro Claude NO viaja entre máquinas —
> **este archivo es tu ramp-up completo.** El estado general del proyecto vive en
> `docs/saas-v2/` y en el repo; el ERP está LIVE en `https://app.praxionops.com`.

## Objetivo de esta fase

Llevar la app de **cero a correr en el Simulador de iOS** (rebanada vertical:
build nativo + login + navegación + listas). **No requiere cuenta Apple.**
TestFlight / App Store / iPhones de otros = Apple Developer de paga ($99/año),
decisión posterior del usuario (hoy NO tiene cuenta).

La app es **Capacitor** envolviendo el frontend React de `saas-erp-frontend`.
**Android ya funciona** (mismo código). El backend ya es 100% compatible con
móvil (auth por Bearer token, tenant por header `X-Tenant-Slug`, login por
descubrimiento de correo). NO se reescribe nada del backend.

## Lo que YA viene listo en el repo (hecho en Windows)

- `@capacitor/ios` en `package.json` (lockstep con los demás `@capacitor/*` 8.x)
  + scripts `npm run sync:ios` (`vite build && cap sync ios`) y `npm run open:ios`.
- **CORS para el origen nativo de iOS.** ⚠️ OJO: `server.iosScheme: "https"` **NO
  funciona** — WKWebView reserva el scheme `https`, así que Capacitor lo descarta
  (`CAPInstanceDescriptor.normalize()` → `WKWebView.handlesURLScheme("https")==true`)
  y vuelve al default. El webview de iOS SIEMPRE usa origen **`capacitor://localhost`**.
  Por eso el backend (`saas-base/src/app.js`) ya incluye `capacitor://localhost`
  (e `ionic://localhost`) en la allowlist de CORS. Sin esto el preflight daba **500**
  ("CORS bloqueado") y la app no conectaba. Android no necesita nada: su
  `androidScheme` default es `https` → origen `https://localhost` (ya permitido).
- `src/hooks/useDocumentScanner.js` limitado a **Android** (`Capacitor.getPlatform()
  === 'android'`): el escáner de documentos ML Kit no existe en iOS; en iOS el
  caller cae al input de cámara/archivo HTML (que abre la cámara nativa). Sin esto
  iOS reventaría con "not implemented".

## Plugins nativos en uso (todos con soporte iOS salvo nota)

| Plugin | iOS | Nota |
|---|---|---|
| `@capacitor-mlkit/barcode-scanning` | ✅ | Requiere `NSCameraUsageDescription`. Solo prueba en device real (el Simulador no tiene cámara). |
| `@capacitor-mlkit/document-scanner` | ❌ | **Solo Android.** Ya deshabilitado en iOS por código. |
| `@capacitor/filesystem` | ✅ | Guardar PDFs a Documents. |
| `@capacitor/share` | ✅ | Hoja de compartir (no requiere permiso). |
| `@capgo/capacitor-printer` | ✅ | Impresión vía `UIPrintInteractionController`. |
| `@capacitor/preferences` | ✅ | Tokens. |

## Prerrequisitos en la Mac

1. **Xcode** (Mac App Store). Ábrelo una vez para instalar componentes.
   `xcode-select --install` para las Command Line Tools.
2. **CocoaPods**: `sudo gem install cocoapods` (o `brew install cocoapods`).
3. **Node 18+** y el repo clonado (`git clone` de la rama `main`).

## Pasos (cap add ios → Simulador)

```bash
cd saas-erp-frontend
npm install
npm run build                 # genera dist/
npx cap add ios               # crea ios/ + corre pod install (tarda: pods MLKit grandes)
npm run sync:ios              # copia dist + 6 plugins al proyecto iOS
```

### Info.plist — cadenas de permiso (si faltan, crash al usar cámara/fotos)

Editar `ios/App/App/Info.plist` y agregar:

- `NSCameraUsageDescription` → "Praxion usa la cámara para escanear códigos de
  barras y capturar evidencia de entregas y recepciones."
- `NSPhotoLibraryUsageDescription` → "Praxion accede a tus fotos para adjuntar
  evidencia de entregas, recepciones y comprobantes."
- (opcional, para TestFlight luego) `ITSAppUsesNonExemptEncryption` = `NO`.

### Abrir y correr

```bash
npx cap open ios              # abre el workspace en Xcode
```

En Xcode:
1. Target **App** → **Signing & Capabilities** → marca "Automatically manage
   signing" y Team = tu **Apple ID personal** ("Personal Team"). *(Para el
   Simulador no hace falta firmar; para iPhone físico sí.)*
2. Arriba, selecciona un **Simulador** (ej. iPhone 15) → ▶ **Run**.

## Validar la cadena (qué debe funcionar)

- **Login por correo** (descubrimiento, sin pedir empresa) → entra y guarda el
  tenant slug. Si falla con error de red/CORS → confirma `iosScheme: https` +
  re-`npm run sync:ios` + re-Run.
- **Navegación por pestañas** (BottomNav, `md:hidden`).
- **Listas en tarjetas** (Inventario, Compras, Ventas).
- **Escáner de barras**: solo en iPhone físico (el Simulador no tiene cámara).
- El escáner de documentos está deshabilitado en iOS por diseño → verás el
  fallback "Tomar foto / Subir archivo".

## Gotchas iOS (lee antes de pelear con algo)

- **NO hay sideload en iOS.** No se reparte un `.ipa` por correo como el APK. Para
  iPhones de otras personas: TestFlight (requiere Apple Developer de paga).
- **Origen del webview**: en iOS es SIEMPRE `capacitor://localhost` (no se puede
  cambiar a `https` — ver arriba). El backend debe permitir ese origen en su CORS.
- **Backend directo a onrender**: la app pega a `https://praxion-api.onrender.com/api`
  directo (no al dominio Cloudflare: Cloudflare no devuelve el CORS preflight para
  el origen `localhost` del webview). El warm-up al abrir mitiga el arranque frío.
  Ver `saas-erp-frontend/src/api/axios.js`.
- **Cámara en Simulador**: no existe; barras solo se prueba en device real.

## Iconos + splash (fuentes YA en el repo)

Las imágenes fuente ya están versionadas en `saas-erp-frontend/assets/`
(`icon-only.png` 1024² SIN alfa = iOS-safe, `icon-foreground/background.png` para
Android adaptive, `splash.png`/`splash-dark.png` 2732²). Generadas con
`node scripts/gen-app-icons.cjs` desde `public/praxion-isotipo.svg` (marca
blanca+verde sobre #0B0F12). Para producir los iconos+splash de iOS (requiere que
`ios/` ya exista por `cap add ios`):

```bash
cd saas-erp-frontend
npx capacitor-assets generate --ios   # escribe en ios/App/App/Assets.xcassets
```

Esto crea el `AppIcon.appiconset` (todos los tamaños) + el splash. Label de la app:
"Praxion". Si cambias el arte: edita el SVG → `node scripts/gen-app-icons.cjs` →
re-corre el comando de arriba. *(El `icon-only.png` se aplana sin canal alfa a
propósito — App Store rechaza iconos con transparencia.)*

## Después del Simulador (siguiente)

1. **Correr en iPhone físico** (Apple ID gratis, firma caduca cada 7 días).
2. **Apple Developer de paga** → TestFlight → repartir a usuarios.

## Convención del proyecto

Los cambios quedan en local por default. Solo cuando el usuario dice literalmente
**"actualiza en línea"** se hace `git add + commit + push` a `origin/main` (Render
redeploya el backend/web solo). El proyecto iOS nativo (`ios/`) NO se commitea
(como `android/`): se regenera con `npx cap add ios`.

## Bitácora — fix safe-area iOS (2026-06-03)

**Síntoma reportado:** en el módulo de Compras → Recepciones, al abrir una recepción
se abre un modal de detalle que se "salía" de la pantalla y quedaba **encimado con la
barra superior del sistema de iOS** (la X de cerrar y las acciones quedaban tapadas
por la barra de estado / notch). Además faltaban los botones **Editar** y **Cancelar
recepción** que ya existían en web.

**Causa real (importante):** NO fue un bug que hubiera que arreglar en esta máquina.
El repo local estaba **16 commits atrás** de `origin/main`. Los dos arreglos ya
existían río arriba y solo faltaba traerlos con `git pull`:

- `792cb8a` — *Recepciones móvil: panel de detalle respeta safe-area (X de cerrar y
  acciones visibles)*. Reestructuró el modal al patrón canónico de los demás paneles:
  header fijo con `paddingTop: calc(1rem + env(safe-area-inset-top))`, cuerpo scrolleable,
  footer de acciones fijo con `paddingBottom: calc(0.75rem + env(safe-area-inset-bottom))`.
  Se quitó el `sticky bottom` (no funcionaba en el webview).
- `b3f7674` — *Recepciones: editar y cancelar una recepción en borrador* (los botones
  Editar/Cancelar). Solo se muestran si `receipt.status === 'draft'` **y** el usuario
  tiene permiso `purchases:update` (`<Can do="purchases:update">`). Si la recepción ya
  se confirmó, desaparecen a propósito — esto explicó el "sigo sin ver los botones":
  la recepción de prueba ya no estaba en borrador.
- Fixes de backend que vinieron en el mismo pull: `72a60d8` y `be8b312` (error 500 al
  editar/crear recepción por constraints `srl_qty_positive` y columna `code` de
  `raw_materials`), más migraciones `189`/`190`.

**Archivos tocados por el fix de safe-area:** un solo archivo de la capa **web**:
`saas-erp-frontend/src/pages/Compras/ComprasRecepciones.jsx` (commit `792cb8a`,
51 inserciones / 50 borrados). El viewport ya traía `viewport-fit=cover` en
`index.html` desde antes.

**Commit / estado:** el fix vive en `792cb8a`; los botones en `b3f7674`. Tras el
`git pull --ff-only` el HEAD quedó en `50314bc` (que es lo que se sincronizó al
dispositivo). Esta bitácora se commitea aparte (su propio hash).

**⚠️ Nativo: NO se tocó nada nativo.** El arreglo es 100% CSS/JSX en la capa web vía
`env(safe-area-inset-*)`. **No** se modificó `Info.plist`, **ni** config de Capacitor
`StatusBar`, **ni** nada dentro de `ios/`. Por eso es totalmente reproducible en otra
máquina sin editar Xcode: basta con

```bash
cd saas-erp-frontend
git pull --ff-only origin main
rm -rf ios/App/build        # build viejo no borrable por xcodebuild → rompe pod install
npm run sync:ios            # vite build + cap sync ios (copia web + pod install)
npm run open:ios            # abrir Xcode y Run
```

(El `rm -rf ios/App/build` fue necesario porque CocoaPods corre `xcodebuild clean` y
fallaba al no poder borrar un directorio `build/` previo "no creado por el build
system". Es directorio de salida intermedia, seguro de borrar.)

---

# Notificaciones push en iOS (FCM/APNs) — HANDOFF 2026-06-04

> **Para el Claude de la Mac:** ejecuta esta sección paso a paso. El usuario YA hizo
> toda la parte de consolas (Apple + Firebase) guiado desde Windows; aquí queda solo
> la parte NATIVA (Podfile + AppDelegate + capacidades) + compilar y probar.

## Qué YA está hecho (NO repetir)
- **Backend FCM LIVE** (firebase-admin). 9 eventos push dirigidos por rol ya en prod
  (commit `de132db`): pedido confirmado, remisión, entrega, factura timbrada, orden
  de producción creada/completada, OC, recepción validada, turno. El que ejecuta la
  acción NO se autonotifica (`excludeUserIds`).
- **Firebase** proyecto `praxion-8312c` (el mismo de Android).
- **App iOS registrada en Firebase** (bundle `com.praxionops.erp`). El usuario descargó
  `GoogleService-Info.plist` y lo **arrastró al grupo "App" en Xcode** con el target App
  marcado (verifícalo en el paso 1).
- **Llave APNs Auth Key (.p8)** creada en Apple Developer (Sandbox & Production,
  unrestricted) y **subida a Firebase → Cloud Messaging** con su Key ID + Team ID.
  **Apple Developer de paga ACTIVA.**
- **Código de push ya en el repo** (pull a `de132db` + `npm install` hechos en la Mac):
  `@capacitor/push-notifications` en package.json, hook `src/hooks/usePushNotifications.js`
  montado en `AppShell` (pide permiso + registra token + deep-link a `data.route`),
  `src/api/push.js`, baja de token en `useAuthStore.logout`. Migración `191_device_tokens`
  ya aplicada en prod (tabla `device_tokens` + endpoints `/api/push/register|unregister|broadcast`).

## Por qué iOS necesita MÁS que Android (clave)
El backend envía por **FCM**. En Android, `@capacitor/push-notifications` + `google-services.json`
entrega un **token FCM** directo. En iOS, ese mismo plugin entrega el token de **APNs**, que
FCM/firebase-admin **NO acepta**. Hay que agregar el **SDK de Firebase iOS** (`FirebaseMessaging`)
y **puentear en AppDelegate**: APNs token → Firebase → **token FCM**, y publicar ESE token FCM en
el evento `registration` del plugin (que es lo que el hook manda a `/api/push/register`).

## Pasos a ejecutar

### 1. Verificar el plist
Confirma que `ios/App/App/GoogleService-Info.plist` existe **y está en el target "App"**
(Xcode → target App → Build Phases → Copy Bundle Resources debe listarlo; o en el navegador,
selecciónalo y en el inspector derecho "Target Membership" → App ✅). Si solo se copió a la
carpeta pero no al target, agrégalo al target.

### 2. Podfile — agregar Firebase
En `ios/App/Podfile`, **dentro** del bloque `target 'App' do` (después de `capacitor_pods`),
agrega una línea:
```ruby
  pod 'FirebaseMessaging'
```
NO toques el bloque `def capacitor_pods ... end` (eso lo regenera `cap sync`).

### 3. AppDelegate.swift — inicializar Firebase y puentear APNs→FCM
Edita `ios/App/App/AppDelegate.swift`:
- Imports (arriba, junto a `import Capacitor`):
  ```swift
  import FirebaseCore
  import FirebaseMessaging
  ```
- En `application(_:didFinishLaunchingWithOptions:)`, antes de `return true`:
  ```swift
  FirebaseApp.configure()
  ```
- **Reemplaza el cuerpo** del método `didRegisterForRemoteNotificationsWithDeviceToken` (hoy
  publica el `deviceToken` APNs crudo) por el puente a FCM — debe publicar el **token FCM (String)**:
  ```swift
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
      Messaging.messaging().apnsToken = deviceToken
      Messaging.messaging().token { token, error in
          if let error = error {
              NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
          } else if let fcmToken = token {
              NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: fcmToken)
          }
      }
  }
  ```
- Deja `didFailToRegisterForRemoteNotificationsWithError` como está (ya publica el error).
  Si AppDelegate no tuviera estos métodos, agrégalos. **Lo crítico:** el `object:` del post
  `.capacitorDidRegisterForRemoteNotifications` debe ser el **token FCM (String)**, NO el `Data` de APNs.

### 4. Pods + sync
```bash
cd saas-erp-frontend
rm -rf ios/App/build        # evita el fallo de xcodebuild clean (ver gotcha de esta misma guía)
npm run sync:ios            # vite build + cap sync ios → agrega CapacitorPushNotifications + pod install (baja FirebaseMessaging)
```
Si `pod install` no jala FirebaseMessaging: `cd ios/App && pod install`. (Primera vez tarda: baja Firebase.)

### 5. Capacidades en Xcode
`npm run open:ios`. Target **App** → **Signing & Capabilities**:
- **Team** = la cuenta Apple Developer de **PAGA** (no el "Personal Team") — el push lo exige.
- **+ Capability** → **Push Notifications**.
- **+ Capability** → **Background Modes** → marca **Remote notifications**.
Con firma automática + team de paga, Xcode habilita el App ID para push solo.

### 6. Compilar en iPhone FÍSICO (el push NO funciona en Simulador)
Run en el dispositivo → al abrir, la app pide permiso de notificaciones (aceptar) → inicia
sesión → el **token FCM** se registra (debe aparecer una fila nueva en la tabla `device_tokens`
para ese usuario en el tenant que abrió la app).

### 7. Primera luz
Como **owner/admin**: `POST /api/push/broadcast { "title": "Prueba iOS" }` (con un Bearer token
válido + header `X-Tenant-Slug` del tenant) → el iPhone recibe (mejor con la app en segundo plano).
Respuesta `{ sent: 1 }` = entregó; `{ skipped: true }` = no había token o Firebase off.
O probar un evento real (que OTRA cuenta confirme un pedido / timbre factura — el actor no se autonotifica).

## Gotchas iOS push
- **Token FCM vs APNs:** si el token en `device_tokens` es un hex largo SIN dos-puntos, es APNs
  (mal) → revisa el puente del AppDelegate. El FCM es una cadena larga con `:` y `_`/`-`.
- **Solo device físico** (Simulador no recibe push real).
- **Background Modes → Remote notifications** es obligatorio para recibir con la app cerrada.
- **Ícono:** en iOS la notificación usa el ícono de la app (NO la silueta blanca tipo Android) →
  no hay que generar nada extra.
- **Deployment target:** FirebaseMessaging requiere iOS 13+ (el Podfile de Capacitor 8 ya pone 14.0).

## Al terminar
- `ios/` está **gitignored** (no se sube, igual que `android/`); el `GoogleService-Info.plist`
  tampoco se commitea (config local). Si NO se tocó nada fuera de `ios/`, no hay nada que pushear.
- **Deja una nota al final de este doc** (qué quedó, token FCM confirmado, cualquier gotcha) y
  haz `git commit + push` de ESTE doc, para que la máquina Windows haga `git pull` y se entere
  (la memoria no viaja entre máquinas; este doc sí).

---

## ✅ HECHO 2026-06-04 — Push iOS LIVE y probado en iPhone físico

Ejecutado desde la Mac. Push en iOS **funcionando de punta a punta**. Qué quedó:

- **Podfile** (`ios/App/Podfile`): agregada `pod 'FirebaseMessaging'` dentro de `target 'App' do`.
  Quedó instalado **FirebaseMessaging 12.14.0** (vía `npm run sync:ios` → `pod install`).
- **AppDelegate.swift**: `import FirebaseCore` + `import FirebaseMessaging`; `FirebaseApp.configure()`
  en `didFinishLaunchingWithOptions`; y se **agregaron** (no existían) los métodos
  `didRegisterForRemoteNotificationsWithDeviceToken` (puente APNs→FCM que publica el **token FCM String**
  en `.capacitorDidRegisterForRemoteNotifications`) y `didFailToRegisterForRemoteNotificationsWithError`.
- **Capacidades en Xcode** (target App, Team de paga `Z69ZT5UW4M`, firma automática):
  **Push Notifications** → generó `App/App.entitlements` con `aps-environment=development`;
  **Background Modes → Remote notifications** → `UIBackgroundModes=[remote-notification]` en Info.plist.
- **Verificación** (scripts de `saas-base`, contra prod `praxion-api.onrender.com`, tenant `gh-insumos-prod`):
  - `poll-push-status.js` → `{ firebaseEnabled: true, deviceCount: 2, audienceAllCount: 10 }`.
  - `send-test-push.js` → **`{ sent: 2, skipped: false, pruned: 0 }`** y la notificación **llegó al iPhone**.
  - **`pruned: 0`** confirma que el token del iPhone es **FCM válido** (si fuera APNs crudo, Firebase lo
    habría rechazado y pruned sería ≥1) → el puente del AppDelegate quedó bien.

**Gotchas confirmados en la práctica:** solo device físico recibe push; mejor probar con la app en
segundo plano. Nada que cambiar en el backend (ya estaba LIVE). `ios/` sigue gitignored, así que el
único cambio versionado es ESTE doc.

---

## Bitácora push iOS — 2026-06-04

**Estado: FUNCIONANDO de punta a punta.** Resumen para la máquina Windows.

### Pasos nativos completados
- **Podfile** (`ios/App/Podfile`): agregué `pod 'FirebaseMessaging'` dentro de `target 'App' do`
  (sin tocar el bloque `def capacitor_pods`, que lo regenera `cap sync`).
- **AppDelegate.swift**: `import FirebaseCore` + `import FirebaseMessaging`; `FirebaseApp.configure()`
  en `didFinishLaunchingWithOptions`; y **agregué** (no existían en el AppDelegate default) los métodos
  `didRegisterForRemoteNotificationsWithDeviceToken` —que hace el **puente APNs→FCM** y publica el
  **token FCM (String)** en `.capacitorDidRegisterForRemoteNotifications`— y
  `didFailToRegisterForRemoteNotificationsWithError`.
- **pod install**: vía `npm run sync:ios` (`vite build && cap sync ios`). Quedó instalado
  **FirebaseMessaging 12.14.0** (+ FirebaseCore 12.14.0). `cap sync` también re-agregó
  `CapacitorPushNotifications` al bloque `capacitor_pods` (esperado).
- **Capacidades en Xcode** (target App, firma automática, Team de PAGA `Z69ZT5UW4M`):
  **Push Notifications** → generó `App/App.entitlements` con `aps-environment=development` y lo cableó
  al pbxproj (`CODE_SIGN_ENTITLEMENTS`). **Background Modes → Remote notifications** →
  `UIBackgroundModes=[remote-notification]` en `Info.plist`.

### ¿Compiló y corrió en iPhone físico?
**Sí.** Build + Run en iPhone físico OK (el push no funciona en Simulador). La app pidió permiso de
notificaciones al abrir (aceptado) y la sesión ya estaba iniciada — el token se registra en cada
arranque vía el hook `usePushNotifications`, no solo en login.

### ¿El token se registró como FCM (no APNs)?
**Sí, FCM válido.** Verificado **sin tocar la base directamente**, con los scripts de `saas-base`
contra prod (`praxion-api.onrender.com`, tenant `gh-insumos-prod`):
- `node scripts/poll-push-status.js gh-insumos-prod <user> <pass>` →
  `{ firebaseEnabled: true, deviceCount: 2, audienceAllCount: 10 }` → la fila del iPhone quedó en
  `device_tokens` (deviceCount subió a 2).
- La confirmación FCM-vs-APNs vino del **broadcast**: `pruned: 0`. Si el token hubiera sido APNs crudo,
  firebase-admin lo habría rechazado y `pruned` sería ≥1. Que sea 0 prueba que el puente del
  AppDelegate entregó un **token FCM** correcto.

### Primera luz (¿llegó la notificación?)
**Sí llegó al iPhone.** `node scripts/send-test-push.js gh-insumos-prod <user> <pass> "Prueba iOS 🍎" "..."`
→ **`{ sent: 2, skipped: false, pruned: 0 }`** y la notificación apareció en el teléfono (con la app en
segundo plano).

### Gotchas / cosas que hubo que tocar
- **AppDelegate sin métodos de push:** el AppDelegate default de Capacitor NO traía
  `didRegisterForRemoteNotificationsWithDeviceToken`. Hubo que **agregarlos completos** (no solo editar),
  publicando el token FCM String — no el `Data` de APNs— en el NotificationCenter del plugin.
- **Commit accidental del plist:** al pushear, el primer commit se llevó por error
  `GoogleService-Info.plist` (que es config local y `ios/` está gitignored). Se sacó del índice con
  `git reset --soft HEAD~1` + `git restore --staged` **antes del push** (el archivo sigue en disco,
  fuera de git). Lección: no usar `git add -f`/`git add .` dentro de `ios/`.
- Sin cambios en pods más allá de `FirebaseMessaging`; el backend ya estaba LIVE, no se tocó.

---

## 🏬 Subir a App Store (handoff para el Claude de la Mac) — 2026-06-05

Pedido del usuario: **publicar en la App Store**. La parte de **contenido/ficha + pasos de App
Store Connect (navegador)** está en **`docs/app-store/GUIA-APP-STORE.md`**. Aquí va solo lo que
se ejecuta **en la Mac** (Xcode). Apple Developer de paga **ACTIVO**, Team `Z69ZT5UW4M`.

### Pre-vuelo
1. `git pull` a origin/main (sincronizar con lo último de Windows — incluye esta guía).
2. `rm -rf ios/App/build` (gotcha conocido: CocoaPods corre `xcodebuild clean` y truena si hay
   `build/` previo).
3. `npm run sync:ios` (vite build + `cap sync ios`; corre `pod install`).
4. Confirmar `GoogleService-Info.plist` presente en el target App (config local, gitignored).

### ⚠️ Tres ajustes ANTES del Archive (viven en `ios/`, gitignored → no se versionan)
1. **Push en producción:** en `ios/App/App/App.entitlements`, cambiar
   `aps-environment` de `development` → **`production`**. Si queda en `development`, el token de
   TestFlight/App Store sería de sandbox y **el push NO llegaría** en la versión publicada. La
   llave APNs `.p8` en Firebase ya cubre Sandbox **y** Production, así que basta el cambio del
   entitlement.
2. **Export compliance (una vez):** en `ios/App/App/Info.plist` agregar
   `ITSAppUsesNonExemptEncryption = NO` (solo usa HTTPS estándar = exenta) → App Store Connect
   deja de preguntar en cada subida.
3. **Versión/Build:** en Xcode (target App → General) o `agvtool`: Version `1.0`, Build `1`.
   **Cada subida nueva debe subir el Build** (1 → 2 → 3…); App Store Connect rechaza builds con
   el mismo número.

### Archive + subida
1. Xcode → abrir `ios/App/App.xcworkspace`. Target **App**, Team de paga `Z69ZT5UW4M`, firma
   **automática**. Destino: **Any iOS Device (arm64)** (NO un simulador, o "Archive" sale gris).
2. **Product → Archive**. Al terminar abre el **Organizer**.
3. **Distribute App → App Store Connect → Upload** → firma automática → Upload.
4. En ~5–15 min el build aparece en **App Store Connect → (la app) → TestFlight** (estado
   "Processing" → listo). Desde TestFlight: agregar a **Internal Testing** para probarlo YA en
   iPhones reales sin esperar revisión.
5. Para la App Store pública: el **usuario** completa la ficha en el navegador
   (`GUIA-APP-STORE.md`) y selecciona ESE build en la versión 1.0 → Submit for Review.

### Capturas para la ficha (las pide Apple, se sacan aquí)
- Correr en **Simulador iPhone 16 Pro Max** (tamaño 6.9" = 1320×2868):
  `npm run sync:ios` → abrir en Xcode/Simulator, o `xcrun simctl boot "iPhone 16 Pro Max"`.
- Capturar: `xcrun simctl io booted screenshot ~/Desktop/praxion-ios-1.png` (repetir por
  pantalla: Dashboard, Ventas/Pedidos, Inventario/escáner, Producción/Compras).
- Pasárselas al usuario; desde Windows se reencuadran si App Store Connect las marca de tamaño.

### Al terminar
- **Commit + push SOLO de docs** (markdown). `ios/` sigue gitignored — los 3 ajustes de arriba
  NO se versionan (se rehacen si se regenera `ios/`). **NUNCA `git add .`/`-f` dentro de `ios/`**
  (se cuela el `GoogleService-Info.plist`).
- Dejar nota aquí (qué build se subió, fecha, cualquier rechazo de Apple + cómo se resolvió) para
  que Windows lo lea en el siguiente `git pull`.
