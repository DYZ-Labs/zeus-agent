# Roadmap

Zeus's purpose is to help one person make meaningful progress on what they genuinely care
about — understanding their preferences, planning the steps, and taking useful actions on
their behalf, with their permission and oversight. The test case is a trip: compare
options, build an itinerary, check the calendar, draft the booking, flag the conflict.

This file records what is built, what is next, and why in that order. It is a plan, not a
promise; the reasoning matters more than the sequence, because the reasoning is what should
survive when the sequence changes.

Persistent open-loop state, explicit priority and next-step retrieval, and completion plus
verification of user-initiated workflows are product requirements. Unsolicited
follow-through is an optional, explicitly enabled capability; expanding or shipping it is
not a phase gate.

Invariants that constrain every phase live in [AGENTS.md](AGENTS.md). Nothing here
overrides them.

---

## Phase 1 — See and act, with confirmation · **shipped**

Landed in [#18](https://github.com/DYZ-Labs/zeus-agent/pull/18).

Zeus is an MCP client. It can read a connected calendar, notice conflicts in it
deterministically, and prepare changes to it — and it cannot change anything without a
message from the user naming the exact payload hash.

What that phase established, which everything after it depends on:

- **Two gates.** Authorizing a plan approves a scope; confirming approves a payload. A
  write step materializes the exact request and pauses rather than calling out.
- **No third-party credentials.** Connectors store commands, arguments, URLs, and the
  *names* of environment variables. There is nowhere to put a value.
- **Capability slots.** A slot fixes its effect kind, so reviewing the granted slots is
  enough to understand everything a connector may do. Remote schema drift withdraws the
  grant.
- **`external_read` is its own effect kind.** The effect kind is the unit of
  authorization, so web research cannot reach a calendar.
- **Detectors.** Four deterministic rules, no model call, delivered through the existing
  opportunity pipeline so every interruption gate applies unchanged.
- **External data is never evidence.** Calendar text can inform a plan and can never
  become memory.
- **`connector_call` vs `effect_proposal`.** The receipt log answers "did anything happen
  out there?" as a query rather than an interpretation.

---

## Phase 2 — Standing grants and `send`

**Why now.** Confirming every action forever is not stewardship; it moves the work rather
than doing it. But a standing grant should be built from evidence of what the user actually
confirms repeatedly, and Phase 1 is what produces that evidence. Building this first would
have meant guessing.

**Standing grants.** A `standing_effect_grant` bound to a capability, a narrow predicate, an
expiry, and a maximum number of uses. Revocable at any time. Every use still writes a
receipt and still appears in the Today control readout — a grant removes the interruption,
never the record. The fail-safe direction is expiry: a grant nobody renews simply stops.

Design constraints worth stating before anyone writes code:

- A grant is not a mode. It names one capability and one narrow predicate — "accept invites
  from my team", not "manage my calendar".
- A grant may never be inferred. It is proposed, reviewed, and accepted explicitly, the same
  way a `machine_effect` facet is.
- Reaching the use limit or the expiry returns to per-action confirmation silently. Zeus
  does not ask to renew at the moment it wants permission.

**`send`.** Email or messaging behind a recipient allowlist, drafted then confirmed. This is
a harder bar than `schedule` for one reason: **a sent message cannot be taken back.** Zeus
offers no undo for a calendar change either, but a calendar change can be reversed by asking
— a new request through the same gates — and a sent message cannot be. That asymmetry is
with *asking*, and it should shape the UI rather than be papered over: the confirmation for
a send has to read differently from the confirmation for a hold.

**Open question.** Whether standing grants should apply to `send` at all in this phase, or
only to `schedule` and `modify_external` until there is a year of evidence. The
conservative answer is probably right.

**Amended.** A mode shipped before narrow grants did, at the user's explicit direction, and
it is scoped to calendar create, reschedule, and cancel. That contradicts the design
constraint two paragraphs above — "a grant is not a mode" — so it is worth being exact about
what made it defensible, because the reasoning does not transfer.

It was not the grant machinery. It was the conflict gate. The mode only ever covers an
action Zeus verified against a calendar it had just read: a collision, a stale or
unreadable calendar, or a target matching more than one event all still stop and ask, and a
daily ceiling bounds how wrong a misclassification can go before it stops on its own. The
check replaced the interruption; nothing replaced the record.

That argument is unavailable for `send`. There is no equivalent of "is this slot free" for a
message, and no equivalent of cancelling the event afterwards. The narrow-predicate
`standing_effect_grant` remains the right shape there. A mode is a ceiling-and-check design;
a grant is a scope design. They are not substitutes, and this one should not be read as a
precedent for the other.

---

## Phase 3 — Real multi-step workflows

**Why after Phase 2.** Broad autonomy is only safe once the gate and the receipts exist,
and they now do.

**The calendar half landed early.** The three calendar regexes are gone, replaced by a
recall-safe keyword skip, a low-effort structured classifier, and a deterministic veto that
can only ever downgrade what the classifier proposed. What that fixed was not the plan loop
but the front door: "I need to get dinner with Sam on the calendar" produced a sentence
rather than an event, because the regex required a leading create verb. Recognition turned
out to be the model's job and permission code's — the same split as `extract` →
`applyExtraction`.

Two things fell out of doing it. Once the payload is built deterministically from a resolved
intent, no model stands between the request and the bytes, and the whole write path became
testable offline. And once a write reads the calendar first, the prior state is sitting in
the read cache, so the receipt can say what an event was before Zeus changed it.

**The non-calendar front door has landed.** `isExplicitBoundedWorkRequest` is gone. Chat now
creates an immutable proposal, renders its exact steps, effects, completion criteria, and
limits, and waits for a separate approval-and-run message naming that plan's hash. A stale,
wrong, quoted, or replayed approval starts nothing, and generic plans cannot claim connector
effects that belong behind the code-owned Calendar gates. Proposals persist across sessions
until the user approves or declines them. The asymmetry remains deliberate: a research plan
has no equivalent of a conflict check, so its approval stays explicit rather than being
replaced by verification.

Still in scope:

- The trip scenario end to end: compare options, build an itinerary, hold the slots, alert
  to conflicts.

---

## Phase 4 — Preferences that steer action

Today an accepted `machine_effect` facet reaches exactly one place: follow-through
recommendation ranking (`machineEffectFor`, `src/core/stewardship.ts`). It can boost,
deprioritize, or block *what Zeus raises*. It cannot shape *what Zeus does*.

That existing path may remain, but expanding proactive surfacing is not required by this
phase.

Extend accepted facets so they deterministically constrain plan shape and payload defaults
— "never schedule me before 9am", "always leave 30 minutes after a flight" — as policy
rather than as prompt text a model may or may not honour.

Separately: promote repeated confirmed patterns into **proposed** standing grants, reusing
the `behavioral_policy_suggestion` machinery. Note the deliberate obstacle — that machinery
today may only ever *reduce* interruptions (`allowed_interruption_change` is `none` or
`suppress_only`, enforced by a CHECK). Widening it so a suggestion can propose *more*
autonomy is a real decision with a real risk, and it should be made explicitly rather than
discovered as a side effect of implementing this phase.

---

## Phase 5 — `purchase`

Deliberately last, and possibly never.

Money is irreversible in a way a calendar is not, and it has its own threat model. Today
`purchase` is refused unconditionally: no slot produces it, `assertAuthorizableEffects`
rejects it by name, and the storage layer will not record a receipt for it. Undoing that
should require a stronger reason than "the enum has the value".

---

## Carried forward from Phase 1

Things the live verification taught that later phases should assume rather than rediscover.

**A model will lowball its own limits.** It proposed three steps and budgeted three calls
when the steps need six, producing a plan that died on its last step — the one that would
have asked the user to confirm. Generation now raises a lowballed ceiling and creation
refuses a plan that cannot cover its own steps. Any future generated artifact with
self-declared limits needs the same treatment.

**Payload validation is shallow.** It checks required fields and rejects invented ones, but
it is not a JSON Schema validator — that would be a new dependency for a check the remote
service performs authoritatively anyway. A `send` capability with a complex schema may
change that calculation. Revisit in Phase 2, not before.

**Undo was built, shipped, and then removed. Do not rebuild it.** The machinery worked: a
created event could be cancelled because the service returns an id, and an update was
reversible as a side effect of reading the calendar first, with `prior_state_json` holding
what the cache knew before anything changed.

What it could never be was honest about its own limits. The reversal restored only the
fields Zeus itself set, and only from the five the cache holds — attendees, description,
recurrence, reminders, and conferencing were never read and were never restored, and
un-cancelling does not recall the notices already sent. A partial undo offered as a button
labelled "Undo" is a promise the code cannot keep, and it earned a card under every completed
change to hold it.

Reversing a change is now a request the user makes, in their own words, through the same
gates as the change itself. That is slower and it is truthful, and it costs nothing to build.
`prior_state_json` survives for the reason that always justified it: the receipt can say what
an event was before Zeus touched it. Assume no undo for any future capability, and do not
add one back for `send`.

**Steps that span a confirmation need explicit settlement.** A resumed run re-enters a
paused write step, and without a settled-effect check it re-proposes forever. Any future
effect kind that pauses must answer "what does resume do?" before it ships.

**Tests with generous limits hide real failures.** Every bug above survived a passing suite
and died on first contact with a real MCP server and a real model. New capabilities should
be exercised against a real server before they are called done.
