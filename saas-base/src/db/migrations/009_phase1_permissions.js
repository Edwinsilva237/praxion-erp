'use strict'

const up = `
  INSERT INTO permissions (resource, action, description) VALUES
    ('products',          'read',    'Ver catálogo de productos'),
    ('products',          'create',  'Crear productos'),
    ('products',          'update',  'Editar productos'),
    ('products',          'delete',  'Eliminar productos'),
    ('raw_materials',     'read',    'Ver materias primas'),
    ('raw_materials',     'create',  'Crear materias primas'),
    ('raw_materials',     'update',  'Editar materias primas'),
    ('warehouses',        'read',    'Ver almacenes'),
    ('warehouses',        'create',  'Crear almacenes'),
    ('warehouses',        'update',  'Editar almacenes'),
    ('business_partners', 'read',    'Ver clientes y proveedores'),
    ('business_partners', 'create',  'Crear clientes y proveedores'),
    ('business_partners', 'update',  'Editar clientes y proveedores'),
    ('business_partners', 'delete',  'Eliminar clientes y proveedores'),
    ('production',        'read',    'Ver órdenes de producción'),
    ('production',        'create',  'Crear órdenes de producción'),
    ('production',        'update',  'Actualizar avances de producción'),
    ('production',        'approve', 'Validar y cerrar turnos de producción'),
    ('production',        'manage',  'Gestión completa — gerencia'),
    ('inventory',         'read',    'Ver inventario y movimientos'),
    ('inventory',         'create',  'Registrar entradas de inventario'),
    ('inventory',         'adjust',  'Ajustes manuales de inventario'),
    ('scrap',             'read',    'Ver lotes de scrap'),
    ('scrap',             'create',  'Registrar scrap en turno'),
    ('scrap',             'approve', 'Autorizar decisiones de scrap — gerencia'),
    ('attachments',       'read',    'Ver archivos adjuntos'),
    ('attachments',       'create',  'Subir archivos adjuntos'),
    ('attachments',       'delete',  'Eliminar archivos adjuntos')
  ON CONFLICT (resource, action) DO NOTHING;
`

const down = `
  DELETE FROM permissions WHERE resource IN (
    'products', 'raw_materials', 'warehouses', 'business_partners',
    'production', 'inventory', 'scrap', 'attachments'
  );
`

module.exports = { up, down }
