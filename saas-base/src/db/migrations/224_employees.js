'use strict'

/**
 * Mig 224 — EMPLEADOS (cimiento del módulo de RH).
 *
 * Hoy las personas del sistema son `users` + `tenant_memberships` (solo quien
 * tiene login). Producción, RH y nómina necesitan una entidad de EMPLEADO con
 * datos laborales (fecha de ingreso, salario, puesto) que existe INDEPENDIENTE
 * de tener o no cuenta en el ERP — un operador de piso puede tener vacaciones
 * sin loguearse nunca.
 *
 * `user_id` liga opcionalmente al usuario del ERP (para que en el futuro
 * "Mis vacaciones" resuelva el empleado del que inició sesión). UNIQUE parcial:
 * un usuario del ERP no puede estar ligado a dos empleados.
 *
 * `hire_date` es OBLIGATORIO: es la base de la antigüedad y, por lo tanto, de
 * los días de vacaciones por la tabla LFT.
 *
 * `daily_salary` alimenta la prima vacacional (25% LFT) — informativo por ahora,
 * el pago se timbra en nómina (fuera de alcance).
 *
 * RLS: replica la policy estándar de la mig 099 (toda tabla NUEVA con tenant_id
 * debe habilitar su propia RLS).
 */

const up = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'employee_status') THEN
      CREATE TYPE employee_status AS ENUM ('active', 'inactive');
    END IF;
  END $$;

  CREATE TABLE employees (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          UUID            REFERENCES users(id) ON DELETE SET NULL,
    employee_number  VARCHAR(30)     NOT NULL,
    full_name        VARCHAR(160)    NOT NULL,
    hire_date        DATE            NOT NULL,
    daily_salary     NUMERIC(12,2),
    position         VARCHAR(120),
    department       VARCHAR(120),
    status           employee_status NOT NULL DEFAULT 'active',
    termination_date DATE,
    notes            TEXT,
    created_by       UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT emp_daily_salary_nonneg CHECK (daily_salary IS NULL OR daily_salary >= 0),
    CONSTRAINT emp_termination_after_hire CHECK (termination_date IS NULL OR termination_date >= hire_date),
    CONSTRAINT emp_number_unique UNIQUE (tenant_id, employee_number)
  );

  CREATE INDEX idx_emp_tenant  ON employees (tenant_id);
  CREATE INDEX idx_emp_status  ON employees (tenant_id, status);
  -- Un usuario del ERP se liga a lo más a un empleado (por tenant).
  CREATE UNIQUE INDEX idx_emp_user_unique ON employees (tenant_id, user_id)
    WHERE user_id IS NOT NULL;

  CREATE TRIGGER set_updated_at_employees
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

  ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
  ALTER TABLE employees FORCE  ROW LEVEL SECURITY;
  CREATE POLICY rls_tenant ON employees
    AS PERMISSIVE FOR ALL
    USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
    WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id());

  COMMENT ON TABLE employees IS
    'Empleados del tenant (RH). Existe independiente de users: cubre operadores sin login. user_id liga opcionalmente al usuario del ERP.';
`

const down = `
  DROP POLICY IF EXISTS rls_tenant ON employees;
  DROP TRIGGER IF EXISTS set_updated_at_employees ON employees;
  DROP TABLE IF EXISTS employees CASCADE;
  DROP TYPE IF EXISTS employee_status;
`

module.exports = { up, down }
