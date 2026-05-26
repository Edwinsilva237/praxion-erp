import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { createPortal } from 'react-dom'
import { systemMessagesApi } from '@/api/systemMessages'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import clsx from 'clsx'

const SEVERITY_LABEL = {
  info:     { label: 'Informativo', variant: 'blue'   },
  success:  { label: 'Éxito',       variant: 'green'  },
  warning:  { label: 'Aviso',       variant: 'amber'  },
  critical: { label: 'Crítico',     variant: 'red'    },
}

const TEMPLATES = [
  {
    label: 'Mantenimiento mensual rutinario',
    apply: (offsetDays = 7) => {
      const maintAt = new Date()
      maintAt.setDate(maintAt.getDate() + offsetDays)
      maintAt.setHours(3, 0, 0, 0)
      const startsAt = new Date()
      const endsAt = new Date(maintAt.getTime() + 60 * 60 * 1000)
      return {
        kind: 'maintenance',
        title: 'Mantenimiento programado mensual',
        message: 'Realizaremos tareas de mantenimiento de rutina (limpieza de tokens, backup verification, revisión de índices). El sistema puede experimentar lentitud breve durante la ventana.',
        severity: 'info',
        starts_at: toLocalInput(startsAt),
        ends_at:   toLocalInput(endsAt),
        maintenance_at: toLocalInput(maintAt),
        duration_minutes: 60,
        notify_email: true,
      }
    },
  },
  {
    label: 'Anuncio de nueva función',
    apply: () => {
      const startsAt = new Date()
      const endsAt = new Date()
      endsAt.setDate(endsAt.getDate() + 14)
      return {
        kind: 'announcement',
        title: '✨ Nueva función disponible',
        message: 'Acabamos de liberar [nombre de la función]. Puedes acceder desde [ubicación].',
        severity: 'success',
        starts_at: toLocalInput(startsAt),
        ends_at:   toLocalInput(endsAt),
        notify_email: false,
      }
    },
  },
  {
    label: 'Aviso urgente',
    apply: () => {
      const startsAt = new Date()
      const endsAt = new Date()
      endsAt.setDate(endsAt.getDate() + 3)
      return {
        kind: 'announcement',
        title: 'Aviso importante',
        message: '',
        severity: 'warning',
        starts_at: toLocalInput(startsAt),
        ends_at:   toLocalInput(endsAt),
        notify_email: true,
      }
    },
  },
]

function toLocalInput(date) {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(date)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtDateTime(date) {
  if (!date) return '—'
  return new Date(date).toLocaleString('es-MX', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusBadge(m) {
  if (m.cancelled_at) return <Badge variant="gray" label="Cancelado" />
  const now = Date.now()
  const start = new Date(m.starts_at).getTime()
  const end   = new Date(m.ends_at).getTime()
  if (now < start) return <Badge variant="blue" label="Programado" />
  if (now > end)   return <Badge variant="gray" label="Expirado" />
  return <Badge variant="green" label="Vigente" />
}

export default function SystemMessages() {
  const [showCancelled, setShowCancelled] = useState(false)
  const [editing, setEditing] = useState(null)

  const { data: messages, isLoading } = useQuery({
    queryKey: ['system-messages', 'admin', { includeCancelled: showCancelled }],
    queryFn:  () => systemMessagesApi.list({ includeCancelled: showCancelled }),
  })

  return (
    <div className="page-enter max-w-6xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">Plataforma · Mensajes y mantenimientos</h1>
          <p className="text-sm text-ink-muted mt-1 max-w-2xl">
            Crea avisos para mostrar como banner en el sistema de todos los tenants, o agenda
            ventanas de mantenimiento. Si activas el envío por correo, los tenants reciben
            un email cuando el mensaje arranca y un recordatorio 24 h antes (si es mantenimiento).
          </p>
        </div>
        <button onClick={() => setEditing({})} className="btn-primary">
          + Nuevo mensaje
        </button>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-line-subtle flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
            <input type="checkbox" checked={showCancelled}
              onChange={(e) => setShowCancelled(e.target.checked)} />
            Mostrar cancelados / expirados
          </label>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Título</th>
                <th>Severidad</th>
                <th>Ventana de visibilidad</th>
                <th>Mantenimiento</th>
                <th>Email</th>
                <th>Estado</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={8} className="text-center py-12 text-ink-muted">
                  <Spinner size="sm" /> Cargando…
                </td></tr>
              )}
              {!isLoading && messages?.length === 0 && (
                <tr><td colSpan={8} className="text-center py-12 text-ink-muted text-sm">
                  No hay mensajes. Crea uno con "+ Nuevo mensaje".
                </td></tr>
              )}
              {messages?.map((m) => {
                const sev = SEVERITY_LABEL[m.severity] || SEVERITY_LABEL.info
                return (
                  <tr key={m.id}>
                    <td>
                      <Badge
                        variant={m.kind === 'maintenance' ? 'amber' : 'blue'}
                        label={m.kind === 'maintenance' ? '🛠 Mantenimiento' : '📣 Aviso'}
                      />
                    </td>
                    <td>
                      <div className="font-medium text-ink-primary">{m.title}</div>
                      {m.message && (
                        <div className="text-xs text-ink-muted max-w-xs truncate" title={m.message}>
                          {m.message}
                        </div>
                      )}
                    </td>
                    <td><Badge variant={sev.variant} label={sev.label} /></td>
                    <td className="text-xs text-ink-secondary">
                      <div>{fmtDateTime(m.starts_at)}</div>
                      <div className="text-ink-muted">a {fmtDateTime(m.ends_at)}</div>
                    </td>
                    <td className="text-xs text-ink-secondary">
                      {m.kind === 'maintenance'
                        ? <>
                            <div>{fmtDateTime(m.maintenance_at)}</div>
                            <div className="text-ink-muted">{m.duration_minutes} min</div>
                          </>
                        : <span className="text-ink-muted">—</span>}
                    </td>
                    <td>
                      {m.notify_email
                        ? (m.notified_at
                            ? <Badge variant="green" label="Enviado" />
                            : <Badge variant="amber" label="Pendiente" />)
                        : <span className="text-ink-muted text-xs">—</span>}
                    </td>
                    <td>{statusBadge(m)}</td>
                    <td>
                      <button onClick={() => setEditing(m)}
                        className="btn-ghost btn-sm btn-icon text-ink-muted hover:text-ink-secondary">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== null && (
        <SystemMessageModal
          message={editing.id ? editing : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────
function SystemMessageModal({ message, onClose }) {
  const qc = useQueryClient()
  const isEdit = !!message
  const [serverError, setServerError] = useState(null)

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isDirty } } = useForm({
    defaultValues: message
      ? {
          kind: message.kind,
          title: message.title,
          message: message.message,
          severity: message.severity,
          starts_at: toLocalInput(message.starts_at),
          ends_at: toLocalInput(message.ends_at),
          maintenance_at: toLocalInput(message.maintenance_at),
          duration_minutes: message.duration_minutes || 60,
          notify_email: message.notify_email,
        }
      : {
          kind: 'announcement',
          title: '',
          message: '',
          severity: 'info',
          starts_at: toLocalInput(new Date()),
          ends_at: toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
          maintenance_at: '',
          duration_minutes: 60,
          notify_email: false,
        },
  })

  const kind = watch('kind')
  const isCancelled = !!message?.cancelled_at

  const createMutation = useMutation({
    mutationFn: (data) => systemMessagesApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-messages'] })
      onClose()
    },
    onError: (e) => setServerError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  const updateMutation = useMutation({
    mutationFn: (data) => systemMessagesApi.update(message.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-messages'] })
      onClose()
    },
    onError: (e) => setServerError(e.response?.data?.error || e.message || 'Error al guardar'),
  })

  const cancelMutation = useMutation({
    mutationFn: (reason) => systemMessagesApi.cancel(message.id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-messages'] })
      onClose()
    },
    onError: (e) => setServerError(e.response?.data?.error || e.message || 'Error al cancelar'),
  })

  const onSubmit = (data) => {
    setServerError(null)
    const payload = {
      kind: data.kind,
      title: data.title?.trim(),
      message: data.message?.trim(),
      severity: data.severity,
      starts_at: new Date(data.starts_at).toISOString(),
      ends_at:   new Date(data.ends_at).toISOString(),
      notify_email: !!data.notify_email,
    }
    if (data.kind === 'maintenance') {
      payload.maintenance_at = data.maintenance_at ? new Date(data.maintenance_at).toISOString() : null
      payload.duration_minutes = parseInt(data.duration_minutes, 10) || 60
    }
    if (isEdit) updateMutation.mutate(payload)
    else        createMutation.mutate(payload)
  }

  const applyTemplate = (tpl) => {
    const values = tpl.apply()
    Object.entries(values).forEach(([k, v]) => setValue(k, v, { shouldDirty: true }))
  }

  const isBusy = createMutation.isPending || updateMutation.isPending || cancelMutation.isPending

  const content = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-surface-primary rounded-2xl shadow-card w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-line-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-ink-primary">
              {isEdit ? 'Editar mensaje' : 'Nuevo mensaje del sistema'}
            </h2>
            {isCancelled && (
              <p className="text-xs text-status-warning mt-0.5">
                Este mensaje fue cancelado el {fmtDateTime(message.cancelled_at)}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-ink-muted hover:text-ink-secondary hover:bg-surface-elevated/60">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

          {/* Plantillas rápidas — solo en modo crear */}
          {!isEdit && (
            <div>
              <p className="text-xs text-ink-muted mb-2 uppercase tracking-wide">Plantillas rápidas</p>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((tpl) => (
                  <button key={tpl.label} type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => applyTemplate(tpl)}>
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tipo */}
          <div>
            <label className="label">Tipo *</label>
            <div className="grid grid-cols-2 gap-2">
              {['announcement', 'maintenance'].map((k) => (
                <label key={k} className={clsx(
                  'flex-1 text-center py-2 rounded-lg border text-sm cursor-pointer transition-colors',
                  watch('kind') === k
                    ? 'border-brand-600 bg-brand-500/10 text-brand-300 font-medium'
                    : 'border-line-subtle text-ink-secondary hover:bg-surface-elevated/40'
                )}>
                  <input type="radio" value={k} className="sr-only"
                    {...register('kind')} disabled={isEdit} />
                  {k === 'announcement' ? '📣 Aviso libre' : '🛠 Mantenimiento programado'}
                </label>
              ))}
            </div>
            {isEdit && <p className="text-[11px] text-ink-muted mt-1">El tipo no se puede cambiar después de crear.</p>}
          </div>

          {/* Severidad */}
          <div>
            <label className="label">Severidad / color</label>
            <select className="select" {...register('severity')}>
              <option value="info">Informativo (azul)</option>
              <option value="success">Éxito (verde)</option>
              <option value="warning">Aviso (ámbar)</option>
              <option value="critical">Crítico (rojo)</option>
            </select>
          </div>

          <div>
            <label className="label">Título *</label>
            <input className={`input ${errors.title ? 'input-error' : ''}`}
              maxLength={200}
              {...register('title', { required: true })} />
          </div>

          <div>
            <label className="label">Mensaje *</label>
            <textarea className="input h-24 resize-y" {...register('message', { required: true })} />
            <p className="text-[11px] text-ink-muted mt-1">
              Texto plano. Los saltos de línea se respetan.
            </p>
          </div>

          {/* Ventana de visibilidad */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Banner visible desde *</label>
              <input type="datetime-local" className="input" {...register('starts_at', { required: true })} />
            </div>
            <div>
              <label className="label">Banner visible hasta *</label>
              <input type="datetime-local" className="input" {...register('ends_at', { required: true })} />
            </div>
          </div>

          {/* Campos específicos de mantenimiento */}
          {kind === 'maintenance' && (
            <div className="p-3 bg-status-info/5 border border-status-info/30 rounded-lg space-y-3">
              <p className="text-xs text-status-info font-medium">
                🛠 Datos del mantenimiento
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Cuándo se ejecuta *</label>
                  <input type="datetime-local" className="input"
                    {...register('maintenance_at', { required: kind === 'maintenance' })} />
                </div>
                <div>
                  <label className="label">Duración estimada (minutos) *</label>
                  <input type="number" min="1" className="input"
                    {...register('duration_minutes', { required: kind === 'maintenance' })} />
                </div>
              </div>
            </div>
          )}

          {/* Email */}
          <div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" className="mt-1" {...register('notify_email')} />
              <div>
                <p className="text-sm text-ink-secondary">Enviar correo a todos los tenants</p>
                <p className="text-xs text-ink-muted">
                  Al activar la ventana se envía un email a cada tenant.
                  {kind === 'maintenance' && ' Para mantenimientos, además se manda un recordatorio 24 h antes.'}
                </p>
              </div>
            </label>
          </div>

          {serverError && (
            <div className="p-3 bg-status-danger/10 border border-status-danger/40 rounded-lg text-sm text-status-danger">
              {serverError}
            </div>
          )}
        </form>

        <div className="flex items-center justify-between gap-2 px-6 py-3 border-t border-line-subtle shrink-0">
          <div>
            {isEdit && !isCancelled && (
              <button type="button"
                className="btn-ghost btn-sm text-status-danger hover:bg-status-danger/10"
                onClick={() => {
                  const reason = prompt('Motivo de cancelación (opcional):')
                  if (reason !== null) cancelMutation.mutate(reason || null)
                }}
                disabled={isBusy}>
                Cancelar mensaje
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isBusy}>
              Cerrar
            </button>
            {!isCancelled && (
              <button type="button" className="btn-primary"
                onClick={handleSubmit(onSubmit)}
                disabled={isBusy || (isEdit && !isDirty)}>
                {isBusy ? 'Guardando…' : (isEdit ? 'Guardar cambios' : 'Crear mensaje')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}
