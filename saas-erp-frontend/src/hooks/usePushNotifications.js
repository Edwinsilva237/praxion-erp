import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { pushApi } from '@/api/push'

const TOKEN_KEY = 'erp_push_token'

/**
 * Registro de notificaciones push (FCM) — SOLO en la app nativa.
 *
 * Patrón igual que useBarcodeScanner: import dinámico del plugin (nunca en
 * top-level → el build web no lo incluye) + guard Capacitor.isNativePlatform().
 *
 * Al montar (una vez): pide permiso → registra → manda el token FCM al backend
 * (POST /push/register) y lo guarda en localStorage para poder darlo de baja al
 * cerrar sesión. Listeners:
 *   - 'registration'                  → guardar token + enviarlo al backend.
 *   - 'pushNotificationReceived'      → (app en primer plano) emite CustomEvent
 *                                       'push:received' para que la UI lo muestre.
 *   - 'pushNotificationActionPerformed' → al tocar la notificación, deep-link a
 *                                       data.route si viene.
 *
 * En web es no-op (el hook no hace nada).
 */
export function usePushNotifications() {
  const navigate = useNavigate()
  const startedRef = useRef(false)

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    if (startedRef.current) return
    startedRef.current = true

    let listeners = []

    async function start() {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications')

        // Permiso: si está en 'prompt', lo pedimos. Si lo niegan, salimos
        // limpio (no registramos).
        let perm = await PushNotifications.checkPermissions()
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
          perm = await PushNotifications.requestPermissions()
        }
        if (perm.receive !== 'granted') {
          console.warn('[push] permiso de notificaciones no concedido')
          return
        }

        // Token recibido → al backend.
        listeners.push(await PushNotifications.addListener('registration', async (token) => {
          try {
            localStorage.setItem(TOKEN_KEY, token.value)
            await pushApi.register({ token: token.value, platform: Capacitor.getPlatform() })
          } catch (err) {
            console.warn('[push] no se pudo registrar el token en el backend', err?.message)
          }
        }))

        listeners.push(await PushNotifications.addListener('registrationError', (err) => {
          console.warn('[push] registrationError', err)
        }))

        // Primer plano: Android no muestra la bandeja → exponemos un evento para
        // que la UI (futuro toast) lo pinte. No intrusivo.
        listeners.push(await PushNotifications.addListener('pushNotificationReceived', (notification) => {
          window.dispatchEvent(new CustomEvent('push:received', { detail: notification }))
        }))

        // Tap en la notificación → deep-link si trae data.route.
        listeners.push(await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const route = action?.notification?.data?.route
          if (route) navigate(route)
        }))

        await PushNotifications.register()
      } catch (err) {
        console.warn('[push] inicialización fallida', err?.message)
      }
    }

    start()

    return () => {
      // Quitar listeners al desmontar (best-effort).
      listeners.forEach((l) => { try { l?.remove?.() } catch { /* noop */ } })
      listeners = []
    }
  }, [navigate])
}

/**
 * Da de baja el token push en el backend (al cerrar sesión). No usa el plugin
 * nativo — solo el token guardado + la API. Best-effort: nunca lanza.
 */
export async function unregisterPushToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) {
      await pushApi.unregister({ token })
    }
  } catch (err) {
    console.warn('[push] unregister falló', err?.message)
  } finally {
    localStorage.removeItem(TOKEN_KEY)
  }
}
