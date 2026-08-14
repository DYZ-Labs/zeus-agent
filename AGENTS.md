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
- `src/core/passages.ts` — exact evidence spans, privacy classification, and recall state.
- `src/core/facets.ts` — scoped, temporal, evidence-backed user understanding.
- `src/core/backfill.ts` — resumable, opt-in historical facet preview.
- `src/core/context.ts` — canonical prompt context and response trace writes.
- `src/core/response-context.ts` — read-side reconstruction of recalled items.
- `src/core/intentions.ts` — goals, commitments, priorities, and append-only lifecycle events.
- `src/core/projects.ts` — source-backed project lifecycles and progress history.
- `src/core/stewardship.ts` — priority-aware next-action selection, signal selection,
  intervention settings, permission boundaries, user decisions, and progress/regret signals.
- `src/core/personalization.ts` — read model over accepted memory, plus behavioral-policy
  proposals that may only ever reduce interruptions.
- `src/core/ambient.ts` — opt-in background evaluation, quiet hours, one-per-day delivery
  claims, and the deterministic refresh that precedes them.
- `src/core/work-plans.ts` — immutable plan hashes, exact-hash authorization, runner leases,
  checkpoints, receipts, and artifacts.
- `src/core/work-execution.ts` — plan generation and the bounded step executor.
- `src/core/connectors.ts` — configured MCP servers and the capability slots granted to them.
- `src/core/connector-catalog.ts` — code-owned connector presets, tool mappings, and scopes.
- `src/core/mcp-client.ts` — the only outbound-network module in core.
- `src/core/effects.ts` — proposed external requests and the payload confirmation gate.
- `src/core/calendar-sync.ts` — the disposable external read cache.
- `src/core/detectors.ts` — deterministic conflict detection over that cache.
- `src/core/budget.ts`, `src/core/concurrency.ts` — durable model/connector ceilings and
  run capacity.
- `src/core/retention.ts` — explicit source deletion and evidence-aware cleanup.
- `src/core/snapshots.ts`, `src/core/restore.ts` — verified snapshots and restore.
- `src/core/observability.ts` — allowlisted operational events; never free-form text.
- `src/core/chat.ts` — retrieve → stream → trace → extract → apply turn loop.
- `src/core/openai.ts` — lazy OpenAI client and response/refusal checks.
- `src/app/actions.ts` — explicit curation, connection, and destructive user actions.
- `src/app/`, `src/components/` — routes and UI.
- `src/server/db.ts` — process-wide database handle for Next.js.
- `src/server/auth/` — Supabase-backed account boundary for the web front door.
- `src/mcp/server.ts` — stdio MCP server, the second front door.
- `scripts/` — demo seed, offline trust evaluation, reindex, export, snapshots, ambient worker.

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

Zeus may surface at most one eligible proposal during a chat turn — either a
follow-through recommendation or a detected signal, never both. It must not claim it sent,
scheduled, purchased, or changed anything outside the local store unless a stored receipt
records that it completed.

### Follow-through proposals are not memory

Zeus is a steward of the user's intentions, not an optimizer of their attention. The
follow-through selector may surface at most one accepted commitment, using deterministic
signals such as current relevance, urgency, explicit goal priority, waiting, staleness,
and deadline collisions. Paused goals, snoozes, dismissals, cooldowns, and the user's
intervention mode are hard gates.

A recommendation is system-authored proposal data and must never become a canonical fact
about the user. Persist it in `follow_through_event`, with the accepted goal and commitment
still serving as its source-backed basis. Record acceptance, completion, snooze, dismissal,
and regret as append-only user-control events. Do not infer those outcomes from silence or
from the assistant's own text.

Measure assisted progress, control signals, and regret separately. Do not replace them with
conversation count, time spent, tasks surfaced, or a composite engagement score that could
reward interruption. Declines and reversals of external requests are regret signals and
must stay separately visible.

### Detected signals are proposals too

A detector may notice something the user never wrote down — two calendar events claiming
the same minutes, a deadline with no time set aside. That output is assistant-authored
proposal data with its own append-only ledger in `signal_event`, never a fact and never a
commitment. It is deliberately not merged into `follow_through_event`, because the
behavioral-policy machinery reasons about commitments the user made.

Detectors are pure functions over the local store and must make no model call. A signal
reaches the user only through the existing opportunity pipeline, so intervention mode,
quiet hours, the one-per-day budget, cooldown, snooze, dismissal, and facet blocks all
apply unchanged. Do not add a second interruption path.

### External action passes two gates, never one

Authorizing a work plan approves a *scope*. It cannot approve a *payload*, because the
concrete request only exists once earlier steps have run. Treating scope approval as
payload approval is the failure the whole design prevents.

- **Scope, up front.** `authorizeWorkPlan` binds an exact plan hash, effects, limits, and
  expiry to a real user message. An effectful kind is authorizable only when a bound,
  enabled `connector_capability` provides it. `purchase` is refused unconditionally.
- **Payload, at execution.** A write step must not call the connector. It materializes the
  exact request into `proposed_effect` and returns a pause, so the run parks at its durable
  checkpoint. `confirmEffect` requires a stored **user** message containing the exact
  payload hash — the same proof `assertExactApprovalMessage` requires for a plan. The hash
  is recomputed from storage immediately before dispatch, so an edited payload fails closed.

Silence is never consent: an unanswered request expires rather than escalating. An
assistant message can never confirm anything; a database trigger enforces that
independently of the write path.

`external_read` is a distinct effect kind rather than a widening of `web_read`, because the
effect kind is the unit of authorization: a plan approved for public web research must not
thereby reach the user's calendar. Reads need no per-use confirmation — connecting the
service was the consent — but writes always do.

In the receipt log, `connector_call` is the only tool name that means bytes left the
machine. `effect_proposal` means a request was prepared and stopped. Keep them distinct.

### Zeus stores no third-party credential

A connector records a preset id or a command, arguments, URL, and the *names* of environment
variables. There is nowhere to put a credential value, and there must not be. Manual values
are read from the process environment at call time. The local-only Google Calendar preset
asks `gcloud` for a short-lived ADC token and quota project for one MCP exchange; both stay
in memory and are never persisted, logged, or exported. Preset ids, destinations, tools,
and scopes must always be re-derived from the code-owned catalog before minting a token.

A stdio connector is spawned without a shell, with explicit argv, and receives only the
SDK's safe default environment plus exactly the variables the user named — never the whole
environment Zeus is running with. An HTTP connector must use https, except on loopback.

Discovering a remote tool is not granting it. A capability binds one discovered tool to one
slot, the slot fixes the effect kind, and the tool's input schema is hashed at bind time:
a server that later changes what "create an event" accepts is disabled and re-reviewed
rather than silently obeyed.

### External data is never evidence

Calendar text is somebody else's writing — anyone who can send an invite can author it. It
may inform a plan, appear in an artifact, or trip a detector. It must never become a fact,
facet, goal, commitment, or candidate, it never enters `extract()`, and it never enters the
`<memory>` block. `external_signal` is a disposable, expiring cache with no path to any
evidence table; keep it that way. Run every external payload through
`inspectUntrustedWorkData` before it reaches a model.

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

- Natural multi-value retraction is conservative and succeeds only when one current
  subject/predicate/value resolves exactly; ambiguous retractions remain candidates.
- Shared aliases deliberately resolve as ambiguous. Merge genuinely duplicate entities
  from curation; never force a shared short name to one person.
- Vector search is brute-force and intended for roughly fewer than 50,000 facts. Beyond
  that scale, use an ANN index and recalibrate retrieval behavior.
- Live extraction quality requires real-conversation evaluation; the offline seed and
  trust corpus validate policy and writes only.
