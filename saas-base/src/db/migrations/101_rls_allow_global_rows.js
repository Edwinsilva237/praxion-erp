'use strict'

/**
 * Ajuste a las policies de RLS:
 *
 * Algunas tablas (notablemente `roles`) usan tenant_id=NULL para denotar
 * filas GLOBALES compartidas entre todos los tenants — p.ej. el rol
 * 'super_admin' es global. La policy original las ocultaba.
 *
 * Esta migration reescribe la policy para:
 *   - LECTURA (USING): permite filas del tenant actual O filas globales (NULL).
 *   - ESCRITURA (WITH CHECK): solo permite escribir filas del tenant actual.
 *     Un tenant NO puede crear/modificar filas globales — eso queda para
 *     migrations/seed corriendo como postgres (superuser bypassea RLS).
 */

const up = `
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
      EXECUTE format($f$
        CREATE POLICY rls_tenant ON %I
          AS PERMISSIVE
          FOR ALL
          USING (
            NOT rls_enforce()
            OR tenant_id IS NULL
            OR tenant_id = current_tenant_id()
          )
          WITH CHECK (
            NOT rls_enforce()
            OR tenant_id = current_tenant_id()
          )
      $f$, t.table_name);
    END LOOP;
  END $$;
`

const down = `
  -- Volver a la policy estricta (sin permitir leer NULL globales).
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

module.exports = { up, down }
