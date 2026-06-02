'use strict'

/**
 * Mig 186 — Permisos FINOS para subir evidencia, aislados de la edición.
 *
 * Problema: subir evidencia iba amarrado a `sales:update` (registrar entrega de
 * remisión) y `purchases:create` (evidencia de recepción), que además otorgan
 * edición/creación. Un rol de "repartidor" no debería poder editar ventas ni
 * crear compras solo por subir la prueba de entrega.
 *
 * Solución: dos acciones nuevas, granulares:
 *   - `sales:deliver`            → registrar la entrega de una remisión con
 *                                  evidencia (foto/firma). NO edita ventas.
 *   - `purchases:upload_evidence`→ subir evidencia a una recepción de material.
 *                                  NO crea ni edita compras.
 *
 * Los endpoints aceptan el permiso NUEVO **o** el amplio existente
 * (checkAnyPermission), así los roles actuales (con update/create) siguen
 * funcionando sin cambios.
 *
 * Se otorgan a `super_admin` (dueño). Los roles del tenant los activan a mano
 * desde el editor de roles (aparecen bajo Comercial / Compras con su
 * descripción). Idempotente vía NOT EXISTS.
 */

const up = `
  INSERT INTO permissions (resource, action, description)
  SELECT 'sales', 'deliver', 'Registrar entrega de remisiones con evidencia (foto/firma) — sin editar ventas'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'sales' AND action = 'deliver'
   );

  INSERT INTO permissions (resource, action, description)
  SELECT 'purchases', 'upload_evidence', 'Subir evidencia a recepciones de material — sin crear ni editar compras'
   WHERE NOT EXISTS (
     SELECT 1 FROM permissions WHERE resource = 'purchases' AND action = 'upload_evidence'
   );

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
    FROM roles r, permissions p
   WHERE r.name = 'super_admin'
     AND ( (p.resource = 'sales'     AND p.action = 'deliver')
        OR (p.resource = 'purchases' AND p.action = 'upload_evidence') )
     AND NOT EXISTS (
       SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
     );
`

const down = `
  DELETE FROM permissions
   WHERE (resource = 'sales'     AND action = 'deliver')
      OR (resource = 'purchases' AND action = 'upload_evidence');
`

module.exports = { up, down }
