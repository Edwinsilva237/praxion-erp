'use strict'

/**
 * users.primary_role_id
 *
 * Cuando un usuario tiene varios roles asignados con preferencias distintas
 * (mobile_tabs, home_route), necesitamos un mecanismo explícito para decidir
 * cuál gana. Antes el código tomaba "el rol propio más reciente con valor",
 * que es arbitrario y confunde.
 *
 * Esta columna apunta a uno de los roles del usuario y desempata. Cuando es
 * NULL, se mantiene el comportamiento anterior (fallback).
 *
 * Validación de consistencia (que primary_role_id esté efectivamente entre
 * los roles asignados al usuario) se hace en backend al guardar — no como
 * constraint de BD porque no podemos referenciar user_roles desde aquí.
 *
 * ON DELETE SET NULL: si el rol se elimina, el usuario queda sin "principal"
 * y vuelve al fallback. No queremos cascada a users.
 */

const up = `
  ALTER TABLE users
    ADD COLUMN primary_role_id UUID REFERENCES roles(id) ON DELETE SET NULL;

  CREATE INDEX idx_users_primary_role ON users (primary_role_id);

  COMMENT ON COLUMN users.primary_role_id IS
    'Rol "principal" del usuario — desempata mobile_tabs/home_route cuando tiene varios roles. NULL = fallback al rol propio más reciente.';
`

const down = `
  DROP INDEX IF EXISTS idx_users_primary_role;
  ALTER TABLE users DROP COLUMN IF EXISTS primary_role_id;
`

module.exports = { up, down }
