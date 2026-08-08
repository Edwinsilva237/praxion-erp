# Actualizaciones por aire (OTA) — Capgo · iOS + Android

> **Para qué:** hoy la app **empaqueta la web** dentro del instalador
> (`capacitor.config.json` → `webDir: "dist"`, sin `server.url`). Lo que el
> usuario ve en el celular queda **congelado en el build**: la web se actualiza
> con cada push, la app no. Al 2026-08-07 las apps estaban **182 commits atrás**
> (124 del frontend, 13 pantallas nuevas: Comunicados, RH, Vales, Notas de
> crédito, Complementos de pago, Devoluciones de venta, Tarjetas de crédito,
> Distribución de docs fiscales y 4 reportes).
>
> Con OTA, cada paquete nuevo llega **solo al abrir la app**, como la web.

## Qué viaja por aire y qué no

| Sí, sin pasar por tienda | No — exige recompilar + tienda |
|---|---|
| Pantallas y módulos nuevos | Plugins nativos nuevos |
| Reportes, textos, diseño | Permisos del sistema |
| Correcciones de interfaz | Ícono, splash, nombre de la app |
| Todo lo del backend (ya es automático) | Subir la versión de Capacitor |

Ambas tiendas lo permiten: es código **interpretado** (JavaScript) dentro de un
webview, no código nativo descargado. Lo que Apple y Google prohíben es cambiar
el propósito de la app o meter por aire algo que la revisión no aprobó.

---

## ✅ Ya hecho desde Windows (2026-08-07) — NO repetir

- `@capgo/capacitor-updater@8.51.3` en `package.json` (peer `@capacitor/core ^8.0.0`
  → alineado con Capacitor 8 del proyecto).
- **`src/utils/liveUpdates.js`** — `notifyLiveUpdateReady()`: import dinámico +
  guard `Capacitor.isNativePlatform()` (mismo patrón que `usePushNotifications`),
  con `try/catch` para que un build sin el plugin no truene.
- **`src/main.jsx`** — la llama después del primer render.
  ⚠️ **`notifyAppReady()` es el seguro de vida:** si no se avisa a tiempo, el
  plugin da por roto el paquete nuevo y **regresa solo** al anterior. Por eso NO
  moverla detrás del login ni de una llamada al backend — con el servidor caído
  haría rollback de un paquete sano.
- **`capacitor.config.json`** — `plugins.CapacitorUpdater.autoUpdate: true`.
- Build web verificado: el plugin queda en un chunk aparte que **solo se carga en
  nativo** (el bundle principal creció 0.3 kB).

## ⏳ Falta (en este orden)

### 0. Cuenta de Capgo — lo hace el USUARIO
1. Crear cuenta en **capgo.app** y sacar la **API key**.
2. Guardarla como secreto (NO va al repo). Es de paga para uso comercial; hay
   plan gratuito acotado.

### 1. Registrar la app (una sola vez, cualquier máquina)

```bash
cd saas-erp-frontend
npx @capgo/cli init <API_KEY>
```

Registra el `appId` `com.praxionops.erp` y sube el primer paquete. El CLI puede
tocar `capacitor.config.json` — **revisar el diff antes de commitear** y no
dejar la llave dentro del archivo.

### 2. Android — recompilar (Windows)

La app **aún NO está publicada** (iOS sí): este build es el que va a producción,
así que el plugin no cuesta ningún trámite extra.

```bash
cd saas-erp-frontend
npm install
npm run build
npx cap sync android
```

⚠️ **Subir `versionCode` en `android/app/build.gradle`** (estaba en `1`): Play
rechaza un `versionCode` repetido. Subir también `versionName` (ej. `1.1`).
Luego generar el AAB firmado con el keystore de siempre.
**Respaldar el keystore** — si se pierde, la app no se puede volver a actualizar
nunca. Pendientes de tienda en `docs/play-store/GUIA-PLAY-STORE.md`.

### 3. iOS — recompilar (SOLO en la Mac)

La app **ya está publicada**, así que este envío cuesta una revisión (~1 día) —
la misma que de todos modos hace falta para ponerla al día.

```bash
git pull                      # traer el plugin + el cableado
cd saas-erp-frontend
npm install
rm -rf ios/App/build          # CocoaPods corre xcodebuild clean y falla si hay build/ previo
npm run sync:ios
```

Antes del Archive, los 3 ajustes de siempre (ver `docs/ios-app-setup.md`):
`aps-environment` → **production**, `ITSAppUsesNonExemptEncryption=NO`, y **subir
el Build number**. Luego Archive → Distribute → App Store Connect → Upload.

⚠️ **NUNCA `git add .` ni `-f` dentro de `ios/`** (está gitignored; ahí se coló
una vez el `GoogleService-Info.plist`).

### 4. De ahí en adelante — publicar una actualización

Después de cada deploy web que valga la pena mandar al celular:

```bash
cd saas-erp-frontend
npm run build
npx @capgo/cli bundle upload --channel production
```

Los teléfonos con la app instalada lo bajan **al abrir**. Si el paquete rompe el
arranque, el plugin regresa solo al anterior (por eso importa `notifyAppReady`).

---

## Coordinación 2 máquinas

El canal entre la Mac y Windows es el **repo**: quien termine hace commit+push y
deja nota aquí o en `docs/ios-app-setup.md`. Antes de tocar `package.json` o
`capacitor.config.json` desde una máquina, verificar que la otra no tenga cambios
sin pushear.
