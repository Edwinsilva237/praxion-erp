'use strict'

/**
 * Mig 170 — 10 catalogos fiscales del SAT para validar pre-timbrado.
 *
 * Carga desde catCFDI_V_4_*.xls oficial del Anexo 20 los catalogos:
 *  - sat_regimen_fiscal    (19)    persona fisica/moral aplicable
 *  - sat_uso_cfdi          (24)   uso del CFDI + regimenes compatibles
 *  - sat_forma_pago        (22)  bancarizado
 *  - sat_metodo_pago       (2) PUE / PPD
 *  - sat_objeto_imp        (8)  objeto de impuesto por concepto
 *  - sat_impuesto          (3)   IVA / ISR / IEPS
 *  - sat_tipo_factor       (3) Tasa / Cuota / Exento
 *  - sat_tasa_cuota        (20)  rangos validos
 *  - sat_tipo_comprobante  (5)   I, E, T, N, P, R
 *  - sat_pais              (250)       para receptores extranjeros
 *
 * El frontend consume estos via /api/sat/<catalogo> y los muestra como
 * dropdowns en formularios fiscales (cliente, factura, conceptos).
 */

const up = `
  -- ─── Tablas ────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS sat_regimen_fiscal (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    fisica      BOOLEAN NOT NULL DEFAULT false,
    moral       BOOLEAN NOT NULL DEFAULT false,
    is_active   BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_uso_cfdi (
    code            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    fisica          BOOLEAN NOT NULL DEFAULT false,
    moral           BOOLEAN NOT NULL DEFAULT false,
    regimenes_csv   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_forma_pago (
    code         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    bancarizado  BOOLEAN NOT NULL DEFAULT false,
    is_active    BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_metodo_pago (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_objeto_imp (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_impuesto (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tipo_factor (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tasa_cuota (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    valor_min  TEXT,
    valor_max  TEXT,
    is_active  BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_tipo_comprobante (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    valor_maximo   TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT true
  );

  CREATE TABLE IF NOT EXISTS sat_pais (
    code      TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true
  );

  -- ─── Datos ────────────────────────────────────────────────────────────────
  INSERT INTO sat_regimen_fiscal (code, name, fisica, moral) VALUES
    ('601', 'General de Ley Personas Morales', false, true),
    ('603', 'Personas Morales con Fines no Lucrativos', false, true),
    ('605', 'Sueldos y Salarios e Ingresos Asimilados a Salarios', true, false),
    ('606', 'Arrendamiento', true, false),
    ('607', 'Régimen de Enajenación o Adquisición de Bienes', true, false),
    ('608', 'Demás ingresos', true, false),
    ('610', 'Residentes en el Extranjero sin Establecimiento Permanente en México', true, true),
    ('611', 'Ingresos por Dividendos (socios y accionistas)', true, false),
    ('612', 'Personas Físicas con Actividades Empresariales y Profesionales', true, false),
    ('614', 'Ingresos por intereses', true, false),
    ('615', 'Régimen de los ingresos por obtención de premios', true, false),
    ('616', 'Sin obligaciones fiscales', true, false),
    ('620', 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos', false, true),
    ('621', 'Incorporación Fiscal', true, false),
    ('622', 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras', false, true),
    ('623', 'Opcional para Grupos de Sociedades', false, true),
    ('624', 'Coordinados', false, true),
    ('625', 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', true, false),
    ('626', 'Régimen Simplificado de Confianza', true, true)
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, fisica = EXCLUDED.fisica, moral = EXCLUDED.moral;

  INSERT INTO sat_uso_cfdi (code, name, fisica, moral, regimenes_csv) VALUES
    ('G01', 'Adquisición de mercancías.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625,626'),
    ('G02', 'Devoluciones, descuentos o bonificaciones.', true, true, '601, 603, 606, 612, 616, 620, 621, 622, 623, 624, 625,626'),
    ('G03', 'Gastos en general.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I01', 'Construcciones.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I02', 'Mobiliario y equipo de oficina por inversiones.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I03', 'Equipo de transporte.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I04', 'Equipo de computo y accesorios.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I05', 'Dados, troqueles, moldes, matrices y herramental.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I06', 'Comunicaciones telefónicas.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I07', 'Comunicaciones satelitales.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('I08', 'Otra maquinaria y equipo.', true, true, '601, 603, 606, 612, 620, 621, 622, 623, 624, 625, 626'),
    ('D01', 'Honorarios médicos, dentales y gastos hospitalarios.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D02', 'Gastos médicos por incapacidad o discapacidad.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D03', 'Gastos funerales.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D04', 'Donativos.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D05', 'Intereses reales efectivamente pagados por créditos hipotecarios (casa habitación).', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D06', 'Aportaciones voluntarias al SAR.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D07', 'Primas por seguros de gastos médicos.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D08', 'Gastos de transportación escolar obligatoria.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D09', 'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones.', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('D10', 'Pagos por servicios educativos (colegiaturas).', true, false, '605, 606, 608, 611, 612, 614, 607, 615, 625'),
    ('S01', 'Sin efectos fiscales.', true, true, '601, 603, 605, 606, 608, 610, 611, 612, 614, 616, 620, 621, 622, 623, 624, 607, 615, 625, 626'),
    ('CP01', 'Pagos', true, true, '601, 603, 605, 606, 608, 610, 611, 612, 614, 616, 620, 621, 622, 623, 624, 607, 615, 625, 626'),
    ('CN01', 'Nómina', true, false, '605')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, fisica = EXCLUDED.fisica, moral = EXCLUDED.moral, regimenes_csv = EXCLUDED.regimenes_csv;

  INSERT INTO sat_forma_pago (code, name, bancarizado) VALUES
    ('01', 'Efectivo', false),
    ('02', 'Cheque nominativo', true),
    ('03', 'Transferencia electrónica de fondos', true),
    ('04', 'Tarjeta de crédito', true),
    ('05', 'Monedero electrónico', true),
    ('06', 'Dinero electrónico', true),
    ('08', 'Vales de despensa', false),
    ('12', 'Dación en pago', false),
    ('13', 'Pago por subrogación', false),
    ('14', 'Pago por consignación', false),
    ('15', 'Condonación', false),
    ('17', 'Compensación', false),
    ('23', 'Novación', false),
    ('24', 'Confusión', false),
    ('25', 'Remisión de deuda', false),
    ('26', 'Prescripción o caducidad', false),
    ('27', 'A satisfacción del acreedor', false),
    ('28', 'Tarjeta de débito', true),
    ('29', 'Tarjeta de servicios', true),
    ('30', 'Aplicación de anticipos', false),
    ('31', 'Intermediario pagos', false),
    ('99', 'Por definir', false)
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, bancarizado = EXCLUDED.bancarizado;

  INSERT INTO sat_metodo_pago (code, name) VALUES
    ('PUE', 'Pago en una sola exhibición'),
    ('PPD', 'Pago en parcialidades o diferido')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO sat_objeto_imp (code, name) VALUES
    ('01', 'No objeto de impuesto.'),
    ('02', 'Sí objeto de impuesto.'),
    ('03', 'Sí objeto del impuesto y no obligado al desglose.'),
    ('04', 'Sí objeto del impuesto y no causa impuesto.'),
    ('05', 'Sí objeto del impuesto, IVA crédito PODEBI.'),
    ('06', 'Sí objeto del IVA, No traslado IVA.'),
    ('07', 'No traslado del IVA, Sí desglose IEPS.'),
    ('08', 'No traslado del IVA, No desglose IEPS.')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO sat_impuesto (code, name) VALUES
    ('001', 'ISR'),
    ('002', 'IVA'),
    ('003', 'IEPS')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO sat_tipo_factor (code, name) VALUES
    ('Tasa', '1/1/22'),
    ('Cuota', '1/1/22'),
    ('Exento', '1/1/22')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO sat_tasa_cuota (code, name, valor_min, valor_max) VALUES
    ('Rango o Fijo', 'c_TasaOCuota', NULL, 'Impuesto'),
    ('Fijo', '', '0.000000', 'IVA'),
    ('Rango', '0.000000', '0.160000', 'IVA')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, valor_min = EXCLUDED.valor_min, valor_max = EXCLUDED.valor_max;

  INSERT INTO sat_tipo_comprobante (code, name, valor_maximo) VALUES
    ('I', 'Ingreso', '999999999999999999.999999'),
    ('E', 'Egreso', '999999999999999999.999999'),
    ('T', 'Traslado', '0'),
    ('N', 'Nómina', 'NS'),
    ('P', 'Pago', '999999999999999999.999999')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, valor_maximo = EXCLUDED.valor_maximo;

  INSERT INTO sat_pais (code, name) VALUES
    ('AFG', 'Afganistán'),
    ('ALA', 'Islas Åland'),
    ('ALB', 'Albania'),
    ('DEU', 'Alemania'),
    ('AND', 'Andorra'),
    ('AGO', 'Angola'),
    ('AIA', 'Anguila'),
    ('ATA', 'Antártida'),
    ('ATG', 'Antigua y Barbuda'),
    ('SAU', 'Arabia Saudita'),
    ('DZA', 'Argelia'),
    ('ARG', 'Argentina'),
    ('ARM', 'Armenia'),
    ('ABW', 'Aruba'),
    ('AUS', 'Australia'),
    ('AUT', 'Austria'),
    ('AZE', 'Azerbaiyán'),
    ('BHS', 'Bahamas (las)'),
    ('BGD', 'Bangladés'),
    ('BRB', 'Barbados'),
    ('BHR', 'Baréin'),
    ('BEL', 'Bélgica'),
    ('BLZ', 'Belice'),
    ('BEN', 'Benín'),
    ('BMU', 'Bermudas'),
    ('BLR', 'Bielorrusia'),
    ('MMR', 'Myanmar'),
    ('BOL', 'Bolivia, Estado Plurinacional de'),
    ('BIH', 'Bosnia y Herzegovina'),
    ('BWA', 'Botsuana'),
    ('BRA', 'Brasil'),
    ('BRN', 'Brunéi Darussalam'),
    ('BGR', 'Bulgaria'),
    ('BFA', 'Burkina Faso'),
    ('BDI', 'Burundi'),
    ('BTN', 'Bután'),
    ('CPV', 'Cabo Verde'),
    ('KHM', 'Camboya'),
    ('CMR', 'Camerún'),
    ('CAN', 'Canadá'),
    ('QAT', 'Catar'),
    ('BES', 'Bonaire, San Eustaquio y Saba'),
    ('TCD', 'Chad'),
    ('CHL', 'Chile'),
    ('CHN', 'China'),
    ('CYP', 'Chipre'),
    ('COL', 'Colombia'),
    ('COM', 'Comoras'),
    ('PRK', 'Corea (la República Democrática Popular de)'),
    ('KOR', 'Corea (la República de)'),
    ('CIV', 'Côte d''Ivoire'),
    ('CRI', 'Costa Rica'),
    ('HRV', 'Croacia'),
    ('CUB', 'Cuba'),
    ('CUW', 'Curaçao'),
    ('DNK', 'Dinamarca'),
    ('DMA', 'Dominica'),
    ('ECU', 'Ecuador'),
    ('EGY', 'Egipto'),
    ('SLV', 'El Salvador'),
    ('ARE', 'Emiratos Árabes Unidos (Los)'),
    ('ERI', 'Eritrea'),
    ('SVK', 'Eslovaquia'),
    ('SVN', 'Eslovenia'),
    ('ESP', 'España'),
    ('USA', 'Estados Unidos (los)'),
    ('EST', 'Estonia'),
    ('ETH', 'Etiopía'),
    ('PHL', 'Filipinas (las)'),
    ('FIN', 'Finlandia'),
    ('FJI', 'Fiyi'),
    ('FRA', 'Francia'),
    ('GAB', 'Gabón'),
    ('GMB', 'Gambia (La)'),
    ('GEO', 'Georgia'),
    ('GHA', 'Ghana'),
    ('GIB', 'Gibraltar'),
    ('GRD', 'Granada'),
    ('GRC', 'Grecia'),
    ('GRL', 'Groenlandia'),
    ('GLP', 'Guadalupe'),
    ('GUM', 'Guam'),
    ('GTM', 'Guatemala'),
    ('GUF', 'Guayana Francesa'),
    ('GGY', 'Guernsey'),
    ('GIN', 'Guinea'),
    ('GNB', 'Guinea-Bisáu'),
    ('GNQ', 'Guinea Ecuatorial'),
    ('GUY', 'Guyana'),
    ('HTI', 'Haití'),
    ('HND', 'Honduras'),
    ('HKG', 'Hong Kong'),
    ('HUN', 'Hungría'),
    ('IND', 'India'),
    ('IDN', 'Indonesia'),
    ('IRQ', 'Irak'),
    ('IRN', 'Irán (la República Islámica de)'),
    ('IRL', 'Irlanda'),
    ('BVT', 'Isla Bouvet'),
    ('IMN', 'Isla de Man'),
    ('CXR', 'Isla de Navidad'),
    ('NFK', 'Isla Norfolk'),
    ('ISL', 'Islandia'),
    ('CYM', 'Islas Caimán (las)'),
    ('CCK', 'Islas Cocos (Keeling)'),
    ('COK', 'Islas Cook (las)'),
    ('FRO', 'Islas Feroe (las)'),
    ('SGS', 'Georgia del sur y las islas sandwich del sur'),
    ('HMD', 'Isla Heard e Islas McDonald'),
    ('FLK', 'Islas Malvinas [Falkland] (las)'),
    ('MNP', 'Islas Marianas del Norte (las)'),
    ('MHL', 'Islas Marshall (las)'),
    ('PCN', 'Pitcairn'),
    ('SLB', 'Islas Salomón (las)'),
    ('TCA', 'Islas Turcas y Caicos (las)'),
    ('UMI', 'Islas de Ultramar Menores de Estados Unidos (las)'),
    ('VGB', 'Islas Vírgenes (Británicas)'),
    ('VIR', 'Islas Vírgenes (EE.UU.)'),
    ('ISR', 'Israel'),
    ('ITA', 'Italia'),
    ('JAM', 'Jamaica'),
    ('JPN', 'Japón'),
    ('JEY', 'Jersey'),
    ('JOR', 'Jordania'),
    ('KAZ', 'Kazajistán'),
    ('KEN', 'Kenia'),
    ('KGZ', 'Kirguistán'),
    ('KIR', 'Kiribati'),
    ('KWT', 'Kuwait'),
    ('LAO', 'Lao, (la) República Democrática Popular'),
    ('LSO', 'Lesoto'),
    ('LVA', 'Letonia'),
    ('LBN', 'Líbano'),
    ('LBR', 'Liberia'),
    ('LBY', 'Libia'),
    ('LIE', 'Liechtenstein'),
    ('LTU', 'Lituania'),
    ('LUX', 'Luxemburgo'),
    ('MAC', 'Macao'),
    ('MDG', 'Madagascar'),
    ('MYS', 'Malasia'),
    ('MWI', 'Malaui'),
    ('MDV', 'Maldivas'),
    ('MLI', 'Malí'),
    ('MLT', 'Malta'),
    ('MAR', 'Marruecos'),
    ('MTQ', 'Martinica'),
    ('MUS', 'Mauricio'),
    ('MRT', 'Mauritania'),
    ('MYT', 'Mayotte'),
    ('MEX', 'México'),
    ('FSM', 'Micronesia (los Estados Federados de)'),
    ('MDA', 'Moldavia (la República de)'),
    ('MCO', 'Mónaco'),
    ('MNG', 'Mongolia'),
    ('MNE', 'Montenegro'),
    ('MSR', 'Montserrat'),
    ('MOZ', 'Mozambique'),
    ('NAM', 'Namibia'),
    ('NRU', 'Nauru'),
    ('NPL', 'Nepal'),
    ('NIC', 'Nicaragua'),
    ('NER', 'Níger (el)'),
    ('NGA', 'Nigeria'),
    ('NIU', 'Niue'),
    ('NOR', 'Noruega'),
    ('NCL', 'Nueva Caledonia'),
    ('NZL', 'Nueva Zelanda'),
    ('OMN', 'Omán'),
    ('NLD', 'Países Bajos (los)'),
    ('PAK', 'Pakistán'),
    ('PLW', 'Palaos'),
    ('PSE', 'Palestina, Estado de'),
    ('PAN', 'Panamá'),
    ('PNG', 'Papúa Nueva Guinea'),
    ('PRY', 'Paraguay'),
    ('PER', 'Perú'),
    ('PYF', 'Polinesia Francesa'),
    ('POL', 'Polonia'),
    ('PRT', 'Portugal'),
    ('PRI', 'Puerto Rico'),
    ('GBR', 'Reino Unido (el)'),
    ('CAF', 'República Centroafricana (la)'),
    ('CZE', 'República Checa (la)'),
    ('MKD', 'Macedonia (la antigua República Yugoslava de)'),
    ('COG', 'Congo'),
    ('COD', 'Congo (la República Democrática del)'),
    ('DOM', 'República Dominicana (la)'),
    ('REU', 'Reunión'),
    ('RWA', 'Ruanda'),
    ('ROU', 'Rumania'),
    ('RUS', 'Rusia, (la) Federación de'),
    ('ESH', 'Sahara Occidental'),
    ('WSM', 'Samoa'),
    ('ASM', 'Samoa Americana'),
    ('BLM', 'San Bartolomé'),
    ('KNA', 'San Cristóbal y Nieves'),
    ('SMR', 'San Marino'),
    ('MAF', 'San Martín (parte francesa)'),
    ('SPM', 'San Pedro y Miquelón'),
    ('VCT', 'San Vicente y las Granadinas'),
    ('SHN', 'Santa Helena, Ascensión y Tristán de Acuña'),
    ('LCA', 'Santa Lucía'),
    ('STP', 'Santo Tomé y Príncipe'),
    ('SEN', 'Senegal'),
    ('SRB', 'Serbia'),
    ('SYC', 'Seychelles'),
    ('SLE', 'Sierra leona'),
    ('SGP', 'Singapur'),
    ('SXM', 'Sint Maarten (parte holandesa)'),
    ('SYR', 'Siria, (la) República Árabe'),
    ('SOM', 'Somalia'),
    ('LKA', 'Sri Lanka'),
    ('SWZ', 'Suazilandia'),
    ('ZAF', 'Sudáfrica'),
    ('SDN', 'Sudán (el)'),
    ('SSD', 'Sudán del Sur'),
    ('SWE', 'Suecia'),
    ('CHE', 'Suiza'),
    ('SUR', 'Surinam'),
    ('SJM', 'Svalbard y Jan Mayen'),
    ('THA', 'Tailandia'),
    ('TWN', 'Taiwán (Provincia de China)'),
    ('TZA', 'Tanzania, República Unida de'),
    ('TJK', 'Tayikistán'),
    ('IOT', 'Territorio Británico del Océano Índico (el)'),
    ('ATF', 'Territorios Australes Franceses (los)'),
    ('TLS', 'Timor-Leste'),
    ('TGO', 'Togo'),
    ('TKL', 'Tokelau'),
    ('TON', 'Tonga'),
    ('TTO', 'Trinidad y Tobago'),
    ('TUN', 'Túnez'),
    ('TKM', 'Turkmenistán'),
    ('TUR', 'Turquía'),
    ('TUV', 'Tuvalu'),
    ('UKR', 'Ucrania'),
    ('UGA', 'Uganda'),
    ('URY', 'Uruguay'),
    ('UZB', 'Uzbekistán'),
    ('VUT', 'Vanuatu'),
    ('VAT', 'Santa Sede[Estado de la Ciudad del Vaticano] (la)'),
    ('VEN', 'Venezuela, República Bolivariana de'),
    ('VNM', 'Viet Nam'),
    ('WLF', 'Wallis y Futuna'),
    ('YEM', 'Yemen'),
    ('DJI', 'Yibuti'),
    ('ZMB', 'Zambia'),
    ('ZWE', 'Zimbabue'),
    ('ZZZ', 'Países no declarados')
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
`

const down = `
  DROP TABLE IF EXISTS sat_pais, sat_tipo_comprobante, sat_tasa_cuota,
    sat_tipo_factor, sat_impuesto, sat_objeto_imp, sat_metodo_pago,
    sat_forma_pago, sat_uso_cfdi, sat_regimen_fiscal;
`

module.exports = { up, down }
