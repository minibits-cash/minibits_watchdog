-- ============================================================================
-- Minibits Watchdog — CDK mint database introspection
-- ============================================================================
--
-- Purpose: discover the CDK mint's Postgres schema so the mint query module can
-- be written against real table/column names.
--
-- SAFETY
--   This script reads SYSTEM CATALOGS ONLY. It reads no application data, runs
--   no aggregates, performs no sequential scans, writes nothing, and takes no
--   locks beyond AccessShare on catalog tables. Safe to run against a live mint
--   at any time, as a read-only role.
--
--   Section 12 does not query data either — it GENERATES the SQL for a second
--   round based on the columns actually found, so nothing here is guessed.
--
-- RUN
--   docker exec -i <mint-pg-container> psql -U <user> -d <db> \
--     < introspect-mint-db.sql > mint-introspection.txt 2>&1
--
--   or:  psql "$MINT_DATABASE_URL" -f introspect-mint-db.sql > mint-introspection.txt 2>&1
--
--   Then send back mint-introspection.txt.
-- ============================================================================

\pset pager off
\pset format aligned
\set ON_ERROR_STOP off

\echo ''
\echo '===== 1. SERVER VERSION ====='
select version();

\echo ''
\echo '===== 2. SCHEMAS ====='
select nspname as schema
from pg_namespace
where nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  and nspname not like 'pg\_temp%'
  and nspname not like 'pg\_toast%'
order by 1;

\echo ''
\echo '===== 3. TABLES: approx row counts + size ====='
\echo '-- Drives the incremental-aggregation design: which tables are too big to SUM per tick.'
select
    n.nspname                                       as schema,
    c.relname                                       as table_name,
    c.reltuples::bigint                             as approx_rows,
    pg_size_pretty(pg_total_relation_size(c.oid))   as total_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg\_toast%'
order by pg_total_relation_size(c.oid) desc;

\echo ''
\echo '===== 4. COLUMNS (all tables and views) ====='
\echo '-- The primary output. Everything else supports reading this correctly.'
select
    table_schema        as schema,
    table_name,
    ordinal_position    as pos,
    column_name,
    data_type,
    is_nullable
from information_schema.columns
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name, ordinal_position;

\echo ''
\echo '===== 5. VIEWS ====='
select table_schema as schema, table_name
from information_schema.views
where table_schema not in ('pg_catalog', 'information_schema')
order by 1, 2;

\echo ''
\echo '===== 6. VIEW DEFINITIONS ====='
\echo '-- If CDK ships balance views, their definitions give us the accounting for free.'
select schemaname as schema, viewname, definition
from pg_views
where schemaname not in ('pg_catalog', 'information_schema')
order by 1, 2;

\echo ''
\echo '===== 7. INDEXES ====='
\echo '-- Determines whether watermark-based incremental aggregation can be index-driven.'
select schemaname as schema, tablename, indexname, indexdef
from pg_indexes
where schemaname not in ('pg_catalog', 'information_schema')
order by tablename, indexname;

\echo ''
\echo '===== 8. PRIMARY KEYS ====='
\echo '-- Candidate watermark columns for append-only aggregation.'
select
    tc.table_schema  as schema,
    tc.table_name,
    tc.constraint_name,
    string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as pk_columns
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
     on kcu.constraint_name = tc.constraint_name
    and kcu.table_schema    = tc.table_schema
where tc.constraint_type = 'PRIMARY KEY'
  and tc.table_schema not in ('pg_catalog', 'information_schema')
group by 1, 2, 3
order by 1, 2;

\echo ''
\echo '===== 9. TRIGGERS ====='
select
    event_object_schema as schema,
    event_object_table  as table_name,
    trigger_name,
    event_manipulation  as event,
    action_timing       as timing
from information_schema.triggers
where event_object_schema not in ('pg_catalog', 'information_schema')
order by 1, 2, 3;

\echo ''
\echo '===== 10. ENUM TYPES ====='
\echo '-- Proof / quote state values, if modelled as enums rather than text.'
select t.typname as type_name, e.enumlabel as value, e.enumsortorder as sort
from pg_type t
join pg_enum e on e.enumtypid = t.oid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname not in ('pg_catalog', 'information_schema')
order by t.typname, e.enumsortorder;

\echo ''
\echo '===== 11. ROLES ====='
\echo '-- Confirms whether a read-only role already exists.'
select rolname, rolsuper, rolcanlogin
from pg_roles
where rolname not like 'pg\_%'
order by 1;

\echo ''
\echo '===== 12. GENERATED STEP-2 QUERIES ====='
\echo '-- Catalog-only. Emits ready-to-run SQL derived from the columns actually'
\echo '-- present, so no CDK table names are guessed. Review, then run separately.'
\echo '-- NOTE: these DO scan data when run. Check sizes in section 3 first.'
\echo ''

\pset tuples_only on

\echo '-- 12a. totals for every table carrying an amount-like column'
select format(
           'select %L as source, count(*) as n, sum(%I) as total from %I.%I;',
           c.table_name || '.' || c.column_name,
           c.column_name, c.table_schema, c.table_name)
from information_schema.columns c
join information_schema.tables t
     on  t.table_schema = c.table_schema
     and t.table_name   = c.table_name
     and t.table_type   = 'BASE TABLE'
where c.table_schema not in ('pg_catalog', 'information_schema')
  and c.column_name ~* '^(amount|value|amount_msat|amount_sat|msat|sats?)$'
order by c.table_schema, c.table_name, c.column_name;

\echo ''
\echo '-- 12b. same, broken down by any state-like column on the same table'
select format(
           'select %L as source, %I as state, count(*) as n, sum(%I) as total from %I.%I group by %I order by %I;',
           a.table_name, s.column_name, a.column_name,
           a.table_schema, a.table_name, s.column_name, s.column_name)
from information_schema.columns a
join information_schema.columns s
     on  s.table_schema = a.table_schema
     and s.table_name   = a.table_name
join information_schema.tables t
     on  t.table_schema = a.table_schema
     and t.table_name   = a.table_name
     and t.table_type   = 'BASE TABLE'
where a.table_schema not in ('pg_catalog', 'information_schema')
  and a.column_name ~* '^(amount|value|amount_msat|amount_sat|msat|sats?)$'
  and s.column_name ~* '^(state|status)$'
order by a.table_schema, a.table_name;

\pset tuples_only off

\echo ''
\echo '===== DONE ====='
