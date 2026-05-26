import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '@/api/admin'
import Spinner from '@/components/ui/Spinner'

const QUEUES = [
  { value: 'emails',    label: 'Correos' },
  { value: 'invoicing', label: 'Timbrado' },
]

const STATUSES = [
  { value: 'failed',    label: 'Fallidos' },
  { value: 'waiting',   label: 'En espera' },
  { value: 'active',    label: 'En curso' },
  { value: 'completed', label: 'Completados' },
]

export default function TareasFallidas() {
  const qc = useQueryClient()
  const [queue, setQueue]   = useState('emails')
  const [status, setStatus] = useState('failed')
  const [msg, setMsg]       = useState(null)
  const [error, setError]   = useState(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-jobs', queue, status],
    queryFn:  () => adminApi.listJobs(queue, status, 100),
    refetchInterval: 10_000,
  })

  const retry = useMutation({
    mutationFn: (jobId) => adminApi.retryJob(queue, jobId),
    onSuccess:  () => { setMsg('Tarea reencolada para nuevo intento.'); setError(null); qc.invalidateQueries({ queryKey: ['admin-jobs'] }) },
    onError:    (e) => { setError(e.response?.data?.error || e.message); setMsg(null) },
  })

  const remove = useMutation({
    mutationFn: (jobId) => adminApi.removeJob(queue, jobId),
    onSuccess:  () => { setMsg('Tarea eliminada.'); setError(null); qc.invalidateQueries({ queryKey: ['admin-jobs'] }) },
    onError:    (e) => { setError(e.response?.data?.error || e.message); setMsg(null) },
  })

  const jobs = data?.jobs || []

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Configuración · Tareas en segundo plano</h1>
        <p className="text-sm text-ink-muted mt-1">
          Aquí ves correos y timbrados que están en espera o que fallaron. Puedes reintentar o descartar
          tareas que ya no apliquen.
        </p>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col text-sm">
          <span className="text-ink-secondary mb-1">Tipo de tarea</span>
          <select className="select" value={queue} onChange={e => setQueue(e.target.value)}>
            {QUEUES.map(q => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          <span className="text-ink-secondary mb-1">Estado</span>
          <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <button className="btn-secondary" onClick={() => refetch()}>Recargar</button>
      </div>

      {msg   && <div className="alert-success text-sm">{msg}</div>}
      {error && <div className="alert-error text-sm">{error}</div>}

      <section className="card p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : jobs.length === 0 ? (
          <div className="py-10 text-center text-sm text-ink-muted">
            {status === 'failed'
              ? 'No hay tareas fallidas. Todo se procesó bien.'
              : `No hay tareas ${STATUSES.find(s => s.value === status)?.label.toLowerCase()}.`}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated/40 text-left text-xs font-medium uppercase text-ink-secondary">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Datos</th>
                <th className="px-3 py-2">Intentos</th>
                <th className="px-3 py-2">Error</th>
                <th className="px-3 py-2">Cuándo</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {jobs.map(j => (
                <tr key={j.id} className="align-top">
                  <td className="px-3 py-2 font-mono text-xs text-ink-muted">{j.id}</td>
                  <td className="px-3 py-2">
                    <DataSummary queue={queue} data={j.data} />
                  </td>
                  <td className="px-3 py-2 text-xs">{j.attemptsMade}</td>
                  <td className="px-3 py-2 text-xs text-status-danger max-w-xs">
                    {j.failedReason || <span className="text-ink-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">
                    {j.finishedOn ? new Date(j.finishedOn).toLocaleString('es-MX') : '—'}
                  </td>
                  <td className="px-3 py-2 flex gap-2">
                    {status === 'failed' && (
                      <button
                        className="btn-secondary text-xs"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(j.id)}>
                        Reintentar
                      </button>
                    )}
                    <button
                      className="btn-danger text-xs"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirm('¿Eliminar esta tarea de la cola?')) remove.mutate(j.id)
                      }}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function DataSummary({ queue, data }) {
  if (!data) return <span className="text-ink-muted">—</span>
  if (queue === 'emails') {
    const to = Array.isArray(data.to) ? data.to.join(', ') : data.to
    return (
      <div className="flex flex-col">
        <span className="text-xs text-ink-muted">Para:</span>
        <span className="font-medium">{to || '—'}</span>
        <span className="text-xs text-ink-secondary mt-1">{data.subject}</span>
        {data.hasAttachments && (
          <span className="text-xs text-status-info mt-1">(con adjunto)</span>
        )}
      </div>
    )
  }
  if (queue === 'invoicing') {
    return (
      <div className="flex flex-col">
        <span className="text-xs text-ink-muted">Factura:</span>
        <span className="font-mono text-xs">{data.invoiceId}</span>
      </div>
    )
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>
}
