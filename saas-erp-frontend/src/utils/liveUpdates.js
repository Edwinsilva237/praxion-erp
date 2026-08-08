import { Capacitor } from '@capacitor/core'

/**
 * Actualizaciones por aire (OTA) — SOLO en la app nativa.
 *
 * La app empaqueta la web dentro del instalador (`webDir: "dist"`), así que sin
 * esto la interfaz se queda congelada en el build hasta pasar otra vez por la
 * tienda. Con el plugin de Capgo, cada paquete nuevo que subimos llega solo al
 * abrir la app — igual que la web.
 *
 * `notifyAppReady()` es el seguro de vida del mecanismo: le avisa al plugin que
 * el paquete recién instalado ARRANCÓ BIEN. Si no se llama dentro del tiempo
 * límite, el plugin asume que el paquete rompió la app y **regresa solo** al
 * anterior. Por eso se llama lo antes posible después de que React pintó, y por
 * eso NO debe moverse detrás de un login ni de una llamada al backend: si el
 * servidor está caído, la app haría rollback de un paquete que en realidad está
 * sano.
 *
 * Qué SÍ viaja por aire: pantallas, reportes, textos, correcciones de interfaz.
 * Qué NO: plugins nuevos, permisos, ícono, splash o subir Capacitor — eso
 * siempre exige recompilar y pasar por la tienda.
 *
 * Patrón igual que usePushNotifications: import dinámico (nunca en top-level →
 * el build web no lo incluye) + guard de plataforma nativa. En web es no-op.
 */
export async function notifyLiveUpdateReady() {
  if (!Capacitor.isNativePlatform()) return

  try {
    const { CapacitorUpdater } = await import('@capgo/capacitor-updater')
    await CapacitorUpdater.notifyAppReady()
  } catch (err) {
    // Nunca romper el arranque por esto: si el plugin no está (build viejo, sin
    // OTA todavía) o falla, la app sigue con el paquete que ya tiene.
    console.warn('[live-updates] notifyAppReady no disponible:', err?.message || err)
  }
}
