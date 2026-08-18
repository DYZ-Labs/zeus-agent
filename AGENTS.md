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
`OPENAI_MODEL` defaults to `gpt-5.6-luna`.

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
- `src/calendar-broker/` — separately deployed Google OAuth and encrypted per-user token
  broker, plus the account-bound Calendar MCP service. Its database is never a Zeus store.
- `src/server/google-calendar/` — signed OAuth handoff and system-managed provider setup for
  the hosted web front door; no Google token crosses this boundary.
- `src/core/effects.ts` — proposed external requests, the payload confirmation gate, batch
  confirmation of one prepared set, and policy authorization.
- `src/core/calendar-time.ts` — the interval arithmetic noticing and acting must share.
- `src/core/calendar-conflicts.ts` — candidate-versus-calendar overlap, already-scheduled
  overlap, free-slot search, and deterministic target resolution. Pure; fails closed without
  proof of a fresh read.
- `src/core/calendar-intent.ts` — model intent recognition behind a deterministic veto that
  can only ever downgrade what the model proposed. Create, reschedule, cancel, clear, read.
- `src/core/calendar-actions.ts` — the resolved action, its payload, and its work plan.
- `src/core/calendar-policy.ts` — the standing direct-execution setting and its ceiling.
  Never consulted for a clear.
- `src/core/calendar-outcome.ts` — the deterministic account of what a calendar request did,
  stored with its assistant turn and replayed to later turns as `<calendar_history>`, so
  neither a reload nor the next message leaves prose as the only record.
- `src/core/capabilities.ts` — what Zeus can do right now, resolved every turn into the
  `<capabilities>` block. Never memory.
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

### External action passes a scope gate and an authorization gate

Authorizing a work plan approves a *scope*. It cannot approve a *payload*, because the
concrete request only exists once earlier steps have run. Treating scope approval as
payload approval is the failure the whole design prevents.

- **Scope, up front.** `authorizeWorkPlan` binds an exact plan hash, effects, limits, and
  expiry to a real user message. An effectful kind is authorizable only when a bound,
  enabled `connector_capability` provides it. `purchase` is refused unconditionally.
- **Payload, at execution.** A write step materializes the exact request into
  `proposed_effect`. It is then authorized in exactly one of two named ways, and
  `confirmation_kind` records which:
  - `user_message` — the default, and the only path for `send`, for generated plans, and
    for any calendar action the conflict gate could not clear. `confirmEffect` requires a
    stored **user** message containing the exact payload hash — the same proof
    `assertExactApprovalMessage` requires for a plan. The step returns a pause, so the run
    parks at its durable checkpoint.
  - `standing_policy` — a calendar create, reschedule, or cancel, when
    `calendar_action_setting.direct_execution` is on and the deterministic conflict gate
    returned `clear` against a freshly read window. `authorizeEffectByPolicy` cites
    `request_message_id`: the user's own request. It is **not** a confirmation and must
    never be recorded as one; `effect_event` gets `authorized_by_policy`, never `confirmed`.

Either way, the hash is recomputed from storage immediately before dispatch, so an edited
payload fails closed.

**One step, one confirmation — even when the step prepared several payloads.** Clearing a
window is the only thing that does. `confirmEffectBatch` takes a digest computed from every
member (`batchPayloadHash`), recomputes it from the rows as they stand, and authorizes each
one with `confirmation_kind = 'user_message'` citing the same real user message. Nothing is
relaxed by saying it once for a set: the digest still comes from the exact bytes, so a
payload added or edited after the user read the list no longer matches and nothing is sent.
Itemising a cleared afternoon into four separate confirmations is not more informed consent.

**Zeus never writes a message the user did not send.** Synthesizing an "I confirm `<hash>`"
message to satisfy the confirmation check is prohibited: it would put fabricated text in the
same `message` table that backs evidence, and it would reduce
`assertExactConfirmationMessage` and the `effect_event_decision_is_user_authored` trigger to
checks the system passes against its own output.

The chat asks for that message instead of writing it. There is no Confirm button any more, so
`confirmationSentence` is placed in the composer — only into an empty one — and the user
sends it themselves. The offer is recomputed from the live pending rows on every turn and
after every reload (`pendingConfirmationOffer`), not derived from the turn that asked: the
composer is emptied whenever the user sends anything else, and a reply saying "the line is in
your message box" has to be true on the turn it is said. `settlePendingConfirmation` in `src/core/chat.ts` recognizes a stored
user message naming a live hash, settles it before intent classification, and blocks its
recall and extraction: a payload digest is a decision, not something the user said about
themselves. Assent without a hash authorizes nothing; "yes, go ahead" leaves the request
sitting there. A plain refusal on the first line *does* decline the set, because that
asymmetry only ever stops an action.

**The standing policy covers verified, unconflicted actions only.** A collision, a calendar
that could not be read or was read too long ago, a target matching more than one event, or
an exhausted daily ceiling all fall back to per-payload confirmation, whatever the setting
says. Removing the interruption never removes the record, and never removes the check.

It also never covers a `clear`. Direct execution exists so that one verified, unconflicted
change need not interrupt anyone; emptying a stretch of somebody's week is not that, and the
itemized list Zeus shows before asking is the entire safeguard. `executeCalendarClear` does
not consult `directExecutionAllowance` at all — not as a check that usually fails, but as a
branch that does not exist.

Silence is never consent: an unanswered request expires rather than escalating. An
assistant message can never authorize anything; a database trigger enforces that
independently of the write path, and a second trigger enforces that an effect is authorized
once, one way.

### A calendar write reads the calendar first

`external_read` is not optional for a calendar write plan, and the conflict gate lives in
the executor rather than in a plan step — a gate a generated plan can omit is not a gate.

The gate must fail closed. An empty event list is not evidence that nothing conflicts,
because an unread calendar produces exactly the same empty list; `external_read_window`
records that a covering window was genuinely read, and `checkCalendarConflicts` refuses to
return `clear` without it. A confirmation gate fails safe when it is wrong, because a human
reads the payload first. This one does not have that luxury.

Resolving which existing event the user meant is deterministic and refuses on ambiguity.
Two plausible targets produce a question, never a choice.

`clear` is the one kind that wants the opposite from ambiguity, which is why it is a kind of
its own rather than a cancel with a looser target. A cancel matching four events must refuse;
a clear matching four events has found exactly what it was asked for. Collapsing them would
mean relaxing the rule that stops the wrong meeting being deleted. A clear selects by start
time inside the window — an event that began earlier and runs into it was not scheduled for
the stretch the user asked to free — refuses above `MAX_CLEAR_EVENTS` rather than truncating
a list that would read as complete, and needs the same fresh, covering read every other write
does.

`external_read` is a distinct effect kind rather than a widening of `web_read`, because the
effect kind is the unit of authorization: a plan approved for public web research must not
thereby reach the user's calendar. Reads need no per-use confirmation — connecting the
service was the consent — but writes always do.

Two events of the user's own colliding is the same arithmetic as a write colliding with one
of them, so it is the same function: `overlappingPairs` in `calendar-conflicts.ts`, used both
by `detectors.ts` when Zeus notices unprompted and by the read step when the user asks. A
clash reported in chat must be a clash Zeus would have refused to create.

In the receipt log, `connector_call` is the only tool name that means bytes left the
machine. `effect_proposal` means a request was prepared and stopped. Keep them distinct.

The read step retries once on a transient connector failure, and only there. A pause is a
deliberate stop rather than a thrown failure, so `max_retries_per_step` never covered it —
which meant a single timed-out handshake reached the user as a calendar that could not be
read. Terminal reasons (a revoked grant, a withdrawn capability, a spent ceiling) are
answered immediately; the retry must never grow into a loop, and must never make a *write*
attempt twice.

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

### An outage is not a withdrawn permission

A connector that cannot be reached is taken out of service — `status` leaves `ready`, the
schema's `enabled = 0 OR status = 'ready'` follows, and `availableCapability` stops offering
it. That much must never soften. What must not happen is the *grant* going with it.

`connector_capability.enabled` records which tools the user reviewed and accepted. A timeout
is not that user changing their mind, and nothing could ever put it back: a later successful
handshake sets `status` and has no user message to cite for consent, so one bad minute cost
a full re-authorization. `reachabilityFailureWithdrawsGrant` is the code-owned split — a
revoked authorization, missing credentials, a configuration Zeus may no longer run, or a
drifted tool contract clear the capabilities and wait for a person; everything else leaves
them standing.

Recovery follows from that. `restoreConnectorReachability` gives a connector in that state
one bounded handshake on a turn that already needs it, then
`restoreConnectorAfterReachability` puts it back into service against the state observed
*before* verifying — which is what keeps a connection the user deliberately switched off,
whose `status` is still `ready`, out of scope. It re-enables no capability row, so it can
never widen a grant.

Say which it is, too. A service that did not answer needs nothing from the user, and telling
them to go and reconnect an intact calendar is the failure this whole section exists to
prevent: `temporarilyUnreachable` and the `provider_unavailable` outcome carry that
distinction into the `<capabilities>` block and into the reply.

### External data is never evidence

Calendar text is somebody else's writing — anyone who can send an invite can author it. It
may inform a plan, appear in an artifact, or trip a detector. It must never become a fact,
facet, goal, commitment, or candidate, it never enters `extract()`, and it never enters the
`<memory>` block. `external_signal` is a disposable, expiring cache with no path to any
evidence table; keep it that way. Run every external payload through
`inspectUntrustedWorkData` before it reaches a model.

### What Zeus did is a matter of record; what is on the calendar is not

Two questions the prompt used to answer identically, and the conflation is a reported bug.
"What is on my calendar?" genuinely needs a fresh read, and the rule stands: never say what
is or is not there unless a `<calendar_result>` or `<work_result>` block in *this* turn
supplies it. "Did you add it?" does not. Zeus has a stored `calendar_outcome` for every
calendar request it recognized, and denying work it holds a receipt for is its own failure.

Every block of a turn belongs to a synthetic final user message that is discarded when the
turn ends — only `options.input` is stored, and prior turns replay as bare prose. So a model
asked "did that go through?" saw no evidence a calendar had ever been opened, and correctly
refused to claim anything. The correct refusal was the bug.

`calendarHistoryFor` closes it: a bounded, oldest-first `<calendar_history>` block built from
the stored outcomes of this conversation. Scoped to the conversation rather than to the
model's message window, because a change made forty messages ago is still a change that was
made. It carries a status and a preview and no event list — a record of Zeus's actions, never
of the calendar's contents — and every preview goes through `guardExternalText`, since an
event title in it is still somebody else's writing.

Two rules follow, and both belong in the prompt. Where the history records something, say it
plainly. Where it records nothing, the honest answer is still that you did not look.

`CalendarOutcome` gains fields over time. Add them with `.default(...)`: a stored row is read
back with `safeParse` and dropped on failure, so a bare required addition silently erases
every outcome written before it — reintroducing the exact amnesia the history exists to fix.

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
- A gate a generated plan can omit is not a gate. Unconditional checks belong in the
  executor, not in a plan step.
- Where a model must be involved, let it *recognize* and let code *decide*. The veto layer
  may narrow what the model proposed; it may never widen it.
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

### Response voice

Zeus speaks as I. The failure this replaced was a reply that narrated its own internals in
the third person — “Zeus did not look at your calendar” — which is what an audit log sounds
like, not a person who knows you.

- `SYSTEM_PROMPT` in `src/core/chat.ts` owns the voice. Prohibitions are necessary but they
  are not free: a prompt that is nine parts *never* and one part *how to write* produces
  careful institutional prose. Keep the voice and conversation paragraphs at the top, and
  when you add a constraint, add it as a constraint rather than as another sentence of
  scripted output.
- `text: { verbosity: "low" }` is the length dial. `reasoning: { effort: "high" }` is not —
  the calendar and effect gates depend on that reasoning, so lower the output, not the
  thinking.
- The chat renders plain text: blank lines become paragraphs via `AssistantProse`, and
  there is no Markdown parser. If you relax the no-Markdown rule in the prompt, ship a
  renderer in the same change or users will read literal asterisks.
- The reply is the whole surface. The calendar, work-plan and follow-through panels that
  used to sit under an assistant turn are gone; the prose now says the particulars —
  what changed or didn't, which event collided, which times are free, what is needed next.
  Do not reintroduce a panel to carry them.
- Removing the panel did not remove the record, and must not. `calendar_outcome` is still
  written for every recognized calendar request, still deterministic, and is now also
  *supplied to the model*, which is what stops the prose drifting from what happened. The
  audit surfaces — `/effects/[id]`, `/today#work-plans`, the receipt log — are unchanged. If
  you add a new outcome shape, the model has to be told about it in `renderCalendarResult`;
  there is no longer a card that would have rendered it for free.
- Fixed user-facing copy speaks in the first person. `src/components/calendar-card-copy.ts`
  went with the cards, and `styleViolations` (`src/core/response-style.ts`) currently has no
  production consumer as a result. If you add fixed copy back, put it in a module a test can
  sweep rather than inline in a component, and point the sweep at it.
- The `<capabilities>` block is the deliberate exception and stays third person: it rides
  inside a user-role message, where “I” would read as the user. The prompt asks for it to
  be relayed as I.
- Text placed in the composer on the user's behalf must read like something they would
  type. It carries no standing safety disclaimer — `authorizeWorkPlan` and `confirmEffect`
  gate external action regardless, and a compliance paragraph attributed to the user
  misrepresents them. `confirmationSentence` in `src/core/effects.ts` is the exception,
  because that exact string is evidence — and with no Confirm button left, it is the only
  way a change gets authorized from chat.
- Nothing in `npm run check` can judge model prose, and there is no longer a deterministic
  panel behind it. Tests pin the blocks the model is given and the rules it is given about
  them; whether it writes a sentence a person wants to read still needs a real conversation.

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
