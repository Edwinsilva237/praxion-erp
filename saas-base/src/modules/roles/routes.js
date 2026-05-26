'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const { query, withTransaction } = require('../../db')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

// Normaliza/valida los campos opcionales de preferencias del rol.
// Devuelve { mobileTabs, homeRoute } o lanza Error con .status para mandar 400.
function normalizePrefs({ mobileTabs, homeRoute }) {
  let tabs = null
  if (mobileTabs !== undefined && mobileTabs !== null) {
    if (!Array.isArray(mobileTabs)) {
      const e = new Error('mobileTabs debe ser un array.'); e.status = 400; throw e
    }
    if (mobileTabs.length > 5) {
      const e = new Error('mobileTabs no puede tener más de 5 elementos.'); e.status = 400; throw e
    }
    const clean = mobileTabs.map(t => String(t).trim()).filter(Boolean)
    tabs = clean.length ? clean : null
  }
  let route = null
  if (homeRoute !== undefined && homeRoute !== null) {
    const s = String(homeRoute).trim()
    if (s && !s.startsWith('/')) {
      const e = new Error('homeRoute debe empezar con "/".'); e.status = 400; throw e
    }
    route = s || null
  }
  return { mobileTabs: tabs, homeRoute: route }
}

/**
 * GET /api/roles
 * Lista todos los roles disponibles para el tenant (sistema + propios).
 */
router.get('/', checkPermission('roles', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.name, r.description, r.is_system, r.created_at,
              COUNT(rp.permission_id) AS permission_count
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.tenant_id = $1 OR r.tenant_id IS NULL
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.name ASC`,
      [req.tenant.id]
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/roles/:id
 * Detalle de un rol con sus permisos.
 */
router.get('/:id', checkPermission('roles', 'read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.name, r.description, r.is_system,
              r.mobile_tabs, r.home_route
       FROM roles r
       WHERE r.id = $1 AND (r.tenant_id = $2 OR r.tenant_id IS NULL)`,
      [req.params.id, req.tenant.id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' })
    }

    const role = rows[0]

    const { rows: perms } = await query(
      `SELECT p.id, p.resource, p.action, p.description
       FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1
       ORDER BY p.resource, p.action`,
      [role.id]
    )

    res.json({ ...role, permissions: perms })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/roles
 * Crea un rol personalizado para el tenant.
 * Body: { name, description, permissionIds[] }
 */
router.post('/', checkPermission('roles', 'create'), async (req, res, next) => {
  try {
    const { name, description, permissionIds = [] } = req.body

    if (!name) {
      return res.status(400).json({ error: 'name is required.' })
    }

    const { mobileTabs, homeRoute } = normalizePrefs(req.body)

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO roles (tenant_id, name, description, is_system, mobile_tabs, home_route)
         VALUES ($1, $2, $3, false, $4, $5)
         RETURNING id, name, description, is_system, mobile_tabs, home_route`,
        [req.tenant.id, name.trim(), description || null,
         mobileTabs ? JSON.stringify(mobileTabs) : null, homeRoute]
      )
      const role = rows[0]

      for (const permId of permissionIds) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role.id, permId]
        )
      }

      return role
    })

    res.status(201).json(result)
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A role with that name already exists.' })
    }
    if (err.status === 400) return res.status(400).json({ error: err.message })
    next(err)
  }
})

/**
 * PATCH /api/roles/:id
 * Edita un rol personalizado del tenant.
 * Body: { name?, description?, permissionIds[]? }
 */
router.patch('/:id', checkPermission('roles', 'update'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, is_system FROM roles WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' })
    }

    if (rows[0].is_system) {
      return res.status(403).json({ error: 'System roles cannot be modified.' })
    }

    const { name, description, permissionIds } = req.body
    const hasMobile = 'mobileTabs' in req.body
    const hasHome   = 'homeRoute'  in req.body
    const { mobileTabs, homeRoute } = normalizePrefs(req.body)

    await withTransaction(async (client) => {
      if (name || description !== undefined || hasMobile || hasHome) {
        await client.query(
          `UPDATE roles SET
             name        = COALESCE($1, name),
             description = COALESCE($2, description),
             mobile_tabs = CASE WHEN $4::boolean THEN $5::jsonb ELSE mobile_tabs END,
             home_route  = CASE WHEN $6::boolean THEN $7 ELSE home_route END
           WHERE id = $3`,
          [name || null,
           description !== undefined ? description : null,
           req.params.id,
           hasMobile, mobileTabs ? JSON.stringify(mobileTabs) : null,
           hasHome, homeRoute]
        )
      }

      if (Array.isArray(permissionIds)) {
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [req.params.id])
        for (const permId of permissionIds) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [req.params.id, permId]
          )
        }
      }
    })

    res.json({ message: 'Role updated.' })
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message })
    next(err)
  }
})

/**
 * DELETE /api/roles/:id
 * Elimina un rol personalizado del tenant.
 */
router.delete('/:id', checkPermission('roles', 'delete'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, is_system FROM roles WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' })
    }

    if (rows[0].is_system) {
      return res.status(403).json({ error: 'System roles cannot be deleted.' })
    }

    await query(`DELETE FROM roles WHERE id = $1`, [req.params.id])
    res.json({ message: 'Role deleted.' })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/roles/permissions/all
 * Lista todos los permisos disponibles en el sistema.
 */
router.get('/permissions/all', checkPermission('roles', 'read'), async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, resource, action, description
       FROM permissions
       ORDER BY resource, action`
    )
    res.json(rows)
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/roles/:id/assign
 * Asigna un rol a un usuario del tenant.
 * Body: { userId }
 */
router.post('/:id/assign', checkPermission('roles', 'assign'), async (req, res, next) => {
  try {
    const { userId } = req.body

    if (!userId) {
      return res.status(400).json({ error: 'userId is required.' })
    }

    // Verificar que el rol existe y pertenece al tenant (o es de sistema)
    const { rows: roleRows } = await query(
      `SELECT id FROM roles WHERE id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)`,
      [req.params.id, req.tenant.id]
    )

    if (roleRows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' })
    }

    // Verificar que el usuario pertenece al tenant
    const { rows: userRows } = await query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2`,
      [userId, req.tenant.id]
    )

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' })
    }

    await query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, req.params.id, req.auth.userId]
    )

    res.json({ message: 'Role assigned.' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
