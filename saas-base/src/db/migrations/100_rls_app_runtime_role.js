'use strict'

/**
 * Rol `app_runtime` para el backend.
 *
 * RAZÓN: PostgreSQL ignora RLS cuando el usuario es SUPERUSER. Para que el
 * doble candado realmente funcione, el backend NO puede conectarse como
 * `postgres`. Creamos un rol con privilegios CRUD amplios pero sin
 * SUPERUSER ni BYPASSRLS.
 *
 * Esta migration crea el rol pero NO cambia el .env del usuario. La
 * activación es manual:
 *   1) En .env del backend: DB_USER=app_runtime, DB_PASSWORD=<el que pongas>
 *   2) Setear contraseña real con:
 *      ALTER ROLE app_runtime WITH LOGIN PASSWORD 'tu_password_segura';
 *   3) APP_RLS_ENFORCE=true en .env
 *   4) Reiniciar backend
 *
 * Las migrations siguen corriendo como postgres (superuser) para tener
 * permisos de DDL.
 */

const up = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      -- Password placeholder — el admin DEBE cambiarla antes de usar este rol:
      -- ALTER ROLE app_runtime WITH PASSWORD 'tu_password_segura';
      CREATE ROLE app_runtime LOGIN PASSWORD 'change_me_via_alter_role';
    END IF;
  END $$;

  -- Permisos sobre el schema actual
  GRANT USAGE ON SCHEMA public TO app_runtime;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_runtime;
  GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
  GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;

  -- Permisos sobre tablas/funciones que se creen en el FUTURO
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT                  ON SEQUENCES TO app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE                        ON FUNCTIONS TO app_runtime;

  -- pg-boss usa un schema separado. Damos acceso para que el backend pueda
  -- crear y consumir jobs sin que pg-boss tenga que correr como superuser.
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
      GRANT USAGE ON SCHEMA pgboss TO app_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_runtime;
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime';
    END IF;
  END $$;
`

const down = `
  -- Revocar y borrar rol. Si quedan objetos owned por app_runtime, REASSIGN primero.
  REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM app_runtime;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;
  REVOKE USAGE ON SCHEMA public FROM app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM app_runtime;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM app_runtime;
  DROP ROLE IF EXISTS app_runtime;
`

module.exports = { up, down }
