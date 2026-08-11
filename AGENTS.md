# AGENTS.md

This file is the operating guide for coding agents working on Zeus.

Zeus is a personal agent with a durable memory of one person. Its product promise is not
merely to remember; it is to make remembered claims auditable. When convenience and
evidentiary integrity conflict, preserve the integrity of the memory.

## Product contract

Zeus is designed against two costly failures:

1. A formerly true fact remains presented as current after the user’s life changes.
2. An inference or assistant-authored suggestion becomes a claimed fact about the user.

The implementation therefore treats every canonical memory as evidence-backed temporal
data. New work must preserve these properties:

- Current truth and historical truth remain distinguishable.
- Every new accepted fact has a real source message.
- Uncertain material stays outside canonical context until the user accepts it.
- An empty or degraded search is safer than an unrelated “best” result.
- The user can inspect, correct, close, export, and explicitly delete their data.

## Stack and boundaries

- Next.js 16 App Router and React 19.
- Strict TypeScript; do not weaken compiler settings to make a change pass.
- Zod 4 schemas are the runtime boundary and the source for inferred types.
- SQLite through `better-sqlite3`, with ordered migrations embedded in TypeScript.
- OpenAI Responses API for streaming chat and structured extraction.
- Local `bge-small-en-v1.5` embeddings, with FTS5 and graph fallbacks.

`src/core/` is framework-free. Do not import React, Next.js, server actions, or UI code
there. Both the web application and MCP server depend on the same core.

## Setup and commands

Use Node.js 22 or newer.

```bash
npm install
cp .env.example .env.local
# Add OPENAI_API_KEY only when exercising chat or extraction.
```

The store, curation UI, tests, trust evaluation, and FTS search do not need an API key.
`OPENAI_MODEL` defaults to `gpt-5.5`.

```bash
npm run dev            # http://127.0.0.1:3000; loopback only
npm run build          # production build
npm run start          # serve the production build on loopback
npm run lint           # eslint, zero warnings allowed
npm run typecheck      # tsc --noEmit
npm test               # full Vitest suite
npm test -- src/core/facts.test.ts
npm run eval:memory    # deterministic offline trust-policy corpus
npm run check          # lint + typecheck + test + eval:memory + build

npm run seed:demo      # fixture replay and write-path assertions
npm run reindex        # rebuild FTS and missing embeddings
npm run reindex -- --fts-only
npm run export         # readable Markdown in ./zeus-export
npm run export -- /path/to/output
npm run mcp            # stdio MCP server
```

`npm run check` is the final gate for implementation changes.

## Repository map

- `src/core/db.ts` — database path, connection pragmas, migration runner, test database.
- `src/core/migrations.ts` — ordered schema migrations and seed data.
- `src/core/schema.ts` — Zod schemas and inferred domain types.
- `src/core/conversations.ts` — conversations, messages, and message FTS indexing.
- `src/core/entities.ts` — entity identity, aliases, slugs, summaries, and merges.
- `src/core/facts.ts` — fact writes, reassertion, supersession, correction, evidence,
  deletion, timeline reads, and FTS indexing.
- `src/core/candidates.ts` — pending/accepted/rejected memory proposals.
- `src/core/extract.ts` — model extraction plus deterministic application policy.
- `src/core/embed.ts` — local embeddings, vector persistence, similarity floors, fallback.
- `src/core/search.ts` — FTS, vector, graph retrieval, and reciprocal-rank fusion.
- `src/core/episodes.ts` — dated retrieval over user messages only.
- `src/core/context.ts` — canonical prompt context and response trace writes.
- `src/core/response-context.ts` — read-side reconstruction of recalled items.
- `src/core/intentions.ts` — goals, commitments, append-only events, and nudges.
- `src/core/retention.ts` — explicit source deletion and evidence-aware cleanup.
- `src/core/chat.ts` — retrieve → stream → trace → extract → apply turn loop.
- `src/core/openai.ts` — lazy OpenAI client and response/refusal checks.
- `src/app/actions.ts` — explicit curation and destructive user actions.
- `src/app/`, `src/components/` — routes and UI.
- `src/server/db.ts` — process-wide database handle for Next.js.
- `src/mcp/server.ts` — stdio MCP server, the second front door.
- `scripts/` — demo seed, offline trust evaluation, reindex, and export.

Tests are colocated with the core modules they protect.

## Non-negotiable memory invariants

### Automated writes preserve history

Extraction and ordinary write paths may insert, reassert, and supersede facts; they may
not hard-delete them. Supersession sets `valid_to` and links `superseded_by`, leaving the
old row available for historical questions.

Hard deletion is reserved for explicit user actions:

- `forgetFact`, reached from the fact curation UI.
- `deleteConversationWithMemory`, reached from confirmed source deletion.

Source deletion must remain evidence-aware: remove memories supported only by the deleted
conversation, rehome multiply evidenced facts to a surviving source, and restore a prior
fact if the deleted source was the sole evidence for its correction.

Editing a fact is also historical, not an in-place rewrite. Create a sourced correction,
close the old assertion, and preserve both rows.

### Cardinality alone controls supersession

Single-valued predicates such as `works_at`, `job_title`, and `lives_in` close their prior
live value when a different value is accepted. Multi-valued predicates such as `likes`,
`knows`, and `works_on` do not.

Unknown predicates default to `multi`, the non-destructive choice. The model’s
`supersedes_previous` field may help the trust gate recognize an explicitly described
change, but it must never directly retire a fact. Closure is the responsibility of the
predicate registry and `recordFact`.

### Provenance is a foreign key

Every new production fact must receive the stored source message ID. Thread that source
through every new write path. `fact_evidence` records the initial assertion, later
reassertions, and corrections. Do not create synthetic evidence for legacy rows whose
source is null.

The same rule applies to goals and commitments: their source columns and subsequent event
records must reflect an actual message or explicit user action. `applyExtraction` must
continue rejecting non-user source messages.

### The candidate queue is the acceptance boundary

Direct, clear, non-sensitive user statements may become canonical automatically.
Inference, ambiguity, sensitive material, low confidence, invalid references, and
unexplained single-value conflicts belong in `memory_candidate`.

Only accepted memory is supplied as canonical context. Accepting a candidate is an
explicit user action and may bypass the gate while retaining the original source. A
rejected candidate remains an audit record but never enters context.

Text present only in an assistant message is discarded. Assistant messages can resolve
conversation references for extraction, but can never serve as evidence that something
is true about the user.

### Facts and episodes are different evidence types

An episode is a dated excerpt from a stored user message. It may answer “What did I say
about this?” but must not be promoted to a current fact. Assistant messages, memory
curation messages, and unresolved sensitive candidate sources are excluded from episodic
retrieval.

Keep these labels explicit in prompt context. A model should never receive an episode in
a section that implies canonical truth.

### Intentions are not generic facts

Goals and commitments have their own lifecycle tables and append-only event tables. Do
not encode the same item as a generic fact. Updates must preserve owners, dates, statuses,
source messages, and history.

Zeus may surface at most one eligible commitment nudge during a chat turn. External
actions are out of scope: Zeus can suggest or clarify, but must not claim it sent,
scheduled, purchased, or changed anything outside the local store.

### Response provenance is persistent

`response_context` records exactly which facts, episodes, goals, and commitments were
provided to an assistant response, including immutable JSON snapshots. If context assembly
changes, keep this trace complete so the response-sources view can still answer “Why did
Zeus say that?” after the underlying memory changes.

## Retrieval rules

Retrieval combines three paths because their failure modes differ:

- FTS5 handles exact names and wording.
- Semantic search handles paraphrases.
- One-hop graph expansion handles relationships between named entities.

Results are fused by rank. Current facts are the default; historical facts are included
only when the query asks about the past or the caller opts in.

`SEMANTIC_FLOOR` is `0.5` for facts because genuine matches on
`Xenova/bge-small-en-v1.5` measured roughly `0.59–0.69`, while unrelated queries topped
out around `0.43–0.46`. `EPISODE_SEMANTIC_FLOOR` is separately calibrated at `0.52` because
message text has a different score distribution. Re-measure both if the embedding model
changes.

Search must degrade, not fail. If the model cannot load, `embed()` returns null and the
remaining FTS5 and graph paths continue. Malformed or unavailable FTS must likewise reduce
recall rather than crash a chat turn. No result is a valid and important result.

## OpenAI integration rules

Both model paths use the Responses API with `store: false` and the model selected by
`OPENAI_MODEL`.

- Chat streams `response.output_text.delta` with reasoning effort `high`.
- Extraction uses reasoning effort `low` and `zodTextFormat` structured output.
- Check refusal content and response status before reading `output_text` or parsed output.
- Extraction failure must leave a successful chat response intact and memory unchanged.
- Construct the client lazily so non-model features work without credentials.

The chat system prompt is a cached prefix. Keep it byte-identical between turns: memory,
dates, transcripts, and any other volatile content go after it. Do not interpolate dynamic
values into the system prompt.

## Database and migration rules

The default store is `~/.zeus/zeus.db`, outside the repository. `ZEUS_DB` overrides it.
Every connection enables WAL, a busy timeout, foreign keys, and `synchronous=NORMAL`
because the web and MCP processes can open the same file concurrently.

For schema changes:

1. Append a new entry to `MIGRATIONS`; do not edit an already-applied migration.
2. Keep SQL in TypeScript strings. The Next.js bundle and `tsx` entry points must load the
   same schema without filesystem path assumptions.
3. Update Zod schemas and inferred types at the same boundary.
4. Add migration and behavior tests using `openTestDb()`.
5. Update export, retention, indexing, and response tracing when the new data participates
   in those systems.

Use `now()` for UTC ISO-8601 timestamps. Keep foreign-key actions deliberate; provenance
depends on them.

## Implementation guidance

- Keep policy decisions in deterministic core code, not solely in model prompts.
- Split model calls from database application so write behavior remains testable offline.
- Wrap multi-row state changes in a transaction.
- Keep FTS and embedding records consistent with fact/message mutations. If searchable
  text changes, rebuild its derived index or remove the stale vector.
- Put destructive and corrective UI operations in `src/app/actions.ts`, require explicit
  user intent, and revalidate every affected view.
- Keep MCP behavior aligned with the web path. MCP responses should include learned
  dates and validity, and should surface confidence when uncertainty matters rather than
  returning bare assertions.
- The MCP server uses stdout as its protocol channel. Send diagnostics only to stderr.
- Preserve loopback-only server binding unless the user explicitly changes the threat
  model.
- Follow existing strict typing and import conventions. ESLint warnings are failures.

## Testing expectations

Use `openTestDb()` for automated tests. Never point a test at the user’s real store.

Add regression coverage for the policy, not only the happy path. Depending on the change,
exercise:

- insertion, reassertion, single-value supersession, and multi-value coexistence;
- provenance and evidence retention;
- conflict, sensitivity, ambiguity, and assistant-only rejection;
- candidate acceptance and rejection;
- entity aliases and merges;
- current versus historical retrieval and irrelevant-query empty results;
- source deletion with exclusive and shared evidence;
- goal/commitment event history and nudge eligibility;
- response-context snapshots;
- embedding-disabled fallback.

Run the smallest relevant test while iterating, then `npm run check` before handing off an
implementation change. `seed:demo` uses fixture extractions and tests the deterministic
write path; it is not evidence of live extraction quality.

## Data safety

- Never commit `.env.local`, database files, WAL/SHM files, `.models/`, or exports that
  contain personal data.
- Do not print API keys, environment files, message contents, or memory exports in logs.
- Prefer `openTestDb()` or an explicit temporary `ZEUS_DB` for scripts used during
  development. Do not experiment against `~/.zeus/zeus.db`.
- Treat conversation deletion and `forgetFact` as destructive operations. Resolve exact
  targets and require the existing confirmations.
- File mode `0600` is best effort, not encryption. Any process running as the same OS user
  can read the store; do not describe Zeus as encrypted at rest.

## Known limitations

- A single value of a multi-valued predicate cannot be retracted automatically. Close it
  explicitly from `/memory`.
- Entity aliases are globally unique. When extraction splits one person into two, merge
  them from the curation UI.
- Vector search is brute-force and intended for roughly fewer than 50,000 facts. Beyond
  that scale, use an ANN index and recalibrate retrieval behavior.
- Live extraction quality requires real-conversation evaluation; the offline seed and
  trust corpus validate policy and writes only.
