import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { productionApi } from '@/api/production'
import { processConfigApi } from '@/api/processConfig'
import api from '@/api/axios'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'
import { downloadBlob, printBlob } from '@/utils/downloadBlob'
import clsx from 'clsx'

const fmt  = (n, d=2) => Number(n||0).toLocaleString('es-MX', { minimumFractionDigits:d, maximumFractionDigits:d })
const fmtN = (n)      => Math.round(n||0).toLocaleString('es-MX')

const STATUS_LABEL = {
  active: 'Activo', pending_handover: 'Pendiente', reviewed: 'Validado', cancelled: 'Cancelado'
}
const STATUS_COLOR = {
  active: '#27500A', pending_handover: '#633806', reviewed: '#0C447C', cancelled: '#A32D2D'
}
const STATUS_BG = {
  active: '#EAF3DE', pending_handover: '#FAEEDA', reviewed: '#E6F1FB', cancelled: '#FCEBEB'
}

const INCIDENT_LABEL = {
  paro_maquina:'Paro de máquina', problema_mp:'Problema de MP',
  cambio_orden:'Cambio de orden', calidad:'Calidad', otro:'Otro',
}

function MetricCard({ label, value, unit, highlight }) {
  return (
    <div style={{
      background: highlight ? '#E6F1FB' : 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-md)',
      padding: '12px 14px',
    }}>
      <p style={{ fontSize:12, color: highlight ? '#185FA5' : 'var(--color-text-secondary)', marginBottom:4 }}>{label}</p>
      <p style={{ fontSize:20, fontWeight:500, color: highlight ? '#0C447C' : 'var(--color-text-primary)' }}>
        {value}
        {unit && <span style={{ fontSize:11, color: highlight ? '#378ADD' : 'var(--color-text-secondary)', marginLeft:3 }}>{unit}</span>}
      </p>
    </div>
  )
}

function ReceptionSectionContent({ reception, forceClose }) {
  const [expanded, setExpanded] = useState(false)
  const issueText = reception?.issueDescription || ''
  const isLong = issueText.length > 200
  const displayText = expanded || !isLong ? issueText : issueText.slice(0, 200) + '…'

  return (
    <div>
      {forceClose && (
        <div style={{
          background: '#FCEBEB',
          border: '0.5px solid #F5C4C4',
          borderRadius: 'var(--border-radius-md)',
          padding: '10px 12px',
          marginBottom: reception && reception.accepted === false ? 10 : 0,
        }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: '#A32D2D', marginBottom: 4 }}>
            ⚡ Cierre forzado por supervisor
          </p>
          <p style={{ fontSize: 12, color: '#7A2222', marginBottom: 4 }}>
            <span style={{ fontWeight: 500 }}>{forceClose.byName || 'Supervisor'}</span>
            {' · '}
            {new Date(forceClose.at).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
          {forceClose.reason && (
            <p style={{ fontSize: 12, color: '#7A2222', fontStyle: 'italic' }}>
              Motivo: {forceClose.reason}
            </p>
          )}
        </div>
      )}

      {reception && reception.accepted === false && reception.issueDescription && (
        <div style={{
          background: '#FAEEDA',
          border: '0.5px solid #E8D49B',
          borderRadius: 'var(--border-radius-md)',
          padding: '10px 12px',
        }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: '#633806', marginBottom: 4 }}>
            ⚠ Observaciones del entrante al recibir
          </p>
          <p style={{ fontSize: 12, color: '#7A4A0F', marginBottom: 6 }}>
            <span style={{ fontWeight: 500 }}>{reception.receivedByName || 'Operador'}</span>
            {' · '}
            {new Date(reception.receivedAt).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
          <div style={{
            background: 'var(--color-background-primary)',
            border: '0.5px solid #F2E0B8',
            borderRadius: 'var(--border-radius-sm)',
            padding: '8px 10px',
            fontSize: 12,
            color: '#5B3608',
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
          }}>
            “{displayText}”
          </div>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              style={{
                marginTop: 6,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: '#7A4A0F',
                padding: 0,
              }}
            >
              {expanded ? 'Ver menos' : 'Ver completo'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{
      background: 'var(--color-background-primary)',
      border: '0.5px solid var(--color-border-tertiary)',
      borderRadius: 'var(--border-radius-lg)',
      overflow: 'hidden',
      marginBottom: 12,
    }}>
      <div style={{
        padding: '10px 16px',
        background: 'var(--color-background-secondary)',
        borderBottom: '0.5px solid var(--color-border-tertiary)',
        fontSize: 12, fontWeight: 500, color: 'var(--color-text-secondary)',
      }}>
        {title}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  )
}

function Row({ label, value, valueColor, bold }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', fontSize:13 }}>
      <span style={{ color: bold ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: bold ? 500 : 400 }}>{label}</span>
      <span style={{ fontWeight: bold ? 500 : 400, color: valueColor || 'var(--color-text-primary)' }}>{value}</span>
    </div>
  )
}

function Divider() {
  return <div style={{ height:'0.5px', background:'var(--color-border-tertiary)', margin:'8px 0' }} />
}

export default function ProduccionResumen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const can = useAuthStore(s => s.can)
  const [showRevert, setShowRevert] = useState(false)
  const [genPdf, setGenPdf] = useState(false)

  async function handlePdf(print) {
    setGenPdf(true)
    try {
      const blob = await productionApi.downloadShiftSummaryPdf(id)
      const name = `Turno-${summary?.shift?.shiftNumber ?? id}`
      if (print) await printBlob(blob, name)
      else await downloadBlob(blob, `${name}.pdf`)
    } catch (e) {
      alert('No se pudo generar el PDF: ' + (e.response?.data?.error || e.message))
    } finally {
      setGenPdf(false)
    }
  }

  const { data: summary, isLoading, error } = useQuery({
    queryKey: ['shift-summary', id],
    queryFn: () => productionApi.getShiftSummary(id),
    enabled: !!id,
  })

  const { data: tenantConfig } = useQuery({
    queryKey: ['tenant-process-config'],
    queryFn: processConfigApi.getConfig,
    staleTime: 300000,
  })
  const { data: qualityGradesRaw } = useQuery({
    queryKey: ['quality-grades-active'],
    queryFn: () => processConfigApi.listQualityGrades({ isActive: true }),
    staleTime: 60000,
  })
  const qualityGrades = Array.isArray(qualityGradesRaw) ? qualityGradesRaw : (qualityGradesRaw?.data || [])
  const operationMode = tenantConfig?.operation_mode || 'industrial'
  const isMicro       = operationMode === 'micro'
  const hasMultiGrade = qualityGrades.length > 2

  // Etiqueta para "calidades inferiores" según los grades configurados
  const lowerQualityLabel = hasMultiGrade
    ? 'Calidades menores'
    : (qualityGrades.find(g => parseInt(g.grade_number) === 2)?.name || '2da calidad')

  if (isLoading) return (
    <div className="page-enter flex items-center justify-center min-h-64"><Spinner /></div>
  )

  if (error || !summary) return (
    <div className="page-enter">
      <div className="empty-state">
        <p className="font-medium text-ink-secondary">Resumen no disponible</p>
        <p>No se encontró información para este turno.</p>
        <button onClick={() => navigate(-1)} className="btn-secondary mt-4">Regresar</button>
      </div>
    </div>
  )

  const { shift, production, materials, costs, incidents, formulaChanges = [], corrections = [], reception, forceClose } = summary
  const durationStr = shift.durationMin
    ? `${Math.floor(shift.durationMin/60)}h ${shift.durationMin%60}min`
    : '—'

  // ¿Este turno produjo metros lineales? (no aplica a frituras, pellet, etc.)
  const hasMeters = (production.totalMeters || 0) > 0

  const shiftDate = shift.shiftDate
    ? new Date(shift.shiftDate).toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
    : '—'

  return (
    <div className="page-enter max-w-2xl mx-auto">
      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <button onClick={() => navigate(-1)}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--color-text-secondary)', fontSize:20, lineHeight:1, padding:'0 4px 0 0' }}>
              ←
            </button>
            <p style={{ fontSize:16, fontWeight:500, color:'var(--color-text-primary)', margin:0 }}>
              Resumen de turno
            </p>
          </div>
          <p style={{ fontSize:12, color:'var(--color-text-secondary)', marginBottom:2 }}>
            Turno {shift.shiftNumber} · {shiftDate} · Línea {shift.lineId}
          </p>
          <p style={{ fontSize:12, color:'var(--color-text-secondary)' }}>
            Operador: {shift.operatorName} · Duración: {durationStr}
          </p>
        </div>
        <span style={{
          flexShrink:0, whiteSpace:'nowrap',
          fontSize:11, fontWeight:500, padding:'3px 10px', borderRadius:20,
          background: STATUS_BG[shift.status] || '#F1EFE8',
          color: STATUS_COLOR[shift.status] || '#5F5E5A',
        }}>
          {STATUS_LABEL[shift.status] || shift.status}
        </span>
      </div>

      {/* Barra de acciones en su propia fila — evita que se amontonen en móvil */}
      <div className="flex flex-wrap gap-2 mb-5">
        <button onClick={() => handlePdf(false)} disabled={genPdf} className="btn-secondary btn-sm">
          {genPdf ? '…' : 'PDF'}
        </button>
        <button onClick={() => handlePdf(true)} disabled={genPdf} className="btn-secondary btn-sm">
          Imprimir
        </button>
        {shift.status === 'reviewed' && can('production', 'revert_validation') && (
          <button onClick={() => setShowRevert(true)} className="btn-secondary btn-sm">
            ⚠ Revertir validación
          </button>
        )}
      </div>

      {showRevert && (
        <RevertValidationModal shiftId={id} onClose={() => setShowRevert(false)} />
      )}

      {/* Métricas principales — adaptadas al tipo de proceso */}
      <div style={{ display:'grid', gridTemplateColumns: hasMeters ? 'repeat(4,minmax(0,1fr))' : 'repeat(3,minmax(0,1fr))', gap:10, marginBottom:16 }}>
        <MetricCard label="Piezas buenas"    value={fmtN(production.goodUnits)}   unit="pzas" />
        {hasMeters && (
          <MetricCard label="Metros producidos" value={fmt(production.totalMeters,1)} unit="m" highlight />
        )}
        <MetricCard label={lowerQualityLabel} value={fmtN(production.secondUnits)} unit="pzas" />
        <MetricCard label="MP cargada"        value={fmt(materials.totalMpKg,1)}   unit="kg" />
      </div>

      {/* Tarjeta destacada de costo — varía según haya metros (plástico) o no (frituras, pellet, etc.) */}
      {!isMicro && (
        <div style={{
          background:'#E6F1FB', border:'0.5px solid #B5D4F4',
          borderRadius:'var(--border-radius-lg)', padding:16,
          display:'flex', justifyContent:'space-between', alignItems:'center',
          marginBottom:12,
        }}>
          <div>
            <p style={{ fontSize:13, color:'#185FA5', fontWeight:500 }}>
              {hasMeters ? 'Costo por metro lineal' : 'Costo por pieza'}
            </p>
            <p style={{ fontSize:11, color:'#378ADD', marginTop:2 }}>Incluye MP + gastos indirectos + empaque</p>
          </div>
          <div style={{ textAlign:'right' }}>
            <p style={{ fontSize:26, fontWeight:500, color:'#0C447C' }}>
              ${fmt(hasMeters ? costs.costPerMeter : costs.costPerUnit, 4)}
              <span style={{ fontSize:14, fontWeight:400, color:'#378ADD' }}>{hasMeters ? ' /m' : ' /pza'}</span>
            </p>
            {hasMeters && (
              <p style={{ fontSize:11, color:'#378ADD', marginTop:2 }}>
                ${fmt(costs.costPerUnit, 4)} / pieza
              </p>
            )}
          </div>
        </div>
      )}

      {/* Producción por orden */}
      {production.orderSummary.length > 0 && (
        <Section title={`Producción por orden (${production.orderSummary.length})`}>
          {production.orderSummary.map((o, i) => (
            <div key={o.orderId} style={{
              display:'flex', alignItems:'center', gap:10, padding:'8px 0',
              borderBottom: i < production.orderSummary.length-1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
            }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:'#1D9E75', flexShrink:0 }} />
              <div style={{ flex:1 }}>
                <p style={{ fontSize:13, fontWeight:500, color:'var(--color-text-primary)', margin:0 }}>{o.productName || o.orderNumber}</p>
                <p style={{ fontSize:11, color:'var(--color-text-secondary)', margin:'2px 0 0' }}>{o.orderNumber}</p>
              </div>
              <div style={{ textAlign:'right' }}>
                <p style={{ fontSize:13, color:'var(--color-text-primary)', margin:0 }}>
                  {fmtN(o.units)} pzas{o.meters > 0 ? ` · ${fmt(o.meters,1)}m` : ''}
                </p>
                {!isMicro && (
                  <p style={{ fontSize:11, color:'#27500A', fontWeight:500, margin:'2px 0 0' }}>
                    ${fmt(o.meters > 0 ? o.costPerMeter : o.costPerUnit, 4)}/{o.meters > 0 ? 'm' : 'pza'}
                  </p>
                )}
              </div>
            </div>
          ))}
          {production.orderSummary.length === 0 && (
            <p style={{ fontSize:13, color:'var(--color-text-secondary)' }}>
              Sin órdenes asociadas — los paquetes no tienen orden asignada.
            </p>
          )}
        </Section>
      )}

      {/* Balance de MP */}
      <Section title="Balance de materia prima">
        <Row label="MP cargada total"     value={`${fmt(materials.totalMpKg,3)} kg`} />
        <Row label="Peso en piezas buenas" value={`${fmt(materials.goodKg,3)} kg`}   valueColor="#27500A" />
        <Row label={`Peso ${lowerQualityLabel.toLowerCase()}`} value={`${fmt(materials.secondKg,3)} kg`} valueColor="#633806" />
        <Divider />
        <Row label="Merma reportada"
          value={`${fmt(materials.scrapReportedKg,3)} kg (${fmt(materials.scrapPctReported,2)}%)`}
          valueColor={materials.scrapPctReported > 5 ? '#A32D2D' : '#5F5E5A'}
          bold
        />
        {(materials.scrapOperatorCount > 0 || materials.scrapSupervisorCount > 0) && (
          <div style={{ marginLeft:14, marginTop:4, marginBottom:4 }}>
            {materials.scrapOperatorCount > 0 && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'3px 0', fontSize:12, color:'var(--color-text-secondary)' }}>
                <span>├ Operador <span style={{ color:'#A8A6A0' }}>({materials.scrapOperatorCount} reg.)</span></span>
                <span>{fmt(materials.scrapByOperatorKg,3)} kg</span>
              </div>
            )}
            {materials.scrapSupervisorCount > 0 && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'3px 0', fontSize:12, color:'var(--color-text-secondary)' }}>
                <span>
                  └ Supervisor{' '}
                  <span style={{
                    display:'inline-block', fontSize:10, fontWeight:500,
                    padding:'1px 6px', borderRadius:10, marginLeft:4,
                    background:'#E6F1FB', color:'#0C447C',
                  }}>
                    agregada
                  </span>{' '}
                  <span style={{ color:'#A8A6A0' }}>({materials.scrapSupervisorCount} reg.)</span>
                </span>
                <span>{fmt(materials.scrapBySupervisorKg,3)} kg</span>
              </div>
            )}
          </div>
        )}
        {/* Diferencia de balance: solo se muestra cuando hay MP cargada registrada */}
        {materials.totalMpKg > 0 && (() => {
          const diff    = materials.scrapBalanceDiff
          const absDiff = Math.abs(diff)
          const absPct  = Math.abs(materials.scrapBalanceDiffPct)
          let level
          if (absPct <= 2) level = 'ok'
          else if (absPct <= 5) level = 'warn'
          else level = 'alert'
          const colors = {
            ok:    { text:'#5F5E5A', label:'#A8A6A0', note:'Balance correcto' },
            warn:  { text:'#633806', label:'#946720', note:'Revisar pesajes' },
            alert: { text:'#A32D2D', label:'#C44D4D', note:'Diferencia significativa, verificar capturas' },
          }
          const c = colors[level]
          const signo = diff > 0 ? 'Faltan' : (diff < 0 ? 'Sobran' : 'Cuadran')
          return (
            <>
              <Divider />
              <Row label="Diferencia de balance"
                value={`${diff > 0 ? '+' : ''}${fmt(diff,3)} kg (${fmt(materials.scrapBalanceDiffPct,2)}%)`}
                valueColor={c.text}
              />
              <p style={{ fontSize:11, color:c.label, marginTop:-2, marginBottom:2 }}>
                MP − producido − merma reportada
                {absDiff > 0.001 && <> · {signo} {fmt(absDiff,3)} kg</>}
                {level !== 'ok' && <> · {c.note}</>}
              </p>
            </>
          )
        })()}
        {production.outOfRangePackages > 0 && (
          <Row label="Paquetes fuera de rango" value={`${production.outOfRangePackages} paq`} valueColor="#A32D2D" />
        )}
      </Section>

      {/* Desglose de costos */}
      <Section title="Desglose de costos del turno">
        {/* Materia prima (peso producido) */}
        {costs.avgCostPerKg > 0 && (
          <>
            <Row
              label={`Materia prima (${fmt(costs.ptKg ?? costs.estimatedMpKg,2)} kg × $${fmt(costs.avgCostPerKg,4)}/kg)`}
              value={`$${fmt(costs.mpCostPT ?? costs.estimatedMpCost,2)}`}
            />
            <p style={{ fontSize:11, color:'var(--color-text-secondary)', marginTop:-2, marginBottom:4 }}>
              Base: {fmt(materials.goodKg + materials.secondKg, 2)} kg producidos (peso de piezas buenas + calidades menores)
            </p>
          </>
        )}
        {/* Merma cargada al producto (normal no recuperable) */}
        {costs.mpCostScrap > 0 && (
          <Row
            label="Merma cargada al producto"
            value={`$${fmt(costs.mpCostScrap,2)}`}
          />
        )}
        {/* Merma a pérdida del período (informativo — NO entra al costo por pieza) */}
        {costs.mpCostScrapLoss > 0 && (
          <Row
            label="Merma a pérdida del período (no carga al producto)"
            value={`$${fmt(costs.mpCostScrapLoss,2)}`}
            valueColor="var(--color-text-secondary)"
          />
        )}
        {/* Costos fijos legacy (turnos antiguos) */}
        {costs.items.map((item) => (
          <Row key={item.id || item.name}
            label={item.name}
            value={`$${fmt(item.amount,2)}`}
          />
        ))}
        {/* Gastos indirectos (overhead) del módulo de Costeo */}
        {(costs.overheadItems || []).map((item) => (
          <Row key={item.id || item.name}
            label={`${item.name} (gasto indirecto)`}
            value={`$${fmt(item.amount,2)}`}
          />
        ))}
        {/* Empaque desde receta */}
        {costs.packagingCost > 0 && (
          <Row label="Empaque (receta)" value={`$${fmt(costs.packagingCost,2)}`} />
        )}
        {costs.items.length === 0 && (costs.overheadItems || []).length === 0 && costs.avgCostPerKg === 0 && (
          <p style={{ fontSize:13, color:'var(--color-text-secondary)' }}>Sin costos registrados para este turno.</p>
        )}
        <Divider />
        <Row label="Costo total del turno" value={`$${fmt(costs.totalCost,2)}`}    bold valueColor="#0C447C" />
        <Row label="Costo por pieza"        value={`$${fmt(costs.costPerUnit,4)}`}  valueColor="#0C447C" bold={!hasMeters} />
        {hasMeters && (
          <Row label="Costo por metro lineal" value={`$${fmt(costs.costPerMeter,4)}`} valueColor="#0C447C" bold />
        )}

        {/* Costo prorrateado por medida (mig 195) — solo si el turno fabricó varias.
            MP por peso, overhead por piezas, empaque por receta. El "costo por pieza"
            de arriba es el promedio del turno; aquí cada medida lleva el suyo real. */}
        {(costs.productCosts || []).filter(p => p.units > 0).length > 1 && (
          <>
            <Divider />
            <p style={{ fontSize:12, fontWeight:600, color:'var(--color-text-primary)', margin:'2px 0 6px' }}>
              Costo por medida (prorrateado)
            </p>
            {(costs.productCosts || []).filter(p => p.units > 0).map((p) => (
              <Row
                key={p.productId}
                label={`${p.productName}${p.sku ? ` · ${p.sku}` : ''} — ${fmt(p.units,0)} pza, ${fmt(p.totalKg,1)} kg`}
                value={`$${fmt(p.costPerUnit,4)}/pza`}
                valueColor="#0C447C"
              />
            ))}
          </>
        )}
      </Section>

      {/* Incidencias */}
      {incidents.length > 0 && (
        <Section title={`Incidencias (${incidents.length})`}>
          {incidents.map((inc, i) => (
            <div key={inc.id} style={{
              paddingBottom: i < incidents.length-1 ? 10 : 0,
              marginBottom:  i < incidents.length-1 ? 10 : 0,
              borderBottom:  i < incidents.length-1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
            }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontSize:13, fontWeight:500, color:'var(--color-text-primary)' }}>
                  {INCIDENT_LABEL[inc.category] || inc.category}
                </span>
                {inc.duration_min && (
                  <span style={{ fontSize:12, color:'#633806' }}>{inc.duration_min} min</span>
                )}
              </div>
              <p style={{ fontSize:12, color:'var(--color-text-secondary)', marginTop:4 }}>{inc.description}</p>
            </div>
          ))}
        </Section>
      )}

      {/* Recepción del turno (observaciones del entrante o cierre forzado) */}
      {(forceClose || (reception && reception.accepted === false && reception.issueDescription)) && (
        <Section title="Recepción del turno">
          <ReceptionSectionContent reception={reception} forceClose={forceClose} />
        </Section>
      )}

      {/* Cambios de fórmula MP durante el turno */}
      {formulaChanges.length > 0 && (
        <Section title={`Cambios de fórmula (${formulaChanges.length})`}>
          {formulaChanges.map((fc, i) => (
            <div key={fc.id} style={{
              paddingBottom: i < formulaChanges.length-1 ? 12 : 0,
              marginBottom:  i < formulaChanges.length-1 ? 12 : 0,
              borderBottom:  i < formulaChanges.length-1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
            }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 6 }}>
                <span style={{ fontSize:13, fontWeight:500, color:'var(--color-text-primary)' }}>
                  {fc.changedByName}
                </span>
                <span style={{ fontSize:11, color:'var(--color-text-secondary)' }}>
                  {new Date(fc.changedAt).toLocaleString('es-MX', { dateStyle:'short', timeStyle:'short' })}
                </span>
              </div>
              {fc.orderNumber && (
                <p style={{ fontSize:11, color:'var(--color-text-secondary)', fontFamily:'monospace', marginBottom: 4 }}>
                  {fc.orderNumber}
                </p>
              )}

              <div style={{ display:'grid', gridTemplateColumns:'1fr auto 1fr', gap:8, alignItems:'center', marginBottom:6 }}>
                <div style={{ fontSize:12 }}>
                  <p style={{ color:'var(--color-text-secondary)', fontSize:10, textTransform:'uppercase', marginBottom:2 }}>De</p>
                  {fc.originalFormula.map((m, idx) => (
                    <div key={idx} style={{ display:'flex', justifyContent:'space-between', color:'var(--color-text-primary)' }}>
                      <span>{m.material}</span>
                      <span style={{ fontFamily:'monospace' }}>{parseFloat(m.percentage).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
                <span style={{ color:'var(--color-text-secondary)', fontSize:14 }}>→</span>
                <div style={{ fontSize:12 }}>
                  <p style={{ color:'var(--color-text-secondary)', fontSize:10, textTransform:'uppercase', marginBottom:2 }}>A</p>
                  {fc.newFormula.map((m, idx) => (
                    <div key={idx} style={{ display:'flex', justifyContent:'space-between', color:'var(--color-text-primary)', fontWeight:500 }}>
                      <span>{m.material}</span>
                      <span style={{ fontFamily:'monospace' }}>{parseFloat(m.percentage).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{
                background:'var(--color-background-secondary)',
                borderLeft:'2px solid #B5D4F4',
                padding:'6px 10px', borderRadius:4, fontSize:12,
                color:'var(--color-text-secondary)', fontStyle:'italic',
              }}>
                "{fc.reason}"
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* Correcciones del supervisor */}
      {corrections.length > 0 && (
        <Section title={`Correcciones del supervisor (${corrections.length})`}>
          {corrections.map((c, i) => {
            const targetLabel = { shift_progress:'paquete', shift_scrap:'merma', shift_incidents:'incidencia' }[c.targetType] || c.targetType
            const actionLabel = { update:'editó', delete:'eliminó', create:'agregó' }[c.action] || c.action
            return (
              <div key={c.id} style={{
                paddingBottom: i < corrections.length-1 ? 10 : 0,
                marginBottom:  i < corrections.length-1 ? 10 : 0,
                borderBottom:  i < corrections.length-1 ? '0.5px solid var(--color-border-tertiary)' : 'none',
              }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                  <span style={{ fontSize:13, color:'var(--color-text-primary)' }}>
                    <strong>{c.correctedByName}</strong> {actionLabel} {targetLabel}
                  </span>
                  <span style={{ fontSize:11, color:'var(--color-text-secondary)' }}>
                    {new Date(c.correctedAt).toLocaleString('es-MX', { dateStyle:'short', timeStyle:'short' })}
                  </span>
                </div>
                <div style={{
                  background:'var(--color-background-secondary)',
                  borderLeft:'2px solid #B5D4F4',
                  padding:'6px 10px', borderRadius:4, fontSize:12,
                  color:'var(--color-text-secondary)', fontStyle:'italic',
                }}>
                  "{c.reason}"
                </div>
              </div>
            )
          })}
        </Section>
      )}
    </div>
  )
}

// ─── Modal: revertir validación ─────────────────────────────────────────────
//
// Mig 163. Pre-check via GET /revert-context (devuelve allowed, blockers,
// preview de movimientos a reversar, si requiere dual approval). Si está
// permitido, captura razón obligatoria (≥20 chars) y aprobador secundario si
// aplica.
function RevertValidationModal({ shiftId, onClose }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [acked, setAcked]   = useState(false)
  const [secondaryApproverId, setSecondary] = useState('')

  const { data: ctx, isLoading } = useQuery({
    queryKey: ['shift-revert-context', shiftId],
    queryFn:  () => productionApi.getRevertContext(shiftId),
    enabled:  !!shiftId,
  })

  // Lista de admins del tenant — solo se carga si el tenant pide dual approval.
  const { data: adminsData } = useQuery({
    queryKey: ['users-admins'],
    queryFn:  () => api.get('/users', { params: { limit: 100, role: 'admin' } }).then(r => r.data),
    enabled:  !!ctx?.requires_dual_approval,
  })
  const admins = adminsData?.data || adminsData || []

  const mutation = useMutation({
    mutationFn: () => productionApi.revertValidation(shiftId, {
      reason: reason.trim(),
      secondaryApproverId: ctx?.requires_dual_approval ? secondaryApproverId : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift-summary', shiftId] })
      qc.invalidateQueries({ queryKey: ['scheduled-shifts'] })
      onClose()
      // El turno vuelve a 'active' — llevar al supervisor a la pantalla de captura.
      navigate('/produccion/ordenes', { replace: true })
    },
  })

  const reasonOk = reason.trim().length >= 20
  const dualOk   = !ctx?.requires_dual_approval || !!secondaryApproverId
  const canSubmit = ctx?.allowed && reasonOk && acked && dualOk && !mutation.isPending

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-md p-0 flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-subtle shrink-0">
          <h2 className="text-base font-semibold text-status-warning">⚠ Revertir validación del turno</h2>
          <button onClick={onClose} className="btn-ghost btn-icon text-ink-muted">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
          {isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : !ctx ? (
            <p className="text-sm text-status-danger">No se pudo cargar el contexto.</p>
          ) : (
            <>
              {ctx.blockers?.length > 0 && (
                <div className="rounded-lg border border-status-danger/40 bg-status-danger/10 p-3 space-y-1">
                  <p className="text-sm font-semibold text-status-danger">No es posible revertir este turno:</p>
                  <ul className="text-xs text-status-danger list-disc ml-5">
                    {ctx.blockers.map(b => <li key={b.code}>{b.message}</li>)}
                  </ul>
                </div>
              )}

              {ctx.allowed && (
                <>
                  <p className="text-sm text-ink-secondary">
                    Esta acción reversará los movimientos de inventario del turno y dejará el turno editable de nuevo.
                  </p>

                  {(ctx.reversal_preview.mp_to_return.length > 0 || ctx.reversal_preview.pt_to_remove.length > 0) && (
                    <div className="rounded-lg border border-line-subtle bg-surface-elevated/40 p-3 space-y-2">
                      {ctx.reversal_preview.mp_to_return.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-ink-muted uppercase">MP que regresará al almacén</p>
                          <ul className="text-xs text-ink-primary mt-1 space-y-0.5">
                            {ctx.reversal_preview.mp_to_return.map(m => (
                              <li key={m.raw_material_id}>+ {Number(m.kg).toFixed(2)} kg de {m.name}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {ctx.reversal_preview.pt_to_remove.length > 0 && (
                        <div>
                          <p className="text-[11px] font-semibold text-ink-muted uppercase">PT que saldrá del almacén</p>
                          <ul className="text-xs text-ink-primary mt-1 space-y-0.5">
                            {ctx.reversal_preview.pt_to_remove.map(p => (
                              <li key={p.product_id}>− {Number(p.units).toFixed(0)} pzas de {p.name}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {ctx.window_hours_remaining != null && ctx.window_hours_remaining > 0 && (
                    <p className="text-xs text-ink-muted">
                      Quedan ~{Number(ctx.window_hours_remaining).toFixed(1)} h dentro de la ventana de reversión.
                    </p>
                  )}

                  <div>
                    <label className="label">Razón (mínimo 20 caracteres) <span className="text-status-danger">*</span></label>
                    <textarea rows={3} className="input h-auto py-2 resize-none"
                      placeholder="Ej: Operario reportó merma de 2 kg no registrada en turno y necesita corregirse."
                      value={reason} onChange={e => setReason(e.target.value)}
                    />
                    <p className="text-[11px] text-ink-muted mt-1">
                      {reason.trim().length}/20 caracteres mínimos. Se registra en auditoría.
                    </p>
                  </div>

                  {ctx.requires_dual_approval && (
                    <div>
                      <label className="label">Aprobador secundario (admin) <span className="text-status-danger">*</span></label>
                      <select className="select" value={secondaryApproverId} onChange={e => setSecondary(e.target.value)}>
                        <option value="">Seleccionar admin...</option>
                        {admins.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                      <p className="text-[11px] text-ink-muted mt-1">
                        El tenant requiere doble aprobación para revertir.
                      </p>
                    </div>
                  )}

                  <label className="flex items-start gap-2 cursor-pointer pt-1">
                    <input type="checkbox" checked={acked} onChange={e => setAcked(e.target.checked)}
                      className="w-4 h-4 accent-status-warning mt-0.5" />
                    <span className="text-sm text-ink-primary">
                      Confirmo que entiendo que esto reversará los movimientos de inventario del turno.
                    </span>
                  </label>
                </>
              )}

              {mutation.isError && (
                <div className="rounded-lg border border-status-danger/40 bg-status-danger/10 p-3 text-sm text-status-danger">
                  {mutation.error?.response?.data?.error || mutation.error?.message || 'No se pudo revertir.'}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 px-6 py-4 border-t border-line-subtle shrink-0">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={mutation.isPending}>Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={!canSubmit} className="btn-primary flex-1">
            {mutation.isPending ? <Spinner size="sm" /> : 'Revertir'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
