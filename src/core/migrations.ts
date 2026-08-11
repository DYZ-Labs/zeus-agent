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

export const MIGRATIONS: readonly Migration[] = [
  { id: "001_init", sql: INIT },
  { id: "002_seed", sql: SEED },
  { id: "003_copilot", sql: COPILOT },
  { id: "004_response_snapshots", sql: RESPONSE_SNAPSHOTS },
];
