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
- **`capacitor.config.json` con `server.iosScheme: "https"`** ← CRÍTICO. El
  webview de iOS por default usa origen `capacitor://localhost`, que el CORS del
  backend (`saas-base/src/app.js`, solo acepta `http(s)://localhost|127.0.0.1|192.168.*`
  + dominio) **NO** permite → bloquearía TODAS las llamadas API. Con `iosScheme:
  https` el origen es `https://localhost`, que sí pasa (igual que Android).
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
- **Origen del webview**: por eso forzamos `iosScheme: https`. Si alguien quita
  ese bloque, la app no habla con el backend.
- **Backend directo a onrender**: la app pega a `https://praxion-api.onrender.com/api`
  directo (no al dominio Cloudflare: Cloudflare no devuelve el CORS preflight para
  el origen `localhost` del webview). El warm-up al abrir mitiga el arranque frío.
  Ver `saas-erp-frontend/src/api/axios.js`.
- **Cámara en Simulador**: no existe; barras solo se prueba en device real.

## Después del Simulador (siguiente)

1. **Iconos**: `npx capacitor-assets generate --ios` (necesita `assets/` con los
   PNG fuente; si no están, regenerar con `node scripts/gen-app-icons.cjs` —
   aplana `public/praxion-isotipo.svg` con sharp). Label de la app: "Praxion".
2. **Splash screen**.
3. **Correr en iPhone físico** (Apple ID gratis, firma caduca cada 7 días).
4. **Apple Developer de paga** → TestFlight → repartir a usuarios.

## Convención del proyecto

Los cambios quedan en local por default. Solo cuando el usuario dice literalmente
**"actualiza en línea"** se hace `git add + commit + push` a `origin/main` (Render
redeploya el backend/web solo). El proyecto iOS nativo (`ios/`) NO se commitea
(como `android/`): se regenera con `npx cap add ios`.
