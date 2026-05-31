import { create } from 'zustand'

// Estado global mínimo para saber si el servidor está respondiendo lento
// (típicamente porque estuvo inactivo y está "despertando"). Lo alimenta el
// interceptor de axios (ver src/api/axios.js) y lo consume el aviso discreto
// ServerWakingBanner. Sin persistencia: es estado de runtime.
const useServerStatus = create((set) => ({
  waking: false,
  setWaking: (waking) => set({ waking }),
}))

export default useServerStatus
