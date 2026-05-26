// Presets de configuración de proceso por industria.
//
// Cada preset define los valores recomendados para `tenant_process_config`.
// Los campos no incluidos se dejan al default del sistema.
//
// Estos presets reflejan las 5 verticales piloto del proyecto. Para
// industrias mixtas o atípicas, usar "custom".

export const PRESETS = [
  {
    key: 'plastico',
    title: 'Plástico (extrusión / esquineros)',
    short: 'Sin caducidad, sin lotes obligatorios, supervisor valida.',
    examples: 'Esquineros, película, perfiles, fundas, bolsas.',
    icon: '🧱',
    config: {
      uses_lots:              false,
      uses_expiry:            false,
      uses_fefo:              false,
      expiry_alert_days:      null,
      pt_goes_to_wip_first:   false,
      mp_goes_to_wip_first:   true,
      uses_handover:          true,
      uses_supervisor:        true,
      supervisor_validates:   true,
      allow_adhoc_shifts:     false,
      allow_second_quality_in_order: true,
      treat_abnormal_scrap_as_loss:  false,
      cost_method:            'weighted_avg',
      allergen_mode:          'alert_only',
      operation_mode:         'industrial',
      simplified_overhead:    false,
      uses_resin_types:       true,
      tracks_material_origin: true,
    },
  },
  {
    key: 'recicladora',
    title: 'Recicladora de plástico',
    short: 'Sin lotes alimentarios pero con varias calidades (1ª/2ª/3ª).',
    examples: 'Pellet, molido, hojuela, recuperado.',
    icon: '♻️',
    config: {
      uses_lots:              false,
      uses_expiry:            false,
      uses_fefo:              false,
      expiry_alert_days:      null,
      pt_goes_to_wip_first:   true,
      mp_goes_to_wip_first:   true,
      uses_handover:          true,
      uses_supervisor:        true,
      supervisor_validates:   true,
      allow_adhoc_shifts:     false,
      allow_second_quality_in_order: true,
      treat_abnormal_scrap_as_loss:  true,
      cost_method:            'weighted_avg',
      allergen_mode:          'alert_only',
      operation_mode:         'industrial',
      simplified_overhead:    false,
      uses_resin_types:       true,
      tracks_material_origin: true,
    },
  },
  {
    key: 'frituras',
    title: 'Frituras / botana',
    short: 'Lotes con caducidad obligatoria, FEFO, alérgenos en alerta.',
    examples: 'Papas, palomitas, chicharrón, churritos.',
    icon: '🍿',
    config: {
      uses_lots:              true,
      uses_expiry:            true,
      uses_fefo:              true,
      expiry_alert_days:      14,
      pt_goes_to_wip_first:   false,
      mp_goes_to_wip_first:   true,
      uses_handover:          true,
      uses_supervisor:        true,
      supervisor_validates:   true,
      allow_adhoc_shifts:     false,
      allow_second_quality_in_order: false,
      treat_abnormal_scrap_as_loss:  true,
      cost_method:            'weighted_avg',
      allergen_mode:          'alert_only',
      operation_mode:         'industrial',
      simplified_overhead:    false,
      uses_resin_types:       false,
      tracks_material_origin: false,
    },
  },
  {
    key: 'pasteleria',
    title: 'Pastelería / panadería',
    short: 'Lotes con caducidad corta, FEFO estricto, FIFO de costo.',
    examples: 'Pasteles, pan, galletas, postres refrigerados.',
    icon: '🎂',
    config: {
      uses_lots:              true,
      uses_expiry:            true,
      uses_fefo:              true,
      expiry_alert_days:      7,
      pt_goes_to_wip_first:   false,
      mp_goes_to_wip_first:   true,
      uses_handover:          true,
      uses_supervisor:        true,
      supervisor_validates:   true,
      allow_adhoc_shifts:     true,
      allow_second_quality_in_order: false,
      treat_abnormal_scrap_as_loss:  true,
      cost_method:            'fifo',
      allergen_mode:          'alert_only',
      operation_mode:         'industrial',
      simplified_overhead:    false,
      uses_resin_types:       false,
      tracks_material_origin: false,
    },
  },
  {
    key: 'micro',
    title: 'Operación pequeña / artesanal',
    short: 'Flujo simplificado, sin lotes, sin supervisor obligatorio.',
    examples: 'Taller artesanal, panadería pequeña, comida casera.',
    icon: '👩‍🍳',
    config: {
      uses_lots:              false,
      uses_expiry:            false,
      uses_fefo:              false,
      expiry_alert_days:      null,
      pt_goes_to_wip_first:   false,
      mp_goes_to_wip_first:   false,
      uses_handover:          false,
      uses_supervisor:        false,
      supervisor_validates:   false,
      allow_adhoc_shifts:     true,
      allow_second_quality_in_order: false,
      treat_abnormal_scrap_as_loss:  true,
      cost_method:            'weighted_avg',
      allergen_mode:          'alert_only',
      operation_mode:         'small',
      simplified_overhead:    true,
      uses_resin_types:       false,
      tracks_material_origin: false,
    },
  },
]

// Encuentra el preset más parecido a la config actual (cantidad de campos iguales).
// Devuelve { preset, matchCount, totalFields } o null si no aplica.
export function detectClosestPreset(config) {
  if (!config) return null
  let best = null
  for (const p of PRESETS) {
    const fields = Object.keys(p.config)
    let match = 0
    for (const f of fields) {
      if (config[f] === p.config[f]) match++
    }
    if (!best || match > best.matchCount) {
      best = { preset: p, matchCount: match, totalFields: fields.length }
    }
  }
  // Solo devolver si hay suficiente coincidencia (≥80%)
  if (best && best.matchCount / best.totalFields >= 0.8) return best
  return null
}

// Calcula los campos que cambiarían si se aplicara un preset.
// Devuelve array de { field, currentValue, newValue }.
export function diffPresetVsConfig(preset, config) {
  if (!preset || !config) return []
  const diffs = []
  for (const [field, newValue] of Object.entries(preset.config)) {
    const currentValue = config[field]
    if (currentValue !== newValue) {
      diffs.push({ field, currentValue, newValue })
    }
  }
  return diffs
}
