import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tenantsApi } from '@/api/tenants'
import Spinner from '@/components/ui/Spinner'
import Can, { useCan } from '@/components/auth/Can'

export default function Notificaciones() {
  const qc = useQueryClient()
  const canEdit = useCan('settings:update')
  const [email, setEmail] = useState('')
  const [touched, setTouched] = useState(false)
  const [msg, setMsg]     = useState(null)
  const [error, setError] = useState(null)

  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
  })

  useEffect(() => {
    if (tenant && !touched) setEmail(tenant.notification_email || '')
  }, [tenant, touched])

  const save = useMutation({
    mutationFn: (notificationEmail) =>
      tenantsApi.updateCurrent({ notificationEmail }),
    onSuccess: (data) => {
      setMsg('Configuración guardada.')
      setError(null)
      setTouched(false)
      qc.setQueryData(['tenant', 'current'], data)
    },
    onError: (e) => {
      setError(e.response?.data?.error || e.message || 'Error al guardar')
      setMsg(null)
    },
  })

  const valid = email === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)

  return (
    <div className="page-enter max-w-2xl mx-auto py-6 px-4 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Configuración · Notificaciones</h1>
        <p className="text-sm text-ink-muted mt-1">
          Controla el correo institucional que recibe copia de los envíos automáticos y manuales.
        </p>
      </div>

      <section className="card p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-ink-primary">Correo de copia (BCC)</h2>
          <p className="text-xs text-ink-muted mt-1">
            Este correo recibe una copia de cada remisión enviada y, cuando es posible, de cada factura.
            Si lo dejas vacío se usará como respaldo el correo del usuario que esté logueado en el momento del envío.
          </p>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <>
            <div>
              <label className="block text-xs text-ink-muted mb-1">Correo institucional</label>
              <input
                type="email"
                className="input"
                value={email}
                disabled={!canEdit}
                onChange={(e) => { setEmail(e.target.value); setTouched(true); setMsg(null); setError(null) }}
                placeholder="administracion@empresa.com"
                title={!canEdit ? 'Necesitas permiso de Configuración (settings:update) para editar' : ''}
              />
              {!valid && (
                <p className="text-xs text-status-danger mt-1">El correo no tiene formato válido.</p>
              )}
              {!canEdit && (
                <p className="text-[11px] text-ink-muted mt-1 italic">
                  Solo lectura — tu rol no incluye permiso para editar la configuración.
                </p>
              )}
            </div>

            {msg && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <p className="text-sm text-emerald-700">{msg}</p>
              </div>
            )}
            {error && (
              <div className="bg-status-danger/10 border border-status-danger/40 rounded-lg px-3 py-2">
                <p className="text-sm text-status-danger">{error}</p>
              </div>
            )}

            <Can do="settings:update">
              <div className="flex justify-end gap-2">
                <button
                  className="btn-secondary"
                  disabled={!touched || save.isPending}
                  onClick={() => { setEmail(tenant?.notification_email || ''); setTouched(false); setMsg(null); setError(null) }}>
                  Cancelar
                </button>
                <button
                  className="btn-primary"
                  disabled={!valid || !touched || save.isPending}
                  onClick={() => save.mutate(email.trim() || null)}>
                  {save.isPending ? <Spinner size="sm" /> : 'Guardar'}
                </button>
              </div>
            </Can>
          </>
        )}
      </section>
    </div>
  )
}
