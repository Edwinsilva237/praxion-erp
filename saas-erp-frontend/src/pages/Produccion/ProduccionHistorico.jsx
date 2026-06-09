import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { productionApi } from '@/api/production'
import { processConfigApi } from '@/api/processConfig'
import Spinner from '@/components/ui/Spinner'
import { parseDateOnly } from '@/utils/fmt'
import clsx from 'clsx'

const STATUS_LABEL = {
  active:'Activo', pending_handover:'Pendiente validación',
  reviewed:'Validado', cancelled:'Cancelado',
}
const STATUS_STYLE = {
  active:           { bg:'#EAF3DE', color:'#27500A' },
  pending_handover: { bg:'#FAEEDA', color:'#633806' },
  reviewed:         { bg:'#E6F1FB', color:'#0C447C' },
  cancelled:        { bg:'#FCEBEB', color:'#A32D2D' },
}

const fmt  = (n, d=2) => Number(n||0).toLocaleString('es-MX', { minimumFractionDigits:d, maximumFractionDigits:d })
const fmtN = (n)      => Math.round(n||0).toLocaleString('es-MX')

export default function ProduccionHistorico() {
  const navigate  = useNavigate()
  const [page, setPage]           = useState(1)
  const [filterStatus, setStatus] = useState('')
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo,   setDateTo]     = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['shifts-history', { page, filterStatus, dateFrom, dateTo }],
    queryFn: () => productionApi.getShiftsHistory({
      status:   filterStatus || undefined,
      dateFrom: dateFrom     || undefined,
      dateTo:   dateTo       || undefined,
      page, limit: 20,
    }),
    keepPreviousData: true,
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn: processConfigApi.getConfig,
    staleTime: 300000,
  })
  const isMicro       = tenantConfig?.operation_mode === 'micro'
  const usesSupervisor = tenantConfig?.uses_supervisor ?? true

  const shifts     = data?.data  || []
  const total      = data?.total || 0
  const totalPages = Math.ceil(total / 20)

  return (
    <div className="page-enter">
      <div className="page-header">
        <div>
          <h1 className="page-title">Histórico de turnos</h1>
          <p className="page-subtitle">{total} turno{total !== 1 ? 's' : ''} registrado{total !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select value={filterStatus} onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          className="select w-48">
          <option value="">Todos los estados</option>
          <option value="reviewed">Validados</option>
          <option value="pending_handover">Pendientes</option>
          <option value="active">Activos</option>
        </select>
        <div className="flex items-center gap-2">
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1) }}
            className="input w-40" />
          <span className="text-ink-muted text-sm">—</span>
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1) }}
            className="input w-40" />
        </div>
        {(filterStatus || dateFrom || dateTo) && (
          <button onClick={() => { setStatus(''); setDateFrom(''); setDateTo(''); setPage(1) }}
            className="btn-secondary btn-sm">
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Lista */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : shifts.length === 0 ? (
        <div className="empty-state">
          <p className="font-medium text-ink-secondary">Sin turnos</p>
          <p>No hay turnos registrados con los filtros aplicados.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {shifts.map((s) => {
            const st      = STATUS_STYLE[s.status] || { bg:'#F1EFE8', color:'#5F5E5A' }
            const meters  = parseFloat(s.total_meters || 0)
            const costM   = s.cost_per_unit && meters > 0
              ? parseFloat(s.cost_per_unit) * (meters / Math.max(1, parseInt(s.pt_units_produced)))
              : null
            const date    = parseDateOnly(s.shift_date)
              ? parseDateOnly(s.shift_date).toLocaleDateString('es-MX', { weekday:'short', day:'numeric', month:'short', year:'numeric' })
              : '—'

            return (
              <div key={s.id}
                onClick={() => navigate(`/produccion/turno/${s.id}/resumen`)}
                className="bg-surface-primary border border-line-subtle rounded-xl p-4 cursor-pointer hover:border-brand-500/40 transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span style={{ fontSize:11, fontWeight:500, padding:'2px 8px', borderRadius:20, background:st.bg, color:st.color }}>
                        {STATUS_LABEL[s.status] || s.status}
                      </span>
                      <span className="text-xs text-ink-muted">
                        Turno {s.shift_number} · L{s.line_id}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-ink-primary">{date}</p>
                    <p className="text-xs text-ink-muted mt-0.5">
                      Op: {s.operator_name}
                      {usesSupervisor && s.supervisor_name && <> · Sup: {s.supervisor_name}</>}
                    </p>
                  </div>

                  <div className="text-right shrink-0 space-y-1">
                    <p className="text-sm font-medium text-ink-primary">
                      {fmtN(s.pt_units_produced)} pzas
                    </p>
                    {meters > 0 && (
                      <p className="text-xs text-ink-muted">{fmt(meters,1)} m</p>
                    )}
                    {!isMicro && s.cost_per_unit > 0 && (
                      <p className="text-xs font-medium text-brand-300">
                        ${fmt(s.cost_per_unit,4)}/pza
                      </p>
                    )}
                  </div>
                </div>

                {/* Barra de info adicional */}
                <div className="flex gap-4 mt-2.5 pt-2.5 border-t border-line-subtle">
                  <span className="text-xs text-ink-muted">
                    MP: {fmt(s.mp_real_kg,1)} kg
                  </span>
                  <span className="text-xs text-ink-muted">
                    {s.orders_count} orden{s.orders_count !== 1 ? 'es' : ''}
                  </span>
                  <span className="text-xs text-brand-300 ml-auto font-medium">
                    Ver resumen →
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Paginación */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-line-subtle">
          <span className="text-xs text-ink-muted">
            Página {page} de {totalPages} · {total} turnos
          </span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1,p-1))}
              disabled={page === 1} className="btn-secondary btn-sm">Anterior</button>
            <button onClick={() => setPage(p => Math.min(totalPages,p+1))}
              disabled={page === totalPages} className="btn-secondary btn-sm">Siguiente</button>
          </div>
        </div>
      )}
    </div>
  )
}
