import clsx from 'clsx'

const VARIANTS = {
  green:  'badge-green',
  amber:  'badge-amber',
  blue:   'badge-blue',
  red:    'badge-red',
  gray:   'badge-gray',
  purple: 'badge-purple',
  teal:   'badge-teal',
}

export const STATUS_VARIANT = {
  // OC estados
  draft:               'gray',
  authorized:          'blue',
  sent:                'purple',
  partially_received:  'amber',
  received:            'green',
  invoiced:            'teal',
  cancelled:           'red',
  closed:              'gray',
  // Recepciones / pedidos confirmados
  confirmed:           'green',
  // Pedidos de venta
  in_delivery:         'purple',
  delivered:           'teal',
  // Remisiones (sales delivery notes)
  issued:              'blue',
  sent_by_email:       'purple',
  partially_delivered: 'amber',
  // CXC / CXP
  pending:             'amber',
  partial:             'blue',
  paid:                'green',
  overdue:             'red',
  // Facturación
  stamped:             'green',
  with_diff:           'amber',
  reconciled:          'green',
  // Ajustes de inventario
  active:              'green',
  // Cotizaciones
  accepted:            'green',
  converted:           'teal',
  rejected:            'red',
  expired:             'gray',
}

export const STATUS_LABEL = {
  draft:               'Borrador',
  invoiced:            'Facturado',
  authorized:          'Autorizada',
  sent:                'Enviada',
  partially_received:  'Parc. recibida',
  received:            'Recibida',
  invoiced:            'Facturada',
  cancelled:           'Cancelada',
  closed:              'Cerrada',
  confirmed:           'Confirmada',
  in_delivery:         'Remisionado',
  delivered:           'Entregado',
  issued:              'Emitida',
  sent_by_email:       'Enviada por correo',
  partially_delivered: 'Entrega parcial',
  pending:             'Pendiente',
  partial:             'Parcial',
  paid:                'Pagado',
  overdue:             'Vencido',
  stamped:             'Timbrado',
  with_diff:           'Con diferencia',
  reconciled:          'Conciliada',
  active:              'Activo',
  // Cotizaciones
  accepted:            'Aceptada',
  converted:           'Convertida a pedido',
  rejected:            'Rechazada',
  expired:             'Expirada',
}

/**
 * Componente Badge con 3 modos de uso:
 *   1. <Badge status="paid" />                       → label y color por status
 *   2. <Badge variant="green" label="Compra" />      → label y color explícitos
 *   3. <Badge variant="green">Compra</Badge>         → label como children (NUEVO)
 *
 * Prioridad para el label: label > children > STATUS_LABEL[status] > status
 */
export default function Badge({ status, label, variant, className, children }) {
  const resolvedVariant = variant || STATUS_VARIANT[status] || 'gray'
  const resolvedLabel   = label != null && label !== ''
    ? label
    : (children != null && children !== ''
        ? children
        : (STATUS_LABEL[status] || status))
  const cls = VARIANTS[resolvedVariant] || 'badge-gray'

  return (
    <span className={clsx(cls, className)}>
      {resolvedLabel}
    </span>
  )
}
