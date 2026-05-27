import { RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import router from '@/router'
import LegacyHostnameNotice from '@/components/LegacyHostnameNotice'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
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
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
