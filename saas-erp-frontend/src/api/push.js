import api from './axios'

const B = '/push'

export const pushApi = {
  // Registra el token FCM del dispositivo para el usuario logueado.
  register: ({ token, platform, deviceInfo }) =>
    api.post(`${B}/register`, { token, platform, deviceInfo }).then((r) => r.data),

  // Borra el token al cerrar sesión.
  unregister: ({ token }) =>
    api.post(`${B}/unregister`, { token }).then((r) => r.data),
}
