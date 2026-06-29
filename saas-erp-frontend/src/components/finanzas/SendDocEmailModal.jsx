import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { partnersApi } from '@/api/partners'
import { tenantsApi } from '@/api/tenants'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'

/**
 * Modal genérico para enviar un comprobante (complemento de pago o recibo) por
 * correo. Selecciona contactos del cliente + correos extra y delega el envío en
 * `sendFn(emails)`. Reusable desde Pagos recibidos y CXC.
 */
export default function SendDocEmailModal({
  partnerId, title, description, sendFn, onClose, onSent,
}) {
  const userEmail = useAuthStore(s => s.user?.email)
  const { data: tenant } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 60_000,
  })
  const copyEmail = tenant?.notification_email || userEmail

  const { data: partner, isLoading } = useQuery({
    queryKey: ['partner', partnerId],
    queryFn:  () => partnersApi.get(partnerId),
    enabled:  !!partnerId,
  })

  const contactsWithEmail = (partner?.contacts || []).filter(c => c?.email)

  const [selected, setSelected]     = useState({})
  const [extraEmails, setExtraEmails] = useState('')
  const [error, setError] = useState(null)
  const [msg, setMsg]     = useState(null)

  useEffect(() => {
    if (!contactsWithEmail.length) return
    const init = {}
    const hasPrimary = contactsWithEmail.some(x => x.is_primary)
    contactsWithEmail.forEach((c, i) => {
      init[c.email] = contactsWithEmail.length === 1
                   || !!c.is_primary
                   || (!hasPrimary && i === 0)
    })
    setSelected(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner?.id])

  const toggle = (email) => setSelected(s => ({ ...s, [email]: !s[email] }))

  const selectedEmails = Object.entries(selected).filter(([, v]) => v).map(([k]) => k)
  const extraList = extraEmails.split(',').map(e => e.trim()).filter(Boolean)
  const finalEmails = [...new Set([...selectedEmails, ...extraList])]

  const mutation = useMutation({
    mutationFn: () => sendFn(finalEmails),
    onSuccess: (res) => {
      const n = res?.recipients?.length ?? finalEmails.length
      setMsg(`Enviado a ${n} destinatario(s).`)
      setTimeout(() => onSent?.(), 1200)
    },
    onError: (e) => setError(e.response?.data?.error || e.message || 'Error al enviar'),
  })

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/40 p-4"
      onClick={e => e.stopPropagation()}>
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-ink-primary">{title}</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink-secondary">×</button>
        </div>
        {description && <p className="text-xs text-ink-muted mb-4">{description}</p>}

        {isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : contactsWithEmail.length > 0 ? (
          <div className="border border-line-subtle rounded-lg divide-y divide-line-subtle max-h-56 overflow-y-auto">
            {contactsWithEmail.map(c => (
              <label key={c.id || c.email}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-elevated/40">
                <input type="checkbox" className="mt-0.5 accent-brand-600"
                  checked={!!selected[c.email]} onChange={() => toggle(c.email)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium text-ink-primary truncate">{c.name || '(Sin nombre)'}</p>
                    {c.is_primary && <span className="badge-teal text-[10px]">Principal</span>}
                  </div>
                  <p className="text-xs text-ink-muted truncate">{c.email}</p>
                </div>
              </label>
            ))}
          </div>
        ) : (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded-lg px-3 py-2">
            <p className="text-xs text-status-warning">
              Este cliente no tiene contactos con correo. Agrega uno abajo o regístralo en el catálogo.
            </p>
          </div>
        )}

        <label className="block text-xs text-ink-muted mt-4 mb-1">
          Correos adicionales (separados por coma)
        </label>
        <input className="input" placeholder="contabilidad@cliente.com"
          value={extraEmails} onChange={e => setExtraEmails(e.target.value)} />

        {copyEmail && (
          <div className="mt-3 flex items-start gap-2 bg-surface-elevated/40 border border-line-subtle rounded-lg px-3 py-2">
            <svg className="w-4 h-4 text-ink-muted mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <div className="text-xs text-ink-secondary">
              Se enviará copia (BCC) a <strong className="text-ink-primary">{copyEmail}</strong>
              {tenant?.notification_email
                ? <span className="text-ink-muted"> · correo institucional</span>
                : <span className="text-ink-muted"> · tu correo de usuario</span>}.
            </div>
          </div>
        )}

        {error && <p className="field-error mt-3">{error}</p>}
        {msg && <p className="text-xs text-status-success mt-3">{msg}</p>}

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>
            Cerrar
          </button>
          <button
            onClick={() => { setError(null); setMsg(null); mutation.mutate() }}
            disabled={mutation.isPending || finalEmails.length === 0}
            className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : `Enviar${finalEmails.length > 0 ? ` (${finalEmails.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
