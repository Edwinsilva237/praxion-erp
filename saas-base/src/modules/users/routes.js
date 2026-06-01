'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const userService = require('./userService')
const { query } = require('../../db')

const router = express.Router()

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

router.get('/', checkPermission('users', 'read'), async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search } = req.query
    const result = await userService.listUsers({
      tenantId: req.tenant.id,
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 100),
      search,
    })
    res.json(result)
  } catch (err) { next(err) }
})

router.get('/:id', checkPermission('users', 'read'), async (req, res, next) => {
  try {
    const user = await userService.getUserById({ userId: req.params.id, tenantId: req.tenant.id })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json(user)
  } catch (err) { next(err) }
})

router.post('/invite', checkPermission('users', 'create'), async (req, res, next) => {
  try {
    const { email, fullName, roleIds } = req.body
    if (!email || !fullName) return res.status(400).json({ error: 'email and fullName are required.' })

    // Obtener nombre del invitador para el email
    const { rows } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.auth.userId])
    const invitedByName = rows[0]?.full_name || 'Un administrador'

    const result = await userService.inviteUser({
      tenantId:      req.tenant.id,
      tenantName:    req.tenant.name,
      email,
      fullName,
      roleIds:       roleIds || [],
      invitedBy:     req.auth.userId,
      invitedByName,
      ipAddress:     req.ip,
      userAgent:     req.get('user-agent'),
    })

    res.status(201).json({
      user:      result.user,
      emailSent: result.emailSent,
      message:   result.emailSent
        ? 'Invitación enviada por correo.'
        : 'Usuario creado, pero el correo de invitación no pudo enviarse. Comparte las credenciales manualmente.',
      // Solo si el correo NO salió, devolvemos las credenciales para que el admin
      // se las pase al invitado a mano (si no, quedaría sin poder entrar).
      ...(result.emailSent ? {} : {
        emailError:  result.emailError,
        credentials: { email: result.user.email, tempPassword: result.tempPassword },
      }),
    })
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' })
    next(err)
  }
})

// Reenviar invitación a un usuario que aún no inició sesión (correo falló o se
// perdió). Regenera la contraseña temporal. Mismo permiso que invitar.
router.post('/:id/resend-invitation', checkPermission('users', 'create'), async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT full_name FROM users WHERE id = $1`, [req.auth.userId])
    const invitedByName = rows[0]?.full_name || 'Un administrador'

    const result = await userService.resendInvitation({
      userId:        req.params.id,
      tenantId:      req.tenant.id,
      tenantName:    req.tenant.name,
      invitedByName,
      requesterId:   req.auth.userId,
      ipAddress:     req.ip,
      userAgent:     req.get('user-agent'),
    })

    res.json({
      emailSent: result.emailSent,
      message:   result.emailSent
        ? 'Invitación reenviada por correo.'
        : 'No se pudo enviar el correo. Comparte las credenciales manualmente.',
      ...(result.emailSent ? {} : {
        emailError:  result.emailError,
        credentials: { email: result.user.email, tempPassword: result.tempPassword },
      }),
    })
  } catch (err) { next(err) }
})

router.patch('/:id', checkPermission('users', 'update'), async (req, res, next) => {
  try {
    const { fullName, isActive } = req.body
    const user = await userService.updateUser({
      userId: req.params.id, tenantId: req.tenant.id,
      fullName, isActive, requesterId: req.auth.userId,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json(user)
  } catch (err) { next(err) }
})

router.delete('/:id', checkPermission('users', 'delete'), async (req, res, next) => {
  try {
    const user = await userService.deactivateUser({
      userId: req.params.id, tenantId: req.tenant.id,
      requesterId: req.auth.userId,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json({ message: `User ${user.email} deactivated.` })
  } catch (err) { next(err) }
})

/**
 * PUT /api/users/:id/roles
 * Reemplaza la lista completa de roles asignados a un usuario.
 * Body: { roleIds: [uuid] }
 */
router.put('/:id/roles', checkPermission('roles', 'assign'), async (req, res, next) => {
  try {
    const { roleIds, primaryRoleId } = req.body
    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'roleIds debe ser un arreglo.' })
    }

    // Verificar que el usuario pertenece al tenant
    const { rows: userRows } = await query(
      `SELECT id FROM users WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    )
    if (!userRows.length) return res.status(404).json({ error: 'Usuario no encontrado.' })

    // Dedup por si llegan repetidos desde el frontend.
    const uniqueRoleIds = [...new Set(roleIds)]

    // Validar que todos los roles existen y son accesibles para el tenant.
    // Si alguno no aparece (no existe, o pertenece a otro tenant), devolvemos
    // los ids fallidos para diagnosticar (un rol viejo, un rol eliminado, etc).
    if (uniqueRoleIds.length > 0) {
      const { rows: roleRows } = await query(
        `SELECT id FROM roles
          WHERE id = ANY($1::uuid[]) AND (tenant_id = $2 OR tenant_id IS NULL)`,
        [uniqueRoleIds, req.tenant.id]
      )
      if (roleRows.length !== uniqueRoleIds.length) {
        const found  = new Set(roleRows.map(r => r.id))
        const missing = uniqueRoleIds.filter(id => !found.has(id))
        return res.status(400).json({
          error: 'Uno o más roles no son válidos para este tenant.',
          missingRoleIds: missing,
        })
      }
    }

    // Validar primary_role: si viene, debe estar entre los roleIds asignados.
    let primaryRoleClean = null
    if (primaryRoleId !== undefined && primaryRoleId !== null && primaryRoleId !== '') {
      if (!uniqueRoleIds.includes(primaryRoleId)) {
        return res.status(400).json({
          error: 'El rol principal debe ser uno de los roles asignados al usuario.',
        })
      }
      primaryRoleClean = primaryRoleId
    }

    const { withTransaction } = require('../../db')
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [req.params.id])
      for (const roleId of uniqueRoleIds) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_id, assigned_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [req.params.id, roleId, req.auth.userId]
        )
      }
      // Actualizar primary_role_id en la misma transacción. Si vino vacío,
      // queda NULL — el usuario opera con fallback (rol más reciente).
      await client.query(
        `UPDATE users SET primary_role_id = $1 WHERE id = $2`,
        [primaryRoleClean, req.params.id]
      )
    })

    res.json({
      message: 'Roles actualizados.',
      roleIds: uniqueRoleIds,
      primaryRoleId: primaryRoleClean,
    })
  } catch (err) { next(err) }
})

module.exports = router
