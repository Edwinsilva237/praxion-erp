'use strict'

require('dotenv').config()
const { withTransaction, pool } = require('./index')
const logger = require('../config/logger')

const PERMISSIONS = [
  { resource: 'users',      action: 'read',   description: 'Ver listado y perfil de usuarios' },
  { resource: 'users',      action: 'create', description: 'Invitar nuevos usuarios al tenant' },
  { resource: 'users',      action: 'update', description: 'Editar datos de usuarios' },
  { resource: 'users',      action: 'delete', description: 'Desactivar o eliminar usuarios' },
  { resource: 'roles',      action: 'read',   description: 'Ver roles y sus permisos' },
  { resource: 'roles',      action: 'create', description: 'Crear roles personalizados' },
  { resource: 'roles',      action: 'update', description: 'Editar roles personalizados' },
  { resource: 'roles',      action: 'delete', description: 'Eliminar roles personalizados' },
  { resource: 'roles',      action: 'assign', description: 'Asignar roles a usuarios' },
  { resource: 'settings',   action: 'read',   description: 'Ver configuracion del tenant' },
  { resource: 'settings',   action: 'update', description: 'Modificar configuracion del tenant' },
  { resource: 'billing',    action: 'read',   description: 'Ver informacion de facturacion' },
  { resource: 'billing',    action: 'manage', description: 'Gestionar suscripcion y pagos' },
  { resource: 'audit_logs', action: 'read',   description: 'Ver logs de auditoria' },
]

const SYSTEM_ROLES = [
  {
    name: 'super_admin',
    description: 'Acceso total al tenant',
    permissions: PERMISSIONS.map((p) => `${p.resource}:${p.action}`),
  },
  {
    name: 'admin',
    description: 'Administrador del tenant',
    permissions: [
      'users:read', 'users:create', 'users:update', 'users:delete',
      'roles:read', 'roles:create', 'roles:update', 'roles:assign',
      'settings:read', 'settings:update',
      'billing:read',
      'audit_logs:read',
    ],
  },
  {
    name: 'member',
    description: 'Usuario estandar',
    permissions: ['users:read', 'roles:read', 'settings:read'],
  },
  {
    name: 'viewer',
    description: 'Solo lectura',
    permissions: ['users:read', 'settings:read'],
  },
]

async function seed() {
  await withTransaction(async (client) => {
    logger.info('Seeding permissions...')
    const permissionIds = {}

    for (const perm of PERMISSIONS) {
      const { rows } = await client.query(
        `INSERT INTO permissions (resource, action, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (resource, action) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, resource, action`,
        [perm.resource, perm.action, perm.description]
      )
      permissionIds[`${rows[0].resource}:${rows[0].action}`] = rows[0].id
    }

    logger.info(`Seeded ${PERMISSIONS.length} permissions.`)
    logger.info('Seeding system roles...')

    for (const role of SYSTEM_ROLES) {
      const { rows } = await client.query(
        `INSERT INTO roles (tenant_id, name, description, is_system)
         VALUES (NULL, $1, $2, true)
         ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
         RETURNING id, name`,
        [role.name, role.description]
      )
      const roleId = rows[0].id

      for (const permKey of role.permissions) {
        const permId = permissionIds[permKey]
        if (!permId) continue
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, permId]
        )
      }
    }

    logger.info(`Seeded ${SYSTEM_ROLES.length} system roles.`)
  })
}

seed()
  .then(() => { logger.info('Seed completed.'); pool.end() })
  .catch((err) => { logger.error('Seed failed:', err.message); pool.end(); process.exit(1) })
