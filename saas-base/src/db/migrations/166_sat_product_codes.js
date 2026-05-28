'use strict'

/**
 * Mig 166 — catálogo global `sat_product_codes` (c_ClaveProdServ CFDI 4.0).
 *
 * Contexto (sesión 2026-05-29):
 *  Al capturar producto se pide la "Clave SAT del producto" (8 dígitos del
 *  c_ClaveProdServ). Hoy es un input libre — el usuario tiene que conocer
 *  el código y no hay forma de verificar que existe ni de ver a qué
 *  artículo corresponde.
 *
 *  Este catálogo es ENORME (~52,000 entradas) — embeberlo en frontend no
 *  es viable. Va a BD como catálogo global (sin tenant_id) y los tenants lo
 *  consultan via /api/sat/product-codes.
 *
 *  El seed incluye solo las claves más comunes en industria mexicana,
 *  representativas de los 4 verticales objetivo del SaaS (alimentos,
 *  plásticos, papel, químicos, servicios). El catálogo completo se carga
 *  después via bulk import (CSV desde el portal del SAT) — el endpoint
 *  acepta upsert por (code) así que ese import es idempotente.
 *
 *  Si el usuario teclea una clave que NO está en BD, el componente la
 *  acepta con advertencia "no verificada" pero sigue siendo válida para
 *  CFDI mientras exista en el catálogo oficial del SAT.
 */

const up = `
  -- pg_trgm habilita búsquedas fuzzy por nombre via índice GIN. Estándar en
  -- PostgreSQL >= 12. CREATE EXTENSION IF NOT EXISTS es idempotente.
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE TABLE sat_product_codes (
    code         TEXT        PRIMARY KEY,
    name         TEXT        NOT NULL,
    is_active    BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT spc_code_format CHECK (code ~ '^[0-9]{8}$')
  );

  CREATE INDEX spc_active ON sat_product_codes (is_active);
  CREATE INDEX spc_name_trgm ON sat_product_codes USING gin (name gin_trgm_ops);

  COMMENT ON TABLE sat_product_codes IS
    'Catálogo global c_ClaveProdServ del SAT (CFDI 4.0). Sin tenant_id — compartido entre todos los tenants. Seed inicial cubre las claves más comunes; catálogo completo via bulk import.';

  -- ─── Seed: claves más usadas en industria mexicana ───────────────────────
  INSERT INTO sat_product_codes (code, name) VALUES
    -- Materiales plásticos
    ('11121800', 'Materiales de plásticos en bruto'),
    ('11121806', 'Polietileno'),
    ('11121807', 'Polipropileno'),
    ('11121808', 'Poliestireno'),
    ('11121809', 'Cloruro de polivinilo'),
    ('11121903', 'Resinas plásticas'),
    ('12141500', 'Materiales abrasivos'),
    ('12161500', 'Materiales acabados'),

    -- Papel y empaque
    ('14111500', 'Papeles para impresión y escritura'),
    ('14111507', 'Cartón'),
    ('14111508', 'Papel kraft'),
    ('14111530', 'Cartulina'),
    ('14111605', 'Bolsas de papel'),
    ('14111703', 'Etiquetas'),
    ('14121500', 'Materiales para empaque y embalaje'),
    ('24111503', 'Cajas de cartón corrugado'),
    ('24111506', 'Cajas plegadizas'),
    ('24112400', 'Bolsas de plástico'),
    ('24121800', 'Etiquetas y rótulos'),

    -- Alimentos y bebidas (palomitas, frituras, pastelería)
    ('50000000', 'Alimentos, bebidas y tabaco'),
    ('50171550', 'Palomitas de maíz'),
    ('50171800', 'Botanas y bocadillos'),
    ('50180000', 'Productos de panadería'),
    ('50181700', 'Pasteles'),
    ('50181900', 'Galletas'),
    ('50192100', 'Confitería'),
    ('50202200', 'Maíz'),
    ('50202300', 'Cereales sin procesar'),
    ('50202400', 'Granos procesados'),
    ('50221200', 'Productos de aceite vegetal'),
    ('50221201', 'Aceite de coco'),
    ('50221202', 'Aceite de girasol'),
    ('50221203', 'Aceite de canola'),
    ('50221204', 'Aceite de soya'),
    ('50221205', 'Aceite de maíz'),
    ('50221206', 'Aceite vegetal mixto'),
    ('50221210', 'Mantequilla'),
    ('50301700', 'Azúcar'),
    ('50301800', 'Harinas'),
    ('50301801', 'Harina de trigo'),
    ('50301802', 'Harina de maíz'),
    ('50301900', 'Sal'),
    ('50302100', 'Saborizantes y condimentos'),

    -- Productos químicos
    ('12141900', 'Aditivos químicos'),
    ('12161800', 'Plastificantes'),
    ('12352300', 'Pigmentos'),
    ('51000000', 'Medicamentos y productos farmacéuticos'),

    -- Materiales y suministros generales
    ('44000000', 'Equipos y suministros de oficina'),
    ('44121700', 'Útiles de oficina'),
    ('44121800', 'Bolígrafos y plumas'),
    ('44121900', 'Cuadernos'),
    ('44122000', 'Carpetas'),

    -- Productos reciclables / esquineros
    ('24111200', 'Materiales de embalaje protector'),
    ('24111800', 'Esquineros de cartón'),
    ('31201500', 'Esquineros y protecciones'),
    ('76121500', 'Servicios de reciclaje'),
    ('76121501', 'Servicios de reciclaje de plástico'),
    ('76121503', 'Servicios de reciclaje de papel'),

    -- Maquinaria y equipo
    ('20000000', 'Maquinaria y accesorios'),
    ('23153000', 'Maquinaria para procesamiento de alimentos'),
    ('23153100', 'Maquinaria para empaque'),
    ('23241600', 'Maquinaria para procesamiento de plásticos'),

    -- Servicios
    ('80000000', 'Servicios empresariales y profesionales'),
    ('80101500', 'Servicios de consultoría de negocios'),
    ('80161500', 'Servicios de apoyo administrativo'),
    ('81111500', 'Servicios de desarrollo de software'),
    ('81112200', 'Servicios de mantenimiento de software'),
    ('82101500', 'Servicios de publicidad'),
    ('82141500', 'Servicios de diseño gráfico'),
    ('84111500', 'Servicios contables'),
    ('84111600', 'Servicios de impuestos'),
    ('84121500', 'Servicios bancarios'),
    ('85000000', 'Servicios de salud'),
    ('86000000', 'Servicios educativos'),
    ('86111500', 'Servicios de educación primaria'),
    ('90000000', 'Servicios de viajes, alimentación y entretenimiento'),
    ('90101500', 'Servicios de restaurante'),

    -- Transporte y logística
    ('78000000', 'Servicios de transporte, almacenaje y correo'),
    ('78101500', 'Transporte de carga por carretera'),
    ('78101800', 'Servicios de mensajería'),
    ('78111500', 'Transporte de pasajeros'),
    ('78121500', 'Servicios de almacenaje'),
    ('78180000', 'Servicios postales y de mensajería'),

    -- Combustibles y energía
    ('15000000', 'Materiales combustibles y lubricantes'),
    ('15101500', 'Gasolina'),
    ('15101600', 'Diésel'),
    ('15111500', 'Gas LP'),
    ('15111800', 'Gas natural'),
    ('83000000', 'Servicios públicos'),
    ('83101500', 'Servicios de agua potable'),
    ('83101800', 'Servicios de electricidad'),

    -- Ropa y calzado
    ('53000000', 'Vestuario, maletas y productos de aseo personal'),
    ('53101500', 'Ropa de hombre'),
    ('53101600', 'Ropa de mujer'),
    ('53111500', 'Calzado'),

    -- Mobiliario y enseres
    ('56000000', 'Muebles y mobiliario'),
    ('56101500', 'Sillas y sillones'),
    ('56101700', 'Mesas y escritorios'),
    ('56121500', 'Mobiliario médico'),

    -- Construcción
    ('30000000', 'Estructuras, componentes y equipos para construcción'),
    ('30181500', 'Concreto'),
    ('30181700', 'Cemento'),
    ('72000000', 'Servicios de edificación, construcción y mantenimiento'),
    ('72101500', 'Servicios de albañilería'),

    -- Reventa y catálogo genérico
    ('01010101', 'No existe en el catálogo')
  ON CONFLICT (code) DO NOTHING;
`

const down = `
  DROP TABLE IF EXISTS sat_product_codes;
`

module.exports = { up, down }
