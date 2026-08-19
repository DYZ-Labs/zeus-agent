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

/** Zeus owns one local memory store, so authentication binds that store to exactly one
 * Supabase identity. The singleton key prevents a later signup from claiming the same
 * evidence-backed memory, while the UUID remains the stable identity if email changes. */
const APP_OWNER = `
CREATE TABLE app_owner (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  supabase_user_id   TEXT NOT NULL UNIQUE
                     CHECK (
                       supabase_user_id = lower(trim(supabase_user_id))
                       AND length(supabase_user_id) = 36
                       AND substr(supabase_user_id, 9, 1) = '-'
                       AND substr(supabase_user_id, 14, 1) = '-'
                       AND substr(supabase_user_id, 19, 1) = '-'
                       AND substr(supabase_user_id, 24, 1) = '-'
                     ),
  email              TEXT NOT NULL
                     CHECK (email = lower(trim(email)) AND length(email) > 3),
  bound_at           TEXT NOT NULL
);
`;

/** Personal-agent control and execution remain append-only, typed, and separate from
 * canonical memory. This migration deliberately defaults ambient behavior to disabled
 * and grants no external-write capability. */
const PERSONAL_AGENT = `
ALTER TABLE stewardship_setting RENAME TO stewardship_setting_legacy;
CREATE TABLE stewardship_setting (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  mode               TEXT NOT NULL DEFAULT 'balanced'
                     CHECK (mode IN ('off','quiet','balanced','proactive')),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);
INSERT INTO stewardship_setting (id, mode, source_message_id, updated_at)
SELECT id, mode, source_message_id, updated_at FROM stewardship_setting_legacy;
DROP TABLE stewardship_setting_legacy;

ALTER TABLE understanding_facet
ADD COLUMN condition_json TEXT CHECK (condition_json IS NULL OR json_valid(condition_json));

CREATE TABLE project (
  id                 INTEGER PRIMARY KEY,
  entity_id          INTEGER NOT NULL UNIQUE REFERENCES entity(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','active','paused','completed','abandoned')),
  progress_summary   TEXT,
  progress_percent   REAL CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 1)),
  blocked_at         TEXT,
  confidence         REAL NOT NULL DEFAULT 0.9 CHECK (confidence > 0 AND confidence <= 1),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  closed_at          TEXT
);
CREATE INDEX project_status_idx ON project(status, updated_at DESC);
CREATE INDEX project_source_idx ON project(source_message_id);

CREATE TABLE project_event (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL
                     CHECK (event_type IN ('created','updated','status_changed','progress','blocked','unblocked')),
  from_status        TEXT,
  to_status          TEXT,
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  passage_id         INTEGER REFERENCES evidence_passage(id) ON DELETE SET NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('message','user_action')),
  created_at         TEXT NOT NULL
);
CREATE INDEX project_event_project_idx ON project_event(project_id, id);
CREATE INDEX project_event_passage_idx ON project_event(passage_id) WHERE passage_id IS NOT NULL;

ALTER TABLE goal ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE SET NULL;
ALTER TABLE commitment ADD COLUMN project_id INTEGER REFERENCES project(id) ON DELETE SET NULL;
CREATE INDEX goal_project_idx ON goal(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX commitment_project_idx ON commitment(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE recommendation_cycle (
  id                        INTEGER PRIMARY KEY,
  policy_version            TEXT NOT NULL,
  trigger                   TEXT NOT NULL CHECK (trigger IN ('chat','today','mcp','worker')),
  context_json              TEXT NOT NULL CHECK (json_valid(context_json)),
  query_text                TEXT NOT NULL,
  candidate_scores_json     TEXT NOT NULL CHECK (json_valid(candidate_scores_json)),
  applied_facet_ids_json    TEXT NOT NULL CHECK (json_valid(applied_facet_ids_json)),
  exclusions_json           TEXT NOT NULL CHECK (json_valid(exclusions_json)),
  selected_commitment_id    INTEGER REFERENCES commitment(id) ON DELETE SET NULL,
  recommendation_json       TEXT CHECK (recommendation_json IS NULL OR json_valid(recommendation_json)),
  created_at                TEXT NOT NULL
);
CREATE INDEX recommendation_cycle_created_idx ON recommendation_cycle(created_at DESC);
CREATE INDEX recommendation_cycle_selected_idx
ON recommendation_cycle(selected_commitment_id, created_at DESC)
WHERE selected_commitment_id IS NOT NULL;

ALTER TABLE follow_through_event
ADD COLUMN effect_kind TEXT NOT NULL DEFAULT 'prepare_local'
  CHECK (effect_kind IN ('memory_read','web_read','prepare_local','send','schedule','purchase','modify_external'));
UPDATE follow_through_event
SET effect_kind = CASE action_kind
  WHEN 'research' THEN 'web_read'
  WHEN 'schedule' THEN 'schedule'
  WHEN 'remind' THEN 'modify_external'
  WHEN 'coordinate' THEN 'send'
  ELSE 'prepare_local'
END;
UPDATE follow_through_event
SET detail_json = json_set(
  detail_json,
  '$.recommendation.effect_kind',
  effect_kind
)
WHERE detail_json IS NOT NULL
  AND json_type(detail_json, '$.recommendation') = 'object'
  AND json_type(detail_json, '$.recommendation.effect_kind') IS NULL;
ALTER TABLE follow_through_event
ADD COLUMN opportunity_id INTEGER REFERENCES recommendation_cycle(id) ON DELETE SET NULL;
CREATE INDEX follow_through_opportunity_idx
ON follow_through_event(opportunity_id) WHERE opportunity_id IS NOT NULL;

CREATE TABLE opportunity_delivery (
  id                   INTEGER PRIMARY KEY,
  opportunity_id       INTEGER NOT NULL REFERENCES recommendation_cycle(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel IN ('chat','today','mcp','macos')),
  response_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  delivered_at         TEXT NOT NULL,
  UNIQUE (opportunity_id, channel)
);
CREATE INDEX opportunity_delivery_time_idx ON opportunity_delivery(delivered_at DESC);

CREATE TABLE ambient_setting (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  quiet_start        TEXT NOT NULL DEFAULT '22:00',
  quiet_end          TEXT NOT NULL DEFAULT '08:00',
  daily_limit        INTEGER NOT NULL DEFAULT 1 CHECK (daily_limit = 1),
  channels_json      TEXT NOT NULL DEFAULT '["macos"]' CHECK (json_valid(channels_json)),
  location_consent   INTEGER NOT NULL DEFAULT 0 CHECK (location_consent IN (0,1)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);
INSERT INTO ambient_setting
  (id, enabled, timezone, quiet_start, quiet_end, daily_limit, channels_json,
   location_consent, source_message_id, updated_at)
VALUES (1, 0, 'UTC', '22:00', '08:00', 1, '["macos"]', 0, NULL, ${NOW});

CREATE TABLE coarse_location (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  zone_id      TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE work_plan (
  id                       INTEGER PRIMARY KEY,
  objective                TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'proposed'
                           CHECK (status IN ('proposed','authorized','running','paused','completed','failed','cancelled')),
  plan_hash                TEXT NOT NULL UNIQUE,
  allowed_effects_json     TEXT NOT NULL CHECK (json_valid(allowed_effects_json)),
  completion_criteria_json TEXT NOT NULL CHECK (json_valid(completion_criteria_json)),
  max_steps                INTEGER NOT NULL DEFAULT 12 CHECK (max_steps BETWEEN 1 AND 12),
  max_model_tool_calls     INTEGER NOT NULL DEFAULT 20 CHECK (max_model_tool_calls BETWEEN 1 AND 20),
  max_retries_per_step     INTEGER NOT NULL DEFAULT 2 CHECK (max_retries_per_step BETWEEN 0 AND 2),
  max_duration_seconds     INTEGER NOT NULL DEFAULT 900 CHECK (max_duration_seconds BETWEEN 1 AND 900),
  source_message_id        INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  source_goal_id           INTEGER REFERENCES goal(id) ON DELETE SET NULL,
  source_commitment_id     INTEGER REFERENCES commitment(id) ON DELETE SET NULL,
  source_project_id        INTEGER REFERENCES project(id) ON DELETE SET NULL,
  origin                   TEXT NOT NULL CHECK (origin IN ('explicit_request','surfaced_proposal')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  completed_at             TEXT
);
CREATE INDEX work_plan_status_idx ON work_plan(status, updated_at DESC);
CREATE INDEX work_plan_source_idx ON work_plan(source_message_id);

CREATE TABLE work_step (
  id             INTEGER PRIMARY KEY,
  work_plan_id   INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position > 0),
  title          TEXT NOT NULL,
  instruction    TEXT NOT NULL,
  effect_kind    TEXT NOT NULL
                 CHECK (effect_kind IN ('memory_read','web_read','prepare_local','send','schedule','purchase','modify_external')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','completed','failed','skipped','cancelled')),
  attempt_count  INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at     TEXT,
  completed_at   TEXT,
  error_code     TEXT,
  error_message  TEXT,
  UNIQUE (work_plan_id, position)
);
CREATE INDEX work_step_plan_idx ON work_step(work_plan_id, status, position);

CREATE TABLE work_step_dependency (
  work_step_id        INTEGER NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  depends_on_step_id INTEGER NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  PRIMARY KEY (work_step_id, depends_on_step_id),
  CHECK (work_step_id != depends_on_step_id)
);

CREATE TABLE work_authorization (
  id                       INTEGER PRIMARY KEY,
  work_plan_id             INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  plan_hash                TEXT NOT NULL,
  authorization_kind       TEXT NOT NULL CHECK (authorization_kind IN ('explicit_request','user_approval')),
  allowed_effects_json     TEXT NOT NULL CHECK (json_valid(allowed_effects_json)),
  max_model_tool_calls     INTEGER NOT NULL CHECK (max_model_tool_calls BETWEEN 1 AND 20),
  max_retries_per_step     INTEGER NOT NULL CHECK (max_retries_per_step BETWEEN 0 AND 2),
  max_duration_seconds     INTEGER NOT NULL CHECK (max_duration_seconds BETWEEN 1 AND 900),
  expires_at               TEXT NOT NULL,
  source_message_id        INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at               TEXT NOT NULL,
  revoked_at               TEXT
);
CREATE INDEX work_authorization_plan_idx ON work_authorization(work_plan_id, id DESC);
CREATE UNIQUE INDEX work_authorization_active_idx
ON work_authorization(work_plan_id) WHERE revoked_at IS NULL;

CREATE TABLE work_run (
  id                  INTEGER PRIMARY KEY,
  work_plan_id        INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  authorization_id    INTEGER NOT NULL REFERENCES work_authorization(id) ON DELETE RESTRICT,
  plan_hash           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  model_call_count    INTEGER NOT NULL DEFAULT 0 CHECK (model_call_count >= 0),
  tool_call_count     INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  checkpoint_step_id  INTEGER REFERENCES work_step(id) ON DELETE SET NULL,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deadline_at         TEXT NOT NULL,
  completed_at        TEXT,
  error_code          TEXT,
  error_message       TEXT
);
CREATE INDEX work_run_plan_idx ON work_run(work_plan_id, status, id DESC);

CREATE TABLE work_artifact (
  id              INTEGER PRIMARY KEY,
  work_plan_id    INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  work_run_id     INTEGER NOT NULL REFERENCES work_run(id) ON DELETE CASCADE,
  work_step_id    INTEGER REFERENCES work_step(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('draft','comparison','report','research_notes')),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  citations_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX work_artifact_run_idx ON work_artifact(work_run_id, id);

CREATE TABLE tool_receipt (
  id               INTEGER PRIMARY KEY,
  work_run_id      INTEGER NOT NULL REFERENCES work_run(id) ON DELETE CASCADE,
  work_step_id     INTEGER REFERENCES work_step(id) ON DELETE SET NULL,
  tool_name        TEXT NOT NULL CHECK (tool_name IN ('memory_recall','web_search','local_artifact')),
  effect_kind      TEXT NOT NULL CHECK (effect_kind IN ('memory_read','web_read','prepare_local')),
  call_index       INTEGER NOT NULL CHECK (call_index > 0),
  input_json       TEXT NOT NULL CHECK (json_valid(input_json)),
  output_json      TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  citations_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
  status           TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
  error_code       TEXT,
  error_message    TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  started_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX tool_receipt_run_idx ON tool_receipt(work_run_id, call_index);

-- Project context is canonical and therefore eligible for the same immutable response
-- and MCP recall traces as facts, facets, and intentions.
UPDATE response_context
SET snapshot_json = json_set(snapshot_json, '$.goal.project_id', json('null'))
WHERE item_kind = 'goal' AND snapshot_json IS NOT NULL
  AND json_type(snapshot_json, '$.goal.project_id') IS NULL;
UPDATE response_context
SET snapshot_json = json_set(snapshot_json, '$.commitment.project_id', json('null'))
WHERE item_kind = 'commitment' AND snapshot_json IS NOT NULL
  AND json_type(snapshot_json, '$.commitment.project_id') IS NULL;
UPDATE response_context
SET snapshot_json = json_set(snapshot_json, '$.facet.condition_json', json('null'))
WHERE item_kind = 'facet' AND snapshot_json IS NOT NULL
  AND json_type(snapshot_json, '$.facet.condition_json') IS NULL;

ALTER TABLE response_context RENAME TO response_context_personal_agent_legacy;
CREATE TABLE response_context (
  assistant_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  item_kind             TEXT NOT NULL CHECK (item_kind IN ('fact','episode','goal','commitment','facet','project')),
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
SELECT assistant_message_id, item_kind, item_id, rank, selection_reason,
       selection_score, retrieval_json, created_at, snapshot_json
FROM response_context_personal_agent_legacy;
DROP TABLE response_context_personal_agent_legacy;
CREATE INDEX response_context_message_idx ON response_context(assistant_message_id, rank);

UPDATE mcp_recall_audit
SET snapshot_json = json_set(snapshot_json, '$.goal.project_id', json('null'))
WHERE item_kind = 'goal' AND json_type(snapshot_json, '$.goal.project_id') IS NULL;
UPDATE mcp_recall_audit
SET snapshot_json = json_set(snapshot_json, '$.commitment.project_id', json('null'))
WHERE item_kind = 'commitment' AND json_type(snapshot_json, '$.commitment.project_id') IS NULL;
UPDATE mcp_recall_audit
SET snapshot_json = json_set(snapshot_json, '$.facet.condition_json', json('null'))
WHERE item_kind = 'facet' AND json_type(snapshot_json, '$.facet.condition_json') IS NULL;

ALTER TABLE mcp_recall_audit RENAME TO mcp_recall_audit_personal_agent_legacy;
CREATE TABLE mcp_recall_audit (
  id                 INTEGER PRIMARY KEY,
  tool_name          TEXT NOT NULL,
  query_text         TEXT NOT NULL,
  item_kind          TEXT NOT NULL
                     CHECK (item_kind IN ('fact','episode','goal','commitment','facet','candidate','project')),
  item_id            INTEGER NOT NULL,
  rank               INTEGER NOT NULL,
  snapshot_json      TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at         TEXT NOT NULL
);
INSERT INTO mcp_recall_audit
  (id, tool_name, query_text, item_kind, item_id, rank, snapshot_json, created_at)
SELECT id, tool_name, query_text, item_kind, item_id, rank, snapshot_json, created_at
FROM mcp_recall_audit_personal_agent_legacy;
DROP TABLE mcp_recall_audit_personal_agent_legacy;
CREATE INDEX mcp_recall_audit_created_idx ON mcp_recall_audit(created_at DESC);
`;

/**
 * Reviewable behavioral-policy proposals stay outside canonical memory. Their only
 * evidence is explicit user-control/progress events, and every decision is appended
 * rather than overwriting earlier review history.
 */
const BEHAVIORAL_POLICY_SUGGESTIONS = `
ALTER TABLE recommendation_cycle
ADD COLUMN source_message_id INTEGER REFERENCES message(id) ON DELETE CASCADE;
CREATE INDEX recommendation_cycle_source_idx
ON recommendation_cycle(source_message_id)
WHERE source_message_id IS NOT NULL;

CREATE TABLE behavioral_policy_suggestion (
  id                           INTEGER PRIMARY KEY,
  pattern_key                  TEXT NOT NULL UNIQUE,
  event_type                   TEXT NOT NULL
                               CHECK (event_type IN ('dismissed','snoozed','completed','regretted')),
  action_kind                  TEXT NOT NULL
                               CHECK (action_kind IN ('draft','schedule','research','remind','coordinate','plan')),
  kind                         TEXT NOT NULL
                               CHECK (kind IN ('temporary_suppression','confirm_routine')),
  summary                      TEXT NOT NULL,
  allowed_interruption_change  TEXT NOT NULL
                               CHECK (allowed_interruption_change IN ('none','suppress_only')),
  minimum_evidence_count       INTEGER NOT NULL CHECK (minimum_evidence_count >= 2),
  created_at                   TEXT NOT NULL,
  CHECK (
    (kind = 'temporary_suppression' AND allowed_interruption_change = 'suppress_only')
    OR (kind = 'confirm_routine' AND allowed_interruption_change = 'none')
  )
);

CREATE TABLE behavioral_policy_suggestion_evidence (
  suggestion_id            INTEGER NOT NULL
                           REFERENCES behavioral_policy_suggestion(id) ON DELETE CASCADE,
  follow_through_event_id  INTEGER NOT NULL
                           REFERENCES follow_through_event(id) ON DELETE CASCADE,
  created_at               TEXT NOT NULL,
  PRIMARY KEY (suggestion_id, follow_through_event_id)
);
CREATE INDEX behavioral_policy_suggestion_evidence_event_idx
ON behavioral_policy_suggestion_evidence(follow_through_event_id);

CREATE TRIGGER behavioral_policy_suggestion_evidence_explicit_insert
BEFORE INSERT ON behavioral_policy_suggestion_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM follow_through_event e
  JOIN behavioral_policy_suggestion s ON s.id = NEW.suggestion_id
  WHERE e.id = NEW.follow_through_event_id
    AND e.event_type IN ('dismissed','snoozed','completed','regretted')
    AND e.source_kind IN ('message','user_action')
    AND e.event_type = s.event_type
    AND e.action_kind = s.action_kind
)
BEGIN
  SELECT RAISE(ABORT, 'behavioral policy evidence must be an explicit user event');
END;

CREATE TABLE behavioral_policy_suggestion_event (
  id                 INTEGER PRIMARY KEY,
  suggestion_id      INTEGER NOT NULL
                     REFERENCES behavioral_policy_suggestion(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL
                     CHECK (event_type IN ('materialized','accepted_for_review','dismissed')),
  detail_json        TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE CASCADE,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('system','message','user_action')),
  created_at         TEXT NOT NULL,
  CHECK (
    (event_type = 'materialized' AND source_kind = 'system' AND source_message_id IS NULL)
    OR
    (event_type IN ('accepted_for_review','dismissed')
      AND source_kind IN ('message','user_action') AND source_message_id IS NOT NULL)
  )
);
CREATE INDEX behavioral_policy_suggestion_event_suggestion_idx
ON behavioral_policy_suggestion_event(suggestion_id, id);
CREATE INDEX behavioral_policy_suggestion_event_source_idx
ON behavioral_policy_suggestion_event(source_message_id)
WHERE source_message_id IS NOT NULL;

CREATE TRIGGER behavioral_policy_suggestion_immutable
BEFORE UPDATE ON behavioral_policy_suggestion
BEGIN
  SELECT RAISE(ABORT, 'behavioral policy suggestions are immutable');
END;
CREATE TRIGGER behavioral_policy_suggestion_evidence_immutable
BEFORE UPDATE ON behavioral_policy_suggestion_evidence
BEGIN
  SELECT RAISE(ABORT, 'behavioral policy evidence is immutable');
END;
CREATE TRIGGER behavioral_policy_suggestion_event_immutable
BEFORE UPDATE ON behavioral_policy_suggestion_event
BEGIN
  SELECT RAISE(ABORT, 'behavioral policy review history is append-only');
END;
`;

/**
 * Ambient notification delivery happens outside SQLite so an operating-system prompt
 * cannot hold the memory store's write lock. A durable claim reserves the one local-day
 * slot first. Unknown crash outcomes retain that reservation, preferring one missed
 * notification to a duplicate interruption.
 */
const AMBIENT_DELIVERY_CLAIMS = `
CREATE TABLE ambient_delivery_attempt (
  id                   INTEGER PRIMARY KEY,
  opportunity_id       INTEGER NOT NULL
                       REFERENCES recommendation_cycle(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel = 'macos'),
  local_day            TEXT NOT NULL,
  claim_slot           TEXT UNIQUE,
  lease_token          TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL
                       CHECK (status IN ('claimed','succeeded','failed','unknown')),
  leased_until         TEXT NOT NULL,
  notifier_started_at  TEXT NOT NULL,
  completed_at         TEXT,
  error_code           TEXT,
  delivery_id          INTEGER REFERENCES opportunity_delivery(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  CHECK (
    (status = 'claimed' AND completed_at IS NULL AND delivery_id IS NULL AND claim_slot IS NOT NULL)
    OR
    (status = 'succeeded' AND completed_at IS NOT NULL AND delivery_id IS NOT NULL AND claim_slot IS NOT NULL)
    OR
    (status = 'failed' AND completed_at IS NOT NULL AND delivery_id IS NULL AND claim_slot IS NULL)
    OR
    (status = 'unknown' AND completed_at IS NOT NULL AND delivery_id IS NULL AND claim_slot IS NOT NULL)
  )
);
CREATE INDEX ambient_delivery_attempt_opportunity_idx
ON ambient_delivery_attempt(opportunity_id, id DESC);
CREATE INDEX ambient_delivery_attempt_status_idx
ON ambient_delivery_attempt(status, leased_until);
`;

/** A durable lease prevents a second web process from treating a live model call as a
 * crashed attempt. Terminal and paused transitions clear ownership. */
const WORK_RUN_LEASES = `
ALTER TABLE work_run ADD COLUMN runner_token TEXT;
ALTER TABLE work_run ADD COLUMN runner_lease_until TEXT;
CREATE UNIQUE INDEX work_run_runner_token_idx
ON work_run(runner_token) WHERE runner_token IS NOT NULL;
`;

/** Exact source dependencies let explicit deletion remove derived artifacts and audit
 * snapshots without brittle text inspection. An active-run uniqueness constraint also
 * closes the cross-process first-start race before a provider call can begin. */
const DERIVED_SOURCE_DEPENDENCIES = `
CREATE TABLE work_artifact_source (
  work_artifact_id  INTEGER NOT NULL REFERENCES work_artifact(id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  PRIMARY KEY (work_artifact_id, source_message_id)
);
CREATE INDEX work_artifact_source_message_idx
ON work_artifact_source(source_message_id, work_artifact_id);

-- A dev store may contain duplicate active runs from before the uniqueness policy.
-- Retain the newest deterministically and close every older row before adding the
-- constraint, preserving a durable reason instead of making migration fail.
UPDATE tool_receipt
SET status = 'failed', error_code = 'superseded_active_run',
    error_message = 'A newer active run superseded this pre-constraint run',
    completed_at = COALESCE(completed_at, ${NOW})
WHERE status = 'started'
  AND work_run_id IN (
    SELECT older.id
    FROM work_run older
    WHERE older.status IN ('queued','running','paused')
      AND EXISTS (
        SELECT 1 FROM work_run newer
        WHERE newer.work_plan_id = older.work_plan_id
          AND newer.status IN ('queued','running','paused')
          AND newer.id > older.id
      )
  );
UPDATE work_run
SET status = 'failed', error_code = 'superseded_active_run',
    error_message = 'A newer active run superseded this pre-constraint run',
    updated_at = ${NOW}, completed_at = ${NOW},
    runner_token = NULL, runner_lease_until = NULL
WHERE status IN ('queued','running','paused')
  AND EXISTS (
    SELECT 1 FROM work_run newer
    WHERE newer.work_plan_id = work_run.work_plan_id
      AND newer.status IN ('queued','running','paused')
      AND newer.id > work_run.id
  );

CREATE UNIQUE INDEX work_run_active_plan_idx
ON work_run(work_plan_id) WHERE status IN ('queued','running','paused');
`;

/** Generated plans bind the exact accepted personalization and local evaluation
 * context supplied to the model. Item-level and message-level dependencies make
 * explicit deletion reliable even when the originating conversation still exists. */
const WORK_PLAN_GENERATION_PROVENANCE = `
ALTER TABLE work_plan
ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 2 CHECK (hash_version IN (2,3));

CREATE TABLE work_plan_generation_context (
  work_plan_id             INTEGER PRIMARY KEY
                           REFERENCES work_plan(id) ON DELETE CASCADE,
  evaluation_context_json TEXT NOT NULL CHECK (json_valid(evaluation_context_json)),
  conflict_snapshot_json  TEXT NOT NULL CHECK (json_valid(conflict_snapshot_json)),
  created_at              TEXT NOT NULL
);

CREATE TABLE work_plan_memory_source (
  work_plan_id       INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('fact','facet')),
  source_id          INTEGER NOT NULL,
  included_in_prompt INTEGER NOT NULL CHECK (included_in_prompt IN (0,1)),
  exclusion_reason  TEXT,
  snapshot_json     TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (work_plan_id, source_kind, source_id),
  CHECK (
    (included_in_prompt = 1 AND exclusion_reason IS NULL)
    OR (included_in_prompt = 0 AND exclusion_reason IS NOT NULL)
  )
);
CREATE INDEX work_plan_memory_source_item_idx
ON work_plan_memory_source(source_kind, source_id, work_plan_id);

CREATE TABLE work_plan_memory_source_message (
  work_plan_id      INTEGER NOT NULL,
  source_kind       TEXT NOT NULL,
  source_id         INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  PRIMARY KEY (work_plan_id, source_kind, source_id, source_message_id),
  FOREIGN KEY (work_plan_id, source_kind, source_id)
    REFERENCES work_plan_memory_source(work_plan_id, source_kind, source_id)
    ON DELETE CASCADE
);
CREATE INDEX work_plan_memory_source_message_idx
ON work_plan_memory_source_message(source_message_id, work_plan_id);
`;

/** Execution-time memory recall can introduce canonical dependencies that were not
 * part of plan generation. Artifact-level item snapshots make later explicit forget
 * remove every downstream draft derived from that exact fact or facet. */
const WORK_ARTIFACT_MEMORY_PROVENANCE = `
CREATE TABLE work_artifact_memory_source (
  work_artifact_id INTEGER NOT NULL REFERENCES work_artifact(id) ON DELETE CASCADE,
  source_kind      TEXT NOT NULL CHECK (source_kind IN ('fact','facet')),
  source_id        INTEGER NOT NULL,
  snapshot_json    TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (work_artifact_id, source_kind, source_id)
);
CREATE INDEX work_artifact_memory_source_item_idx
ON work_artifact_memory_source(source_kind, source_id, work_artifact_id);
`;

/**
 * MCP tool arguments are model-controlled and therefore cannot themselves be user
 * provenance. Mutations use capability-negotiated elicitation and record only a digest
 * until the user approves. Approved/applied events link to the resulting real user
 * action; deleting that source cascades those source-derived audit rows as well.
 */
const MCP_MUTATION_APPROVAL = `
CREATE TABLE mcp_mutation_event (
  id                    INTEGER PRIMARY KEY,
  operation_id          TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  request_hash          TEXT NOT NULL
                        CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  target_kind           TEXT,
  target_id             INTEGER,
  event_type            TEXT NOT NULL
                        CHECK (event_type IN (
                          'approval_requested','approval_unsupported','approval_declined',
                          'approval_cancelled','approval_expired','approved','applied','failed'
                        )),
  source_message_id     INTEGER REFERENCES message(id) ON DELETE CASCADE,
  approval_expires_at   TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE (operation_id, event_type),
  CHECK (target_id IS NULL OR (target_id > 0 AND target_kind IS NOT NULL)),
  CHECK (
    source_message_id IS NULL
    OR event_type IN ('approved','applied','failed')
  )
);
CREATE INDEX mcp_mutation_event_operation_idx
ON mcp_mutation_event(operation_id, id);
CREATE INDEX mcp_mutation_event_source_idx
ON mcp_mutation_event(source_message_id)
WHERE source_message_id IS NOT NULL;
CREATE INDEX mcp_mutation_event_created_idx
ON mcp_mutation_event(created_at DESC);
`;

/**
 * Snapshot destinations are durable erasure boundaries. Keeping every path and its
 * filesystem identity in the store lets explicit source deletion fail closed when a
 * formerly used removable target is unavailable, and purge old configured targets.
 */
const SNAPSHOT_DESTINATIONS = `
CREATE TABLE snapshot_destination (
  directory      TEXT NOT NULL,
  file_prefix    TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  registered_at  TEXT NOT NULL,
  PRIMARY KEY (directory, file_prefix)
);
`;

const MODEL_USAGE = `
-- One row per closed accounting window per store. Durable rather than in-memory so a
-- restart cannot reset a spend cap: the bill outlives the process.
CREATE TABLE model_usage (
  window_kind    TEXT NOT NULL,
  window_start   TEXT NOT NULL,
  calls          INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (window_kind, window_start)
);
`;

/**
 * External action, gated twice.
 *
 * Zeus reaches a third-party service only through an MCP server the user configured, and
 * only through a capability slot they explicitly bound to one discovered remote tool. No
 * credential lives here: a connector records a command, arguments, a URL, and the *names*
 * of environment variables, never their values.
 *
 * Authorizing a work plan approves a scope, not a payload — the concrete request is only
 * known once earlier steps have run. So a write effect materializes a `proposed_effect`
 * and stops. The user confirms one exact payload hash, and only those bytes execute.
 * Proposals and receipts are system-authored data; neither is ever a claim about the user.
 *
 * `external_read` is a distinct effect kind rather than a widening of `web_read`. The
 * effect kind is the unit of authorization, so a plan approved for public web research
 * must not thereby be able to open the user's calendar.
 *
 * `work_step` and `tool_receipt` only need a relaxed CHECK, which SQLite cannot alter in
 * place, so both are rebuilt. `work_step` is referenced by four tables; `migrate()`
 * suspends foreign-key enforcement for the swap and verifies every reference still
 * resolves before committing.
 */
const EXTERNAL_ACTIONS = `
ALTER TABLE work_step RENAME TO work_step_safe_legacy;
CREATE TABLE work_step (
  id             INTEGER PRIMARY KEY,
  work_plan_id   INTEGER NOT NULL REFERENCES work_plan(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position > 0),
  title          TEXT NOT NULL,
  instruction    TEXT NOT NULL,
  effect_kind    TEXT NOT NULL
                 CHECK (effect_kind IN ('memory_read','web_read','prepare_local',
                                        'external_read','send','schedule','purchase',
                                        'modify_external')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','completed','failed','skipped','cancelled')),
  attempt_count  INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at     TEXT,
  completed_at   TEXT,
  error_code     TEXT,
  error_message  TEXT,
  UNIQUE (work_plan_id, position)
);
INSERT INTO work_step
  (id, work_plan_id, position, title, instruction, effect_kind, status, attempt_count,
   started_at, completed_at, error_code, error_message)
SELECT id, work_plan_id, position, title, instruction, effect_kind, status, attempt_count,
       started_at, completed_at, error_code, error_message
FROM work_step_safe_legacy;
DROP TABLE work_step_safe_legacy;
CREATE INDEX work_step_plan_idx ON work_step(work_plan_id, status, position);

-- A connector is a user-configured MCP server. Enabling it requires a live handshake, so
-- a typo cannot sit in the store looking like an available capability.
CREATE TABLE connector (
  id                  INTEGER PRIMARY KEY,
  label               TEXT NOT NULL,
  transport           TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  command             TEXT,
  args_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(args_json)),
  cwd                 TEXT,
  url                 TEXT,
  env_var_names_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(env_var_names_json)),
  -- What the last handshake found, so the grant UI can offer real tools with real
  -- schemas instead of asking the user to type a name and hope.
  discovered_tools_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(discovered_tools_json)),
  status              TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (status IN ('unverified','ready','unreachable','disabled')),
  enabled             INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  source_message_id   INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  last_verified_at    TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (
    (transport = 'stdio' AND command IS NOT NULL AND length(command) > 0 AND url IS NULL)
    OR
    (transport = 'http' AND url IS NOT NULL AND length(url) > 0
      AND command IS NULL AND cwd IS NULL)
  ),
  CHECK (enabled = 0 OR status = 'ready')
);
CREATE INDEX connector_enabled_idx ON connector(enabled, id);

-- One bound capability = one remote tool the user reviewed and accepted for one slot.
-- The slot fixes the effect kind, so reading the slot list is enough to understand the
-- whole grant. schema_hash pins the remote tool's input contract: a server that changes
-- what "create an event" accepts must be re-reviewed rather than silently obeyed.
CREATE TABLE connector_capability (
  id                 INTEGER PRIMARY KEY,
  connector_id       INTEGER NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  slot               TEXT NOT NULL
                     CHECK (slot IN ('calendar.list_events','calendar.create_event',
                                     'calendar.update_event')),
  remote_tool_name   TEXT NOT NULL,
  effect_kind        TEXT NOT NULL
                     CHECK (effect_kind IN ('external_read','schedule','modify_external')),
  input_schema_json  TEXT NOT NULL CHECK (json_valid(input_schema_json)),
  schema_hash        TEXT NOT NULL
                     CHECK (length(schema_hash) = 64 AND schema_hash NOT GLOB '*[^0-9a-f]*'),
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  source_message_id  INTEGER NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (connector_id, slot),
  CHECK (
    (slot = 'calendar.list_events' AND effect_kind = 'external_read')
    OR (slot = 'calendar.create_event' AND effect_kind = 'schedule')
    OR (slot = 'calendar.update_event' AND effect_kind = 'modify_external')
  )
);
CREATE INDEX connector_capability_slot_idx ON connector_capability(slot, enabled);

-- The payload gate. A run reaching a write effect stops here with the exact request it
-- intends to make. Nothing leaves the machine until the user confirms this hash.
CREATE TABLE proposed_effect (
  id                       INTEGER PRIMARY KEY,
  work_run_id              INTEGER NOT NULL REFERENCES work_run(id) ON DELETE CASCADE,
  work_step_id             INTEGER NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  connector_capability_id  INTEGER NOT NULL
                           REFERENCES connector_capability(id) ON DELETE RESTRICT,
  effect_kind              TEXT NOT NULL
                           CHECK (effect_kind IN ('send','schedule','modify_external')),
  payload_json             TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash             TEXT NOT NULL UNIQUE
                           CHECK (length(payload_hash) = 64
                                  AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  preview_text             TEXT NOT NULL,
  reversal_json            TEXT CHECK (reversal_json IS NULL OR json_valid(reversal_json)),
  status                   TEXT NOT NULL DEFAULT 'pending_confirmation'
                           CHECK (status IN ('pending_confirmation','confirmed','declined',
                                             'expired','executed','failed','reverted')),
  idempotency_key          TEXT NOT NULL UNIQUE,
  provider_request_key     TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX proposed_effect_run_idx ON proposed_effect(work_run_id, id);
CREATE INDEX proposed_effect_pending_idx ON proposed_effect(expires_at)
WHERE status = 'pending_confirmation';

CREATE TABLE effect_event (
  id                  INTEGER PRIMARY KEY,
  proposed_effect_id  INTEGER NOT NULL REFERENCES proposed_effect(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL
                      CHECK (event_type IN ('proposed','confirmed','declined','expired',
                                            'executed','failed','reverted')),
  source_message_id   INTEGER REFERENCES message(id) ON DELETE RESTRICT,
  detail_json         TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at          TEXT NOT NULL,
  UNIQUE (proposed_effect_id, event_type),
  CHECK (
    (event_type IN ('confirmed','declined','reverted') AND source_message_id IS NOT NULL)
    OR
    (event_type IN ('proposed','expired','executed','failed') AND source_message_id IS NULL)
  )
);
CREATE INDEX effect_event_effect_idx ON effect_event(proposed_effect_id, id);
CREATE INDEX effect_event_source_idx ON effect_event(source_message_id)
WHERE source_message_id IS NOT NULL;

CREATE TRIGGER effect_event_immutable
BEFORE UPDATE ON effect_event
BEGIN
  SELECT RAISE(ABORT, 'effect history is append-only');
END;

-- Defense in depth for the rule the whole design rests on: an assistant message can never
-- authorize an external action, whatever calls the write path.
CREATE TRIGGER effect_event_decision_is_user_authored
BEFORE INSERT ON effect_event
WHEN NEW.source_message_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM message WHERE id = NEW.source_message_id AND role = 'user'
  )
BEGIN
  SELECT RAISE(ABORT, 'an effect decision must cite a user message');
END;

ALTER TABLE tool_receipt RENAME TO tool_receipt_safe_legacy;
CREATE TABLE tool_receipt (
  id                       INTEGER PRIMARY KEY,
  work_run_id              INTEGER NOT NULL REFERENCES work_run(id) ON DELETE CASCADE,
  work_step_id             INTEGER REFERENCES work_step(id) ON DELETE SET NULL,
  -- 'effect_proposal' is a step that prepared an external request and stopped; only a
  -- 'connector_call' row means bytes actually left this machine. Keeping them distinct
  -- makes "did anything happen out there?" a query rather than an interpretation.
  tool_name                TEXT NOT NULL
                           CHECK (tool_name IN ('memory_recall','web_search',
                                                'local_artifact','effect_proposal',
                                                'connector_call')),
  effect_kind              TEXT NOT NULL
                           CHECK (effect_kind IN ('memory_read','web_read','prepare_local',
                                                  'external_read','send','schedule',
                                                  'modify_external')),
  connector_capability_id  INTEGER REFERENCES connector_capability(id) ON DELETE SET NULL,
  proposed_effect_id       INTEGER REFERENCES proposed_effect(id) ON DELETE SET NULL,
  call_index               INTEGER NOT NULL CHECK (call_index > 0),
  input_json               TEXT NOT NULL CHECK (json_valid(input_json)),
  output_json              TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  citations_json           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
  status                   TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
  error_code               TEXT,
  error_message            TEXT,
  idempotency_key          TEXT NOT NULL UNIQUE,
  started_at               TEXT NOT NULL,
  completed_at             TEXT,
  CHECK (
    (tool_name IN ('connector_call','effect_proposal') AND connector_capability_id IS NOT NULL)
    OR
    (tool_name NOT IN ('connector_call','effect_proposal')
      AND connector_capability_id IS NULL AND proposed_effect_id IS NULL)
  )
);
INSERT INTO tool_receipt
  (id, work_run_id, work_step_id, tool_name, effect_kind, call_index, input_json,
   output_json, citations_json, status, error_code, error_message, idempotency_key,
   started_at, completed_at)
SELECT id, work_run_id, work_step_id, tool_name, effect_kind, call_index, input_json,
       output_json, citations_json, status, error_code, error_message, idempotency_key,
       started_at, completed_at
FROM tool_receipt_safe_legacy;
DROP TABLE tool_receipt_safe_legacy;
CREATE INDEX tool_receipt_run_idx ON tool_receipt(work_run_id, call_index);
CREATE INDEX tool_receipt_effect_idx ON tool_receipt(proposed_effect_id)
WHERE proposed_effect_id IS NOT NULL;

-- A disposable, TTL-bounded copy of what a connector reported. Deliberately unreachable
-- from every evidence table: a calendar invite is somebody else's text about the user,
-- never the user's own statement, so it can inform a plan but can never become memory.
CREATE TABLE external_signal (
  id            INTEGER PRIMARY KEY,
  connector_id  INTEGER NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('calendar_event')),
  external_id   TEXT NOT NULL,
  starts_at     TEXT,
  ends_at       TEXT,
  location      TEXT,
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  fetched_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  UNIQUE (connector_id, kind, external_id)
);
CREATE INDEX external_signal_window_idx ON external_signal(kind, starts_at);
CREATE INDEX external_signal_expiry_idx ON external_signal(expires_at);

-- Deterministic detector output. Like a follow-through recommendation this is an
-- assistant-side proposal, kept in its own table so it can never be mistaken for an
-- intention the user stated.
CREATE TABLE detected_signal (
  id                INTEGER PRIMARY KEY,
  detector          TEXT NOT NULL
                    CHECK (detector IN ('calendar_overlap','travel_gap',
                                        'deadline_collision','commitment_unscheduled')),
  dedupe_key        TEXT NOT NULL UNIQUE,
  subject_json      TEXT NOT NULL CHECK (json_valid(subject_json)),
  commitment_id     INTEGER REFERENCES commitment(id) ON DELETE CASCADE,
  severity          INTEGER NOT NULL CHECK (severity BETWEEN 0 AND 100),
  why               TEXT NOT NULL,
  suggested_action  TEXT NOT NULL,
  effect_kind       TEXT NOT NULL
                    CHECK (effect_kind IN ('memory_read','web_read','prepare_local',
                                           'external_read','send','schedule','purchase',
                                           'modify_external')),
  occurs_at         TEXT,
  detected_at       TEXT NOT NULL,
  snoozed_until     TEXT,
  last_surfaced_at  TEXT,
  resolved_at       TEXT
);
CREATE INDEX detected_signal_open_idx ON detected_signal(severity DESC, id)
WHERE resolved_at IS NULL;
CREATE INDEX detected_signal_commitment_idx ON detected_signal(commitment_id)
WHERE commitment_id IS NOT NULL;

-- Signal decisions mirror follow-through decisions but stay in their own ledger. A
-- conflict Zeus noticed in the world is a different kind of claim from a commitment the
-- user made, and the behavioral-policy machinery is deliberately built around the latter.
CREATE TABLE signal_event (
  id                   INTEGER PRIMARY KEY,
  detected_signal_id   INTEGER NOT NULL REFERENCES detected_signal(id) ON DELETE CASCADE,
  event_type           TEXT NOT NULL
                       CHECK (event_type IN ('surfaced','accepted','dismissed','snoozed',
                                             'completed','regretted')),
  detail_json          TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  response_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_message_id    INTEGER REFERENCES message(id) ON DELETE SET NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('system','message','user_action')),
  created_at           TEXT NOT NULL,
  CHECK (
    (event_type = 'surfaced' AND source_kind = 'system' AND source_message_id IS NULL)
    OR
    (event_type <> 'surfaced' AND source_kind IN ('message','user_action')
      AND source_message_id IS NOT NULL)
  )
);
CREATE INDEX signal_event_signal_idx ON signal_event(detected_signal_id, created_at DESC);
CREATE INDEX signal_event_type_idx ON signal_event(event_type, created_at DESC);

CREATE TRIGGER signal_event_immutable
BEFORE UPDATE ON signal_event
BEGIN
  SELECT RAISE(ABORT, 'signal decision history is append-only');
END;

-- One opportunity pipeline, two possible subjects. Every existing gate — intervention
-- mode, quiet hours, the one-per-day budget, cooldown, snooze, dismissal, facet blocks —
-- keeps applying because detector alerts are delivered through it rather than beside it.
ALTER TABLE recommendation_cycle
ADD COLUMN selected_signal_id INTEGER REFERENCES detected_signal(id) ON DELETE SET NULL;
CREATE INDEX recommendation_cycle_signal_idx
ON recommendation_cycle(selected_signal_id, created_at DESC)
WHERE selected_signal_id IS NOT NULL;

-- Connector calls get their own durable ceiling, for the same reason model calls do: a
-- limit a crash-loop can reset is not a limit.
CREATE TABLE connector_usage (
  window_kind   TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (window_kind, window_start)
);
`;

/**
 * Catalog connectors retain the same reviewed-capability model as manual MCP servers.
 * The nullable id identifies code-owned configuration without changing legacy rows; the
 * partial unique index permits any number of manual connectors but only one instance of
 * each preset.
 */
const CONNECTOR_PRESETS = `
ALTER TABLE connector ADD COLUMN preset_id TEXT;
CREATE UNIQUE INDEX connector_preset_unique_idx
ON connector(preset_id)
WHERE preset_id IS NOT NULL;
`;

const GOOGLE_CALENDAR_PROVIDER = `
-- First-party provider connections are created only from an authenticated OAuth result.
-- The opaque connection id locates an encrypted grant in the separate broker; it is not
-- a credential and is useless without the broker service key, which never enters this DB.
ALTER TABLE connector
ADD COLUMN provider TEXT NOT NULL DEFAULT 'generic'
CHECK (provider IN ('generic','google_calendar'));

ALTER TABLE connector
ADD COLUMN provider_connection_id TEXT;

CREATE UNIQUE INDEX connector_google_calendar_provider_idx
ON connector(provider)
WHERE provider = 'google_calendar';
`;

/**
 * Direct calendar execution: a second, *named* authorization path — never the absence of one.
 *
 * `proposed_effect` and `effect_event` are rebuilt rather than altered, for two reasons.
 * `payload_hash` carried a global UNIQUE, so two identical requests collided across runs —
 * harmless while every write needed a hand-typed confirmation, and a live bug the moment one
 * sentence is enough. Uniqueness belongs to the step, not to the digest. And `effect_event`
 * needs a new event type, which its CHECK constraints cannot accept in place.
 *
 * The rule this preserves: Zeus never writes a message the user did not send. A
 * policy-authorized effect cites the user's real request — a stored `role='user'` row that
 * really does say "add dinner Friday at 7" — and is recorded as `authorized_by_policy`, never
 * as `confirmed`, because it does not name the payload hash.
 */
const CALENDAR_DIRECT_EXECUTION = `
ALTER TABLE proposed_effect RENAME TO proposed_effect_gate_legacy;
CREATE TABLE proposed_effect (
  id                       INTEGER PRIMARY KEY,
  work_run_id              INTEGER NOT NULL REFERENCES work_run(id) ON DELETE CASCADE,
  work_step_id             INTEGER NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  connector_capability_id  INTEGER NOT NULL
                           REFERENCES connector_capability(id) ON DELETE RESTRICT,
  effect_kind              TEXT NOT NULL
                           CHECK (effect_kind IN ('send','schedule','modify_external')),
  payload_json             TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash             TEXT NOT NULL
                           CHECK (length(payload_hash) = 64
                                  AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  preview_text             TEXT NOT NULL,
  reversal_json            TEXT CHECK (reversal_json IS NULL OR json_valid(reversal_json)),
  -- What the read cache said about the target immediately before the call. Enough to
  -- reverse the fields Zeus itself set; never enough to claim a full rollback.
  prior_state_json         TEXT CHECK (prior_state_json IS NULL OR json_valid(prior_state_json)),
  -- The deterministic check Zeus performed instead of asking a human.
  conflict_check_json      TEXT CHECK (conflict_check_json IS NULL
                                       OR json_valid(conflict_check_json)),
  confirmation_kind        TEXT NOT NULL DEFAULT 'user_message'
                           CHECK (confirmation_kind IN ('user_message','standing_policy')),
  -- The user message this request was built from. Real and stored, and deliberately NOT a
  -- confirmation, because it does not name the payload hash.
  request_message_id       INTEGER REFERENCES message(id) ON DELETE RESTRICT,
  status                   TEXT NOT NULL DEFAULT 'pending_confirmation'
                           CHECK (status IN ('pending_confirmation','confirmed','declined',
                                             'expired','executed','failed','reverted')),
  idempotency_key          TEXT NOT NULL UNIQUE,
  provider_request_key     TEXT NOT NULL,
  expires_at               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (work_step_id, payload_hash),
  -- A policy execution with nothing to cite is exactly the ledger lie this design refuses.
  CHECK (confirmation_kind = 'user_message' OR request_message_id IS NOT NULL)
);
INSERT INTO proposed_effect
  (id, work_run_id, work_step_id, connector_capability_id, effect_kind, payload_json,
   payload_hash, preview_text, reversal_json, status, idempotency_key,
   provider_request_key, expires_at, created_at, updated_at)
SELECT id, work_run_id, work_step_id, connector_capability_id, effect_kind, payload_json,
       payload_hash, preview_text, reversal_json, status, idempotency_key,
       provider_request_key, expires_at, created_at, updated_at
FROM proposed_effect_gate_legacy;
DROP TABLE proposed_effect_gate_legacy;
CREATE INDEX proposed_effect_run_idx ON proposed_effect(work_run_id, id);
CREATE INDEX proposed_effect_pending_idx ON proposed_effect(expires_at)
WHERE status = 'pending_confirmation';
CREATE INDEX proposed_effect_hash_idx ON proposed_effect(payload_hash);

DROP TRIGGER effect_event_immutable;
DROP TRIGGER effect_event_decision_is_user_authored;
ALTER TABLE effect_event RENAME TO effect_event_gate_legacy;
CREATE TABLE effect_event (
  id                  INTEGER PRIMARY KEY,
  proposed_effect_id  INTEGER NOT NULL REFERENCES proposed_effect(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL
                      CHECK (event_type IN ('proposed','confirmed','authorized_by_policy',
                                            'declined','expired','executed','failed',
                                            'reverted')),
  source_message_id   INTEGER REFERENCES message(id) ON DELETE RESTRICT,
  detail_json         TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at          TEXT NOT NULL,
  UNIQUE (proposed_effect_id, event_type),
  CHECK (
    (event_type IN ('confirmed','authorized_by_policy','declined','reverted')
      AND source_message_id IS NOT NULL)
    OR
    (event_type IN ('proposed','expired','executed','failed') AND source_message_id IS NULL)
  )
);
INSERT INTO effect_event (id, proposed_effect_id, event_type, source_message_id,
                          detail_json, created_at)
SELECT id, proposed_effect_id, event_type, source_message_id, detail_json, created_at
FROM effect_event_gate_legacy;
DROP TABLE effect_event_gate_legacy;
CREATE INDEX effect_event_effect_idx ON effect_event(proposed_effect_id, id);
CREATE INDEX effect_event_source_idx ON effect_event(source_message_id)
WHERE source_message_id IS NOT NULL;

CREATE TRIGGER effect_event_immutable
BEFORE UPDATE ON effect_event
BEGIN
  SELECT RAISE(ABORT, 'effect history is append-only');
END;

-- Unchanged in force, and now covering the policy path too: whatever authorized this, the
-- message it cites is the user's own.
CREATE TRIGGER effect_event_decision_is_user_authored
BEFORE INSERT ON effect_event
WHEN NEW.source_message_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM message WHERE id = NEW.source_message_id AND role = 'user'
  )
BEGIN
  SELECT RAISE(ABORT, 'an effect decision must cite a user message');
END;

-- An external request is authorized once, one way. Hand-confirmed and policy-authorized are
-- mutually exclusive, enforced independently of whatever calls the write path.
CREATE TRIGGER effect_event_single_authorization
BEFORE INSERT ON effect_event
WHEN NEW.event_type IN ('confirmed','authorized_by_policy')
  AND EXISTS (
    SELECT 1 FROM effect_event
    WHERE proposed_effect_id = NEW.proposed_effect_id
      AND event_type IN ('confirmed','authorized_by_policy')
  )
BEGIN
  SELECT RAISE(ABORT, 'an external request is authorized once, one way');
END;

-- Proof that a window was actually read, independent of whether it held any events. An
-- empty calendar and a failed read must never look the same to a write gate, because
-- "nothing conflicts" is otherwise exactly what an unread calendar reports.
CREATE TABLE external_read_window (
  id            INTEGER PRIMARY KEY,
  connector_id  INTEGER NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('calendar_event')),
  window_from   TEXT NOT NULL,
  window_to     TEXT NOT NULL,
  event_count   INTEGER NOT NULL CHECK (event_count >= 0),
  fetched_at    TEXT NOT NULL,
  UNIQUE (connector_id, kind)
);

-- Deliberation is not Zeus's work. A run parked for a decision must not spend the budget
-- that bounds how long Zeus may run; the authorization expiry is what bounds the user's
-- window, and that one is untouched.
ALTER TABLE work_run ADD COLUMN paused_at TEXT;
ALTER TABLE work_run ADD COLUMN paused_ms_total INTEGER NOT NULL DEFAULT 0
CHECK (paused_ms_total >= 0);

CREATE TABLE calendar_action_setting (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  direct_execution   INTEGER NOT NULL DEFAULT 1 CHECK (direct_execution IN (0,1)),
  daily_limit        INTEGER NOT NULL DEFAULT 10 CHECK (daily_limit BETWEEN 1 AND 50),
  day_start          TEXT NOT NULL DEFAULT '08:00',
  day_end            TEXT NOT NULL DEFAULT '20:00',
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);
INSERT INTO calendar_action_setting
  (id, direct_execution, daily_limit, day_start, day_end, source_message_id, updated_at)
VALUES (1, 1, 10, '08:00', '20:00', NULL, ${NOW});
`;

/**
 * What a calendar request did, kept with the assistant turn that reported it.
 *
 * Assistant-authored outcome data: not memory, not evidence, and deliberately in its own
 * table so it cannot reach extraction, the `<memory>` block, or retrieval. It is stored
 * rather than reconstructed because the outcomes that most needed saying — nothing
 * connected, a request Zeus could not resolve — never produced a `work_run` to rebuild from.
 *
 * Cascades from the message, so deleting a source conversation takes its outcomes with it.
 */
const CALENDAR_TURN_OUTCOME = `
CREATE TABLE calendar_outcome (
  assistant_message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('create','reschedule','cancel','read')),
  status               TEXT NOT NULL,
  outcome_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
`;

/**
 * Give back the grants a network failure took away.
 *
 * `recordConnectorVerification` used to clear `enabled` on every capability of a connector
 * whose handshake failed, for any reason at all. Those rows are the record of which slots
 * the user reviewed and accepted, and nothing could put them back: a later successful
 * handshake sets `status` and has no user message to cite as consent. So one timed-out
 * request permanently cost a full re-authorization, and a store left in that state greets
 * every new conversation by saying a plainly connected calendar cannot be used.
 *
 * Restored only where the recorded reason was not the user's to fix. A revoked grant, absent
 * credentials, a configuration Zeus may no longer run, or a remote tool that stopped matching
 * what was reviewed all stay withdrawn: those genuinely need someone to act. Capabilities
 * disabled by schema drift or by the user are untouched too, since neither of those leaves
 * the connector `unreachable`.
 *
 * Note what this does not do: the connector's own `enabled` is left at 0, as the schema's
 * `enabled = 0 OR status = 'ready'` requires. Nothing here becomes callable. The connector
 * must still answer a handshake before it is put back into service.
 */
const CONNECTOR_REACHABILITY_IS_NOT_CONSENT = `
UPDATE connector_capability
SET enabled = 1, updated_at = ${NOW}
WHERE enabled = 0
  AND connector_id IN (
    SELECT id FROM connector
    WHERE status = 'unreachable'
      AND last_error_code IS NOT NULL
      AND last_error_code NOT IN (
        'reconnect_required','refresh_revoked','api_or_iam_missing','scope_missing',
        'adc_missing','project_missing','missing_environment','invalid_connector',
        'invalid_preset','invalid_permissions','tool_contract_changed','local_only'
      )
  );
`;

/**
 * Clearing a window is a fourth kind of calendar request.
 *
 * `calendar_outcome.kind` pinned the three single-event actions plus a read, so a bulk clear
 * could not be recorded at all — and an outcome that cannot be stored is one a later turn
 * cannot recall, which is the whole failure this table exists to prevent. SQLite cannot widen
 * a CHECK in place, so the table is rebuilt and copied.
 */
const CALENDAR_CLEAR_OUTCOME_KIND = `
ALTER TABLE calendar_outcome RENAME TO calendar_outcome_clear_legacy;
CREATE TABLE calendar_outcome (
  assistant_message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL
                       CHECK (kind IN ('create','reschedule','cancel','clear','read')),
  status               TEXT NOT NULL,
  outcome_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
INSERT INTO calendar_outcome
  (assistant_message_id, kind, status, outcome_json, created_at)
SELECT assistant_message_id, kind, status, outcome_json, created_at
FROM calendar_outcome_clear_legacy;
DROP TABLE calendar_outcome_clear_legacy;
`;

/**
 * The standing schedule block a turn rendered for the model, kept with the assistant turn.
 *
 * Assistant-context data over an external, expiring cache: not memory, not evidence, never
 * indexed, never exported, and with no path to extraction or retrieval. Stored because the
 * cache it was rendered from reconciles and expires — without this row, "Why did Zeus say
 * that?" about a schedule claim stops being answerable an hour after the claim. Cascades
 * with its message, exactly like `calendar_outcome`.
 */
const SCHEDULE_TURN_CONTEXT = `
CREATE TABLE schedule_context (
  assistant_message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN ('current','stale','unread')),
  as_of         TEXT,
  window_from   TEXT,
  window_to     TEXT,
  events_shown  INTEGER NOT NULL CHECK (events_shown >= 0),
  events_total  INTEGER NOT NULL CHECK (events_total >= 0),
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
`;

/**
 * Proactivity becomes opt-in, in the schema rather than in a prompt.
 *
 * Migration 013 widened the mode to include `off` but left the default at `balanced`, so
 * every account ever created has volunteered follow-through in ordinary chat without anyone
 * choosing it. The product documents say the opposite. SQLite cannot alter a DEFAULT in
 * place, so the table is rebuilt on the same rename→create→copy→drop path 013 itself used.
 *
 * The update moves only rows nobody chose. `source_message_id` is exactly that evidence: it
 * is the user message that set the mode, and `setStewardshipMode` records it on every
 * deliberate change. A row with one is a decision and is left alone — including a decision
 * to be `balanced`.
 */
const PROACTIVITY_OPT_IN = `
ALTER TABLE stewardship_setting RENAME TO stewardship_setting_default_legacy;
CREATE TABLE stewardship_setting (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  mode               TEXT NOT NULL DEFAULT 'off'
                     CHECK (mode IN ('off','quiet','balanced','proactive')),
  source_message_id  INTEGER REFERENCES message(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL
);
INSERT INTO stewardship_setting (id, mode, source_message_id, updated_at)
SELECT id, mode, source_message_id, updated_at FROM stewardship_setting_default_legacy;
DROP TABLE stewardship_setting_default_legacy;

UPDATE stewardship_setting
SET mode = 'off', updated_at = ${NOW}
WHERE source_message_id IS NULL AND mode = 'balanced';
`;

/**
 * A calendar turn where the intent was never established is a fifth thing that can happen.
 *
 * The five existing kinds all presume recognition succeeded — they name an action. When the
 * classifier is unavailable there is no action to name, and filing the turn as a `read`
 * (the closest fit, and what `refusalIntoKind` already stretches `none` into) would put a
 * wrong answer into the only record a later turn can consult. Same rebuild as migration 030,
 * for the same reason: SQLite cannot widen a CHECK in place.
 */
const CALENDAR_UNCLASSIFIED_OUTCOME = `
ALTER TABLE calendar_outcome RENAME TO calendar_outcome_unclassified_legacy;
CREATE TABLE calendar_outcome (
  assistant_message_id INTEGER PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL
                       CHECK (kind IN ('create','reschedule','cancel','clear','read','unclassified')),
  status               TEXT NOT NULL,
  outcome_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
INSERT INTO calendar_outcome
  (assistant_message_id, kind, status, outcome_json, created_at)
SELECT assistant_message_id, kind, status, outcome_json, created_at
FROM calendar_outcome_unclassified_legacy;
DROP TABLE calendar_outcome_unclassified_legacy;
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
  { id: "012_app_owner", sql: APP_OWNER },
  { id: "013_personal_agent", sql: PERSONAL_AGENT },
  { id: "014_behavioral_policy_suggestions", sql: BEHAVIORAL_POLICY_SUGGESTIONS },
  { id: "015_ambient_delivery_claims", sql: AMBIENT_DELIVERY_CLAIMS },
  { id: "016_work_run_leases", sql: WORK_RUN_LEASES },
  { id: "017_derived_source_dependencies", sql: DERIVED_SOURCE_DEPENDENCIES },
  { id: "018_work_plan_generation_provenance", sql: WORK_PLAN_GENERATION_PROVENANCE },
  { id: "019_work_artifact_memory_provenance", sql: WORK_ARTIFACT_MEMORY_PROVENANCE },
  { id: "020_mcp_mutation_approval", sql: MCP_MUTATION_APPROVAL },
  { id: "021_snapshot_destinations", sql: SNAPSHOT_DESTINATIONS },
  { id: "022_model_usage", sql: MODEL_USAGE },
  { id: "023_external_actions", sql: EXTERNAL_ACTIONS },
  { id: "024_connector_presets", sql: CONNECTOR_PRESETS },
  { id: "025_google_calendar_provider", sql: GOOGLE_CALENDAR_PROVIDER },
  { id: "026_calendar_direct_execution", sql: CALENDAR_DIRECT_EXECUTION },
  { id: "027_calendar_turn_outcome", sql: CALENDAR_TURN_OUTCOME },
  {
    id: "028_connector_reachability_is_not_consent",
    sql: CONNECTOR_REACHABILITY_IS_NOT_CONSENT,
  },
  { id: "029_schedule_turn_context", sql: SCHEDULE_TURN_CONTEXT },
  { id: "030_calendar_clear_outcome_kind", sql: CALENDAR_CLEAR_OUTCOME_KIND },
  { id: "031_proactivity_opt_in", sql: PROACTIVITY_OPT_IN },
  // Numbered 032 because 031 belongs to the proactivity opt-in, which lands first. A
  // migration may only ever be appended: inserting one before an id a store has already
  // applied fails `validateMigrationLedger`, which is the check that refuses a build that
  // does not recognize the schema in front of it.
  { id: "032_calendar_unclassified_outcome", sql: CALENDAR_UNCLASSIFIED_OUTCOME },
];
