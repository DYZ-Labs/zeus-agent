-- Run after applying ../migrations/202608120001_consumer_v1.sql to a disposable
-- Supabase database:
--   psql "$HOSTED_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/two_user_isolation.sql
--
-- The transaction always rolls back. It requires the migration/CI role so it
-- can create auth fixtures and then SET ROLE to the non-BYPASSRLS app roles.

\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '00000000-0000-4000-8000-00000000a001',
    'authenticated',
    'authenticated',
    'alice-isolation@example.invalid',
    '',
    clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    '00000000-0000-4000-8000-00000000b002',
    'authenticated',
    'authenticated',
    'bob-isolation@example.invalid',
    '',
    clock_timestamp(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    clock_timestamp(),
    clock_timestamp()
  );

insert into zeus.experience_setting (user_id) values
  ('00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b002');

insert into zeus.conversation (id, user_id, title) values
  ('10000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'Alice private chat'),
  ('10000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', 'Alice second private chat'),
  ('10000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'Bob private chat');

insert into zeus.message (id, user_id, conversation_id, role, content) values
  ('20000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a001', 'user', 'Alice evidence'),
  ('21000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a001', 'assistant', 'Alice answer'),
  ('20000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a003', 'user', 'Alice second evidence'),
  ('21000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a003', 'assistant', 'Alice second answer'),
  ('23000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a003', 'user', 'A😀B'),
  ('20000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000b002', 'user', 'Bob evidence'),
  ('21000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000b002', 'assistant', 'Bob answer');

insert into zeus.evidence_passage (
  id, user_id, message_id, start_offset, end_offset, quote
) values
  ('22000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', 0, 14, 'Alice evidence'),
  ('22000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a003', 0, 5, 'Alice'),
  ('22100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '23000000-0000-4000-8000-00000000a003', 1, 3, '😀'),
  ('22200000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '23000000-0000-4000-8000-00000000a003', 3, 4, 'B'),
  ('22000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', 0, 12, 'Bob evidence');

insert into zeus.response_trace (
  id, user_id, conversation_id, assistant_message_id, model, prompt_version
) values
  ('30000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a001', '21000000-0000-4000-8000-00000000a001', 'test-model', 'test-v1'),
  ('30000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000b002', '21000000-0000-4000-8000-00000000b002', 'test-model', 'test-v1');

insert into zeus.entity (id, user_id, kind, canonical_name) values
  ('40000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'person', 'Alice'),
  ('40000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'person', 'Bob');

insert into zeus.fact (
  id, user_id, subject_entity_id, predicate, object_text, valid_from,
  confidence, source_message_id, searchable_text
) values
  ('50000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '40000000-0000-4000-8000-00000000a001', 'likes', 'tea', clock_timestamp(), 1, '20000000-0000-4000-8000-00000000a001', 'Alice likes tea'),
  ('50000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '40000000-0000-4000-8000-00000000b002', 'likes', 'coffee', clock_timestamp(), 1, '20000000-0000-4000-8000-00000000b002', 'Bob likes coffee');

insert into zeus.fact_evidence (
  id, user_id, fact_id, source_message_id, passage_id, evidence_kind
) values
  ('51000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '50000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001', 'assertion'),
  ('51100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '50000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a003', '22000000-0000-4000-8000-00000000a003', 'reassertion'),
  ('51000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '50000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002', 'assertion');

insert into zeus.response_trace_item (
  id, user_id, response_trace_id, rank, item_kind, resource_id, snapshot
) values
  ('31000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '30000000-0000-4000-8000-00000000a001', 0, 'fact', '50000000-0000-4000-8000-00000000a001', '{"kind":"fact"}'),
  ('31000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '30000000-0000-4000-8000-00000000b002', 0, 'fact', '50000000-0000-4000-8000-00000000b002', '{"kind":"fact"}');

insert into zeus.memory_candidate (
  id, user_id, source_message_id, candidate_kind, category, statement,
  proposed_data, reason
) values
  ('60000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', 'fact', 'Preferences', 'Alice may like green tea', '{}', 'uncertain'),
  ('60000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', 'fact', 'Preferences', 'Bob may like espresso', '{}', 'uncertain');

insert into zeus.candidate_evidence (
  id, user_id, candidate_id, passage_id
) values
  ('63000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '60000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001'),
  ('63000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '60000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002');

insert into zeus.understanding_facet (
  id, user_id, category, scope_kind, statement, valid_from, source_message_id
) values
  ('61000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'preference', 'person', 'Alice values calm mornings', clock_timestamp(), '20000000-0000-4000-8000-00000000a001'),
  ('61000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'preference', 'person', 'Bob values focused afternoons', clock_timestamp(), '20000000-0000-4000-8000-00000000b002');

insert into zeus.facet_evidence (
  id, user_id, facet_id, source_message_id, passage_id, evidence_kind
) values
  ('62000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '61000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001', 'assertion'),
  ('62100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '61000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a003', '22000000-0000-4000-8000-00000000a003', 'reassertion'),
  ('62000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '61000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002', 'assertion');

insert into zeus.project (
  id, user_id, title, source_message_id
) values
  ('70000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'Alice project', '20000000-0000-4000-8000-00000000a001'),
  ('70000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'Bob project', '20000000-0000-4000-8000-00000000b002');

insert into zeus.response_trace_item (
  id, user_id, response_trace_id, rank, item_kind, resource_id, snapshot
) values
  ('31100000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '30000000-0000-4000-8000-00000000a001', 1, 'project', '70000000-0000-4000-8000-00000000a001', '{"kind":"project"}'),
  ('31100000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '30000000-0000-4000-8000-00000000b002', 1, 'project', '70000000-0000-4000-8000-00000000b002', '{"kind":"project"}');

insert into zeus.project_event (
  id, user_id, project_id, event_type, source_message_id, passage_id
) values
  ('73000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '70000000-0000-4000-8000-00000000a001', 'created', '20000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001'),
  ('73100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '70000000-0000-4000-8000-00000000a001', 'reasserted', '20000000-0000-4000-8000-00000000a003', '22000000-0000-4000-8000-00000000a003'),
  ('73000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '70000000-0000-4000-8000-00000000b002', 'created', '20000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002');

insert into zeus.goal (
  id, user_id, project_id, title, source_message_id
) values
  ('71000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '70000000-0000-4000-8000-00000000a001', 'Alice goal', '20000000-0000-4000-8000-00000000a001'),
  ('71000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '70000000-0000-4000-8000-00000000b002', 'Bob goal', '20000000-0000-4000-8000-00000000b002');

insert into zeus.goal_event (
  id, user_id, goal_id, event_type, source_message_id, passage_id
) values
  ('74000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '71000000-0000-4000-8000-00000000a001', 'created', '20000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001'),
  ('74100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '71000000-0000-4000-8000-00000000a001', 'reasserted', '20000000-0000-4000-8000-00000000a003', '22000000-0000-4000-8000-00000000a003'),
  ('74000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '71000000-0000-4000-8000-00000000b002', 'created', '20000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002');

insert into zeus.commitment (
  id, user_id, project_id, linked_goal_id, title, source_message_id
) values
  ('72000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '70000000-0000-4000-8000-00000000a001', '71000000-0000-4000-8000-00000000a001', 'Alice commitment', '20000000-0000-4000-8000-00000000a001'),
  ('72000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '70000000-0000-4000-8000-00000000b002', '71000000-0000-4000-8000-00000000b002', 'Bob commitment', '20000000-0000-4000-8000-00000000b002');

insert into zeus.commitment_event (
  id, user_id, commitment_id, event_type, source_message_id, passage_id
) values
  ('75000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '72000000-0000-4000-8000-00000000a001', 'created', '20000000-0000-4000-8000-00000000a001', '22000000-0000-4000-8000-00000000a001'),
  ('75100000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000a001', '72000000-0000-4000-8000-00000000a001', 'reasserted', '20000000-0000-4000-8000-00000000a003', '22000000-0000-4000-8000-00000000a003'),
  ('75000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '72000000-0000-4000-8000-00000000b002', 'created', '20000000-0000-4000-8000-00000000b002', '22000000-0000-4000-8000-00000000b002');

insert into zeus.memory_job (
  id, user_id, conversation_id, source_message_id, assistant_message_id,
  prompt_version, remembering_mode
) values
  ('80000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', '21000000-0000-4000-8000-00000000a001', 'extract-v1', 'automatic'),
  ('80000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', '21000000-0000-4000-8000-00000000b002', 'extract-v1', 'automatic');

insert into zeus.memory_change_set (
  id, user_id, memory_job_id
) values
  ('82000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '80000000-0000-4000-8000-00000000a001'),
  ('82000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '80000000-0000-4000-8000-00000000b002');

insert into zeus.memory_change (
  id, user_id, change_set_id, resource_kind, resource_id, action,
  after_snapshot, record_version_after
) values
  ('83000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '82000000-0000-4000-8000-00000000a001', 'fact', '50000000-0000-4000-8000-00000000a001', 'insert', '{"value":"tea"}', 1),
  ('83000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '82000000-0000-4000-8000-00000000b002', 'fact', '50000000-0000-4000-8000-00000000b002', 'insert', '{"value":"coffee"}', 1);

insert into zeus.memory_job_activity (
  id, user_id, memory_job_id, resource_kind, resource_id, source_message_id,
  item_kind, change_type, label
) values
  ('81000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', '80000000-0000-4000-8000-00000000a001', 'fact', '50000000-0000-4000-8000-00000000a001', '20000000-0000-4000-8000-00000000a001', 'preference', 'saved', 'Likes tea'),
  ('81000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', '80000000-0000-4000-8000-00000000b002', 'fact', '50000000-0000-4000-8000-00000000b002', '20000000-0000-4000-8000-00000000b002', 'preference', 'saved', 'Likes coffee');

insert into zeus.data_export_job (id, user_id) values
  ('90000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001'),
  ('90000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002');

insert into zeus.deletion_request (
  id, user_id, scope, impact_snapshot
) values
  ('91000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'clear_data', '{}'),
  ('91000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'clear_data', '{}');

insert into zeus.deletion_request (
  id, user_id, scope, requested_target_id, live_target_id, impact_snapshot
) values
  ('92000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a001', 'conversation', '10000000-0000-4000-8000-00000000a001', '10000000-0000-4000-8000-00000000a001', '{}'),
  ('92000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000b002', 'conversation', '10000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000b002', '{}');

-- A new global table must start inaccessible to application roles. This probe
-- directly exercises the migration owner's default-privilege posture, then is
-- dropped before private-table schema assertions run.
create table zeus.default_privilege_probe (id bigint primary key);

do $global_acl_assertions$
declare
  role_name text;
  table_name text;
  predicate_count integer;
begin
  select count(*) into predicate_count
  from zeus.predicate_registry
  where name = any(array[
    'works_at', 'job_title', 'lives_in', 'birthday', 'timezone',
    'relationship_to_user', 'status', 'likes', 'dislikes', 'knows',
    'works_on', 'cares_about', 'goal', 'prefers', 'note'
  ]);
  if predicate_count <> 15 then
    raise exception 'hosted predicate registry does not match the local built-ins';
  end if;
  if has_table_privilege('zeus_app', 'zeus.predicate_registry', 'INSERT')
    or has_table_privilege('zeus_app', 'zeus.predicate_registry', 'UPDATE')
    or has_table_privilege('zeus_app', 'zeus.predicate_registry', 'DELETE')
    or has_table_privilege('zeus_worker', 'zeus.predicate_registry', 'INSERT')
    or has_table_privilege('zeus_worker', 'zeus.predicate_registry', 'UPDATE')
    or has_table_privilege('zeus_worker', 'zeus.predicate_registry', 'DELETE')
  then
    raise exception 'application roles can mutate the global predicate registry';
  end if;

  if has_table_privilege('zeus_app', 'zeus.default_privilege_probe', 'SELECT')
    or has_table_privilege('zeus_app', 'zeus.default_privilege_probe', 'INSERT')
    or has_table_privilege('zeus_worker', 'zeus.default_privilege_probe', 'SELECT')
    or has_table_privilege('zeus_worker', 'zeus.default_privilege_probe', 'INSERT')
  then
    raise exception 'future global tables inherit application privileges';
  end if;

  foreach role_name in array array['zeus_app', 'zeus_worker']
  loop
    foreach table_name in array array[
      'message', 'response_trace', 'response_trace_item', 'fact_evidence',
      'candidate_evidence', 'candidate_resolution_event', 'facet_evidence',
      'project_event', 'goal_event', 'commitment_event',
      'follow_through_event', 'memory_change', 'memory_job_activity'
    ]
    loop
      if has_table_privilege(role_name, format('zeus.%I', table_name), 'UPDATE')
        or has_table_privilege(role_name, format('zeus.%I', table_name), 'DELETE')
      then
        raise exception '% can rewrite append-only zeus.%', role_name, table_name;
      end if;
    end loop;
  end loop;
end
$global_acl_assertions$;

drop table zeus.default_privilege_probe;

-- Schema-level safety invariants: all private tables are FORCE RLS, all have a
-- NOT NULL user_id, and all tenant-to-tenant FKs carry user_id on both sides.
do $schema_assertions$
declare
  failures integer;
begin
  select count(*) into failures
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'zeus'
    and c.relkind = 'r'
    and c.relname <> 'predicate_registry'
    and (not c.relrowsecurity or not c.relforcerowsecurity);
  if failures <> 0 then
    raise exception '% private tables are missing forced RLS', failures;
  end if;

  select count(*) into failures
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'zeus'
    and c.relkind = 'r'
    and c.relname <> 'predicate_registry'
    and not exists (
      select 1
      from pg_attribute a
      where a.attrelid = c.oid
        and a.attname = 'user_id'
        and a.attnotnull
        and not a.attisdropped
    );
  if failures <> 0 then
    raise exception '% private tables lack a NOT NULL user_id', failures;
  end if;

  select count(*) into failures
  from pg_constraint fk
  join pg_class child on child.oid = fk.conrelid
  join pg_namespace child_ns on child_ns.oid = child.relnamespace
  join pg_class parent on parent.oid = fk.confrelid
  join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
  where fk.contype = 'f'
    and child_ns.nspname = 'zeus'
    and parent_ns.nspname = 'zeus'
    and parent.relname <> 'predicate_registry'
    and (
      (select a.attname from pg_attribute a
       where a.attrelid = child.oid and a.attnum = fk.conkey[1]) <> 'user_id'
      or
      (select a.attname from pg_attribute a
       where a.attrelid = parent.oid and a.attnum = fk.confkey[1]) <> 'user_id'
    );
  if failures <> 0 then
    raise exception '% private relationships lack a composite tenant FK', failures;
  end if;

  select count(*) into failures
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'zeus'
    and c.relkind = 'r'
    and c.relname <> 'predicate_registry'
    and not exists (
      select 1 from pg_policy p where p.polrelid = c.oid
    );
  if failures <> 0 then
    raise exception '% private tables lack a tenant policy', failures;
  end if;

  select count(*) into failures
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'zeus'
    and c.relname <> 'predicate_registry'
    and (
      pg_get_expr(p.polqual, p.polrelid) not like '%auth.uid()%'
      or pg_get_expr(p.polwithcheck, p.polrelid) not like '%auth.uid()%'
    );
  if failures <> 0 then
    raise exception '% private policies do not derive both predicates from auth.uid()', failures;
  end if;

  select count(*) into failures
  from unnest(array[
    'fact', 'memory_candidate', 'understanding_facet',
    'project', 'goal', 'commitment'
  ]) as tracked(table_name)
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'zeus'
      and c.relname = tracked.table_name
      and a.attname = 'record_version'
      and a.attnotnull
      and not a.attisdropped
  );
  if failures <> 0 then
    raise exception '% memory-change resources lack a non-null record version', failures;
  end if;

  select count(*) into failures
  from unnest(array[
    'fact', 'memory_candidate', 'understanding_facet',
    'project', 'goal', 'commitment'
  ]) as tracked(table_name)
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_trigger trigger on trigger.tgrelid = c.oid and not trigger.tgisinternal
    where n.nspname = 'zeus'
      and c.relname = tracked.table_name
      and trigger.tgname = tracked.table_name || '_bump_record_version'
  );
  if failures <> 0 then
    raise exception '% memory-change resources lack automatic version bumps', failures;
  end if;
end
$schema_assertions$;

-- Application roles cannot update append-only rows at all. Exercise the
-- underlying UPDATE-time relationship guards as the migration role as well,
-- so a future privilege change cannot turn an old valid row into a forged one.
do $owner_update_integrity$
declare
  binding record;
begin
  begin
    update zeus.response_trace
    set assistant_message_id = '21000000-0000-4000-8000-00000000a003'
    where id = '30000000-0000-4000-8000-00000000a001';
    raise exception 'response trace update crossed conversations';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update zeus.response_trace_item
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '31000000-0000-4000-8000-00000000a001';
    raise exception 'response trace item update crossed tenants';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.candidate_evidence
    set passage_id = '22000000-0000-4000-8000-00000000a003'
    where id = '63000000-0000-4000-8000-00000000a001';
    raise exception 'candidate evidence update crossed source messages';
  exception
    when check_violation then null;
  end;

  for binding in
    select *
    from (values
      ('fact_evidence', '51000000-0000-4000-8000-00000000a001'::uuid),
      ('facet_evidence', '62000000-0000-4000-8000-00000000a001'::uuid),
      ('project_event', '73000000-0000-4000-8000-00000000a001'::uuid),
      ('goal_event', '74000000-0000-4000-8000-00000000a001'::uuid),
      ('commitment_event', '75000000-0000-4000-8000-00000000a001'::uuid)
    ) as cases(table_name, existing_id)
  loop
    begin
      execute format(
        'update zeus.%I set passage_id = $1 where id = $2',
        binding.table_name
      ) using
        '22000000-0000-4000-8000-00000000a003'::uuid,
        binding.existing_id;
      raise exception '% update crossed source messages', binding.table_name;
    exception
      when foreign_key_violation then null;
    end;
  end loop;

  begin
    update zeus.memory_change
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '83000000-0000-4000-8000-00000000a001';
    raise exception 'memory change update crossed tenants';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.memory_job_activity
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '81000000-0000-4000-8000-00000000a001';
    raise exception 'memory activity update crossed tenants';
  exception
    when check_violation then null;
  end;
end
$owner_update_integrity$;

set local role zeus_app;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);

do $alice_visibility$
declare
  count_rows integer;
  table_name text;
  verified_tenant uuid;
begin
  select zeus_private.require_verified_tenant() into verified_tenant;
  if verified_tenant <> '00000000-0000-4000-8000-00000000a001'::uuid then
    raise exception 'transaction tenant verification returned the wrong account';
  end if;

  select count(*) into count_rows from zeus.conversation;
  if count_rows <> 2 then raise exception 'Alice conversation export scope leaked'; end if;

  select count(*) into count_rows
  from zeus.conversation
  where id = '10000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed conversation id leaked'; end if;

  select count(*) into count_rows
  from zeus.message
  where id = '20000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed message id leaked'; end if;

  select count(*) into count_rows
  from zeus.response_trace
  where id = '30000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed response trace id leaked'; end if;

  select count(*) into count_rows
  from zeus.fact
  where id = '50000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed fact id leaked'; end if;

  select count(*) into count_rows
  from zeus.memory_candidate
  where id = '60000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed review id leaked'; end if;

  select count(*) into count_rows
  from zeus.memory_job
  where id = '80000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed memory job id leaked'; end if;

  select count(*) into count_rows
  from zeus.memory_job_activity
  where id = '81000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed job activity id leaked'; end if;

  select count(*) into count_rows
  from zeus.data_export_job
  where id = '90000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed export id leaked'; end if;

  select count(*) into count_rows
  from zeus.deletion_request
  where id = '91000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'guessed deletion id leaked'; end if;

  -- This dynamic pass is the export-boundary test: an Alice-scoped export can
  -- never observe a Bob row from any present or future private table.
  for table_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'zeus'
      and c.relkind = 'r'
      and c.relname <> 'predicate_registry'
  loop
    execute format(
      'select count(*) from zeus.%I where user_id is distinct from ''00000000-0000-4000-8000-00000000a001''::uuid',
      table_name
    ) into count_rows;
    if count_rows <> 0 then
      raise exception 'cross-tenant export rows visible in zeus.%', table_name;
    end if;
  end loop;
end
$alice_visibility$;

do $alice_mutations$
declare
  changed integer;
  binding record;
begin
  insert into zeus.memory_candidate (
    user_id, source_message_id, candidate_kind, category, statement,
    proposed_data, reason
  ) values (
    '00000000-0000-4000-8000-00000000a001',
    '20000000-0000-4000-8000-00000000a001',
    'fact',
    'Preferences',
    'Alice tenant-scoped source check',
    '{}',
    'uncertain'
  );

  insert into zeus.fact (
    id, user_id, subject_entity_id, predicate, object_text, valid_from,
    confidence, source_message_id, searchable_text
  ) values (
    '50100000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a001',
    '40000000-0000-4000-8000-00000000a001',
    'mentors',
    'new teammates',
    clock_timestamp(),
    1,
    '20000000-0000-4000-8000-00000000a001',
    'Alice mentors new teammates'
  );
  select count(*) into changed
  from zeus.tenant_predicate
  where name = 'mentors' and cardinality = 'multi';
  if changed <> 1 then raise exception 'unknown predicate did not default tenant-locally to multi'; end if;

  update zeus.conversation
  set title = 'tampered'
  where id = '10000000-0000-4000-8000-00000000b002';
  get diagnostics changed = row_count;
  if changed <> 0 then raise exception 'guessed update crossed tenant'; end if;

  begin
    delete from zeus.data_export_job
    where id = '90000000-0000-4000-8000-00000000b002';
    raise exception 'application role unexpectedly deleted an export job';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from zeus.deletion_request
    where id = '91000000-0000-4000-8000-00000000b002';
    raise exception 'application role unexpectedly deleted an erasure request';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.conversation (user_id, title)
    values ('00000000-0000-4000-8000-00000000b002', 'forged tenant');
    raise exception 'forged user_id insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.message (user_id, conversation_id, role, content)
    values (
      '00000000-0000-4000-8000-00000000a001',
      '10000000-0000-4000-8000-00000000b002',
      'user',
      'guessed parent'
    );
    raise exception 'cross-tenant parent reference unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into zeus.evidence_passage (
      id, user_id, message_id, start_offset, end_offset, quote
    ) values (
      '22000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '20000000-0000-4000-8000-00000000a001',
      0,
      5,
      'Wrong'
    );
    raise exception 'non-matching evidence quote insert unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    insert into zeus.evidence_passage (
      id, user_id, message_id, start_offset, end_offset, quote
    ) values (
      '22300000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '23000000-0000-4000-8000-00000000a003',
      2,
      4,
      '😀'
    );
    raise exception 'evidence offsets split a UTF-16 surrogate pair';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.evidence_passage
    set quote = 'Wrong'
    where id = '22000000-0000-4000-8000-00000000a001';
    raise exception 'non-matching evidence quote update unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    insert into zeus.evidence_passage (
      id, user_id, message_id, start_offset, end_offset, quote
    ) values (
      '22000000-0000-4000-8000-00000000a098',
      '00000000-0000-4000-8000-00000000a001',
      '21000000-0000-4000-8000-00000000a001',
      0,
      5,
      'Alice'
    );
    raise exception 'assistant-authored evidence passage unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    insert into zeus.response_trace (
      id, user_id, conversation_id, assistant_message_id, model, prompt_version
    ) values (
      '30000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '10000000-0000-4000-8000-00000000a001',
      '21000000-0000-4000-8000-00000000a003',
      'test-model',
      'mismatched-conversation'
    );
    raise exception 'same-tenant response message from another conversation unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update zeus.response_trace
    set assistant_message_id = '21000000-0000-4000-8000-00000000a003'
    where id = '30000000-0000-4000-8000-00000000a001';
    raise exception 'same-tenant response message update crossed conversations';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.memory_job (
      id, user_id, conversation_id, source_message_id, assistant_message_id,
      prompt_version, remembering_mode
    ) values (
      '80000000-0000-4000-8000-00000000a098',
      '00000000-0000-4000-8000-00000000a001',
      '10000000-0000-4000-8000-00000000a001',
      '20000000-0000-4000-8000-00000000a003',
      '21000000-0000-4000-8000-00000000a001',
      'mismatched-source',
      'automatic'
    );
    raise exception 'same-tenant memory source from another conversation unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into zeus.memory_job (
      id, user_id, conversation_id, source_message_id, assistant_message_id,
      prompt_version, remembering_mode
    ) values (
      '80000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '10000000-0000-4000-8000-00000000a001',
      '20000000-0000-4000-8000-00000000a001',
      '21000000-0000-4000-8000-00000000a003',
      'mismatched-assistant',
      'automatic'
    );
    raise exception 'same-tenant memory assistant from another conversation unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update zeus.memory_job
    set source_message_id = '20000000-0000-4000-8000-00000000a003'
    where id = '80000000-0000-4000-8000-00000000a001';
    raise exception 'same-tenant memory source update crossed conversations';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update zeus.memory_job
    set assistant_message_id = '21000000-0000-4000-8000-00000000a003'
    where id = '80000000-0000-4000-8000-00000000a001';
    raise exception 'same-tenant memory assistant update crossed conversations';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into zeus.candidate_evidence (
      id, user_id, candidate_id, passage_id
    ) values (
      '63000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '60000000-0000-4000-8000-00000000a001',
      '22000000-0000-4000-8000-00000000a003'
    );
    raise exception 'candidate accepted evidence from another source message';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.candidate_evidence
    set passage_id = '22000000-0000-4000-8000-00000000a003'
    where id = '63000000-0000-4000-8000-00000000a001';
    raise exception 'candidate evidence update crossed source messages';
  exception
    when insufficient_privilege then null;
  end;

  for binding in
    select *
    from (values
      (
        'fact_evidence', 'fact_id', 'evidence_kind', 'reassertion',
        '50000000-0000-4000-8000-00000000a001'::uuid,
        '51000000-0000-4000-8000-00000000a001'::uuid,
        '51000000-0000-4000-8000-00000000a099'::uuid
      ),
      (
        'facet_evidence', 'facet_id', 'evidence_kind', 'reassertion',
        '61000000-0000-4000-8000-00000000a001'::uuid,
        '62000000-0000-4000-8000-00000000a001'::uuid,
        '62000000-0000-4000-8000-00000000a099'::uuid
      ),
      (
        'project_event', 'project_id', 'event_type', 'tested',
        '70000000-0000-4000-8000-00000000a001'::uuid,
        '73000000-0000-4000-8000-00000000a001'::uuid,
        '73000000-0000-4000-8000-00000000a099'::uuid
      ),
      (
        'goal_event', 'goal_id', 'event_type', 'tested',
        '71000000-0000-4000-8000-00000000a001'::uuid,
        '74000000-0000-4000-8000-00000000a001'::uuid,
        '74000000-0000-4000-8000-00000000a099'::uuid
      ),
      (
        'commitment_event', 'commitment_id', 'event_type', 'tested',
        '72000000-0000-4000-8000-00000000a001'::uuid,
        '75000000-0000-4000-8000-00000000a001'::uuid,
        '75000000-0000-4000-8000-00000000a099'::uuid
      )
    ) as cases(
      table_name, parent_column, kind_column, kind_value,
      parent_id, existing_id, new_id
    )
  loop
    begin
      execute format(
        'insert into zeus.%I (id, user_id, %I, %I, source_message_id, passage_id) values ($1, $2, $3, $4, $5, $6)',
        binding.table_name,
        binding.parent_column,
        binding.kind_column
      ) using
        binding.new_id,
        '00000000-0000-4000-8000-00000000a001'::uuid,
        binding.parent_id,
        binding.kind_value,
        '20000000-0000-4000-8000-00000000a001'::uuid,
        '22000000-0000-4000-8000-00000000a003'::uuid;
      raise exception '% accepted a passage from another source message on insert', binding.table_name;
    exception
      when foreign_key_violation then null;
    end;

    begin
      execute format(
        'update zeus.%I set passage_id = $1 where id = $2',
        binding.table_name
      ) using
        '22000000-0000-4000-8000-00000000a003'::uuid,
        binding.existing_id;
      raise exception '% accepted a passage from another source message on update', binding.table_name;
    exception
      when insufficient_privilege then null;
    end;
  end loop;

  -- Polymorphic audit rows must resolve the discriminator and UUID together
  -- inside Alice's RLS scope. Both creation and later retargeting are covered.
  begin
    insert into zeus.response_trace_item (
      id, user_id, response_trace_id, rank, item_kind, resource_id, snapshot
    ) values (
      '31000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '30000000-0000-4000-8000-00000000a001',
      2,
      'fact',
      '50000000-0000-4000-8000-00000000b002',
      '{}'
    );
    raise exception 'cross-tenant response trace resource insert unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.response_trace_item
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '31000000-0000-4000-8000-00000000a001';
    raise exception 'cross-tenant response trace resource update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.memory_change (
      id, user_id, change_set_id, resource_kind, resource_id, action,
      after_snapshot, record_version_after
    ) values (
      '83000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '82000000-0000-4000-8000-00000000a001',
      'fact',
      '50000000-0000-4000-8000-00000000b002',
      'insert',
      '{}',
      2
    );
    raise exception 'cross-tenant memory change resource insert unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.memory_change
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '83000000-0000-4000-8000-00000000a001';
    raise exception 'cross-tenant memory change resource update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.memory_job_activity (
      id, user_id, memory_job_id, resource_kind, resource_id,
      source_message_id, item_kind, change_type, label
    ) values (
      '81000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      '80000000-0000-4000-8000-00000000a001',
      'fact',
      '50000000-0000-4000-8000-00000000b002',
      '20000000-0000-4000-8000-00000000a001',
      'preference',
      'saved',
      'forged receipt'
    );
    raise exception 'cross-tenant memory activity resource insert unexpectedly succeeded';
  exception
    when check_violation then null;
  end;

  begin
    update zeus.memory_job_activity
    set resource_id = '50000000-0000-4000-8000-00000000b002'
    where id = '81000000-0000-4000-8000-00000000a001';
    raise exception 'cross-tenant memory activity resource update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into zeus.deletion_request (
      id, user_id, scope, requested_target_id, live_target_id, impact_snapshot
    ) values (
      '92000000-0000-4000-8000-00000000a099',
      '00000000-0000-4000-8000-00000000a001',
      'conversation',
      '10000000-0000-4000-8000-00000000b002',
      '10000000-0000-4000-8000-00000000b002',
      '{}'
    );
    raise exception 'cross-tenant deletion target insert unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update zeus.deletion_request
    set live_target_id = '10000000-0000-4000-8000-00000000b002'
    where id = '92000000-0000-4000-8000-00000000a001';
    raise exception 'cross-tenant deletion target update unexpectedly succeeded';
  exception
    when check_violation or foreign_key_violation then null;
  end;

  begin
    perform zeus_private.erase_requested_conversation(
      '92000000-0000-4000-8000-00000000a001'
    );
    raise exception 'application role invoked the controlled erasure function';
  exception
    when insufficient_privilege then null;
  end;

  select record_version into changed
  from zeus.project
  where id = '70000000-0000-4000-8000-00000000a001';
  if changed <> 1 then raise exception 'new tracked resource did not start at version 1'; end if;

  update zeus.project
  set title = title
  where id = '70000000-0000-4000-8000-00000000a001';

  select record_version into changed
  from zeus.project
  where id = '70000000-0000-4000-8000-00000000a001';
  if changed <> 2 then raise exception 'tracked resource update did not bump its version'; end if;

  begin
    insert into zeus.memory_change (
      id, user_id, change_set_id, resource_kind, resource_id, action,
      after_snapshot, record_version_after
    ) values (
      '83100000-0000-4000-8000-00000000a098',
      '00000000-0000-4000-8000-00000000a001',
      '82000000-0000-4000-8000-00000000a001',
      'project',
      '70000000-0000-4000-8000-00000000a001',
      'insert',
      '{}',
      1
    );
    raise exception 'memory ledger accepted a stale resource version';
  exception
    when check_violation then null;
  end;

  insert into zeus.memory_change (
    id, user_id, change_set_id, resource_kind, resource_id, action,
    before_snapshot, after_snapshot, record_version_before, record_version_after
  ) values (
    '83100000-0000-4000-8000-00000000a099',
    '00000000-0000-4000-8000-00000000a001',
    '82000000-0000-4000-8000-00000000a001',
    'project',
    '70000000-0000-4000-8000-00000000a001',
    'update',
    '{"title":"Alice project"}',
    '{"title":"Alice project"}',
    1,
    2
  );

  update zeus.project
  set title = title
  where id = '70000000-0000-4000-8000-00000000a001';

  select project.record_version - change.record_version_after into changed
  from zeus.project project
  join zeus.memory_change change
    on change.user_id = project.user_id
   and change.resource_kind = 'project'
   and change.resource_id = project.id
  where project.id = '70000000-0000-4000-8000-00000000a001';
  if changed <> 1 then raise exception 'later update is not detectable from the memory ledger'; end if;

  for binding in
    select unnest(array[
      'message', 'response_trace', 'response_trace_item', 'fact_evidence',
      'candidate_evidence', 'candidate_resolution_event', 'facet_evidence',
      'project_event', 'goal_event', 'commitment_event',
      'follow_through_event', 'memory_change', 'memory_job_activity'
    ]) as table_name
  loop
    begin
      execute format('update zeus.%I set created_at = created_at where false', binding.table_name);
      raise exception 'application role updated append-only zeus.%', binding.table_name;
    exception
      when insufficient_privilege then null;
    end;

    begin
      execute format('delete from zeus.%I where false', binding.table_name);
      raise exception 'application role deleted from append-only zeus.%', binding.table_name;
    exception
      when insufficient_privilege then null;
    end;
  end loop;

  begin
    insert into zeus.predicate_registry (name, cardinality, description)
    values ('forged_app_predicate', 'multi', 'must not persist');
    raise exception 'application role inserted a global predicate';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update zeus.predicate_registry
    set description = 'tampered'
    where name = 'likes';
    raise exception 'application role updated a global predicate';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from zeus.predicate_registry where name = 'likes';
    raise exception 'application role deleted a global predicate';
  exception
    when insufficient_privilege then null;
  end;
end
$alice_mutations$;

reset role;

set local role zeus_worker;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);

do $worker_global_registry_mutations$
declare
  table_name text;
begin
  foreach table_name in array array[
    'message', 'response_trace', 'response_trace_item', 'fact_evidence',
    'candidate_evidence', 'candidate_resolution_event', 'facet_evidence',
    'project_event', 'goal_event', 'commitment_event',
    'follow_through_event', 'memory_change', 'memory_job_activity'
  ]
  loop
    begin
      execute format('update zeus.%I set created_at = created_at where false', table_name);
      raise exception 'worker role updated append-only zeus.%', table_name;
    exception
      when insufficient_privilege then null;
    end;

    begin
      execute format('delete from zeus.%I where false', table_name);
      raise exception 'worker role deleted from append-only zeus.%', table_name;
    exception
      when insufficient_privilege then null;
    end;
  end loop;

  begin
    insert into zeus.predicate_registry (name, cardinality, description)
    values ('forged_worker_predicate', 'multi', 'must not persist');
    raise exception 'worker role inserted a global predicate';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update zeus.predicate_registry
    set description = 'worker tampered'
    where name = 'likes';
    raise exception 'worker role updated a global predicate';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from zeus.predicate_registry where name = 'likes';
    raise exception 'worker role deleted a global predicate';
  exception
    when insufficient_privilege then null;
  end;
end
$worker_global_registry_mutations$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);

do $realtime_surface$
declare
  count_rows integer;
begin
  select count(*) into count_rows from zeus.memory_job;
  if count_rows <> 1 then raise exception 'realtime job feed crossed tenant'; end if;

  select count(*) into count_rows
  from zeus.memory_job_activity
  where id = '81000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'realtime activity guessed-id leak'; end if;

  begin
    update zeus.memory_job set status = 'running'
    where id = '80000000-0000-4000-8000-00000000a001';
    raise exception 'browser unexpectedly mutated a worker-owned job';
  exception
    when insufficient_privilege then null;
  end;
end
$realtime_surface$;

reset role;

set local role zeus_worker;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000a001', true);

select zeus_private.erase_requested_conversation(
  '92000000-0000-4000-8000-00000000a001'
);

do $controlled_conversation_erasure$
declare
  count_rows integer;
  source_id uuid;
  request_row record;
begin
  select count(*) into count_rows from zeus.conversation
  where id = '10000000-0000-4000-8000-00000000a001';
  if count_rows <> 0 then raise exception 'controlled erasure retained its conversation'; end if;

  select count(*) into count_rows from zeus.conversation
  where id = '10000000-0000-4000-8000-00000000a003';
  if count_rows <> 1 then raise exception 'controlled erasure removed another same-tenant conversation'; end if;

  select * into request_row from zeus.deletion_request
  where id = '92000000-0000-4000-8000-00000000a001';
  if request_row.status <> 'completed'
    or request_row.completed_at is null
    or request_row.live_target_id is not null
    or request_row.requested_target_id <> '10000000-0000-4000-8000-00000000a001'::uuid
  then
    raise exception 'completed deletion audit lost its immutable request target';
  end if;

  select source_message_id into source_id from zeus.fact
  where id = '50000000-0000-4000-8000-00000000a001';
  if source_id <> '20000000-0000-4000-8000-00000000a003'::uuid then
    raise exception 'multiply evidenced fact was not rehomed to surviving evidence';
  end if;

  select count(*) into count_rows from zeus.fact_evidence
  where fact_id = '50000000-0000-4000-8000-00000000a001';
  if count_rows <> 1 then raise exception 'shared fact evidence cleanup was not exact'; end if;

  select source_message_id into source_id from zeus.understanding_facet
  where id = '61000000-0000-4000-8000-00000000a001';
  if source_id <> '20000000-0000-4000-8000-00000000a003'::uuid then
    raise exception 'multiply evidenced facet was not rehomed';
  end if;

  select count(*) into count_rows
  from zeus.project
  where id = '70000000-0000-4000-8000-00000000a001'
    and source_message_id = '20000000-0000-4000-8000-00000000a003';
  if count_rows <> 1 then raise exception 'project was not rehomed'; end if;

  select count(*) into count_rows
  from zeus.goal
  where id = '71000000-0000-4000-8000-00000000a001'
    and source_message_id = '20000000-0000-4000-8000-00000000a003';
  if count_rows <> 1 then raise exception 'goal was not rehomed'; end if;

  select count(*) into count_rows
  from zeus.commitment
  where id = '72000000-0000-4000-8000-00000000a001'
    and source_message_id = '20000000-0000-4000-8000-00000000a003';
  if count_rows <> 1 then raise exception 'commitment was not rehomed'; end if;

  select count(*) into count_rows from zeus.memory_candidate
  where id = '60000000-0000-4000-8000-00000000a001';
  if count_rows <> 0 then raise exception 'source-exclusive candidate survived erasure'; end if;

  select count(*) into count_rows from zeus.memory_job
  where id = '80000000-0000-4000-8000-00000000a001';
  if count_rows <> 0 then raise exception 'source-linked memory job survived erasure'; end if;

  select count(*) into count_rows from zeus.fact
  where id = '50000000-0000-4000-8000-00000000b002';
  if count_rows <> 0 then raise exception 'worker erasure could observe Bob through RLS'; end if;
end
$controlled_conversation_erasure$;

reset role;

-- Account deletion must cascade through the whole tenant graph, including
-- provenance relationships that intentionally block ad-hoc source deletion.
delete from auth.users
where id = '00000000-0000-4000-8000-00000000a001';
set constraints all immediate;

do $account_erasure$
declare
  count_rows integer;
  table_name text;
begin
  for table_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'zeus'
      and c.relkind = 'r'
      and c.relname <> 'predicate_registry'
  loop
    execute format(
      'select count(*) from zeus.%I where user_id = ''00000000-0000-4000-8000-00000000a001''::uuid',
      table_name
    ) into count_rows;
    if count_rows <> 0 then
      raise exception 'account erasure left rows in zeus.%', table_name;
    end if;
  end loop;
end
$account_erasure$;

rollback;

\echo 'two-user isolation checks passed'
