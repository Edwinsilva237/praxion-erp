'use strict'

/**
 * Row-Level Security (RLS): doble candado entre tenants.
 *
 * Antes: aislamiento depende 100% de que cada query del backend filtre por
 * tenant_id en el WHERE. Olvidar el filtro = leak entre clientes.
 *
 * Después: PostgreSQL aplica un filtro automático a nivel del motor. Aunque
 * el código se olvide del WHERE tenant_id, PG solo devuelve filas del tenant
 * cuyo UUID esté en `app.tenant_id` (variable de sesión que setea el backend
 * en cada request).
 *
 * INTERRUPTOR: la policy revisa `app.rls_enforce`. Si es 'true', aplica el
 * filtro. Si es 'false' o no está seteado, las queries pasan sin filtro RLS
 * (comportamiento legacy). Esto permite activar/desactivar sin tocar código.
 *
 * Para activarlo en producción:
 *   - Setear APP_RLS_ENFORCE=true en .env y reiniciar backend
 *   - O en SQL directo: `ALTER DATABASE ... SET app.rls_enforce = 'true';`
 *
 * Migrations: cuando esta migration se aplica, RLS queda HABILITADO en las
 * tablas pero el interruptor está APAGADO — así no rompe nada de inmediato.
 */

const up = `
  -- ── Funciones helper ────────────────────────────────────────────────────
  -- current_tenant_id() lee la variable de sesión 'app.tenant_id'.
  -- nullif(..., '') hace que retorne NULL si está vacía en lugar de error.
  CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid;
  $$ LANGUAGE sql STABLE;

  -- rls_enforce() es el INTERRUPTOR. Retorna true sólo si la variable de
  -- sesión 'app.rls_enforce' está explícitamente seteada a 'true'.
  CREATE OR REPLACE FUNCTION rls_enforce() RETURNS boolean AS $$
    SELECT coalesce(current_setting('app.rls_enforce', true), 'false') = 'true';
  $$ LANGUAGE sql STABLE;

  -- ── Aplicar RLS a todas las tablas con tenant_id ─────────────────────────
  -- En vez de listar las 50 tablas a mano, las recorremos. Esto significa
  -- que tablas FUTURAS con tenant_id también necesitarán esta migration
  -- aplicada — agregaremos un step a la migration que las crea.
  DO $$
  DECLARE
    t record;
  BEGIN
    FOR t IN
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tt
          ON tt.table_name = c.table_name AND tt.table_schema = c.table_schema
       WHERE c.column_name = 'tenant_id'
         AND c.table_schema = 'public'
         AND tt.table_type = 'BASE TABLE'  -- excluir VIEWs (no soportan RLS)
         -- Si en el futuro hay tablas que deban quedar fuera del RLS,
         -- agregar: AND c.table_name <> 'nombre_tabla'
    LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t.table_name);

      -- Policy estándar: pasa si el interruptor está apagado O si la fila
      -- es del tenant actual. WITH CHECK asegura que INSERT/UPDATE solo
      -- pueden grabar filas del tenant actual cuando RLS está activo.
      EXECUTE format($f$
        CREATE POLICY rls_tenant ON %I
          AS PERMISSIVE
          FOR ALL
          USING (NOT rls_enforce() OR tenant_id = current_tenant_id())
          WITH CHECK (NOT rls_enforce() OR tenant_id = current_tenant_id())
      $f$, t.table_name);
    END LOOP;
  END $$;
`

const down = `
  -- Revertir: borrar todas las policies y deshabilitar RLS.
  DO $$
  DECLARE
    t record;
  BEGIN
    FOR t IN
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tt
          ON tt.table_name = c.table_name AND tt.table_schema = c.table_schema
       WHERE c.column_name = 'tenant_id'
         AND c.table_schema = 'public'
         AND tt.table_type = 'BASE TABLE'
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS rls_tenant ON %I', t.table_name);
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t.table_name);
      EXECUTE format('ALTER TABLE %I DISABLE   ROW LEVEL SECURITY', t.table_name);
    END LOOP;
  END $$;

  DROP FUNCTION IF EXISTS rls_enforce();
  DROP FUNCTION IF EXISTS current_tenant_id();
`

module.exports = { up, down }
