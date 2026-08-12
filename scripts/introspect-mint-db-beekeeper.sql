-- ============================================================================
-- Minibits Watchdog — CDK mint introspection (GUI client version)
-- ============================================================================
--
-- For Beekeeper Studio, DBeaver, pgAdmin, TablePlus etc. — any client that does
-- not support psql backslash meta-commands.
--
-- This is ONE statement returning ONE text column named "report". Run it, click
-- into the grid, select the whole column and copy.
--
-- SAFETY: reads system catalogs only. No application data, no aggregates, no
-- sequential scans, no writes. Safe against a live mint.
--
-- Section 8 of the output PRINTS follow-up SQL rather than running it. Review
-- and run those separately (they do scan data).
-- ============================================================================

WITH t AS (
    SELECT n.nspname                                     AS sch,
           c.relname                                     AS tbl,
           c.reltuples::bigint                           AS approx_rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
),
lines AS (

    -- ---- 1. version -------------------------------------------------------
    SELECT 1 AS sec, '0' AS sub, '===== 1. SERVER VERSION =====' AS line
    UNION ALL SELECT 1, '1', version()

    -- ---- 2. tables and columns -------------------------------------------
    UNION ALL SELECT 2, '0', ''
    UNION ALL SELECT 2, '1', '===== 2. TABLES AND COLUMNS ====='
    UNION ALL
    SELECT 2, '2|' || t.sch || '.' || t.tbl || '|0000',
           format('TABLE %s.%s   (~%s rows, %s)', t.sch, t.tbl, t.approx_rows, t.size)
    FROM t
    UNION ALL
    SELECT 2, '2|' || c.table_schema || '.' || c.table_name || '|'
              || lpad(c.ordinal_position::text, 4, '0'),
           format('      %s  %s%s', c.column_name, c.data_type,
                  CASE WHEN c.is_nullable = 'NO' THEN '  NOT NULL' ELSE '' END)
    FROM information_schema.columns c
    JOIN t ON t.sch = c.table_schema AND t.tbl = c.table_name

    -- ---- 3. views ---------------------------------------------------------
    UNION ALL SELECT 3, '0', ''
    UNION ALL SELECT 3, '1', '===== 3. VIEWS (definitions give us the accounting for free) ====='
    UNION ALL
    SELECT 3, '2|' || v.schemaname || '.' || v.viewname,
           format('VIEW %s.%s%s%s', v.schemaname, v.viewname, chr(10), v.definition)
    FROM pg_views v
    WHERE v.schemaname NOT IN ('pg_catalog', 'information_schema')

    -- ---- 4. indexes -------------------------------------------------------
    UNION ALL SELECT 4, '0', ''
    UNION ALL SELECT 4, '1', '===== 4. INDEXES ====='
    UNION ALL
    SELECT 4, '2|' || i.tablename || '|' || i.indexname, '  ' || i.indexdef
    FROM pg_indexes i
    WHERE i.schemaname NOT IN ('pg_catalog', 'information_schema')

    -- ---- 5. primary keys --------------------------------------------------
    UNION ALL SELECT 5, '0', ''
    UNION ALL SELECT 5, '1', '===== 5. PRIMARY KEYS (candidate watermark columns) ====='
    UNION ALL
    SELECT 5, '2|' || tc.table_schema || '.' || tc.table_name,
           format('  %s.%s  PK(%s)', tc.table_schema, tc.table_name,
                  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position))
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
         ON  kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema    = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    GROUP BY tc.table_schema, tc.table_name

    -- ---- 6. triggers ------------------------------------------------------
    UNION ALL SELECT 6, '0', ''
    UNION ALL SELECT 6, '1', '===== 6. TRIGGERS ====='
    UNION ALL
    SELECT DISTINCT 6, '2|' || tr.event_object_table || '|' || tr.trigger_name,
           format('  %s on %s.%s (%s %s)', tr.trigger_name, tr.event_object_schema,
                  tr.event_object_table, tr.action_timing, tr.event_manipulation)
    FROM information_schema.triggers tr
    WHERE tr.event_object_schema NOT IN ('pg_catalog', 'information_schema')

    -- ---- 7. enum types ----------------------------------------------------
    UNION ALL SELECT 7, '0', ''
    UNION ALL SELECT 7, '1', '===== 7. ENUM TYPES (proof / quote states) ====='
    UNION ALL
    SELECT 7, '2|' || ty.typname || '|' || lpad(e.enumsortorder::text, 6, '0'),
           format('  %s = %s', ty.typname, e.enumlabel)
    FROM pg_type ty
    JOIN pg_enum e ON e.enumtypid = ty.oid
    JOIN pg_namespace n ON n.oid = ty.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')

    -- ---- 8. generated follow-up queries -----------------------------------
    UNION ALL SELECT 8, '0', ''
    UNION ALL SELECT 8, '1', '===== 8. GENERATED STEP-2 QUERIES (review, then run separately) ====='
    UNION ALL SELECT 8, '2', '-- these DO scan data; check sizes in section 2 first'
    UNION ALL
    SELECT 8, '3|' || c.table_name || '|' || c.column_name,
           format('select %L as source, count(*) as n, sum(%I) as total from %I.%I;',
                  c.table_name || '.' || c.column_name,
                  c.column_name, c.table_schema, c.table_name)
    FROM information_schema.columns c
    JOIN t ON t.sch = c.table_schema AND t.tbl = c.table_name
    WHERE c.column_name ~* '^(amount|value|amount_msat|amount_sat|msat|sats?)$'
    UNION ALL
    SELECT 8, '4|' || a.table_name || '|' || s.column_name,
           format('select %L as source, %I as state, count(*) as n, sum(%I) as total from %I.%I group by %I order by %I;',
                  a.table_name, s.column_name, a.column_name,
                  a.table_schema, a.table_name, s.column_name, s.column_name)
    FROM information_schema.columns a
    JOIN information_schema.columns s
         ON  s.table_schema = a.table_schema
         AND s.table_name   = a.table_name
    JOIN t ON t.sch = a.table_schema AND t.tbl = a.table_name
    WHERE a.column_name ~* '^(amount|value|amount_msat|amount_sat|msat|sats?)$'
      AND s.column_name ~* '^(state|status)$'
)
SELECT line AS report
FROM lines
ORDER BY sec, sub;
