// Opciones de React Query para listas "vivas" (multi-usuario): refresca cada 45s
// SOLO cuando la pestaña/app está visible. refetchIntervalInBackground:false (el
// default, explícito aquí) → en segundo plano NO hace polling: no gasta batería/
// datos en el móvil ni pega al backend de gratis. Combinado con keepPreviousData,
// el refresco es en segundo plano y sin parpadeo.
//
// Cadencia única: cambia el número aquí y aplica a todas las listas operativas.
export const LIVE_LIST = {
  refetchInterval: 45_000,
  refetchIntervalInBackground: false,
}
