import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { partnersApi } from '@/api/partners'
import Spinner from '@/components/ui/Spinner'
import Badge from '@/components/ui/Badge'
import Can from '@/components/auth/Can'

const fmtMXN = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(n || 0)

const TYPE_LABEL = { customer: 'Cliente', supplier: 'Proveedor', both: 'Cliente y proveedor' }
const TYPE_VARIANT = { customer: 'blue', supplier: 'amber', both: 'green' }
const PERSON_LABEL = { fisica: 'Persona física', moral: 'Persona moral' }
const CREDIT_LABEL = { cash: 'Contado', credit: 'Crédito' }

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-muted shrink-0">{label}</span>
      <span className="text-sm text-ink-primary text-right min-w-0 break-words">{children ?? '—'}</span>
    </div>
  )
}

function Sect({ title, children }) {
  return (
    <div className="border-t border-line-subtle pt-3 mt-3 first:border-0 first:pt-0 first:mt-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">{title}</p>
      {children}
    </div>
  )
}

/**
 * Detalle de SOCIO DE NEGOCIO en solo lectura. Se abre al hacer clic en una fila,
 * sin entrar a editar (no requiere business_partners:update). Botón "Editar" para
 * quien sí tenga permiso.
 */
export default function PartnerDetailModal({ partnerId, onClose, onEdit }) {
  const { data: p, isLoading } = useQuery({
    queryKey: ['partner-detail', partnerId],
    queryFn:  () => partnersApi.get(partnerId),
    enabled:  !!partnerId,
    staleTime: 30000,
  })

  const isSupplier = p && (p.type === 'supplier' || p.type === 'both')
  const isCustomer = p && (p.type === 'customer' || p.type === 'both')
  const addr = p && [p.address, p.neighborhood, p.city, p.state, p.zip_code].filter(Boolean).join(', ')
  const contacts = (p?.contacts || []).filter(Boolean)

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="card w-full max-w-lg p-0 max-h-[90vh] flex flex-col">
        {isLoading || !p ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <>
            <div className="px-6 pt-5 pb-3 border-b border-line-subtle">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow">SOCIO DE NEGOCIO</p>
                  <h2 className="text-base font-semibold text-ink-primary mt-0.5 break-words">{p.name}</h2>
                  {p.internal_code && <p className="text-xs text-ink-muted mt-0.5">{p.internal_code}</p>}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge variant={TYPE_VARIANT[p.type] || 'gray'} label={TYPE_LABEL[p.type] || p.type} />
                  <Badge variant={p.is_active ? 'green' : 'gray'} label={p.is_active ? 'Activo' : 'Inactivo'} />
                  {p.is_occasional && <Badge variant="gray" label="Eventual" />}
                </div>
              </div>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              <Sect title="Datos fiscales">
                <Row label="RFC">{p.rfc || <span className="text-ink-muted">Sin RFC (solo remisión)</span>}</Row>
                {p.tax_name && <Row label="Razón social">{p.tax_name}</Row>}
                {p.person_type && <Row label="Tipo de persona">{PERSON_LABEL[p.person_type] || p.person_type}</Row>}
                {p.tax_regime && <Row label="Régimen fiscal">{p.tax_regime}{p.tax_regime_code ? ` (${p.tax_regime_code})` : ''}</Row>}
                {p.cfdi_use && <Row label="Uso CFDI">{p.cfdi_use}</Row>}
              </Sect>

              {isCustomer && (
                <Sect title="Comercial (cliente)">
                  <Row label="Crédito">{CREDIT_LABEL[p.credit_type] || p.credit_type || '—'}</Row>
                  {p.credit_type === 'credit' && <Row label="Días de crédito">{p.credit_days ?? 0} días</Row>}
                  {p.credit_limit != null && <Row label="Límite de crédito">{fmtMXN(p.credit_limit)}</Row>}
                  {p.preferred_currency && <Row label="Moneda preferida">{p.preferred_currency}</Row>}
                  {p.requires_po && <Row label="Requiere orden de compra">Sí</Row>}
                </Sect>
              )}

              {isSupplier && (
                <Sect title="Proveedor">
                  {p.supplier_credit_days != null && <Row label="Días de crédito">{p.supplier_credit_days} días</Row>}
                  {p.supplier_credit_limit != null && <Row label="Límite de crédito">{fmtMXN(p.supplier_credit_limit)}</Row>}
                  {p.supplier_lead_time_days != null && <Row label="Lead time">{p.supplier_lead_time_days} días</Row>}
                  {p.supplier_rating != null && <Row label="Calificación">{p.supplier_rating}/5</Row>}
                </Sect>
              )}

              {addr && (
                <Sect title="Domicilio">
                  <p className="text-sm text-ink-primary">{addr}</p>
                </Sect>
              )}

              {contacts.length > 0 && (
                <Sect title="Contactos">
                  <div className="space-y-2">
                    {contacts.map((c, i) => (
                      <div key={c.id || i} className="rounded-lg bg-surface-elevated/40 border border-line-subtle px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-ink-primary">{c.name}{c.is_primary ? ' ★' : ''}</span>
                          {c.position && <span className="text-[11px] text-ink-muted">{c.position}</span>}
                        </div>
                        {(c.email || c.phone) && (
                          <div className="text-xs text-ink-secondary mt-0.5">
                            {[c.email, c.phone].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Sect>
              )}

              {p.notes && (
                <Sect title="Notas">
                  <p className="text-sm text-ink-secondary whitespace-pre-wrap">{p.notes}</p>
                </Sect>
              )}
            </div>

            <div className="px-6 py-4 border-t border-line-subtle flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1">Cerrar</button>
              <Can do="business_partners:update">
                <button onClick={() => onEdit?.(p)} className="btn-primary flex-1">Editar</button>
              </Can>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
