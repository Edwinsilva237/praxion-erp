// Catálogos legibles del kardex / inventario. Compartidos entre la página de
// Inventario y el modal de detalle de movimiento.

export const MOVEMENT_LABELS = {
  purchase_entry:            'Compra',
  production_mp_consumption: 'Consumo MP',
  production_mp_reserve:     'MP → WIP',
  production_mp_return:      'Devolución MP',
  production_pt_entry:       'Entrada PT',
  production_wip_entry:      'Entrada WIP',
  production_wip_to_pt:      'WIP → PT',
  sale_exit:                 'Venta',
  adjustment_in:             'Ajuste entrada',
  adjustment_out:            'Ajuste salida',
  scrap_entry:               'Entrada merma',
  scrap_disposal:            'Baja merma',
  scrap_to_regrind:          'Merma → Regrind',
  transfer_in:               'Transferencia entrada',
  transfer_out:              'Transferencia salida',
}

export const MOVEMENT_BADGE = {
  purchase_entry:            'green',
  production_mp_consumption: 'red',
  production_mp_reserve:     'amber',
  production_mp_return:      'blue',
  production_pt_entry:       'green',
  production_wip_entry:      'blue',
  production_wip_to_pt:      'purple',
  adjustment_in:             'blue',
  adjustment_out:            'amber',
  sale_exit:                 'purple',
  scrap_entry:               'gray',
  scrap_disposal:            'gray',
  scrap_to_regrind:          'amber',
  transfer_in:               'blue',
  transfer_out:              'amber',
  default:                   'gray',
}

// Etiquetas legibles para la columna "Referencia" del kardex.
export const REFERENCE_LABELS = {
  supplier_receipt:               'Recepción',
  supplier_invoice:               'Factura proveedor',
  supplier_return:                'Devolución a proveedor',
  shift_progress:                 'Captura turno',
  shift_mp_load:                  'Carga de MP',
  shift_scrap:                    'Merma de turno',
  production_shift:               'Turno producción',
  production_order:               'Orden producción',
  inventory_adjustment:           'Ajuste',
  inventory_adjustment_reversal:  'Reversión ajuste',
  manual_adjustment:              'Ajuste manual',
  quality_release:                'Liberación 2ª calidad',
  sales_order:                    'Pedido',
  delivery_note:                  'Remisión',
  invoice:                        'Factura',
}
