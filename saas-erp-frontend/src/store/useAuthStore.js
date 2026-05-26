import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { setSentryUser, clearSentryUser } from '@/config/sentry'

const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      tenant: null,
      permissions: [],
      uiPrefs: { mobile_tabs: null, home_route: null },
      isAuthenticated: false,
      // Si !== null, estamos viendo el ERP como otro tenant via impersonación.
      // Contiene { sessionId, actorUserId, actorTenantId, actorEmail }.
      impersonation: null,

      login: ({ user, tenant, permissions, uiPrefs, accessToken, refreshToken }) => {
        localStorage.setItem('erp_access_token', accessToken)
        if (refreshToken) localStorage.setItem('erp_refresh_token', refreshToken)
        if (tenant?.slug) localStorage.setItem('erp_tenant_slug', tenant.slug)
        set({
          user, tenant, permissions,
          uiPrefs: uiPrefs || { mobile_tabs: null, home_route: null },
          isAuthenticated: true,
        })
        setSentryUser({ user, tenant })
      },

      logout: () => {
        localStorage.removeItem('erp_access_token')
        localStorage.removeItem('erp_refresh_token')
        localStorage.removeItem('erp_tenant_slug')
        // Limpiar también cualquier impersonación pendiente
        localStorage.removeItem('erp_impersonation_backup')
        set({
          user: null, tenant: null, permissions: [],
          uiPrefs: { mobile_tabs: null, home_route: null },
          isAuthenticated: false,
          impersonation: null,
        })
        clearSentryUser()
      },

      // ── Impersonación ──────────────────────────────────────────────────
      // Guarda los tokens actuales (del platform admin), inyecta los de la
      // sesión impersonada, refresca el store. Devuelve la info del target.
      startImpersonation: async (tenantId, reason = null) => {
        const { default: api } = await import('@/api/axios')
        const { platformAdminApi } = await import('@/api/platformAdmin')
        const data = await platformAdminApi.impersonate(tenantId, reason)

        // Backup de la sesión actual (la del actor real).
        localStorage.setItem('erp_impersonation_backup', JSON.stringify({
          accessToken:  localStorage.getItem('erp_access_token'),
          refreshToken: localStorage.getItem('erp_refresh_token'),
          tenantSlug:   localStorage.getItem('erp_tenant_slug'),
          startedAt:    new Date().toISOString(),
        }))

        // Swap a la sesión impersonada. NOTA: no hay refresh token nuevo —
        // la sesión impersonada NO se renueva. Si expira, vuelves al actor.
        localStorage.setItem('erp_access_token', data.accessToken)
        localStorage.removeItem('erp_refresh_token')
        localStorage.setItem('erp_tenant_slug', data.target.tenantSlug)

        // Refresh /me — viene con impersonation: { sessionId, actorUserId, ... }
        const me = await api.get('/auth/me').then((r) => r.data)
        set({
          user: {
            id:        me.userId,
            email:     me.email,
            fullName:  data.target.userName,
            roles:     me.roles,
            isPlatformAdmin: false, // En modo impersonación NO eres platform admin
          },
          tenant: {
            id:    me.tenantId,
            slug:  data.target.tenantSlug,
            name:  data.target.tenantName,
            is_active: me.tenantActive,
          },
          permissions: me.permissions || [],
          uiPrefs:     me.uiPrefs || { mobile_tabs: null, home_route: null },
          isAuthenticated: true,
          impersonation: me.impersonation,
        })
        setSentryUser({
          user:   { id: me.userId, email: me.email },
          tenant: { id: me.tenantId, slug: data.target.tenantSlug },
        })
        return data
      },

      endImpersonation: async () => {
        const { default: api } = await import('@/api/axios')
        // Avisar al backend para cerrar la sesión en BD (audit).
        try {
          await api.post('/platform-admin/impersonation/end')
        } catch { /* si falla seguimos restaurando, no bloquea */ }

        // Restaurar la sesión del actor.
        const raw = localStorage.getItem('erp_impersonation_backup')
        if (!raw) {
          // Sin backup: forzar logout (estado inconsistente).
          get().logout()
          return
        }
        const backup = JSON.parse(raw)
        localStorage.setItem('erp_access_token',  backup.accessToken)
        if (backup.refreshToken) localStorage.setItem('erp_refresh_token', backup.refreshToken)
        else                     localStorage.removeItem('erp_refresh_token')
        localStorage.setItem('erp_tenant_slug',   backup.tenantSlug)
        localStorage.removeItem('erp_impersonation_backup')

        // Re-hidratar el store con /me del actor.
        const me = await api.get('/auth/me').then((r) => r.data).catch(() => null)
        if (me) {
          set((s) => ({
            user: {
              ...s.user,
              id:        me.userId,
              email:     me.email,
              roles:     me.roles,
              isPlatformAdmin: me.isPlatformAdmin === true,
            },
            permissions: me.permissions || [],
            uiPrefs:     me.uiPrefs || { mobile_tabs: null, home_route: null },
            impersonation: null,
          }))
        } else {
          // /me falló: limpia impersonation pero deja al usuario en /login.
          set({ impersonation: null })
        }
      },

      // Actualiza datos del usuario en el store (ej. al editar nombre).
      // No toca tokens ni permisos.
      updateUser: (patch) => set((s) => ({
        user: { ...s.user, ...patch },
      })),

      // ── Switch de tenant ───────────────────────────────────────────────
      // Cambia la empresa activa. Reemite tokens, actualiza tenant slug en
      // localStorage para que los requests siguientes vayan al tenant nuevo,
      // y rehidrata el store con los datos del tenant target.
      //
      // Por simplicidad usa window.location.href = '/' después de actualizar
      // los tokens — esto fuerza un reload limpio del SPA, invalidando
      // todas las queries de React Query del tenant anterior. Más simple y
      // robusto que tratar de invalidar selectivamente.
      switchTenant: async (tenantId) => {
        const { membershipsApi } = await import('@/api/memberships')
        const data = await membershipsApi.switch(tenantId)

        localStorage.setItem('erp_access_token',  data.accessToken)
        localStorage.setItem('erp_refresh_token', data.refreshToken)
        localStorage.setItem('erp_tenant_slug',   data.tenant.slug)

        set({
          user: {
            id:              data.user.id,
            email:           data.user.email,
            fullName:        data.user.fullName,
            roles:           data.user.roles,
            isPlatformAdmin: data.user.isPlatformAdmin === true,
          },
          tenant: {
            id:        data.tenant.id,
            slug:      data.tenant.slug,
            name:      data.tenant.name,
            modules:   data.tenant.modules,
            is_active: data.tenant.is_active,
            is_sandbox: data.tenant.is_sandbox,
            plan:      data.tenant.plan,
          },
          permissions: data.permissions || [],
          uiPrefs:     data.uiPrefs || { mobile_tabs: null, home_route: null },
          isAuthenticated: true,
          impersonation: null,
        })
        setSentryUser({ user: data.user, tenant: data.tenant })

        // Reload completo para purgar caches de queries del tenant viejo.
        window.location.href = '/'
      },

      // Refresca permisos/roles desde el backend (/auth/me).
      // Útil cuando un admin cambia los roles del usuario logueado y
      // queremos que vea su nuevo menú sin tener que cerrar sesión.
      refresh: async () => {
        try {
          const { default: api } = await import('@/api/axios')
          const { data } = await api.get('/auth/me')
          set((s) => ({
            user: {
              ...s.user,
              roles: data.roles,
              fullName: s.user?.fullName,
              isPlatformAdmin: data.isPlatformAdmin === true,
            },
            permissions: data.permissions || [],
            uiPrefs: data.uiPrefs || { mobile_tabs: null, home_route: null },
            // Sincroniza el flag de impersonación (puede haber expirado el JWT
            // y entonces ya no aparece — el backend lo refleja).
            impersonation: data.impersonation || null,
          }))
          return data
        } catch (err) {
          // Si /me falla (token vencido, etc.) no rompemos UI.
          console.warn('auth refresh failed', err)
          return null
        }
      },

      // super_admin (rol en el backend) tiene acceso a todo
      can: (resource, action) => {
        const { user, permissions } = get()
        if (user?.roles?.includes?.('super_admin')) return true
        if (permissions.includes('*')) return true
        return permissions.includes(`${resource}:${action}`)
      },

      canAny: (...keys) => {
        const { user, permissions } = get()
        if (user?.roles?.includes?.('super_admin')) return true
        if (permissions.includes('*')) return true
        return keys.some((k) => permissions.includes(k))
      },
    }),
    {
      name: 'erp-auth',
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        permissions: state.permissions,
        uiPrefs: state.uiPrefs,
        isAuthenticated: state.isAuthenticated,
        impersonation: state.impersonation,
      }),
      // Restaura el contexto de Sentry tras rehidratar (abrir la app con sesión persistida).
      onRehydrateStorage: () => (state) => {
        if (state?.isAuthenticated && state.user) {
          setSentryUser({ user: state.user, tenant: state.tenant })
        }
      },
    }
  )
)

export default useAuthStore
