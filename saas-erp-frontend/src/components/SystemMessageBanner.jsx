import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { systemMessagesApi } from '@/api/systemMessages'
import clsx from 'clsx'

// localStorage key para los IDs de mensajes que el usuario cerró. Se reinicia
// si el mensaje cambia (porque updated_at es parte del hash).
const STORAGE_KEY = 'erp_dismissed_system_messages'

const SEVERITY_STYLES = {
  info: {
    bg: 'bg-status-info/10',
    border: 'border-status-info/40',
    text: 'text-status-info',
    icon: 'ℹ',
  },
  success: {
    bg: 'bg-status-success/10',
    border: 'border-status-success/40',
    text: 'text-status-success',
    icon: '✓',
  },
  warning: {
    bg: 'bg-status-warning/10',
    border: 'border-status-warning/40',
    text: 'text-status-warning',
    icon: '⚠',
  },
  critical: {
    bg: 'bg-status-danger/10',
    border: 'border-status-danger/40',
    text: 'text-status-danger',
    icon: '⚠',
  },
}

function loadDismissed() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch { return {} }
}

function saveDismissed(map) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

function fmtDateTime(date) {
  if (!date) return ''
  return new Date(date).toLocaleString('es-MX', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(minutes) {
  if (!minutes) return ''
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${m} min`
}

export default function SystemMessageBanner() {
  const [dismissed, setDismissed] = useState(loadDismissed)

  // Polling cada 5 min — los mensajes son cross-tenant y cambian poco.
  const { data: messages = [] } = useQuery({
    queryKey: ['system-messages', 'active'],
    queryFn:  systemMessagesApi.active,
    refetchInterval: 5 * 60 * 1000,
    staleTime:       60 * 1000,
  })

  // Filtramos los que el usuario cerró (usando id + updated_at como hash —
  // si el admin edita el mensaje, vuelve a aparecer).
  const visible = messages.filter((m) => {
    const dismissedAt = dismissed[m.id]
    return !dismissedAt || dismissedAt !== m.updated_at
  })

  // Si cambian los mensajes y alguno cerrado ya no está vigente, limpiamos.
  useEffect(() => {
    if (!messages.length) return
    const activeIds = new Set(messages.map((m) => m.id))
    const cleaned = Object.fromEntries(
      Object.entries(dismissed).filter(([id]) => activeIds.has(id))
    )
    if (Object.keys(cleaned).length !== Object.keys(dismissed).length) {
      setDismissed(cleaned)
      saveDismissed(cleaned)
    }
  }, [messages]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleDismiss = (m) => {
    const next = { ...dismissed, [m.id]: m.updated_at }
    setDismissed(next)
    saveDismissed(next)
  }

  if (!visible.length) return null

  return (
    <div className="flex flex-col">
      {visible.map((m) => {
        const s = SEVERITY_STYLES[m.severity] || SEVERITY_STYLES.info
        const isMaint = m.kind === 'maintenance'
        return (
          <div
            key={m.id}
            className={clsx('border-b px-4 py-2.5 flex items-start gap-3', s.bg, s.border)}
          >
            <span className={clsx('text-base shrink-0 leading-snug', s.text)}>{s.icon}</span>
            <div className="flex-1 min-w-0">
              <p className={clsx('text-sm font-medium', s.text)}>{m.title}</p>
              {m.message && (
                <p className="text-xs text-ink-secondary mt-0.5 whitespace-pre-wrap">
                  {m.message}
                </p>
              )}
              {isMaint && (
                <p className="text-xs text-ink-muted mt-1">
                  <strong>Cuándo:</strong> {fmtDateTime(m.maintenance_at)}
                  {' · '}
                  <strong>Duración:</strong> {fmtDuration(m.duration_minutes)}
                </p>
              )}
            </div>
            <button
              onClick={() => handleDismiss(m)}
              className={clsx(
                'shrink-0 p-1 rounded hover:bg-surface-elevated/60 transition-colors',
                s.text
              )}
              title="Ocultar este mensaje"
              aria-label="Cerrar"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
