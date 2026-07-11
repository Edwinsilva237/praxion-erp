// Ayudas contextuales para cada flag de tenant_process_config.
//
// Formato por flag: { title, body, examples? }
// `body` puede ser string o ReactNode. Para mantener este archivo .js
// (sin JSX) usamos solo strings; los componentes que renderizan pueden
// envolver en <p> si lo necesitan.

// ── Ayudas comunes reutilizables en formularios genéricos ────────────────────

// Campo "Orden" (sort_order) presente en muchos catálogos: unidades, calidades,
// tipos de merma, roles de turno, alérgenos, tipos de producto, gastos indirectos.
export const ORDEN_HELP = {
  title: '¿Para qué sirve "Orden"?',
  body: 'Es solo cosmético: controla en qué posición aparece este registro en listas y selectores. Los números menores se muestran primero. Si dos tienen el mismo número, se ordenan alfabéticamente por nombre.',
  examples: [
    { label: 'Útil para', value: 'Poner las opciones más usadas arriba (ej: "Kilogramo" antes que "Onza").' },
    { label: 'Tip',       value: 'Deja huecos (10, 20, 30) por si después necesitas insertar algo en medio.' },
    { label: 'Déjalo en 0', value: 'Si no te importa el orden — se ordenará alfabéticamente.' },
  ],
}

// Campo "Código" presente en muchos catálogos.
export const CODIGO_HELP = {
  title: 'Código',
  body: 'Identificador corto en minúsculas y sin espacios. Sirve para referirse al registro internamente y en reportes. No se puede cambiar después de crear, así que elige algo descriptivo.',
  examples: [
    { label: 'Bueno',  value: 'kg, primera, gluten, renta' },
    { label: 'Evitar', value: 'espacios, mayúsculas o caracteres especiales' },
  ],
}

export const HELP = {
  // ── Trazabilidad y lotes ──────────────────────────────────────────────
  uses_lots: {
    title: '¿Usar lotes de materia prima?',
    body: 'Si está activo, cada carga de MP queda asociada a un lote específico, y cada paquete de PT producido también genera su lote. Esto permite trazabilidad completa (qué MP entró en qué producto, recall por lote). Si está apagado, la MP/PT solo manejan kg/unidades sin distinguir lotes.',
    examples: [
      { label: 'Actívalo si', value: 'Tienes industria alimentaria, farmacéutica, o tu cliente exige trazabilidad (recall).' },
      { label: 'Déjalo apagado si', value: 'Producto de bajo riesgo: plástico industrial, materiales de construcción, esquineros.' },
    ],
  },
  uses_expiry: {
    title: 'Fechas de vencimiento',
    body: 'Permite registrar fecha de caducidad o "mejor antes de" en cada lote. Habilita alertas próximas al vencimiento.',
    examples: [
      { label: 'Actívalo si', value: 'Tus productos tienen vida útil definida (alimentos, lácteos, panadería, químicos sensibles).' },
      { label: 'Déjalo apagado si', value: 'Producto no perecedero (plástico, metales, papel).' },
    ],
  },
  uses_fefo: {
    title: 'FEFO — Primero vence, primero sale',
    body: 'Al consumir o despachar, el sistema sugiere automáticamente el lote más próximo a vencer. Requiere "Usar lotes" y "Fechas de vencimiento" activos.',
    examples: [
      { label: 'Actívalo si', value: 'Producto perecedero — minimiza pérdida por caducidad.' },
      { label: 'Apágalo si', value: 'Quieres que el operador elija manualmente, o si usas FIFO contable que es diferente.' },
    ],
  },
  expiry_alert_days: {
    title: 'Días para alertar antes del vencimiento',
    body: 'El sistema muestra alerta cuando un lote está a N días o menos de su fecha de caducidad. Solo aplica si "Fechas de vencimiento" está activo.',
    examples: [
      { label: 'Pastelería',  value: '3–7 días (vida corta)' },
      { label: 'Frituras',    value: '14–30 días' },
      { label: 'Lácteos',     value: '5–10 días' },
    ],
  },

  // ── Proceso y WIP ─────────────────────────────────────────────────────
  pt_goes_to_wip_first: {
    title: 'PT pasa por WIP antes de almacén',
    body: 'Cuando un operador captura un paquete producido, ¿va directo a producto terminado, o primero a WIP para inspección/clasificación por supervisor?',
    examples: [
      { label: 'Actívalo si', value: 'Necesitas QA antes de liberar (recicladora con clasificación 1ª/2ª/3ª, productos con grado variable).' },
      { label: 'Déjalo apagado si', value: 'El paquete capturado ya es producto terminado listo para venta.' },
    ],
  },
  mp_goes_to_wip_first: {
    title: 'MP pasa por WIP antes de consumir',
    body: 'Cuando cargas materia prima al turno, ¿va a WIP (en proceso) primero, o se descuenta directo del almacén MP al consumir?',
    examples: [
      { label: 'Actívalo si',   value: 'Operación industrial estándar — quieres ver consumo en tiempo real.' },
      { label: 'Apágalo si',    value: 'Operación pequeña sin separación física entre almacén MP y línea de producción.' },
    ],
  },
  allow_second_quality_in_order: {
    title: 'Permitir 2ª calidad para cumplir pedidos',
    body: 'Si un pedido es de calidad 1, ¿se puede entregar con calidad 2 o inferior cuando no hay stock de 1ª? (queda registrado y el cliente puede aprobar/rechazar).',
    examples: [
      { label: 'Actívalo si', value: 'Recicladora, plásticos industriales — el cliente puede aceptar grado menor con descuento.' },
      { label: 'Apágalo si', value: 'Alimentos, farma, o cualquier producto donde 2ª calidad significa "no apto para venta".' },
    ],
  },
  treat_abnormal_scrap_as_loss: {
    title: 'Tratar merma anormal como pérdida total',
    body: 'Cuando la merma de un turno supera el % esperado, ¿se considera pérdida 100% (sin valor de rescate) o se trata como merma normal con su valor de recuperación?',
    examples: [
      { label: 'Actívalo si',   value: 'Quieres penalizar al turno responsable; ayuda a detectar problemas de proceso.' },
      { label: 'Apágalo si',    value: 'La merma siempre tiene valor (reciclaje), o no quieres distinguir entre normal/anormal.' },
    ],
  },

  // ── Turnos y roles ────────────────────────────────────────────────────
  uses_handover: {
    title: 'Handover entre turnos',
    body: 'Al cerrar un turno, el operador saliente y el entrante firman la transferencia (MP recibida, problemas detectados, observaciones). Crea trazabilidad clara entre turnos.',
    examples: [
      { label: 'Actívalo si', value: 'Producción 24/7 o varios turnos al día — necesitas saber quién entregó qué.' },
      { label: 'Apágalo si',  value: 'Un solo turno por día o operación familiar sin relevo.' },
    ],
  },
  uses_supervisor: {
    title: 'Rol de supervisor por turno',
    body: 'Cada turno tiene asignado un supervisor además del operador. El supervisor puede validar turnos, aprobar correcciones, autorizar 2ª calidad, etc.',
    examples: [
      { label: 'Actívalo si', value: 'Operación con más de 3 operadores y necesidad de control de calidad.' },
      { label: 'Apágalo si',  value: 'Operación pequeña donde el dueño/admin valida directamente desde el panel.' },
    ],
  },
  supervisor_validates: {
    title: 'Solo supervisor puede validar el turno',
    body: 'Al cierre, el supervisor del turno (no el operador) es quien debe revisar y validar para liberar la producción al inventario. Requiere "Usar supervisor".',
    examples: [
      { label: 'Actívalo si', value: 'Quieres separación de responsabilidades: operador captura, supervisor valida.' },
      { label: 'Apágalo si',  value: 'El admin o el mismo operador puede cerrar (operación más ágil).' },
    ],
  },
  allow_adhoc_shifts: {
    title: 'Turnos ad-hoc (fuera de programación)',
    body: 'Permite abrir turnos sin que estén pre-programados en el calendario. Útil para producciones esporádicas o re-trabajos.',
    examples: [
      { label: 'Actívalo si',   value: 'Demanda variable — abres turno cuando hay pedido.' },
      { label: 'Apágalo si',    value: 'Producción muy estructurada con calendario fijo de turnos.' },
    ],
  },

  // ── Costos, alérgenos, modo ───────────────────────────────────────────
  cost_method: {
    title: 'Método de costo de MP',
    body: 'Cómo se valora la materia prima al consumirla en un turno. Afecta el costo unitario reportado de cada orden.',
    examples: [
      { label: 'Promedio ponderado', value: 'Más común. Cada nueva compra recalcula el costo promedio del stock.' },
      { label: 'FIFO',               value: 'Primero entró, primero salió. Recomendado para perecederos (pastelería).' },
      { label: 'Costo estándar',     value: 'Costo fijo predefinido; varianzas se reportan aparte. Para empresas grandes.' },
    ],
  },
  default_intra_shift_proration: {
    title: 'Cómo dividir costos entre paquetes del turno',
    body: 'Cuando un mismo turno produce varios paquetes/lotes, el costo total del turno (materia prima + gastos del mes) hay que repartirlo. Esta opción dice cómo se hace ese reparto entre los paquetes producidos.',
    examples: [
      { label: 'Por peso (kg)', value: 'El paquete que pese más absorbe más costo. Lo más justo cuando los productos son similares.' },
      { label: 'Por unidades',  value: 'Cada pieza paga lo mismo, sin importar peso. Para producto uniforme.' },
      { label: 'Por tiempo',    value: 'Reparte según horas/minutos invertidos en cada paquete. Para procesos donde unos toman mucho más tiempo que otros.' },
      { label: 'Manual',        value: 'El supervisor ajusta el reparto a mano al validar el turno.' },
    ],
  },
  allergen_mode: {
    title: 'Manejo de contaminación cruzada por alérgenos',
    body: 'Cómo reacciona el sistema cuando una MP con alérgeno se carga en un turno cuyo producto NO debería contenerlo.',
    examples: [
      { label: 'Estricto',            value: 'Bloquea el cierre del turno hasta resolver. Para tenant con cliente alérgico.' },
      { label: 'Solo prioritarios',   value: 'Bloquea solo en los 8 alérgenos principales (gluten, lácteo, soya…).' },
      { label: 'Solo alerta',         value: 'Avisa pero no bloquea — el operador decide. (Default seguro para no-alimentario)' },
    ],
  },
  operation_mode: {
    title: 'Modo de operación general',
    body: 'Determina cuánto detalle pide el sistema en pantallas de captura. Modo "industrial" pide más datos; "pequeño" y "micro" simplifican.',
    examples: [
      { label: 'Industrial', value: 'Captura completa: WIP, supervisor, formula MP, NRV. (default)' },
      { label: 'Pequeño',    value: 'Salta validaciones secundarias para agilizar al operador.' },
      { label: 'Micro',      value: 'Mínimo viable: solo pesa, cuenta y cierra. Para operación artesanal.' },
    ],
  },
  simplified_overhead: {
    title: 'Overhead simplificado (monto fijo por turno)',
    body: 'Modo legacy: en lugar de prorratear gastos indirectos por base (kg, horas, etc.), aplicar un único monto fijo por turno. ⚠ Reemplazado por el módulo Costeo nuevo — solo úsalo si NO quieres usar gastos indirectos prorrateados.',
    examples: [
      { label: 'Apágalo (recomendado)', value: 'Para usar el módulo Costeo con prorrateo real, recosteo mensual y reporte de varianza.' },
      { label: 'Actívalo si',           value: 'Operación micro sin tiempo de manejar el cierre mensual.' },
    ],
  },
  expenses_enabled: {
    title: 'Módulo de Gastos',
    body: 'Habilita la pantalla de Gastos: registra gastos de proveedor que no son mercancía (fletes, luz, renta, combustible, servicios, etc.), clasifícalos por categoría y concílialos contra su factura y pago. Su IVA cuenta como acreditable en el resumen.',
    examples: [
      { label: 'Actívalo si',  value: 'Llevas el control de tus gastos operativos y su deducibilidad dentro del ERP.' },
      { label: 'Apágalo si',   value: 'Operación micro que solo factura mercancía y no necesita gestionar gastos aquí.' },
    ],
  },

  // ── Inventario ───────────────────────────────────────────────────────
  allow_negative_stock: {
    title: 'Permitir inventario en negativo',
    body: 'Cuando una venta/remisión sale sin existencia capturada, el stock baja a NEGATIVO (en rojo) en vez de quedarse en 0. El saldo negativo funciona como bandera de que falta validar el turno de producción o capturar la entrada que debió generar ese producto. Si está apagado, la salida clampa a 0 y el faltante queda oculto (comportamiento histórico).',
    examples: [
      { label: 'Actívalo si', value: 'Remisionas/facturas antes de validar la producción, o quieres ver de inmediato dónde falta una captura.' },
      { label: 'Apágalo si',  value: 'Prefieres que el sistema nunca muestre negativos (p.ej. solo vendes lo que ya está capturado en inventario).' },
    ],
  },
  block_sale_without_stock: {
    title: 'Bloquear remisión sin existencia',
    body: 'Al registrar la ENTREGA de una remisión, si el almacén no tiene existencia suficiente para cubrir la salida, la operación se rechaza con un error "Stock insuficiente" en lugar de dejar el saldo en 0 o negativo. El indicador de stock del pedido es solo un aviso; esta bandera es la que realmente impide entregar de más. Es la contraparte estricta de "Permitir inventario en negativo": si bloqueas la sobreventa, nunca se llega a un saldo negativo.',
    examples: [
      { label: 'Actívalo si', value: 'No quieres entregar más de lo que hay físicamente (retail/alimentos, control estricto de existencias).' },
      { label: 'Apágalo si',  value: 'Produces o surtes sobre la marcha y prefieres entregar aunque el stock aún no esté capturado.' },
    ],
  },

  // ── Atributos de materias primas específicos de plástico ─────────────
  uses_resin_types: {
    title: 'Mostrar "Tipo de resina" en materias primas',
    body: 'Si está activo, el formulario de materias primas y de almacenes pide "Tipo de resina" (PP / PE). Útil únicamente para industrias plásticas. Si tu producto no es plástico, déjalo apagado y el campo desaparece de toda la UI.',
    examples: [
      { label: 'Actívalo si', value: 'Eres tenant de esquineros, recicladora de plástico, extrusión, película.' },
      { label: 'Déjalo apagado si', value: 'Eres tenant de frituras, panadería, pellet alimentario, cualquier otro.' },
    ],
  },
  tracks_material_origin: {
    title: 'Distinguir material virgen vs reciclado',
    body: 'Si está activo, las materias primas tienen el atributo "Virgen / Regrind" para diferenciar materia prima nueva de material reciclado/recuperado. Importante cuando tu proceso reincorpora merma.',
    examples: [
      { label: 'Actívalo si', value: 'Tu operación recicla merma internamente y necesitas separar costos de MP virgen vs regrind.' },
      { label: 'Déjalo apagado si', value: 'Todas tus MP llegan del proveedor sin distinguir origen, o no manejas reciclado interno.' },
    ],
  },
}

// ── Validaciones cruzadas ────────────────────────────────────────────────
// Devuelve array de { severity, field?, message } para mostrar como warnings.
export function validateConfig(config) {
  const warnings = []
  if (!config) return warnings

  if (config.uses_fefo && !config.uses_lots) {
    warnings.push({
      severity: 'warn',
      field: 'uses_fefo',
      message: 'FEFO requiere "Usar lotes" activo — sin lotes el sistema no sabe qué lote está más próximo a vencer.',
    })
  }
  if (config.uses_fefo && !config.uses_expiry) {
    warnings.push({
      severity: 'warn',
      field: 'uses_fefo',
      message: 'FEFO sin fechas de vencimiento no tiene cómo ordenar los lotes — activa "Fechas de vencimiento".',
    })
  }
  if (config.supervisor_validates && !config.uses_supervisor) {
    warnings.push({
      severity: 'error',
      field: 'supervisor_validates',
      message: '"Supervisor valida" requiere "Usar supervisor" activo. La validación no funcionará.',
    })
  }
  if (config.uses_expiry && !config.uses_lots) {
    warnings.push({
      severity: 'warn',
      field: 'uses_expiry',
      message: 'Las fechas de vencimiento se guardan por lote — necesitas "Usar lotes" activo para que sirvan.',
    })
  }
  if (config.simplified_overhead && config.operation_mode === 'industrial') {
    warnings.push({
      severity: 'info',
      field: 'simplified_overhead',
      message: 'Overhead simplificado no aprovecha el módulo Costeo con prorrateo y recosteo mensual. Considera apagarlo para operación industrial.',
    })
  }
  if (config.expiry_alert_days != null && !config.uses_expiry) {
    warnings.push({
      severity: 'info',
      field: 'expiry_alert_days',
      message: 'Los días de alerta no aplican porque "Fechas de vencimiento" está apagado.',
    })
  }

  return warnings
}

// Label legible para un valor (para mostrar en preview de diff)
const COST_LABELS     = { weighted_avg: 'Promedio ponderado', fifo: 'FIFO', standard: 'Costo estándar' }
const ALLERGEN_LABELS = { strict: 'Estricto', priority_only: 'Solo prioritarios', alert_only: 'Solo alerta' }
const OPMODE_LABELS   = { industrial: 'Industrial', small: 'Pequeño', micro: 'Micro' }
const PRORATION_LABELS= { weight: 'Por peso', units: 'Por unidades', time: 'Por tiempo', manual: 'Manual' }

export function formatValue(field, value) {
  if (value === true)  return 'Activo'
  if (value === false) return 'Apagado'
  if (value === null || value === '' || value === undefined) return '—'
  if (field === 'cost_method')                   return COST_LABELS[value]      || value
  if (field === 'allergen_mode')                 return ALLERGEN_LABELS[value]  || value
  if (field === 'operation_mode')                return OPMODE_LABELS[value]    || value
  if (field === 'default_intra_shift_proration') return PRORATION_LABELS[value] || value
  if (field === 'expiry_alert_days')             return `${value} días`
  return String(value)
}

export const FIELD_LABELS = {
  uses_lots:                    'Usar lotes de MP',
  uses_expiry:                  'Fechas de vencimiento',
  uses_fefo:                    'Aplicar FEFO',
  expiry_alert_days:            'Días alerta vencimiento',
  pt_goes_to_wip_first:         'PT pasa por WIP primero',
  mp_goes_to_wip_first:         'MP pasa por WIP primero',
  uses_handover:                'Handover de turno',
  uses_supervisor:              'Usar supervisor',
  supervisor_validates:         'Supervisor valida',
  allow_adhoc_shifts:           'Turnos ad-hoc',
  allow_second_quality_in_order:'Permitir 2ª calidad en OC',
  treat_abnormal_scrap_as_loss: 'Merma anormal como pérdida',
  cost_method:                  'Método de costo',
  default_intra_shift_proration:'Reparto de costo intra-turno',
  allergen_mode:                'Modo de alérgenos',
  operation_mode:               'Modo de operación',
  simplified_overhead:          'Overhead simplificado',
  uses_resin_types:             'Usar tipo de resina (PP/PE)',
  tracks_material_origin:       'Distinguir virgen vs reciclado',
  allow_revert_validation:         'Permitir revertir validación',
  revert_validation_window_hours:  'Ventana de tiempo (horas)',
  block_revert_if_order_fulfilled: 'Bloquear si la orden ya cerró',
  block_revert_if_period_closed:   'Bloquear si el periodo contable cerró',
  require_revert_dual_approval:    'Requerir doble aprobación',
  expenses_enabled:                'Módulo de Gastos',
  allow_negative_stock:            'Permitir inventario en negativo',
  block_sale_without_stock:        'Bloquear remisión sin existencia',
}
