/**
 * Schema migrations, in order. Applied once each and recorded in `schema_migration`.
 *
 * These are TypeScript string constants rather than `.sql` files on purpose: the same
 * module is loaded by the Next.js bundler and by `tsx` for the MCP server, and embedded
 * strings resolve identically in both. Reading sibling files would need `__dirname`,
 * which does not exist in ESM and does not survive Next's bundling.
 */

export type Migration = {
  readonly id: string;
  readonly sql: string;
};

/** Slug of the entity representing the user. Facts about the user hang off this row. */
export const SELF_SLUG = "self";

const INIT = `
-- Entities: people, projects, orgs, places, topics, things.
-- Topics are first-class — they are the "everything they care about" half of Zeus.
CREATE TABLE entity (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('person','project','org','place','topic','thing')),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  summary     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX entity_kind_idx ON entity(kind);

-- "Sarah" / "Sarah Chen" / "sarah" all resolve to one entity.
-- Aliases are stored folded (lowercase, collapsed whitespace) so lookup is exact.
CREATE TABLE entity_alias (
  entity_id   INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias)
);

CREATE UNIQUE INDEX entity_alias_alias_idx ON entity_alias(alias);

-- Episodic memory: the raw conversation log. Every fact points back into it,
-- so provenance is a foreign key rather than a hopeful note.
CREATE TABLE conversation (
  id          INTEGER PRIMARY KEY,
  title       TEXT,
  source      TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','mcp','seed')),
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE message (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX message_conversation_idx ON message(conversation_id, id);

-- Predicate registry. The cardinality column drives supersession, and defaults to
-- 'multi' for anything unseen: Zeus never silently closes a fact it was unsure about.
CREATE TABLE predicate (
  name         TEXT PRIMARY KEY,
  cardinality  TEXT NOT NULL DEFAULT 'multi' CHECK (cardinality IN ('single','multi')),
  description  TEXT,
  created_at   TEXT NOT NULL
);

-- The core. An atomic assertion with provenance and a validity window.
-- Nothing here is ever hard-deleted by the pipeline; superseded facts get
-- valid_to set and remain answerable ("where did I work before?").
CREATE TABLE fact (
  id                 INTEGER PRIMARY KEY,
  subject_id         INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  predicate          TEXT NOT NULL REFERENCES predicate(name),
  object             TEXT NOT NULL,
  object_entity_id   INTEGER REFERENCES entity(id) ON DELETE SET NULL,
  confidence         REAL NOT NULL DEFAULT 0.8 CHECK (confidence > 0 AND confidence <= 1),
  valid_from         TEXT NOT NULL,
  valid_to           TEXT,
  superseded_by      INTEGER REFERENCES fact(id) ON DELETE SET NULL,
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  assertion_count    INTEGER NOT NULL DEFAULT 1,
  last_seen_at       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

-- Supersession lookup and entity dossiers hit this constantly.
CREATE INDEX fact_live_idx ON fact(subject_id, predicate) WHERE valid_to IS NULL;
CREATE INDEX fact_subject_idx ON fact(subject_id);
-- Reverse graph traversal: "who else is connected to Acme?"
CREATE INDEX fact_object_entity_idx ON fact(object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX fact_source_idx ON fact(source_message_id);
CREATE INDEX fact_valid_from_idx ON fact(valid_from);

-- Local embeddings. vec is a little-endian Float32Array buffer.
CREATE TABLE embedding (
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('fact','message','entity')),
  owner_id    INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  dim         INTEGER NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

-- Lexical search. Regular (not contentless) FTS5 tables so DELETE by rowid works
-- without replaying the original text; the extra disk is irrelevant at personal scale.
CREATE VIRTUAL TABLE fact_fts USING fts5(text, tokenize='porter unicode61');
CREATE VIRTUAL TABLE message_fts USING fts5(text, tokenize='porter unicode61');
`;

/** ISO-8601 UTC from SQLite's own clock, so migrations need no bound parameters. */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * Seed rows. Written as a migration so a fresh database is immediately usable.
 *
 * The `self` entity means every fact has a non-null subject: joins, the graph, and
 * the dossier UI are all uniform, with no "NULL means the user" special case.
 */
const SEED = `
INSERT INTO entity (kind, name, slug, summary, created_at, updated_at)
VALUES ('person', 'You', '${SELF_SLUG}', 'The user Zeus exists to know.', ${NOW}, ${NOW});

INSERT INTO entity_alias (entity_id, alias, created_at)
VALUES ((SELECT id FROM entity WHERE slug = '${SELF_SLUG}'), 'me', ${NOW}),
       ((SELECT id FROM entity WHERE slug = '${SELF_SLUG}'), 'i', ${NOW}),
       ((SELECT id FROM entity WHERE slug = '${SELF_SLUG}'), 'myself', ${NOW});

-- Single-valued predicates: asserting a new value closes the old one.
-- Everything else defaults to 'multi' on first use.
INSERT INTO predicate (name, cardinality, description, created_at) VALUES
  ('works_at',       'single', 'Current employer or organization', ${NOW}),
  ('job_title',      'single', 'Current role or title', ${NOW}),
  ('lives_in',       'single', 'Current city or region of residence', ${NOW}),
  ('birthday',       'single', 'Date of birth', ${NOW}),
  ('timezone',       'single', 'Current timezone', ${NOW}),
  ('relationship_to_user', 'single', 'How this entity relates to the user', ${NOW}),
  ('status',         'single', 'Current status of a project or thing', ${NOW}),
  ('likes',          'multi',  'Something the subject enjoys or prefers', ${NOW}),
  ('dislikes',       'multi',  'Something the subject avoids or dislikes', ${NOW}),
  ('knows',          'multi',  'A person the subject knows', ${NOW}),
  ('works_on',       'multi',  'A project the subject contributes to', ${NOW}),
  ('cares_about',    'multi',  'A topic the subject actively tracks', ${NOW}),
  ('goal',           'multi',  'Something the subject is trying to achieve', ${NOW}),
  ('prefers',        'multi',  'A stated working or tooling preference', ${NOW}),
  ('note',           'multi',  'A durable fact that fits no other predicate', ${NOW});
`;

/**
 * The personal-copilot layer. Facts remain the compact current/history projection;
 * these tables add the evidence, review, and intention records that should never be
 * squeezed into a generic predicate.
 */
const COPILOT = `
-- Every assertion of a fact is evidence. The fact row keeps its original source for
-- backwards compatibility; this table preserves later reassertions as well.
CREATE TABLE fact_evidence (
  id                 INTEGER PRIMARY KEY,
  fact_id            INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('assertion','reassertion','correction')),
  confidence         REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  created_at         TEXT NOT NULL,
  UNIQUE (fact_id, source_message_id)
);

CREATE INDEX fact_evidence_fact_idx ON fact_evidence(fact_id, created_at);
CREATE INDEX fact_evidence_source_idx ON fact_evidence(source_message_id);

-- Backfill only genuine provenance. A legacy NULL is left NULL rather than replaced
-- with a synthetic source that would make the history look stronger than it is.
INSERT INTO fact_evidence (fact_id, source_message_id, kind, confidence, created_at)
SELECT id, source_message_id, 'assertion', confidence, created_at
FROM fact
WHERE source_message_id IS NOT NULL;

-- Proposed memories that are not safe to treat as canonical yet. payload_json is
-- validated by Zod before insertion and again when it crosses an application boundary.
CREATE TABLE memory_candidate (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('fact','goal','commitment','interest')),
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  reason             TEXT NOT NULL CHECK (reason IN ('inference','ambiguous','sensitive','conflict')),
  confidence         REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  resolved_at        TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX memory_candidate_status_idx ON memory_candidate(status, created_at DESC);
CREATE INDEX memory_candidate_source_idx ON memory_candidate(source_message_id);

CREATE TABLE goal (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','achieved','abandoned')),
  target_at          TEXT,
  confidence         REAL NOT NULL DEFAULT 0.9 CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  closed_at          TEXT
);

CREATE INDEX goal_status_idx ON goal(status, target_at, updated_at DESC);
CREATE INDEX goal_source_idx ON goal(source_message_id);

CREATE TABLE goal_event (
  id                 INTEGER PRIMARY KEY,
  goal_id            INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL CHECK (event_type IN ('created','updated','status_changed')),
  from_status        TEXT,
  to_status          TEXT,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('message','user_action')),
  created_at         TEXT NOT NULL
);

CREATE INDEX goal_event_goal_idx ON goal_event(goal_id, created_at);

CREATE TABLE commitment (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  owner_entity_id    INTEGER NOT NULL REFERENCES entity(id) ON DELETE RESTRICT,
  linked_goal_id     INTEGER REFERENCES goal(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','done','cancelled')),
  due_at             TEXT,
  snoozed_until      TEXT,
  last_surfaced_at   TEXT,
  confidence         REAL NOT NULL DEFAULT 0.9 CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  closed_at          TEXT
);

CREATE INDEX commitment_status_idx ON commitment(status, due_at, updated_at DESC);
CREATE INDEX commitment_owner_idx ON commitment(owner_entity_id, status);
CREATE INDEX commitment_goal_idx ON commitment(linked_goal_id);
CREATE INDEX commitment_source_idx ON commitment(source_message_id);

CREATE TABLE commitment_event (
  id                 INTEGER PRIMARY KEY,
  commitment_id      INTEGER NOT NULL REFERENCES commitment(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL CHECK (event_type IN ('created','updated','status_changed','surfaced','snoozed')),
  from_status        TEXT,
  to_status          TEXT,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('message','user_action','system')),
  created_at         TEXT NOT NULL
);

CREATE INDEX commitment_event_commitment_idx ON commitment_event(commitment_id, created_at);

-- What was actually supplied to a response. This makes "why did Zeus say that?"
-- inspectable without treating the trace itself as new memory.
CREATE TABLE response_context (
  assistant_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  item_kind             TEXT NOT NULL CHECK (item_kind IN ('fact','episode','goal','commitment')),
  item_id               INTEGER NOT NULL,
  rank                  INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (assistant_message_id, item_kind, item_id)
);

CREATE INDEX response_context_message_idx ON response_context(assistant_message_id, rank);
`;

const RESPONSE_SNAPSHOTS = `
-- IDs make traces navigable; immutable snapshots make them historically accurate when
-- a goal or commitment changes later. Explicit source deletion removes affected rows.
ALTER TABLE response_context
ADD COLUMN snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json));
`;

/**
 * Follow-through is deliberately separate from memory. A recommendation is a proposal,
 * not a fact about the user; this append-only log records what Zeus surfaced and how the
 * user responded without promoting assistant-authored text into canonical context.
 */
const STEWARDSHIP = `
ALTER TABLE goal
ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high'));

-- Goal snapshots written before priorities existed must remain parseable and immutable.
-- Backfill only the new field inside the stored snapshot; do not reconstruct it from the
-- now-current goal row, which could have changed since the response.
UPDATE response_context
SET snapshot_json = json_set(snapshot_json, '$.goal.priority', 'normal')
WHERE item_kind = 'goal'
  AND snapshot_json IS NOT NULL
  AND json_type(snapshot_json, '$.goal.priority') IS NULL;

CREATE TABLE stewardship_setting (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  mode               TEXT NOT NULL DEFAULT 'balanced'
                     CHECK (mode IN ('quiet','balanced','proactive')),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);

INSERT INTO stewardship_setting (id, mode, source_message_id, updated_at)
VALUES (1, 'balanced', NULL, ${NOW});

CREATE TABLE follow_through_event (
  id                   INTEGER PRIMARY KEY,
  commitment_id        INTEGER NOT NULL REFERENCES commitment(id) ON DELETE CASCADE,
  goal_id              INTEGER REFERENCES goal(id) ON DELETE SET NULL,
  event_type           TEXT NOT NULL
                       CHECK (event_type IN ('surfaced','accepted','dismissed','snoozed','completed','regretted')),
  reason               TEXT NOT NULL
                       CHECK (reason IN ('overdue','due_soon','relevant','waiting','stale','conflict','priority')),
  action_kind          TEXT NOT NULL
                       CHECK (action_kind IN ('draft','schedule','research','remind','coordinate','plan')),
  detail_json          TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  response_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_message_id    INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('system','message','user_action')),
  created_at           TEXT NOT NULL
);

CREATE INDEX follow_through_commitment_idx
ON follow_through_event(commitment_id, created_at DESC);
CREATE INDEX follow_through_response_idx
ON follow_through_event(response_message_id)
WHERE response_message_id IS NOT NULL;
CREATE INDEX follow_through_source_idx
ON follow_through_event(source_message_id)
WHERE source_message_id IS NOT NULL;
CREATE INDEX follow_through_type_idx
ON follow_through_event(event_type, created_at DESC);
`;

/**
 * Evidence-backed whole-person understanding.
 *
 * Facts remain atomic claims. Facets are accepted, contextual interpretations such as
 * values, constraints, and communication preferences. Passages make episodic recall
 * claim-sized so accepting one sensitive claim cannot unlock its whole source message.
 */
const UNDERSTANDING = `
ALTER TABLE message
ADD COLUMN origin TEXT NOT NULL DEFAULT 'conversation'
  CHECK (origin IN ('conversation','user_action','reflection','backfill'));

ALTER TABLE message
ADD COLUMN recall_state TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (recall_state IN ('unclassified','classified','blocked'));

-- An alias may name more than one entity. Resolution must surface ambiguity rather
-- than silently binding a shared first name to whichever entity was inserted first.
DROP INDEX entity_alias_alias_idx;
CREATE INDEX entity_alias_lookup_idx ON entity_alias(alias, entity_id);

CREATE TABLE entity_evidence (
  id                 INTEGER PRIMARY KEY,
  entity_id          INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('mention','assertion','correction')),
  created_at         TEXT NOT NULL,
  UNIQUE (entity_id, source_message_id, kind)
);

CREATE INDEX entity_evidence_source_idx ON entity_evidence(source_message_id);

CREATE TABLE entity_alias_evidence (
  entity_id          INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  alias              TEXT NOT NULL,
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias, source_message_id),
  FOREIGN KEY (entity_id, alias) REFERENCES entity_alias(entity_id, alias) ON DELETE CASCADE
);

CREATE TABLE extraction_run (
  id                 INTEGER PRIMARY KEY,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  focus_message_id   INTEGER REFERENCES message(id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
  error_code         TEXT,
  started_at         TEXT NOT NULL,
  completed_at       TEXT
);

CREATE INDEX extraction_run_focus_idx ON extraction_run(focus_message_id, id DESC);

CREATE TABLE evidence_passage (
  id                 INTEGER PRIMARY KEY,
  message_id         INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  start_offset       INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset         INTEGER NOT NULL CHECK (end_offset > start_offset),
  text               TEXT NOT NULL,
  sensitivity        TEXT NOT NULL CHECK (sensitivity IN ('normal','sensitive','uncertain')),
  recall_status      TEXT NOT NULL CHECK (recall_status IN ('allowed','pending','blocked')),
  extraction_run_id  INTEGER REFERENCES extraction_run(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  UNIQUE (message_id, start_offset, end_offset)
);

CREATE INDEX evidence_passage_message_idx ON evidence_passage(message_id, start_offset);
CREATE INDEX evidence_passage_recall_idx ON evidence_passage(recall_status, sensitivity);
CREATE VIRTUAL TABLE passage_fts USING fts5(text, tokenize='porter unicode61');

-- Canonical claims keep their message-level provenance for compatibility and also
-- identify the exact validated claim span used by the production extractor.
ALTER TABLE fact_evidence
ADD COLUMN passage_id INTEGER REFERENCES evidence_passage(id) ON DELETE SET NULL;

ALTER TABLE goal_event
ADD COLUMN passage_id INTEGER REFERENCES evidence_passage(id) ON DELETE SET NULL;

ALTER TABLE commitment_event
ADD COLUMN passage_id INTEGER REFERENCES evidence_passage(id) ON DELETE SET NULL;

CREATE INDEX fact_evidence_passage_idx ON fact_evidence(passage_id);
CREATE INDEX goal_event_passage_idx ON goal_event(passage_id);
CREATE INDEX commitment_event_passage_idx ON commitment_event(passage_id);

CREATE TABLE passage_embedding (
  passage_id   INTEGER PRIMARY KEY REFERENCES evidence_passage(id) ON DELETE CASCADE,
  vec          BLOB NOT NULL,
  dim          INTEGER NOT NULL,
  model        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE understanding_backfill_job (
  id                 INTEGER PRIMARY KEY,
  status             TEXT NOT NULL CHECK (status IN ('preview','running','completed','failed','cancelled')),
  conversation_count INTEGER NOT NULL DEFAULT 0,
  message_count      INTEGER NOT NULL DEFAULT 0,
  processed_count    INTEGER NOT NULL DEFAULT 0,
  last_message_id    INTEGER,
  error_message      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  completed_at       TEXT
);

CREATE TABLE understanding_facet (
  id                   INTEGER PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'value','decision_criterion','constraint','preference','motivation',
                         'routine','communication_style','working_style','boundary',
                         'capacity_pattern','skill','relationship_dynamic'
                       )),
  statement            TEXT NOT NULL,
  scope_kind           TEXT NOT NULL CHECK (scope_kind IN ('global','domain','entity','goal','commitment')),
  scope_label          TEXT,
  scope_entity_id      INTEGER REFERENCES entity(id) ON DELETE SET NULL,
  scope_goal_id        INTEGER REFERENCES goal(id) ON DELETE SET NULL,
  scope_commitment_id  INTEGER REFERENCES commitment(id) ON DELETE SET NULL,
  condition_text       TEXT,
  importance           TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('low','normal','high')),
  sensitivity          TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive')),
  confidence           REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  machine_effect       TEXT CHECK (machine_effect IN ('boost','deprioritize','block')),
  valid_from           TEXT NOT NULL,
  valid_to             TEXT,
  superseded_by        INTEGER REFERENCES understanding_facet(id) ON DELETE SET NULL,
  source_message_id    INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    (scope_kind = 'global' AND scope_label IS NULL AND scope_entity_id IS NULL AND scope_goal_id IS NULL AND scope_commitment_id IS NULL)
    OR (scope_kind = 'domain' AND scope_label IS NOT NULL AND scope_entity_id IS NULL AND scope_goal_id IS NULL AND scope_commitment_id IS NULL)
    OR (scope_kind = 'entity' AND scope_entity_id IS NOT NULL AND scope_goal_id IS NULL AND scope_commitment_id IS NULL)
    OR (scope_kind = 'goal' AND scope_goal_id IS NOT NULL AND scope_entity_id IS NULL AND scope_commitment_id IS NULL)
    OR (scope_kind = 'commitment' AND scope_commitment_id IS NOT NULL AND scope_entity_id IS NULL AND scope_goal_id IS NULL)
  )
);

CREATE INDEX understanding_facet_live_idx ON understanding_facet(kind, scope_kind)
WHERE valid_to IS NULL;
CREATE INDEX understanding_facet_source_idx ON understanding_facet(source_message_id);
CREATE INDEX understanding_facet_entity_idx ON understanding_facet(scope_entity_id)
WHERE scope_entity_id IS NOT NULL;
CREATE INDEX understanding_facet_goal_idx ON understanding_facet(scope_goal_id)
WHERE scope_goal_id IS NOT NULL;
CREATE INDEX understanding_facet_commitment_idx ON understanding_facet(scope_commitment_id)
WHERE scope_commitment_id IS NOT NULL;
CREATE VIRTUAL TABLE facet_fts USING fts5(text, tokenize='porter unicode61');

CREATE TABLE facet_evidence (
  id                 INTEGER PRIMARY KEY,
  facet_id           INTEGER NOT NULL REFERENCES understanding_facet(id) ON DELETE CASCADE,
  passage_id         INTEGER NOT NULL REFERENCES evidence_passage(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('assertion','pattern_support','correction')),
  confidence         REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  created_at         TEXT NOT NULL,
  UNIQUE (facet_id, passage_id)
);

CREATE INDEX facet_evidence_facet_idx ON facet_evidence(facet_id, id);
CREATE INDEX facet_evidence_passage_idx ON facet_evidence(passage_id);

CREATE TABLE facet_event (
  id                 INTEGER PRIMARY KEY,
  facet_id           INTEGER REFERENCES understanding_facet(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL CHECK (event_type IN ('accepted','corrected','closed','revived','forgotten')),
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('message','user_action','system')),
  created_at         TEXT NOT NULL
);

CREATE INDEX facet_event_facet_idx ON facet_event(facet_id, id);

-- Recreate the candidate table to add facets, multi-reason audit data, dedupe keys,
-- and optional association with a preview-only historical backfill.
ALTER TABLE memory_candidate RENAME TO memory_candidate_legacy;

CREATE TABLE memory_candidate (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('fact','goal','commitment','interest','facet')),
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  reason             TEXT NOT NULL CHECK (reason IN ('inference','ambiguous','sensitive','conflict')),
  reasons_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
  confidence         REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  dedupe_key         TEXT,
  origin             TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','backfill')),
  backfill_job_id    INTEGER REFERENCES understanding_backfill_job(id) ON DELETE CASCADE,
  resolved_at        TEXT,
  created_at         TEXT NOT NULL
);

INSERT INTO memory_candidate
  (id, kind, payload_json, reason, reasons_json, confidence, source_message_id,
   status, dedupe_key, origin, backfill_job_id, resolved_at, created_at)
SELECT id, kind, payload_json, reason, json_array(reason), confidence,
       source_message_id, status, NULL, 'live', NULL, resolved_at, created_at
FROM memory_candidate_legacy;

DROP TABLE memory_candidate_legacy;
CREATE INDEX memory_candidate_status_idx ON memory_candidate(status, created_at DESC);
CREATE INDEX memory_candidate_source_idx ON memory_candidate(source_message_id);
CREATE INDEX memory_candidate_dedupe_idx ON memory_candidate(dedupe_key, status)
WHERE dedupe_key IS NOT NULL;
CREATE INDEX memory_candidate_backfill_idx ON memory_candidate(backfill_job_id, status)
WHERE backfill_job_id IS NOT NULL;

CREATE TABLE candidate_evidence (
  candidate_id  INTEGER NOT NULL REFERENCES memory_candidate(id) ON DELETE CASCADE,
  passage_id    INTEGER NOT NULL REFERENCES evidence_passage(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (candidate_id, passage_id)
);

CREATE TABLE candidate_resolution_event (
  id                 INTEGER PRIMARY KEY,
  candidate_id       INTEGER NOT NULL REFERENCES memory_candidate(id) ON DELETE CASCADE,
  decision           TEXT NOT NULL CHECK (decision IN ('accepted','rejected','edited_accepted')),
  edited_payload_json TEXT CHECK (edited_payload_json IS NULL OR json_valid(edited_payload_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('user_action','message','system')),
  created_at         TEXT NOT NULL
);

CREATE INDEX candidate_resolution_candidate_idx
ON candidate_resolution_event(candidate_id, id);

CREATE TABLE understanding_backfill_item (
  job_id             INTEGER NOT NULL REFERENCES understanding_backfill_job(id) ON DELETE CASCADE,
  message_id         INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  extractor_version  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','skipped')),
  candidate_count    INTEGER NOT NULL DEFAULT 0,
  error_message      TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (job_id, message_id, extractor_version)
);

-- Response snapshots now support accepted facets and explain why every item was
-- selected. Old snapshots and ranks remain byte-for-byte intact.
ALTER TABLE response_context RENAME TO response_context_legacy;

CREATE TABLE response_context (
  assistant_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  item_kind             TEXT NOT NULL CHECK (item_kind IN ('fact','episode','goal','commitment','facet')),
  item_id               INTEGER NOT NULL,
  rank                  INTEGER NOT NULL,
  selection_reason      TEXT,
  selection_score       REAL,
  retrieval_json        TEXT CHECK (retrieval_json IS NULL OR json_valid(retrieval_json)),
  created_at            TEXT NOT NULL,
  snapshot_json         TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  PRIMARY KEY (assistant_message_id, item_kind, item_id)
);

INSERT INTO response_context
  (assistant_message_id, item_kind, item_id, rank, selection_reason,
   selection_score, retrieval_json, created_at, snapshot_json)
SELECT assistant_message_id, item_kind, item_id, rank, NULL, NULL, NULL,
       created_at, snapshot_json
FROM response_context_legacy;

DROP TABLE response_context_legacy;
CREATE INDEX response_context_message_idx ON response_context(assistant_message_id, rank);

CREATE TABLE mcp_recall_audit (
  id                 INTEGER PRIMARY KEY,
  tool_name          TEXT NOT NULL,
  query_text         TEXT NOT NULL,
  item_kind          TEXT NOT NULL CHECK (item_kind IN ('fact','episode','goal','commitment','facet')),
  item_id            INTEGER NOT NULL,
  rank               INTEGER NOT NULL,
  snapshot_json      TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at         TEXT NOT NULL
);

CREATE INDEX mcp_recall_audit_created_idx ON mcp_recall_audit(created_at DESC);
`;

/** Dedicated vectors keep facets out of the legacy owner-kind table and inherit
 * deletion from their canonical row. Passage vectors already have the same shape
 * in 006; facets need an independent table because the original generic embedding
 * CHECK intentionally admits only facts, messages, and entities. */
const FACET_EMBEDDINGS = `
CREATE TABLE facet_embedding (
  facet_id     INTEGER PRIMARY KEY REFERENCES understanding_facet(id) ON DELETE CASCADE,
  vec          BLOB NOT NULL,
  dim          INTEGER NOT NULL,
  model        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX facet_embedding_model_idx ON facet_embedding(model, facet_id);
CREATE INDEX passage_embedding_model_idx ON passage_embedding(model, passage_id);
`;

/** Pending candidates are review proposals, not canonical memory, but MCP can read
 * them through an explicit review tool. Give those reads their own truthful audit
 * kind instead of disguising a candidate id as a fact or facet id. */
const MCP_CANDIDATE_AUDIT = `
ALTER TABLE mcp_recall_audit RENAME TO mcp_recall_audit_legacy;

CREATE TABLE mcp_recall_audit (
  id                 INTEGER PRIMARY KEY,
  tool_name          TEXT NOT NULL,
  query_text         TEXT NOT NULL,
  item_kind          TEXT NOT NULL CHECK (item_kind IN ('fact','episode','goal','commitment','facet','candidate')),
  item_id            INTEGER NOT NULL,
  rank               INTEGER NOT NULL,
  snapshot_json      TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at         TEXT NOT NULL
);

INSERT INTO mcp_recall_audit
  (id, tool_name, query_text, item_kind, item_id, rank, snapshot_json, created_at)
SELECT id, tool_name, query_text, item_kind, item_id, rank, snapshot_json, created_at
FROM mcp_recall_audit_legacy;

DROP TABLE mcp_recall_audit_legacy;
CREATE INDEX mcp_recall_audit_created_idx ON mcp_recall_audit(created_at DESC);
`;

/** Historical backfill is always preview-only. Its ordinary explicit statements may
 * eventually be batch accepted, but the initial proposals need a distinct audit
 * reason that deterministic policy can never mistake for live auto-acceptance. */
const BACKFILL_PREVIEW_REASON = `
-- Early development builds of 006 created candidate evidence but did not yet
-- create the resolution audit table. Some local stores can therefore truthfully
-- report 006 as applied while lacking this table. Materialize the empty audit
-- table before rebuilding the candidate graph so those stores can still upgrade
-- without weakening or discarding any existing candidate data.
CREATE TABLE IF NOT EXISTS candidate_resolution_event (
  id                  INTEGER PRIMARY KEY,
  candidate_id        INTEGER NOT NULL REFERENCES memory_candidate(id) ON DELETE CASCADE,
  decision            TEXT NOT NULL CHECK (decision IN ('accepted','rejected','edited_accepted')),
  edited_payload_json TEXT CHECK (edited_payload_json IS NULL OR json_valid(edited_payload_json)),
  source_message_id   INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_action','message','system')),
  created_at          TEXT NOT NULL
);

DROP INDEX IF EXISTS memory_candidate_status_idx;
DROP INDEX IF EXISTS memory_candidate_source_idx;
DROP INDEX IF EXISTS memory_candidate_dedupe_idx;
DROP INDEX IF EXISTS memory_candidate_backfill_idx;
DROP INDEX IF EXISTS candidate_resolution_candidate_idx;

ALTER TABLE candidate_evidence RENAME TO candidate_evidence_legacy;
ALTER TABLE candidate_resolution_event RENAME TO candidate_resolution_event_legacy;
ALTER TABLE memory_candidate RENAME TO memory_candidate_legacy;

CREATE TABLE memory_candidate (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('fact','goal','commitment','interest','facet')),
  payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
  reason             TEXT NOT NULL CHECK (reason IN ('inference','ambiguous','sensitive','conflict','backfill_preview')),
  reasons_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
  confidence         REAL NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  dedupe_key         TEXT,
  origin             TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','backfill')),
  backfill_job_id    INTEGER REFERENCES understanding_backfill_job(id) ON DELETE CASCADE,
  resolved_at        TEXT,
  created_at         TEXT NOT NULL
);

INSERT INTO memory_candidate
  (id, kind, payload_json, reason, reasons_json, confidence, source_message_id,
   status, dedupe_key, origin, backfill_job_id, resolved_at, created_at)
SELECT id, kind, payload_json, reason, reasons_json, confidence, source_message_id,
       status, dedupe_key, origin, backfill_job_id, resolved_at, created_at
FROM memory_candidate_legacy;

CREATE TABLE candidate_evidence (
  candidate_id  INTEGER NOT NULL REFERENCES memory_candidate(id) ON DELETE CASCADE,
  passage_id    INTEGER NOT NULL REFERENCES evidence_passage(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (candidate_id, passage_id)
);

INSERT INTO candidate_evidence (candidate_id, passage_id, created_at)
SELECT candidate_id, passage_id, created_at FROM candidate_evidence_legacy;

CREATE TABLE candidate_resolution_event (
  id                  INTEGER PRIMARY KEY,
  candidate_id        INTEGER NOT NULL REFERENCES memory_candidate(id) ON DELETE CASCADE,
  decision            TEXT NOT NULL CHECK (decision IN ('accepted','rejected','edited_accepted')),
  edited_payload_json TEXT CHECK (edited_payload_json IS NULL OR json_valid(edited_payload_json)),
  source_message_id   INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_action','message','system')),
  created_at          TEXT NOT NULL
);

INSERT INTO candidate_resolution_event
  (id, candidate_id, decision, edited_payload_json, source_message_id,
   source_kind, created_at)
SELECT id, candidate_id, decision, edited_payload_json, source_message_id,
       source_kind, created_at
FROM candidate_resolution_event_legacy;

DROP TABLE candidate_evidence_legacy;
DROP TABLE candidate_resolution_event_legacy;
DROP TABLE memory_candidate_legacy;

CREATE INDEX memory_candidate_status_idx ON memory_candidate(status, created_at DESC);
CREATE INDEX memory_candidate_source_idx ON memory_candidate(source_message_id);
CREATE INDEX memory_candidate_dedupe_idx ON memory_candidate(dedupe_key, status)
WHERE dedupe_key IS NOT NULL;
CREATE INDEX memory_candidate_backfill_idx ON memory_candidate(backfill_job_id, status)
WHERE backfill_job_id IS NOT NULL;
CREATE INDEX candidate_resolution_candidate_idx
ON candidate_resolution_event(candidate_id, id);
`;

/** Some development stores recorded the understanding migration before its resumable
 * item table was finalized. Recreate only the missing table so source deletion can
 * inspect and clean up backfill work without rewriting any applied migration. */
const BACKFILL_ITEM_COMPATIBILITY = `
CREATE TABLE IF NOT EXISTS understanding_backfill_item (
  job_id             INTEGER NOT NULL REFERENCES understanding_backfill_job(id) ON DELETE CASCADE,
  message_id         INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  extractor_version  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','skipped')),
  candidate_count    INTEGER NOT NULL DEFAULT 0,
  error_message      TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (job_id, message_id, extractor_version)
);
`;

/** Removing a chat from visible history must not destroy its transcript or any memory
 * that cites it. Keep that reversible UI state separate from the evidence itself. */
const CONVERSATION_HISTORY_STATE = `
CREATE TABLE conversation_history_state (
  conversation_id  INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
  hidden_at        TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: "001_init", sql: INIT },
  { id: "002_seed", sql: SEED },
  { id: "003_copilot", sql: COPILOT },
  { id: "004_response_snapshots", sql: RESPONSE_SNAPSHOTS },
  { id: "005_stewardship", sql: STEWARDSHIP },
  { id: "006_understanding", sql: UNDERSTANDING },
  { id: "007_facet_embeddings", sql: FACET_EMBEDDINGS },
  { id: "008_mcp_candidate_audit", sql: MCP_CANDIDATE_AUDIT },
  { id: "009_backfill_preview_reason", sql: BACKFILL_PREVIEW_REASON },
  { id: "010_backfill_item_compatibility", sql: BACKFILL_ITEM_COMPATIBILITY },
  { id: "011_conversation_history_state", sql: CONVERSATION_HISTORY_STATE },
];
