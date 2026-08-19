# Roadmap

Zeus's purpose is defined in [README.md](README.md): a personal AI agent for busy
professionals that understands what matters, remembers what matters, and handles what does
not require their attention. The MVP is an agent for **email + calendar** — triage,
summaries, drafting, scheduling, meeting preparation, a daily brief on request, persistent
open-loop state, approval-before-action, and verification — with proactivity strictly
opt-in.

This file supersedes the previous roadmap (git history retains it), written after its
Phase 1 shipped calendar end to end and the product goals were rewritten. Its principle
survives unchanged: this is a plan, not a promise, and the reasoning matters more than the
sequence, because the reasoning is what should survive when the sequence changes.

Invariants that constrain every increment live in [AGENTS.md](AGENTS.md). Nothing here
overrides them.

---

## Invariants carried forward

Lessons the calendar work paid for. Later increments assume them rather than rediscover
them.

- **Two gates.** Authorizing a plan approves a scope (a hash over exact steps, effects,
  and limits). Confirming approves a payload (a hash over the exact request). Neither
  substitutes for the other.
- **Connector rows never hold credential values.** Commands, URLs, and the *names* of
  environment variables only. First-party OAuth tokens live in the isolated broker
  service, encrypted, never in an account database.
- **External data is never memory evidence.** Calendar and email content can inform a
  plan, a brief, or a signal — and can never become a fact, a facet, or a candidate.
- **No undo.** It was built, shipped, and removed: a partial reversal offered as "Undo" is
  a promise the code cannot keep. Reversal is a new request, in the user's words, through
  the same gates. Do not rebuild it for any capability.
- **A grant is not a mode.** The calendar direct-execution mode is defensible only because
  a deterministic conflict gate verifies every action against a freshly read calendar and
  a daily ceiling bounds a misclassification. That argument does not transfer to
  capabilities without an equivalent check.
- **Steps that span a confirmation need explicit settlement.** A resumed run re-enters a
  paused write step; without a settled-effect check it re-proposes forever.
- **Models lowball their own limits.** Any generated artifact with self-declared ceilings
  needs a raise-and-refuse pass at creation.
- **Tests with generous limits hide real failures.** Every capability is exercised against
  a real server and a real model before it is called done.
- **`purchase` stays refused unconditionally.** Undoing that requires a stronger reason
  than the enum having the value.

---

## Where the codebase stands

Shipped and tested: the memory system (facts, entities, facets, passages, review
candidates — with confidence, provenance, supersession, and erasure that reaches
backups); calendar read/create/reschedule/cancel/clear through an isolated OAuth broker
with a twice-run deterministic conflict gate; the two-gate work-plan and effect machinery
with append-only, trigger-enforced ledgers and receipts; multi-account isolation with one
SQLite store per account; snapshots, replication, restore, and export; Zeus as an MCP
server for external clients.

All of it is shaped around a single capability domain. Against the MVP list in README.md:

| MVP requirement | State |
|---|---|
| Authentication, calendar, scheduling, availability | Shipped |
| Preference memory, task extraction, open-loop persistence | Shipped |
| Priority and next-step retrieval on request | Shipped (`src/core/stewardship.ts`) |
| Approval workflows | Shipped, strong (hash-bound, ledgered) |
| Gmail; inbox triage; email summarization; email drafting | Absent — no email code exists |
| Daily brief on request | Absent — ingredients exist, no composition |
| Meeting preparation | Absent — ingredients exist, no assembly |
| Verification of writes | Absent — all checks are pre-flight; nothing reads back |
| Action history | Partial — per-effect receipt pages, no aggregate view |
| Contacts | Absent as an integration (internal entity graph exists) |
| Opt-in proactivity | Misaligned — in-chat follow-through defaults on |

---

## Increment 1 — Email read foundation, the brief, meeting prep

**Why now.** Every remaining MVP absence traces to the same root: Zeus cannot see email.
Triage, thread summaries, the brief's needs-attention section, and half of meeting prep
all begin with reading the inbox. Read-only first, because reads need no per-use
confirmation (connecting the service is the consent), because email is the most
adversarial text Zeus will ever ingest and the guarding should be proven before any email
write exists, and because Gmail's write scopes raise the OAuth verification stakes.

### Alignment first

Small, independent changes that land before the capability, each its own PR:

- **Proactivity becomes opt-in.** A migration moves `stewardship_setting.mode` from
  `balanced` to `off` where no user message chose the mode; `buildContext`
  (`src/core/context.ts`) stops evaluating an opportunity on every ordinary turn. Safe
  because explicit triggers already bypass `off` — `/today`, MCP, and explicit chat
  phrases keep answering "what should I do next" — so the MVP's explicit-retrieval
  contract is untouched. Matches README "Opt-in proactivity" and AGENTS.md §18.
- **The injection surface gets its tests.** `src/core/untrusted-data.ts` currently has no
  direct coverage. Unit tests for the classifier and guard, plus scenario tests proving an
  injection-titled calendar event renders withheld end to end. These land *before* the
  first Gmail connect.
- **Operations documentation returns.** The pre-rewrite README's operational sections
  (hosting, configuration, health, budgets, durability, recovery, commands) are restored
  as `docs/operations.md` (`git show '531e527~1:README.md'`), the dangling references in
  `docs/staging-rehearsal.md` are repointed, and README gains a one-line pointer.
- **Classifier timeout becomes honest.** A strongly action-shaped calendar request whose
  intent classification times out gets a spoken "couldn't work that out just now" outcome
  instead of the current silent fallthrough (`src/core/chat.ts`).
- **`update_event` becomes idempotent.** Read-before-write in the broker
  (`src/calendar-broker/google.ts`): when the target already holds the requested state,
  return it without patching — the analogue of `create_event`'s derived event id.

### Gmail, read-only first

Google ships an official Gmail MCP server (`https://gmailmcp.googleapis.com/mcp/v1`,
Developer Preview at the time of writing — re-verify tools and status at implementation).
Its read tools (`search_threads`, `get_thread`) cover this increment, and it exposes **no
send tool** — drafts are its only write, which happens to match Zeus's reversibility
ladder exactly.

`gmail.readonly` is a Google *restricted* scope. Local single-account connections use the
user's own OAuth client through the Application Default Credentials pattern already used by
Calendar (`src/core/connector-catalog.ts`). Hosted accounts use an independently keyed,
per-user broker grant and a separate Gmail OAuth client; the broker exposes only
`search_threads` and `get_thread` even though Google's preview server advertises write tools.
External production users still require Google app verification plus a recurring security
assessment. An OAuth client left in "Testing" status also expires refresh tokens after seven
days — publish it or mark it Internal.

### The shape of the change

- **Slots.** `email.search_threads` and `email.get_thread`, both effect kind
  `external_read`, added to `CapabilitySlot` and `CAPABILITY_SLOT_EFFECTS`
  (`src/core/schema.ts`) and to the mirrored SQL CHECKs — a `connector_capability`
  rebuild, following the established rename→recreate→copy→drop precedents (migrations
  023, 026, 030). `external_signal` and `external_read_window` admit kind `email_thread`;
  a new `inbox_context` table is `schedule_context`'s twin, for the same answerability
  reason.
- **A trap to disarm in the same change.** `availableCapabilityForEffect`
  (`src/core/connectors.ts`) resolves capabilities by effect kind by iterating slots; the
  moment an email slot carries `external_read`, a generated plan's "read the calendar"
  could silently resolve to Gmail. The call sites in `src/core/work-execution.ts` and
  `src/core/work-plans.ts` get pinned to `calendar.list_events`; email reads run through
  their own deterministic paths, never through generated plan steps. Slot-addressed steps
  arrive in Increment 2 with the code-owned email plan builders.
- **Sync and context, on the calendar template.** `email-sync.ts` mirrors
  `calendar-sync.ts`: schema-driven fail-closed argument building, parse-then-cache in one
  transaction with window reconciliation and a read-window proof (a failed read must never
  look like an empty inbox), a 15-minute chat-facing TTL, and thread bodies that are
  fetched on request and never cached. `email-context.ts` renders a standing `<inbox>`
  block — **subjects and senders only, no snippets**; snippets and bodies are the
  highest-injection, highest-token text for the least standing value — and a `<thread>`
  block for on-request summaries. Everything third-party passes `guardExternalText`.
- **Chat wiring.** Turn start refreshes calendar and inbox caches in parallel under one
  deadline. Thread requests ("summarize the email from Sarah") parse deterministically
  against the cache — no model classifier in v1; ambiguity lists candidates rather than
  guessing. Summarization is a context block plus the one streaming call, **not** a work
  plan: a read needs no approval hop.
- **Detectors.** `email_unanswered` (inbound, direct-to-user, quiet past a threshold) and
  `email_commitment_adjacent` (a cached thread overlapping an open commitment) join the
  four deterministic detectors in `src/core/detectors.ts`, feeding the existing signal
  pipeline with reconciliation — a replied thread stops being raised. Their `why` text is
  guarded at composition.
- **The brief.** `brief.ts` composes deterministically, with no model call: today's
  schedule, needs-attention (email signals, overdue and due-soon commitments, open
  calendar signals), the top recommendation (an explicit trigger, so it works in mode
  `off`), and prepared items (pending effects, plans awaiting approval). Rendered as a
  `<brief>` block on trigger phrases in chat, on `/today`, and as a `zeus_brief` MCP
  tool. "What needs my attention" *is* the brief's attention section — one composition,
  two render depths, so triage and the brief can never disagree.
- **Meeting prep.** The calendar cache starts retaining attendee emails (today's parse
  drops them). `meeting-prep.ts` resolves an event deterministically ("prep me for my 11
  AM"; next meeting by default), folds attendees to entities via aliases, and assembles
  per-attendee facts, open commitments, related cached threads (subjects only), and open
  signals into a `<meeting_prep>` block and a `zeus_meeting_prep` MCP tool.

### Done means

The AGENTS.md §37 matrix per workflow (happy path, permission, missing context,
conflicting data, tool failure, duplicate execution, injection, timezone), plus the
real-account recipes: connect locally via ADC and through the hosted per-user broker; ask
for the inbox; send yourself an email titled
with an injection payload and watch it render withheld; kill the network and watch the
inbox degrade honestly; `npm run check` green. Email rows exist only in `external_signal`
and `inbox_context`, with no path into facts, candidates, or extraction — and no write
slot exists, so no email write is possible at all in this increment.

---

## Increment 2 — Drafts, then `send`

**Why after read.** Standing on a proven read path, drafting is low-risk: drafts are
`work_artifact` rows, local and reversible, produced by a code-owned plan builder with a
strict intent schema. `send` is the step change.

A sent message cannot be taken back. A calendar change can be reversed by asking; a sent
email cannot, and that asymmetry should shape the UI rather than be papered over: the
confirmation for a send has to read differently from the confirmation for a hold.

- New slot `email.send_message` → effect kind `send`, reachable only from code-owned
  builders — never from a generated plan.
- **Exact-confirmation only.** No standing-policy path, no mode: there is no equivalent of
  "is this slot free" for a message, so the calendar mode's ceiling-and-check reasoning
  does not transfer. A recipient allowlist is enforced deterministically at payload build
  and re-checked at execution.
- **Served by the broker, not the official server** (which has no send tool): extend the
  existing read-only Gmail broker path with a Gmail API client, and add
  provider-side idempotency by deriving the RFC 5322 Message-ID from the request key, the
  send analogue of the derived event id.
- Settlement generalizes: `settlePendingConfirmation` currently restores reachability for
  `calendar.list_events` by name; the slot derives from the pending effect's capability.
- **Public hosted Gmail remains an operational go/no-go**: the isolated OAuth path exists,
  while restricted-scope verification and CASA remain a funded launch decision.

---

## Increment 3 — Verification, and the action ledger made visible

The README's verification principle — a write is not done until the resulting state is
read back — is currently unimplemented; every check is pre-flight. After
`executeConfirmedEffect` succeeds, a bounded read-back through the matching read slot
(calendar: re-read the window and match the event; send: locate the Message-ID) records a
`verified` or `verification_failed` event in the effect ledger. Receipts and chat wording
distinguish executed-and-verified from executed-unconfirmed; an unverified write is
reported honestly, never retried blindly.

Alongside it, the aggregate action history the MVP asks for: an `/actions` page over
executed, failed, and declined effects — the data already exists in the ledgers; only the
view is missing.

---

## Increment 4 — One thread of work: tasks and relationships

Today "Sarah needs a response → drafted → sent → done" is split across three unjoined
ledgers: commitments (user-stated), detected signals (noticed), work plans (executable).
This increment widens `commitment.status` toward the nine states the product docs name
(a CHECK rebuild with a conservative mapping for existing rows), persists last and next
action on the commitment, and links commitments to the work plans and signals that
advance them.

Relationship intelligence rides the same change: the entity page grows rollups — open
commitments with that person, recent episodes, last interaction — and "what did I promise
James" becomes a first-class retrieval path rather than a lucky search hit.

---

## Increment 5 — Standing grants and the autonomy surface

The prior roadmap's design, unchanged in substance: a `standing_effect_grant` names one
capability and one narrow structured predicate, with an expiry and a maximum number of
uses, revocable at any time, proposed and accepted explicitly — never inferred, and
**never for `send`**. Every use writes a ledger event citing the accepting user message; a
grant removes the interruption, never the record. Expiry and exhaustion fall back to
per-action confirmation silently.

Settings grows an autonomy section that shows, in one place, the calendar mode, standing
grants, and (from Increment 3) verification outcomes — the visible, editable, revocable
surface the product docs require. Widening `behavioral_policy_suggestion` beyond
reduce-only interruption changes remains an explicit decision with its own review; the
CHECK constraint exists precisely so that widening cannot happen as a side effect.

---

## Increment 6 — Contacts and Drive

Google Contacts arrives as a read slot whose output becomes **entity candidates through
the existing review pipeline** — a contact record is external data, so the user's
acceptance, not the record, is the evidence. Drive arrives as a read slot serving meeting
prep ("relevant documents") and draft attachments. Both wait until the email loop proves
the multi-service patterns.

---

## Evals, throughout

Starting during Increment 1, a scenario eval joins `eval:memory` in `npm run check`:
deterministic fixtures per AGENTS.md §36 — scheduling (right person, hours, timezone, no
unconfirmed write), triage (right ranking, no send), prompt injection (summarized, no
tool call, no memory write), memory supersession. The real-account recipes become a
repeatable smoke checklist in the operations doc, run before any connector capability is
called done. Retrieval-quality queries ("what did I promise X") join once Increment 4
lands.

---

## Risks

- **Gmail restricted scopes.** Local ADC with the user's own client avoids verification.
  Hosted test users can use the isolated broker flow, but public external access still
  depends on Google verification and recurring CASA; testing-status tokens expire after
  seven days.
- **Preview-status endpoint drift.** The official Gmail MCP server may change contracts;
  schema-hash drift detection already withdraws a capability safely, and argument
  builders fail closed on schemas they do not understand.
- **Prompt growth.** `<inbox>`, `<brief>`, and `<meeting_prep>` land on an already
  monolithic system prompt. Caps hold the line (eight threads, subjects only, brief
  sections bounded; the brief replaces detail blocks rather than stacking on them), token
  deltas are measured, and restructuring the prompt is scheduled as its own change rather
  than smuggled into a capability.
- **Injection surface.** Email is adversarial by default. The standing block carries
  subjects and senders only; bodies appear only on request, guarded and bounded; the
  injection tests precede the first real connect; and the worst case in Increment 1 is a
  withheld line — never a tool call and never a memory write, because email has no write
  slot and external data is never evidence.
