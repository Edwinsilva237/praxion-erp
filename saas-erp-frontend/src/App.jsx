import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import router from '@/router'
import LegacyHostnameNotice from '@/components/LegacyHostnameNotice'
import ServerWakingBanner from '@/components/ServerWakingBanner'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Auto-refresca al volver el foco a la pestaña/app y al reconectar. Las
      // listas usan keepPreviousData → actualiza en segundo plano, sin parpadeo
      // ni F5. (Antes false; el polling "vivo" por pantalla está en livePolling.js.)
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 60 * 1000, // 1 min por defecto
    },
  },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Overlay que aparece SOLO si el usuario entra por la URL antigua
          praxion-web.onrender.com (en cualquier otro hostname devuelve null). */}
      <LegacyHostnameNotice />
      <ServerWakingBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
