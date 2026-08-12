-- Zeus hosted consumer-v1 foundation.
--
-- This schema is deliberately separate from the local SQLite edition. Every
-- private row carries its tenant and every dependent relationship repeats the
-- tenant in a composite foreign key. RLS is forced even for table owners.

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists zeus;
create schema if not exists zeus_private;

revoke all on schema zeus from public, anon;
revoke all on schema zeus_private from public, anon, authenticated;

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'zeus_app') then
    create role zeus_app nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'zeus_worker') then
    create role zeus_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$roles$;

alter role zeus_app nobypassrls;
alter role zeus_worker nobypassrls;

grant usage on schema zeus to authenticated, zeus_app, zeus_worker;
grant usage on schema zeus_private to zeus_app, zeus_worker;

create or replace function zeus_private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

create or replace function zeus_private.bump_record_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.record_version := old.record_version + 1;
  return new;
end
$function$;

create or replace function zeus_private.require_verified_tenant()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  tenant uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
begin
  if tenant is null then
    raise exception 'verified tenant context is required' using errcode = '28000';
  end if;
  return tenant;
end
$function$;

-- The sole unowned application table. Product code may read this registry but
-- only migrations may change it.
create table zeus.predicate_registry (
  name text primary key,
  cardinality text not null check (cardinality in ('single', 'multi')),
  description text not null,
  created_at timestamptz not null default clock_timestamp()
);

insert into zeus.predicate_registry (name, cardinality, description) values
  ('works_at', 'single', 'Current employer or organization'),
  ('job_title', 'single', 'Current role or title'),
  ('lives_in', 'single', 'Current city or region of residence'),
  ('birthday', 'single', 'Date of birth'),
  ('timezone', 'single', 'Current timezone'),
  ('relationship_to_user', 'single', 'How this entity relates to the user'),
  ('status', 'single', 'Current status of a project or thing'),
  ('likes', 'multi', 'Something the subject enjoys or prefers'),
  ('dislikes', 'multi', 'Something the subject avoids or dislikes'),
  ('knows', 'multi', 'A person the subject knows'),
  ('works_on', 'multi', 'A project the subject contributes to'),
  ('cares_about', 'multi', 'A topic the subject actively tracks'),
  ('goal', 'multi', 'Something the subject is trying to achieve'),
  ('prefers', 'multi', 'A stated working or tooling preference'),
  ('note', 'multi', 'A durable fact that fits no other predicate')
on conflict (name) do nothing;

-- Unknown predicates are tenant-owned and default to multi, preserving the
-- local non-destructive cardinality policy without allowing application roles
-- to mutate the global built-in registry.
create table zeus.tenant_predicate (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_]{0,99}$'),
  cardinality text not null default 'multi' check (cardinality = 'multi'),
  description text,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, name)
);

create table zeus.experience_setting (
  user_id uuid primary key references auth.users(id) on delete cascade,
  remembering_mode text not null default 'automatic'
    check (remembering_mode in ('automatic', 'confirm', 'off')),
  suggestion_mode text not null default 'helpful'
    check (suggestion_mode in ('off', 'important', 'helpful', 'proactive')),
  onboarding_status text not null default 'welcome'
    check (onboarding_status in ('welcome', 'first_chat', 'complete')),
  labs_enabled boolean not null default false,
  notifications_enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table zeus.conversation (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  history_status text not null default 'active'
    check (history_status in ('active', 'archived')),
  archived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  check ((history_status = 'archived') = (archived_at is not null))
);

create table zeus.message (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) > 0),
  cross_chat_recall_eligible boolean not null default true,
  content_search tsvector generated always as
    (to_tsvector('english', coalesce(content, ''))) stored,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, conversation_id, id),
  foreign key (user_id, conversation_id)
    references zeus.conversation(user_id, id) on delete cascade
);

create index message_conversation_time_idx
  on zeus.message(user_id, conversation_id, created_at, id);
create index message_search_idx on zeus.message using gin(content_search);

create table zeus.response_trace (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  assistant_message_id uuid not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, assistant_message_id),
  foreign key (user_id, conversation_id)
    references zeus.conversation(user_id, id) on delete cascade,
  foreign key (user_id, conversation_id, assistant_message_id)
    references zeus.message(user_id, conversation_id, id) on delete cascade
);

create table zeus.response_trace_item (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  response_trace_id uuid not null,
  rank integer not null check (rank >= 0),
  item_kind text not null
    check (item_kind in ('fact', 'episode', 'facet', 'project', 'goal', 'commitment', 'recommendation')),
  resource_id uuid not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, response_trace_id, rank),
  foreign key (user_id, response_trace_id)
    references zeus.response_trace(user_id, id) on delete cascade
);

create table zeus.entity (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  canonical_name text not null check (length(canonical_name) > 0),
  summary text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id)
);

create unique index entity_identity_idx
  on zeus.entity(user_id, kind, lower(canonical_name));

create table zeus.entity_alias (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null,
  alias text not null check (length(alias) > 0),
  source_message_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, entity_id, alias),
  foreign key (user_id, entity_id)
    references zeus.entity(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete cascade
);

create index entity_alias_lookup_idx on zeus.entity_alias(user_id, lower(alias));

create table zeus.evidence_passage (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null,
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  quote text not null check (length(quote) > 0),
  sensitivity text not null default 'ordinary'
    check (sensitivity in ('ordinary', 'sensitive', 'restricted')),
  recall_status text not null default 'eligible'
    check (recall_status in ('eligible', 'review_only', 'excluded', 'deleted')),
  quote_search tsvector generated always as
    (to_tsvector('english', coalesce(quote, ''))) stored,
  embedding extensions.vector(384),
  embedding_model text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, message_id, id),
  unique (user_id, message_id, start_offset, end_offset),
  foreign key (user_id, message_id)
    references zeus.message(user_id, id) on delete cascade,
  check ((embedding is null) = (embedding_model is null))
);

create index passage_message_idx
  on zeus.evidence_passage(user_id, message_id, start_offset);
create index passage_search_idx on zeus.evidence_passage using gin(quote_search);

create table zeus.fact (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_entity_id uuid not null,
  predicate text not null check (predicate ~ '^[a-z][a-z0-9_]{0,99}$'),
  object_text text,
  object_entity_id uuid,
  valid_from timestamptz not null,
  valid_to timestamptz,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  source_message_id uuid not null,
  superseded_by_id uuid,
  searchable_text text not null,
  fact_search tsvector generated always as
    (to_tsvector('english', coalesce(searchable_text, ''))) stored,
  embedding extensions.vector(384),
  embedding_model text,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, subject_entity_id)
    references zeus.entity(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, object_entity_id)
    references zeus.entity(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, superseded_by_id)
    references zeus.fact(user_id, id) deferrable initially deferred,
  check ((object_text is not null)::integer + (object_entity_id is not null)::integer = 1),
  check (valid_to is null or valid_to >= valid_from),
  check ((embedding is null) = (embedding_model is null))
);

create index fact_current_idx
  on zeus.fact(user_id, subject_entity_id, predicate)
  where valid_to is null;
create index fact_source_idx on zeus.fact(user_id, source_message_id);
create index fact_search_idx on zeus.fact using gin(fact_search);

create table zeus.fact_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fact_id uuid not null,
  source_message_id uuid not null,
  passage_id uuid,
  evidence_kind text not null
    check (evidence_kind in ('assertion', 'reassertion', 'correction')),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, fact_id, source_message_id, evidence_kind),
  foreign key (user_id, fact_id)
    references zeus.fact(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id, passage_id)
    references zeus.evidence_passage(user_id, message_id, id)
      on delete no action
);

create table zeus.memory_candidate (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_message_id uuid not null,
  candidate_kind text not null
    check (candidate_kind in ('fact', 'facet', 'project', 'goal', 'commitment')),
  category text not null,
  statement text not null check (length(statement) > 0),
  proposed_data jsonb not null check (jsonb_typeof(proposed_data) = 'object'),
  reason text not null
    check (reason in ('uncertain', 'sensitive', 'conflict', 'ambiguous')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  dedupe_key text,
  resolved_at timestamptz,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete cascade,
  check ((status = 'pending') = (resolved_at is null))
);

create unique index memory_candidate_pending_dedupe_idx
  on zeus.memory_candidate(user_id, dedupe_key)
  where status = 'pending' and dedupe_key is not null;
create index memory_candidate_review_idx
  on zeus.memory_candidate(user_id, status, created_at desc);

create table zeus.candidate_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null,
  passage_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, candidate_id, passage_id),
  foreign key (user_id, candidate_id)
    references zeus.memory_candidate(user_id, id) on delete cascade,
  foreign key (user_id, passage_id)
    references zeus.evidence_passage(user_id, id) on delete cascade
);

create table zeus.candidate_resolution_event (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null,
  decision text not null check (decision in ('accepted', 'edited', 'rejected')),
  final_statement text,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, candidate_id)
    references zeus.memory_candidate(user_id, id) on delete cascade
);

create table zeus.understanding_facet (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  scope_kind text not null
    check (scope_kind in ('person', 'entity', 'project', 'goal', 'commitment')),
  scope_entity_id uuid,
  scope_project_id uuid,
  scope_goal_id uuid,
  scope_commitment_id uuid,
  statement text not null check (length(statement) > 0),
  valid_from timestamptz not null,
  valid_to timestamptz,
  source_message_id uuid not null,
  facet_search tsvector generated always as
    (to_tsvector('english', coalesce(statement, ''))) stored,
  embedding extensions.vector(384),
  embedding_model text,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, scope_entity_id)
    references zeus.entity(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  check (valid_to is null or valid_to >= valid_from),
  check ((embedding is null) = (embedding_model is null))
);

-- Project/goal/commitment ownership FKs for facets are added after those tables
-- exist. The four nullable scope columns are constrained at the end.

create table zeus.facet_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  facet_id uuid not null,
  source_message_id uuid not null,
  passage_id uuid,
  evidence_kind text not null
    check (evidence_kind in ('assertion', 'reassertion', 'correction')),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, facet_id)
    references zeus.understanding_facet(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id, passage_id)
    references zeus.evidence_passage(user_id, message_id, id)
      on delete no action
);

create index facet_current_idx
  on zeus.understanding_facet(user_id, category, scope_kind)
  where valid_to is null;
create index facet_search_idx on zeus.understanding_facet using gin(facet_search);

create table zeus.project (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) > 0),
  description text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'stopped')),
  priority integer not null default 0,
  target_at timestamptz,
  source_message_id uuid not null,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred
);

create table zeus.project_event (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  event_type text not null,
  source_message_id uuid,
  passage_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, project_id)
    references zeus.project(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id, passage_id)
    references zeus.evidence_passage(user_id, message_id, id)
      on delete no action,
  check (passage_id is null or source_message_id is not null)
);

create table zeus.goal (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  title text not null check (length(title) > 0),
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'stopped')),
  priority integer not null default 0,
  target_at timestamptz,
  source_message_id uuid not null,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, project_id)
    references zeus.project(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred
);

create table zeus.goal_event (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null,
  event_type text not null,
  source_message_id uuid,
  passage_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, goal_id)
    references zeus.goal(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id, passage_id)
    references zeus.evidence_passage(user_id, message_id, id)
      on delete no action,
  check (passage_id is null or source_message_id is not null)
);

create table zeus.commitment (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  linked_goal_id uuid,
  owner_entity_id uuid,
  title text not null check (length(title) > 0),
  status text not null default 'active'
    check (status in ('active', 'waiting', 'paused', 'completed', 'stopped')),
  due_at timestamptz,
  waiting_on text,
  source_message_id uuid not null,
  record_version bigint not null default 1 check (record_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, project_id)
    references zeus.project(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, linked_goal_id)
    references zeus.goal(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, owner_entity_id)
    references zeus.entity(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  check ((status = 'waiting') = (waiting_on is not null))
);

create table zeus.commitment_event (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  commitment_id uuid not null,
  event_type text not null,
  source_message_id uuid,
  passage_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, commitment_id)
    references zeus.commitment(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, source_message_id, passage_id)
    references zeus.evidence_passage(user_id, message_id, id)
      on delete no action,
  check (passage_id is null or source_message_id is not null)
);

alter table zeus.understanding_facet
  add foreign key (user_id, scope_project_id)
    references zeus.project(user_id, id) on delete no action deferrable initially deferred,
  add foreign key (user_id, scope_goal_id)
    references zeus.goal(user_id, id) on delete no action deferrable initially deferred,
  add foreign key (user_id, scope_commitment_id)
    references zeus.commitment(user_id, id) on delete no action deferrable initially deferred,
  add constraint understanding_facet_scope_check check (
    (scope_kind = 'person' and scope_entity_id is null and scope_project_id is null
      and scope_goal_id is null and scope_commitment_id is null)
    or (scope_kind = 'entity' and scope_entity_id is not null and scope_project_id is null
      and scope_goal_id is null and scope_commitment_id is null)
    or (scope_kind = 'project' and scope_entity_id is null and scope_project_id is not null
      and scope_goal_id is null and scope_commitment_id is null)
    or (scope_kind = 'goal' and scope_entity_id is null and scope_project_id is null
      and scope_goal_id is not null and scope_commitment_id is null)
    or (scope_kind = 'commitment' and scope_entity_id is null and scope_project_id is null
      and scope_goal_id is null and scope_commitment_id is not null)
  );

create index project_status_idx on zeus.project(user_id, status, updated_at desc);
create index goal_status_idx on zeus.goal(user_id, status, target_at, updated_at desc);
create index commitment_status_idx
  on zeus.commitment(user_id, status, due_at, updated_at desc);

create table zeus.stewardship_setting (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'balanced'
    check (mode in ('off', 'quiet', 'balanced', 'proactive')),
  cooldown_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table zeus.follow_through_event (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid,
  commitment_id uuid,
  source_message_id uuid,
  response_message_id uuid,
  event_type text not null
    check (event_type in ('proposed', 'accepted', 'completed', 'snoozed', 'dismissed', 'regret')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  foreign key (user_id, goal_id)
    references zeus.goal(user_id, id) on delete cascade,
  foreign key (user_id, commitment_id)
    references zeus.commitment(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  foreign key (user_id, response_message_id)
    references zeus.message(user_id, id) on delete no action deferrable initially deferred,
  check (goal_id is not null or commitment_id is not null)
);

create index follow_through_eligibility_idx
  on zeus.follow_through_event(user_id, event_type, created_at desc);

create table zeus.memory_job (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  source_message_id uuid not null,
  assistant_message_id uuid not null,
  prompt_version text not null,
  remembering_mode text not null
    check (remembering_mode in ('automatic', 'confirm', 'off')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, source_message_id, prompt_version),
  foreign key (user_id, conversation_id)
    references zeus.conversation(user_id, id) on delete cascade,
  foreign key (user_id, conversation_id, source_message_id)
    references zeus.message(user_id, conversation_id, id) on delete cascade,
  foreign key (user_id, conversation_id, assistant_message_id)
    references zeus.message(user_id, conversation_id, id) on delete cascade,
  check (
    (status = 'pending' and started_at is null and completed_at is null and error_code is null)
    or (status = 'running' and started_at is not null and completed_at is null and error_code is null)
    or (status = 'completed' and started_at is not null and completed_at is not null and error_code is null)
    or (status = 'failed' and started_at is not null and completed_at is not null and error_code is not null)
  )
);

create index memory_job_queue_idx
  on zeus.memory_job(user_id, conversation_id, status, created_at);

create table zeus.memory_change_set (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence_number bigint generated always as identity unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_job_id uuid not null,
  status text not null default 'applied'
    check (status in ('applied', 'undone', 'conflicted')),
  created_at timestamptz not null default clock_timestamp(),
  undone_at timestamptz,
  unique (user_id, id),
  unique (user_id, memory_job_id),
  foreign key (user_id, memory_job_id)
    references zeus.memory_job(user_id, id) on delete cascade,
  check ((status = 'undone') = (undone_at is not null))
);

create table zeus.memory_change (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  change_set_id uuid not null,
  resource_kind text not null
    check (resource_kind in ('fact', 'facet', 'project', 'goal', 'commitment', 'candidate')),
  resource_id uuid not null,
  action text not null check (action in ('insert', 'update', 'close', 'review')),
  before_snapshot jsonb,
  after_snapshot jsonb,
  record_version_before bigint,
  record_version_after bigint not null check (record_version_after > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, change_set_id, resource_kind, resource_id),
  foreign key (user_id, change_set_id)
    references zeus.memory_change_set(user_id, id) on delete cascade,
  check (before_snapshot is null or jsonb_typeof(before_snapshot) = 'object'),
  check (after_snapshot is null or jsonb_typeof(after_snapshot) = 'object'),
  check (record_version_before is null or record_version_before > 0),
  check (before_snapshot is not null or after_snapshot is not null),
  check (
    (action in ('insert', 'review') and record_version_before is null)
    or (
      action in ('update', 'close')
      and record_version_before is not null
      and record_version_after = record_version_before + 1
    )
  )
);

create index memory_change_conflict_idx
  on zeus.memory_change(user_id, resource_kind, resource_id, created_at desc);

create table zeus.memory_job_activity (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_job_id uuid not null,
  resource_kind text not null
    check (resource_kind in ('fact', 'facet', 'project', 'goal', 'commitment', 'candidate')),
  resource_id uuid not null,
  source_message_id uuid not null,
  item_kind text not null check (item_kind in ('detail', 'preference', 'plan')),
  change_type text not null check (change_type in ('saved', 'updated', 'needs_review')),
  label text not null check (length(label) > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, id),
  unique (user_id, memory_job_id, resource_id, change_type),
  foreign key (user_id, memory_job_id)
    references zeus.memory_job(user_id, id) on delete cascade,
  foreign key (user_id, source_message_id)
    references zeus.message(user_id, id) on delete cascade,
  check (
    (item_kind in ('detail', 'preference') and resource_kind in ('fact', 'facet', 'candidate'))
    or (item_kind = 'plan' and resource_kind in ('project', 'goal', 'commitment', 'candidate'))
  )
);

-- User-visible export and erasure workflows are tenant-owned jobs too. Object
-- keys are never predictable download URLs; the application signs them only
-- after re-verifying the requesting session.
create table zeus.data_export_job (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'expired')),
  object_key text,
  sha256 text,
  expires_at timestamptz,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (user_id, id)
);

create table zeus.deletion_request (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('conversation', 'clear_data', 'account')),
  requested_target_id uuid,
  live_target_id uuid,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  impact_snapshot jsonb not null check (jsonb_typeof(impact_snapshot) = 'object'),
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  error_code text,
  unique (user_id, id),
  foreign key (user_id, live_target_id)
    references zeus.conversation(user_id, id) on delete set null (live_target_id),
  check (
    (scope = 'conversation' and requested_target_id is not null)
    or (scope <> 'conversation' and requested_target_id is null and live_target_id is null)
  ),
  check (live_target_id is null or live_target_id = requested_target_id)
);

-- Source assertions ensure canonical memories and intentions are backed by a
-- real user message, not assistant-authored text. Composite FKs already prove
-- that the message belongs to the same tenant.
create or replace function zeus_private.assert_source_message(
  tenant_id uuid,
  source_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if source_id is null then
    return;
  end if;
  if not exists (
    select 1 from zeus.message
    where user_id = tenant_id and id = source_id and role = 'user'
  ) then
    raise exception 'source must be a user message in the same tenant'
      using errcode = '23514';
  end if;
end
$function$;

create or replace function zeus_private.validate_source_column()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  source_id uuid;
begin
  source_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  perform zeus_private.assert_source_message(new.user_id, source_id);
  return new;
end
$function$;

create or replace function zeus_private.ensure_fact_predicate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from zeus.predicate_registry where name = new.predicate
  ) then
    insert into zeus.tenant_predicate (user_id, name)
    values (new.user_id, new.predicate)
    on conflict (user_id, name) do nothing;
  end if;
  return new;
end
$function$;

create trigger fact_ensure_predicate
before insert or update of user_id, predicate on zeus.fact
for each row execute function zeus_private.ensure_fact_predicate();

create or replace function zeus_private.validate_message_role_column()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  message_id uuid;
  expected_role text := tg_argv[1];
begin
  message_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if message_id is null or not exists (
    select 1 from zeus.message
    where user_id = new.user_id and id = message_id and role = expected_role
  ) then
    raise exception 'message role does not match %', expected_role
      using errcode = '23514';
  end if;
  return new;
end
$function$;

-- PostgreSQL counts Unicode code points while JavaScript string offsets count
-- UTF-16 code units. Preserve the application contract explicitly, including
-- astral characters such as emoji.
create or replace function zeus_private.utf16_code_units(input_text text)
returns integer
language sql
immutable
strict
security invoker
set search_path = ''
as $function$
  select coalesce(sum(
    case when ascii(substr(input_text, position, 1)) > 65535 then 2 else 1 end
  ), 0)::integer
  from generate_series(1, char_length(input_text)) as positions(position)
$function$;

-- Passage offsets are zero-based and end-exclusive UTF-16 offsets. A passage
-- is recallable evidence only when it is an exact span of a stored user
-- message; caller-supplied quote text is never trusted alone.
create or replace function zeus_private.validate_evidence_passage_span()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  message_content text;
  message_role text;
begin
  select content, role into message_content, message_role
  from zeus.message
  where user_id = new.user_id and id = new.message_id;

  if not found or message_role <> 'user' then
    raise exception 'evidence passage must belong to a user message in the same tenant'
      using errcode = '23514';
  end if;

  if new.end_offset > zeus_private.utf16_code_units(message_content)
    or zeus_private.utf16_code_units(new.quote) <> new.end_offset - new.start_offset
    or not exists (
      select 1
      from generate_series(0, char_length(message_content)) as starts(codepoint_offset)
      where zeus_private.utf16_code_units(
          substr(message_content, 1, starts.codepoint_offset)
        ) = new.start_offset
        and substr(
          message_content,
          starts.codepoint_offset + 1,
          char_length(new.quote)
        ) = new.quote
    )
  then
    raise exception 'evidence quote must exactly match its message offsets'
      using errcode = '23514';
  end if;

  return new;
end
$function$;

create trigger evidence_passage_validate_exact_span
before insert or update on zeus.evidence_passage
for each row execute function zeus_private.validate_evidence_passage_span();

-- Candidate evidence has no duplicated source_message_id column. Tie its
-- passage to the candidate's source explicitly so a same-tenant passage from
-- another message cannot be attached to the proposal.
create or replace function zeus_private.validate_candidate_evidence_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from zeus.memory_candidate candidate
    join zeus.evidence_passage passage
      on passage.user_id = candidate.user_id
     and passage.message_id = candidate.source_message_id
    where candidate.user_id = new.user_id
      and candidate.id = new.candidate_id
      and passage.id = new.passage_id
  ) then
    raise exception 'candidate evidence passage must match the candidate source message'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

create trigger candidate_evidence_validate_source
before insert or update on zeus.candidate_evidence
for each row execute function zeus_private.validate_candidate_evidence_source();

-- Polymorphic audit/receipt references cannot use a conventional foreign key,
-- so validate the exact resource table selected by the discriminator. This is
-- SECURITY INVOKER on purpose: forced RLS remains in force and a guessed UUID
-- from another tenant is indistinguishable from a missing resource.
create or replace function zeus_private.assert_tenant_resource(
  tenant_id uuid,
  resource_kind text,
  resource_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  resource_exists boolean := false;
begin
  if tenant_id is null or resource_kind is null or resource_id is null then
    raise exception 'resource reference is incomplete' using errcode = '23514';
  end if;

  resource_exists := case resource_kind
    when 'fact' then exists (
      select 1 from zeus.fact where user_id = tenant_id and id = resource_id
    )
    when 'episode' then exists (
      select 1 from zeus.evidence_passage where user_id = tenant_id and id = resource_id
    )
    when 'facet' then exists (
      select 1 from zeus.understanding_facet where user_id = tenant_id and id = resource_id
    )
    when 'project' then exists (
      select 1 from zeus.project where user_id = tenant_id and id = resource_id
    )
    when 'goal' then exists (
      select 1 from zeus.goal where user_id = tenant_id and id = resource_id
    )
    when 'commitment' then exists (
      select 1 from zeus.commitment where user_id = tenant_id and id = resource_id
    )
    when 'candidate' then exists (
      select 1 from zeus.memory_candidate where user_id = tenant_id and id = resource_id
    )
    when 'recommendation' then exists (
      select 1 from zeus.follow_through_event where user_id = tenant_id and id = resource_id
    )
    else false
  end;

  if not resource_exists then
    raise exception 'resource must exist in the same tenant and match its kind'
      using errcode = '23514';
  end if;
end
$function$;

create or replace function zeus_private.validate_polymorphic_resource()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  resource_kind text;
  resource_id uuid;
begin
  resource_kind := nullif(to_jsonb(new) ->> tg_argv[0], '');
  resource_id := nullif(to_jsonb(new) ->> tg_argv[1], '')::uuid;
  perform zeus_private.assert_tenant_resource(new.user_id, resource_kind, resource_id);
  return new;
end
$function$;

create trigger response_trace_item_validate_resource
before insert or update on zeus.response_trace_item
for each row execute function zeus_private.validate_polymorphic_resource(
  'item_kind',
  'resource_id'
);

create trigger memory_change_validate_resource
before insert or update on zeus.memory_change
for each row execute function zeus_private.validate_polymorphic_resource(
  'resource_kind',
  'resource_id'
);

create or replace function zeus_private.validate_memory_change_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  current_version bigint;
begin
  current_version := case new.resource_kind
    when 'fact' then (
      select record_version from zeus.fact
      where user_id = new.user_id and id = new.resource_id
    )
    when 'facet' then (
      select record_version from zeus.understanding_facet
      where user_id = new.user_id and id = new.resource_id
    )
    when 'project' then (
      select record_version from zeus.project
      where user_id = new.user_id and id = new.resource_id
    )
    when 'goal' then (
      select record_version from zeus.goal
      where user_id = new.user_id and id = new.resource_id
    )
    when 'commitment' then (
      select record_version from zeus.commitment
      where user_id = new.user_id and id = new.resource_id
    )
    when 'candidate' then (
      select record_version from zeus.memory_candidate
      where user_id = new.user_id and id = new.resource_id
    )
    else null
  end;

  if current_version is null or current_version <> new.record_version_after then
    raise exception 'memory change version must equal the current resource version'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

create trigger memory_change_validate_version
before insert or update on zeus.memory_change
for each row execute function zeus_private.validate_memory_change_version();

create trigger memory_job_activity_validate_resource
before insert or update on zeus.memory_job_activity
for each row execute function zeus_private.validate_polymorphic_resource(
  'resource_kind',
  'resource_id'
);

create or replace function zeus_private.preserve_deletion_request_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.user_id <> old.user_id
    or new.scope <> old.scope
    or new.requested_target_id is distinct from old.requested_target_id
  then
    raise exception 'deletion request identity is immutable' using errcode = '23514';
  end if;
  return new;
end
$function$;

create trigger deletion_request_preserve_identity
before update on zeus.deletion_request
for each row execute function zeus_private.preserve_deletion_request_identity();

-- The only selective DELETE capability granted to the hosted runtime. It is
-- SECURITY DEFINER so ordinary roles retain append-only ACLs, but derives its
-- tenant exclusively from the verified transaction claim and accepts only an
-- existing, same-tenant deletion-request id. The immutable requested target is
-- retained after the live FK is cleared by conversation deletion.
create or replace function zeus_private.erase_requested_conversation(
  deletion_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  tenant_id uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  target_conversation_id uuid;
  target_message_ids uuid[];
  target_passage_ids uuid[];
  affected_fact_ids uuid[];
  doomed_fact_ids uuid[];
  affected_facet_ids uuid[];
  doomed_facet_ids uuid[];
  affected_candidate_ids uuid[];
  affected_commitment_ids uuid[];
  doomed_commitment_ids uuid[];
  affected_goal_ids uuid[];
  doomed_goal_ids uuid[];
  affected_project_ids uuid[];
  doomed_project_ids uuid[];
  affected_recommendation_ids uuid[];
  deleted_messages integer := 0;
begin
  if tenant_id is null then
    raise exception 'verified tenant context is required' using errcode = '28000';
  end if;

  select live_target_id into target_conversation_id
  from zeus.deletion_request
  where user_id = tenant_id
    and id = deletion_request_id
    and scope = 'conversation'
    and status in ('pending', 'failed')
    and live_target_id is not null
  for update;

  if target_conversation_id is null then
    raise exception 'eligible same-tenant conversation deletion request was not found'
      using errcode = '23514';
  end if;

  if not exists (
    select 1 from zeus.conversation
    where user_id = tenant_id and id = target_conversation_id
    for update
  ) then
    raise exception 'deletion target is not an accessible conversation'
      using errcode = '23514';
  end if;

  update zeus.deletion_request
  set status = 'running', error_code = null
  where user_id = tenant_id and id = deletion_request_id;

  select coalesce(array_agg(id), array[]::uuid[]), count(*)
  into target_message_ids, deleted_messages
  from zeus.message
  where user_id = tenant_id and conversation_id = target_conversation_id;

  select coalesce(array_agg(id), array[]::uuid[])
  into target_passage_ids
  from zeus.evidence_passage
  where user_id = tenant_id and message_id = any(target_message_ids);

  select coalesce(array_agg(distinct fact.id), array[]::uuid[])
  into affected_fact_ids
  from zeus.fact fact
  left join zeus.fact_evidence evidence
    on evidence.user_id = fact.user_id and evidence.fact_id = fact.id
  where fact.user_id = tenant_id
    and (
      fact.source_message_id = any(target_message_ids)
      or evidence.source_message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'fact' and resource_id = any(affected_fact_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'fact' and resource_id = any(affected_fact_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'fact' and resource_id = any(affected_fact_ids);

  update zeus.fact fact
  set source_message_id = (
    select evidence.source_message_id
    from zeus.fact_evidence evidence
    where evidence.user_id = fact.user_id
      and evidence.fact_id = fact.id
      and not (evidence.source_message_id = any(target_message_ids))
    order by evidence.created_at, evidence.id
    limit 1
  )
  where fact.user_id = tenant_id
    and fact.source_message_id = any(target_message_ids)
    and exists (
      select 1 from zeus.fact_evidence evidence
      where evidence.user_id = fact.user_id
        and evidence.fact_id = fact.id
        and not (evidence.source_message_id = any(target_message_ids))
    );

  delete from zeus.fact_evidence
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_fact_ids
  from zeus.fact
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  update zeus.fact
  set valid_to = null, superseded_by_id = null
  where user_id = tenant_id and superseded_by_id = any(doomed_fact_ids);

  delete from zeus.fact
  where user_id = tenant_id and id = any(doomed_fact_ids);

  select coalesce(array_agg(distinct facet.id), array[]::uuid[])
  into affected_facet_ids
  from zeus.understanding_facet facet
  left join zeus.facet_evidence evidence
    on evidence.user_id = facet.user_id and evidence.facet_id = facet.id
  where facet.user_id = tenant_id
    and (
      facet.source_message_id = any(target_message_ids)
      or evidence.source_message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'facet' and resource_id = any(affected_facet_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'facet' and resource_id = any(affected_facet_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'facet' and resource_id = any(affected_facet_ids);

  update zeus.understanding_facet facet
  set source_message_id = (
    select evidence.source_message_id
    from zeus.facet_evidence evidence
    where evidence.user_id = facet.user_id
      and evidence.facet_id = facet.id
      and not (evidence.source_message_id = any(target_message_ids))
    order by evidence.created_at, evidence.id
    limit 1
  )
  where facet.user_id = tenant_id
    and facet.source_message_id = any(target_message_ids)
    and exists (
      select 1 from zeus.facet_evidence evidence
      where evidence.user_id = facet.user_id
        and evidence.facet_id = facet.id
        and not (evidence.source_message_id = any(target_message_ids))
    );

  delete from zeus.facet_evidence
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_facet_ids
  from zeus.understanding_facet
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  delete from zeus.understanding_facet
  where user_id = tenant_id and id = any(doomed_facet_ids);

  select coalesce(array_agg(distinct candidate.id), array[]::uuid[])
  into affected_candidate_ids
  from zeus.memory_candidate candidate
  left join zeus.candidate_evidence evidence
    on evidence.user_id = candidate.user_id and evidence.candidate_id = candidate.id
  left join zeus.evidence_passage passage
    on passage.user_id = evidence.user_id and passage.id = evidence.passage_id
  where candidate.user_id = tenant_id
    and (
      candidate.source_message_id = any(target_message_ids)
      or passage.message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and resource_id = any(affected_candidate_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'candidate'
    and resource_id = any(affected_candidate_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'candidate'
    and resource_id = any(affected_candidate_ids);
  delete from zeus.memory_candidate
  where user_id = tenant_id and id = any(affected_candidate_ids);

  select coalesce(array_agg(distinct commitment.id), array[]::uuid[])
  into affected_commitment_ids
  from zeus.commitment commitment
  left join zeus.commitment_event event
    on event.user_id = commitment.user_id and event.commitment_id = commitment.id
  where commitment.user_id = tenant_id
    and (
      commitment.source_message_id = any(target_message_ids)
      or event.source_message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'commitment'
    and resource_id = any(affected_commitment_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'commitment'
    and resource_id = any(affected_commitment_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'commitment'
    and resource_id = any(affected_commitment_ids);

  update zeus.commitment commitment
  set source_message_id = (
    select event.source_message_id
    from zeus.commitment_event event
    where event.user_id = commitment.user_id
      and event.commitment_id = commitment.id
      and event.source_message_id is not null
      and not (event.source_message_id = any(target_message_ids))
    order by event.created_at, event.id
    limit 1
  )
  where commitment.user_id = tenant_id
    and commitment.source_message_id = any(target_message_ids)
    and exists (
      select 1 from zeus.commitment_event event
      where event.user_id = commitment.user_id
        and event.commitment_id = commitment.id
        and event.source_message_id is not null
        and not (event.source_message_id = any(target_message_ids))
    );

  delete from zeus.commitment_event
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_commitment_ids
  from zeus.commitment
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  delete from zeus.commitment
  where user_id = tenant_id and id = any(doomed_commitment_ids);

  select coalesce(array_agg(distinct goal.id), array[]::uuid[])
  into affected_goal_ids
  from zeus.goal goal
  left join zeus.goal_event event
    on event.user_id = goal.user_id and event.goal_id = goal.id
  where goal.user_id = tenant_id
    and (
      goal.source_message_id = any(target_message_ids)
      or event.source_message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'goal' and resource_id = any(affected_goal_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'goal' and resource_id = any(affected_goal_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'goal' and resource_id = any(affected_goal_ids);

  update zeus.goal goal
  set source_message_id = (
    select event.source_message_id
    from zeus.goal_event event
    where event.user_id = goal.user_id
      and event.goal_id = goal.id
      and event.source_message_id is not null
      and not (event.source_message_id = any(target_message_ids))
    order by event.created_at, event.id
    limit 1
  )
  where goal.user_id = tenant_id
    and goal.source_message_id = any(target_message_ids)
    and exists (
      select 1 from zeus.goal_event event
      where event.user_id = goal.user_id
        and event.goal_id = goal.id
        and event.source_message_id is not null
        and not (event.source_message_id = any(target_message_ids))
    );

  delete from zeus.goal_event
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_goal_ids
  from zeus.goal
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  update zeus.commitment
  set linked_goal_id = null
  where user_id = tenant_id and linked_goal_id = any(doomed_goal_ids);

  delete from zeus.goal
  where user_id = tenant_id and id = any(doomed_goal_ids);

  select coalesce(array_agg(distinct project.id), array[]::uuid[])
  into affected_project_ids
  from zeus.project project
  left join zeus.project_event event
    on event.user_id = project.user_id and event.project_id = project.id
  where project.user_id = tenant_id
    and (
      project.source_message_id = any(target_message_ids)
      or event.source_message_id = any(target_message_ids)
    );

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'project'
    and resource_id = any(affected_project_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'project'
    and resource_id = any(affected_project_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'project'
    and resource_id = any(affected_project_ids);

  update zeus.project project
  set source_message_id = (
    select event.source_message_id
    from zeus.project_event event
    where event.user_id = project.user_id
      and event.project_id = project.id
      and event.source_message_id is not null
      and not (event.source_message_id = any(target_message_ids))
    order by event.created_at, event.id
    limit 1
  )
  where project.user_id = tenant_id
    and project.source_message_id = any(target_message_ids)
    and exists (
      select 1 from zeus.project_event event
      where event.user_id = project.user_id
        and event.project_id = project.id
        and event.source_message_id is not null
        and not (event.source_message_id = any(target_message_ids))
    );

  delete from zeus.project_event
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_project_ids
  from zeus.project
  where user_id = tenant_id and source_message_id = any(target_message_ids);

  update zeus.goal
  set project_id = null
  where user_id = tenant_id and project_id = any(doomed_project_ids);
  update zeus.commitment
  set project_id = null
  where user_id = tenant_id and project_id = any(doomed_project_ids);

  -- Facets scoped to a resource that disappears cannot remain semantically valid.
  select coalesce(array_agg(id), array[]::uuid[])
  into doomed_facet_ids
  from zeus.understanding_facet
  where user_id = tenant_id
    and (
      scope_project_id = any(doomed_project_ids)
      or scope_goal_id = any(doomed_goal_ids)
      or scope_commitment_id = any(doomed_commitment_ids)
    );
  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'facet' and resource_id = any(doomed_facet_ids);
  delete from zeus.memory_job_activity
  where user_id = tenant_id and resource_kind = 'facet' and resource_id = any(doomed_facet_ids);
  delete from zeus.memory_change
  where user_id = tenant_id and resource_kind = 'facet' and resource_id = any(doomed_facet_ids);
  delete from zeus.understanding_facet
  where user_id = tenant_id and id = any(doomed_facet_ids);

  delete from zeus.project
  where user_id = tenant_id and id = any(doomed_project_ids);

  select coalesce(array_agg(id), array[]::uuid[])
  into affected_recommendation_ids
  from zeus.follow_through_event
  where user_id = tenant_id
    and (
      source_message_id = any(target_message_ids)
      or response_message_id = any(target_message_ids)
    );
  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'recommendation'
    and resource_id = any(affected_recommendation_ids);
  delete from zeus.follow_through_event
  where user_id = tenant_id and id = any(affected_recommendation_ids);

  delete from zeus.response_trace_item
  where user_id = tenant_id and item_kind = 'episode'
    and resource_id = any(target_passage_ids);

  delete from zeus.conversation
  where user_id = tenant_id and id = target_conversation_id;

  update zeus.deletion_request
  set status = 'completed', completed_at = clock_timestamp(), error_code = null
  where user_id = tenant_id and id = deletion_request_id;

  return jsonb_build_object(
    'conversation_id', target_conversation_id,
    'deleted_messages', deleted_messages,
    'rehomed_facts', cardinality(affected_fact_ids) - cardinality(doomed_fact_ids),
    'removed_facts', cardinality(doomed_fact_ids)
  );
end
$function$;

do $source_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'entity_alias', 'fact', 'fact_evidence', 'memory_candidate',
    'understanding_facet', 'facet_evidence', 'project', 'project_event',
    'goal', 'goal_event', 'commitment', 'commitment_event',
    'follow_through_event', 'memory_job', 'memory_job_activity'
  ]
  loop
    execute format(
      'create trigger %I_validate_source before insert or update of source_message_id on zeus.%I for each row execute function zeus_private.validate_source_column(''source_message_id'')',
      table_name,
      table_name
    );
  end loop;
end
$source_triggers$;

create trigger response_trace_validate_assistant
before insert or update of assistant_message_id on zeus.response_trace
for each row execute function zeus_private.validate_message_role_column(
  'assistant_message_id',
  'assistant'
);

create trigger memory_job_validate_assistant
before insert or update of assistant_message_id on zeus.memory_job
for each row execute function zeus_private.validate_message_role_column(
  'assistant_message_id',
  'assistant'
);

do $updated_at_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'experience_setting', 'conversation', 'entity', 'evidence_passage', 'fact',
    'memory_candidate', 'understanding_facet', 'project', 'goal', 'commitment',
    'stewardship_setting', 'memory_job'
  ]
  loop
    execute format(
      'create trigger %I_touch_updated_at before update on zeus.%I for each row execute function zeus_private.touch_updated_at()',
      table_name,
      table_name
    );
  end loop;
end
$updated_at_triggers$;

do $record_version_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'fact', 'memory_candidate', 'understanding_facet',
    'project', 'goal', 'commitment'
  ]
  loop
    execute format(
      'create trigger %I_bump_record_version before update on zeus.%I for each row execute function zeus_private.bump_record_version()',
      table_name,
      table_name
    );
  end loop;
end
$record_version_triggers$;

-- RLS is intentionally repetitive at runtime but generated here so additions
-- cannot accidentally receive a differently worded tenant predicate.
do $tenant_rls$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenant_predicate', 'experience_setting', 'conversation', 'message', 'response_trace',
    'response_trace_item', 'entity', 'entity_alias', 'evidence_passage',
    'fact', 'fact_evidence', 'memory_candidate', 'candidate_evidence',
    'candidate_resolution_event', 'understanding_facet', 'facet_evidence',
    'project', 'project_event', 'goal', 'goal_event', 'commitment',
    'commitment_event', 'stewardship_setting', 'follow_through_event',
    'memory_job', 'memory_change_set', 'memory_change', 'memory_job_activity',
    'data_export_job', 'deletion_request'
  ]
  loop
    execute format('alter table zeus.%I enable row level security', table_name);
    execute format('alter table zeus.%I force row level security', table_name);
    execute format(
      'create policy %I on zeus.%I for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_tenant_isolation',
      table_name
    );
  end loop;
end
$tenant_rls$;

revoke all on all tables in schema zeus from public, anon, authenticated;
revoke all on all sequences in schema zeus from public, anon, authenticated;
revoke all on all tables in schema zeus from zeus_app, zeus_worker;
revoke execute on all functions in schema zeus_private
  from public, anon, authenticated, zeus_app, zeus_worker;
grant execute on all functions in schema zeus_private to zeus_app, zeus_worker;
revoke execute on function zeus_private.erase_requested_conversation(uuid) from zeus_app;
grant select on zeus.predicate_registry to authenticated, zeus_app, zeus_worker;

-- Browsers may subscribe to and read their own job/activity rows. All writes
-- and all remaining reads go through the tenant-scoped Node services.
grant select on
  zeus.memory_job,
  zeus.memory_job_activity,
  zeus.memory_change_set,
  zeus.memory_change,
  zeus.data_export_job,
  zeus.deletion_request
to authenticated;

-- Grant only the operations each domain requires. Provenance, evidence, and
-- lifecycle histories are append-only: explicit parent/source deletion may
-- still remove them through FK cascades, but application roles cannot rewrite
-- or selectively erase their audit records. A future table starts inaccessible
-- until a migration deliberately classifies it here.
do $tenant_table_grants$
declare
  table_name text;
begin
  foreach table_name in array array[
    'experience_setting', 'conversation', 'entity', 'entity_alias',
    'evidence_passage', 'fact', 'understanding_facet', 'project', 'goal',
    'commitment', 'stewardship_setting'
  ]
  loop
    execute format(
      'grant select, insert, update, delete on zeus.%I to zeus_app, zeus_worker',
      table_name
    );
  end loop;

  foreach table_name in array array[
    'memory_candidate', 'memory_job', 'memory_change_set',
    'data_export_job', 'deletion_request'
  ]
  loop
    execute format(
      'grant select, insert, update on zeus.%I to zeus_app, zeus_worker',
      table_name
    );
  end loop;

  foreach table_name in array array[
    'tenant_predicate', 'message', 'response_trace', 'response_trace_item', 'fact_evidence',
    'candidate_evidence', 'candidate_resolution_event', 'facet_evidence',
    'project_event', 'goal_event', 'commitment_event',
    'follow_through_event', 'memory_change', 'memory_job_activity'
  ]
  loop
    execute format(
      'grant select, insert on zeus.%I to zeus_app, zeus_worker',
      table_name
    );
  end loop;
end
$tenant_table_grants$;

revoke all on zeus.predicate_registry from zeus_app, zeus_worker;
grant select on zeus.predicate_registry to authenticated, zeus_app, zeus_worker;
grant usage, select on all sequences in schema zeus to zeus_app, zeus_worker;

alter default privileges in schema zeus revoke all on tables
  from public, anon, authenticated, zeus_app, zeus_worker;
alter default privileges in schema zeus revoke all on sequences
  from public, anon, authenticated, zeus_app, zeus_worker;
alter default privileges in schema zeus_private revoke execute on functions
  from public, anon, authenticated, zeus_app, zeus_worker;

-- Realtime publication is optional in self-hosted Postgres, but Supabase
-- projects should publish only the small user-visible job/change feed.
do $realtime$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array[
      'memory_job', 'memory_job_activity', 'memory_change_set'
    ]
    loop
      begin
        execute format('alter publication supabase_realtime add table zeus.%I', table_name);
      exception when duplicate_object then
        null;
      end;
      execute format('alter table zeus.%I replica identity full', table_name);
    end loop;
  end if;
end
$realtime$;

commit;
