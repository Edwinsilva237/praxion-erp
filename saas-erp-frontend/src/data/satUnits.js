// Catálogo SAT c_ClaveUnidad (CFDI 4.0) — subset curado de las claves más
// usadas en industria mexicana. Cubre conteo, masa, volumen, longitud, área,
// tiempo, energía, frecuencia, eléctricos, temperatura, presión, empaque y
// servicios. Si el cliente necesita una clave fuera de esta lista, el
// combobox permite ingresarla como "código personalizado" (formato 1-3
// caracteres alfanuméricos) — el SAT acepta cualquier clave válida del
// catálogo oficial aunque no esté listada aquí.
//
// Fuente: SAT c_ClaveUnidad versión vigente (2024-2025), seleccionando las
// claves de los Recommendation N° 20 / N° 21 de UNECE más usadas + los
// agregados específicos del SAT mexicano.
//
// Si quieres agregar más, edita esta lista. No requiere migración — solo
// rebuild del frontend.

export const SAT_UNITS = [
  // ── Genéricas / Servicios ────────────────────────────────────────────────
  { code: 'ACT', label: 'Actividad' },
  { code: 'E48', label: 'Unidad de servicio' },
  { code: 'E51', label: 'Trabajo' },
  { code: 'E52', label: 'Estación de trabajo' },
  { code: 'KT',  label: 'Kit' },
  { code: 'SET', label: 'Conjunto' },
  { code: '11',  label: 'Equipos' },
  { code: '10',  label: 'Grupos' },

  // ── Conteo / Piezas ──────────────────────────────────────────────────────
  { code: 'H87', label: 'Pieza' },
  { code: 'C62', label: 'Uno (unidad)' },
  { code: 'DPC', label: 'Docena de piezas' },
  { code: '14',  label: 'Decenas' },
  { code: 'D14', label: 'Centena' },
  { code: 'NPR', label: 'Número de pares' },
  { code: 'PR',  label: 'Par' },
  { code: 'D63', label: 'Libro' },
  { code: 'D67', label: 'Dosis' },
  { code: 'EA',  label: 'Cada uno' },
  { code: 'X4',  label: 'Pieza individual' },

  // ── Masa ─────────────────────────────────────────────────────────────────
  { code: 'KGM', label: 'Kilogramo' },
  { code: 'GRM', label: 'Gramo' },
  { code: 'TNE', label: 'Tonelada métrica' },
  { code: 'MGM', label: 'Miligramo' },
  { code: 'MC',  label: 'Microgramo' },
  { code: 'LBR', label: 'Libra' },
  { code: 'ONZ', label: 'Onza' },
  { code: 'TON', label: 'Tonelada (larga)' },
  { code: 'HKM', label: 'Kilogramos por 100 (paquete)' },
  { code: 'CGM', label: 'Centigramo' },
  { code: 'DG',  label: 'Decigramo' },
  { code: 'KTN', label: 'Kilotonelada' },

  // ── Volumen — Líquidos ───────────────────────────────────────────────────
  { code: 'LTR', label: 'Litro' },
  { code: 'MLT', label: 'Mililitro' },
  { code: 'DLT', label: 'Decilitro' },
  { code: 'CLT', label: 'Centilitro' },
  { code: 'HLT', label: 'Hectolitro' },
  { code: 'GLI', label: 'Galón (Reino Unido)' },
  { code: 'GLL', label: 'Galón (EUA)' },
  { code: '4G',  label: 'Microlitro' },
  { code: 'KL',  label: 'Kilolitro' },

  // ── Volumen — Cúbicos ────────────────────────────────────────────────────
  { code: 'MTQ', label: 'Metro cúbico' },
  { code: 'DMQ', label: 'Decímetro cúbico' },
  { code: 'CMQ', label: 'Centímetro cúbico' },
  { code: 'MMQ', label: 'Milímetro cúbico' },
  { code: 'INQ', label: 'Pulgada cúbica' },
  { code: 'FTQ', label: 'Pie cúbico' },
  { code: 'YDQ', label: 'Yarda cúbica' },
  { code: '5I',  label: 'Mil pies cúbicos estándar' },

  // ── Longitud ─────────────────────────────────────────────────────────────
  { code: 'MTR', label: 'Metro' },
  { code: 'CMT', label: 'Centímetro' },
  { code: 'MMT', label: 'Milímetro' },
  { code: 'DMT', label: 'Decímetro' },
  { code: 'KMT', label: 'Kilómetro' },
  { code: 'INH', label: 'Pulgada' },
  { code: 'FOT', label: 'Pie' },
  { code: 'YRD', label: 'Yarda' },
  { code: 'SMI', label: 'Milla' },
  { code: '4H',  label: 'Micrómetro' },
  { code: 'NMI', label: 'Milla náutica' },

  // ── Área / Superficie ────────────────────────────────────────────────────
  { code: 'MTK', label: 'Metro cuadrado' },
  { code: 'CMK', label: 'Centímetro cuadrado' },
  { code: 'MMK', label: 'Milímetro cuadrado' },
  { code: 'DMK', label: 'Decímetro cuadrado' },
  { code: 'KMK', label: 'Kilómetro cuadrado' },
  { code: 'HAR', label: 'Hectárea' },
  { code: 'ARE', label: 'Área' },
  { code: 'INK', label: 'Pulgada cuadrada' },
  { code: 'FTK', label: 'Pie cuadrado' },
  { code: 'YDK', label: 'Yarda cuadrada' },
  { code: 'ACR', label: 'Acre' },

  // ── Tiempo ───────────────────────────────────────────────────────────────
  { code: 'SEC', label: 'Segundo' },
  { code: 'MIN', label: 'Minuto' },
  { code: 'HUR', label: 'Hora' },
  { code: 'DAY', label: 'Día' },
  { code: 'WEE', label: 'Semana' },
  { code: 'MON', label: 'Mes' },
  { code: 'ANN', label: 'Año' },
  { code: 'D40', label: 'Mil segundos' },

  // ── Frecuencia ───────────────────────────────────────────────────────────
  { code: 'HTZ', label: 'Hertz' },
  { code: 'KHZ', label: 'Kilohertz' },
  { code: 'MHZ', label: 'Megahertz' },
  { code: 'GHZ', label: 'Gigahertz' },

  // ── Velocidad ────────────────────────────────────────────────────────────
  { code: 'KMH', label: 'Kilómetro por hora' },
  { code: 'MTS', label: 'Metro por segundo' },
  { code: '2M',  label: 'Centímetro por segundo' },
  { code: 'IU',  label: 'Pulgada por segundo' },
  { code: 'FR',  label: 'Pie por segundo' },

  // ── Energía / Potencia ───────────────────────────────────────────────────
  { code: 'KWH', label: 'Kilowatt hora' },
  { code: 'MWH', label: 'Megawatt hora' },
  { code: 'GWH', label: 'Gigawatt hora' },
  { code: 'WHR', label: 'Watt hora' },
  { code: 'JOU', label: 'Joule' },
  { code: 'KJO', label: 'Kilojoule' },
  { code: 'MJ',  label: 'Megajoule' },
  { code: 'KWT', label: 'Kilowatt' },
  { code: 'MAW', label: 'Megawatt' },
  { code: 'WTT', label: 'Watt' },
  { code: 'HP',  label: 'Caballo de potencia' },
  { code: 'BHP', label: 'Caballo eléctrico' },

  // ── Eléctricos ───────────────────────────────────────────────────────────
  { code: 'AMP', label: 'Amperio' },
  { code: 'VLT', label: 'Voltio' },
  { code: 'KVT', label: 'Kilovoltio' },
  { code: 'KVA', label: 'Kilovoltio amperio' },
  { code: 'OHM', label: 'Ohm' },
  { code: 'KO',  label: 'Kiloohm' },
  { code: 'FAR', label: 'Faradio' },
  { code: 'COU', label: 'Coulomb' },
  { code: '2F',  label: 'Kilovar' },

  // ── Temperatura ──────────────────────────────────────────────────────────
  { code: 'CEL', label: 'Grado Celsius' },
  { code: 'FAH', label: 'Grado Fahrenheit' },
  { code: 'KEL', label: 'Kelvin' },

  // ── Presión ──────────────────────────────────────────────────────────────
  { code: 'BAR', label: 'Bar' },
  { code: 'PAL', label: 'Pascal' },
  { code: 'KPA', label: 'Kilopascal' },
  { code: 'MPA', label: 'Megapascal' },
  { code: 'PSI', label: 'Libra por pulgada cuadrada' },
  { code: 'ATM', label: 'Atmósfera estándar' },
  { code: 'MBR', label: 'Milibar' },

  // ── Empaque (categoría X*) ───────────────────────────────────────────────
  { code: 'XBX', label: 'Caja' },
  { code: 'XBA', label: 'Barril' },
  { code: 'XBC', label: 'Caja de botellas' },
  { code: 'XBG', label: 'Bolsa' },
  { code: 'XBJ', label: 'Cubo' },
  { code: 'XBO', label: 'Botella' },
  { code: 'XBR', label: 'Barra' },
  { code: 'XCH', label: 'Recipiente' },
  { code: 'XCJ', label: 'Cono' },
  { code: 'XCN', label: 'Lata' },
  { code: 'XCT', label: 'Cartón' },
  { code: 'XCS', label: 'Estuche' },
  { code: 'XCT', label: 'Cartón' },
  { code: 'XDR', label: 'Tambor' },
  { code: 'XGB', label: 'Botellón de gas' },
  { code: 'XJR', label: 'Tarro' },
  { code: 'XKG', label: 'Saco' },
  { code: 'XPK', label: 'Paquete' },
  { code: 'XPL', label: 'Placa' },
  { code: 'XPP', label: 'Pieza' },
  { code: 'XPU', label: 'Bandeja' },
  { code: 'XPX', label: 'Paleta' },
  { code: 'XRO', label: 'Rollo' },
  { code: 'XSA', label: 'Saco' },
  { code: 'XSC', label: 'Costal' },
  { code: 'XSK', label: 'Esqueleto' },
  { code: 'XSL', label: 'Lámina' },
  { code: 'XTC', label: 'Caja de té' },
  { code: 'XTU', label: 'Tubo' },
  { code: 'XVA', label: 'Frasco' },
  { code: 'XVI', label: 'Vial' },
  { code: 'XYT', label: 'Yute' },
  { code: 'XCR', label: 'Cajón' },

  // ── Densidad / Concentración ─────────────────────────────────────────────
  { code: 'MGL', label: 'Miligramo por litro' },
  { code: 'A35', label: 'Kilogramo por metro cúbico' },
  { code: '23',  label: 'Gramo por centímetro cúbico' },

  // ── Combinadas / Transporte ──────────────────────────────────────────────
  { code: 'TKM', label: 'Tonelada-kilómetro' },
  { code: 'PA',  label: 'Tira' },
  { code: 'P1',  label: 'Porcentaje' },

  // ── Petróleo y químicos ──────────────────────────────────────────────────
  { code: 'BLD', label: 'Barril seco (US)' },
  { code: 'BLL', label: 'Barril (US)' },

  // ── Aforo / Hidráulica ───────────────────────────────────────────────────
  { code: '87',  label: 'Litro por segundo' },
  { code: '96',  label: 'Litro por minuto' },

  // ── Otras industriales comunes ───────────────────────────────────────────
  { code: 'PAQ', label: 'Paquete (no SAT estándar, sólo para compat local)' },
  { code: 'D63', label: 'Libro' },
  { code: 'KMQ', label: 'Kilogramo por metro cuadrado' },
  { code: 'A75', label: 'Kilometro por kilolitro' },

  // ── Códigos no oficiales del SAT pero comunes en industria mexicana ──────
  // Nota: estos NO están en c_ClaveUnidad CFDI 4.0 oficial. Se permiten para
  // capturar productos en el inventario, pero al facturar puede que el SAT
  // los rechace y haya que convertir (ej. millares → H87 con cantidad × 1000).
  { code: 'MIL', label: 'Millar (uso comercial — verifica equivalencia SAT al timbrar)' },
]

// Verifica si una clave parece válida en el formato del SAT
// (1-3 caracteres alfanuméricos, mayúsculas). Útil para permitir que el
// usuario ingrese una clave que no está en SAT_UNITS si la conoce.
export const SAT_UNIT_PATTERN = /^[A-Z0-9]{1,3}$/

export function isSatUnitCodeValid(code) {
  if (!code) return false
  return SAT_UNIT_PATTERN.test(String(code).toUpperCase().trim())
}

export function findSatUnit(code) {
  if (!code) return null
  const c = String(code).toUpperCase().trim()
  return SAT_UNITS.find(u => u.code === c) || null
}
