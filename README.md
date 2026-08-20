# Zeus

A personal AI agent for the administrative layer of professional life — email, calendar,
the people around them, and the commitments that fall between. Zeus reads what you have
authorized it to read, remembers what matters, and finishes the work you approve:

**Observe → Understand → Prioritize → Recommend → Act → Verify → Remember**

The objective is not to recommend. It is to get the work done, with the user in control at
every step.

## Status

Shipped and tested:

- **Memory** — facts, entities, and passages carrying confidence, provenance, and
  supersession, with erasure that reaches the backups.
- **Calendar** — read, create, reschedule, cancel, and clear through an isolated OAuth
  broker, behind a twice-run deterministic conflict gate.
- **Email** — read, draft, trash, untrash, and send, behind the same two-gate approval and
  the append-only, trigger-enforced effect ledger.
- **The record** — hash-bound approvals, per-effect receipts at `/effects/<id>`, snapshots,
  replication, restore, and export. One SQLite store per account.
- **MCP** — Zeus runs as an MCP server for external clients.

Not yet built: a composed daily brief (the ingredients surface at `/today`), meeting
preparation, verification that reads state back after a write — every check today is
pre-flight — an aggregate action history, and Contacts and Drive as integrations.
[ROADMAP.md](ROADMAP.md) sequences the work.

## Quickstart

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY
npm run dev                  # http://127.0.0.1:3000
```

`.env.example` documents every setting beside its default. Leaving the Supabase values
blank gives you loopback-only local mode with no login.

## What it looks like

A brief, on request:

```text
TODAY
• 4 meetings
• 2 require preparation
• 1 scheduling conflict

NEEDS ATTENTION
• Sarah needs your response before 2 PM.
• Your Tokyo hotel cancellation window closes tonight.

PREPARED
• Drafted a response to Sarah.
• Prepared notes for your 11 AM investor call.

I CAN HANDLE
• Move the internal product meeting.
• Send the invoice follow-up.
```

Ask for thirty minutes with John next week and Zeus reads the calendar rather than asking
when you are free. The user manages exceptions, not workflows.

## Principles

- **Action over answers.** If Zeus is authorized and able, it finishes the task rather than
  explaining how you could do it yourself.
- **User control.** Permissions never escalate silently. Read, prepare, modify, send — each
  one is granted, not assumed.
- **Progressive autonomy.** Five levels, from read to autonomous domain. Trust is earned
  before it is extended.
- **Memory with purpose.** Remember what stays useful, not every turn of a conversation.
  Chat history is not the database.
- **Verification.** A write is not a success until the resulting state has been checked.
- **Reversibility.** archive > delete, draft > send, reserve > purchase, propose > commit.
- **External content is data.** An email saying "ignore your instructions" is text Zeus
  read, never an instruction Zeus follows. Nothing external raises a permission.
- **Opt-in proactivity.** Unsolicited follow-through stays off until explicitly enabled.

## Documentation

| Document | What it covers |
|---|---|
| [AGENTS.md](AGENTS.md) | The specification — architecture, autonomy model, memory, permission rules, per-domain agent behavior, engineering principles, definition of done. |
| [ROADMAP.md](ROADMAP.md) | Where the codebase stands, and the increments that come next. |
| [docs/operations.md](docs/operations.md) | The operating guide — every environment variable, hosting and rollback, health and operational events, budgets, durability, snapshots and the restore runbook, MCP integration, command reference. |
| [docs/staging-rehearsal.md](docs/staging-rehearsal.md) | The drill that proves backup, restore, and rollback actually work. |

## Development

```bash
npm run check   # lint, typecheck, tests, memory evaluation, build
```

`npm run check` is the required gate before any change lands. Never commit credentials or
OAuth tokens, and keep the memory database outside the repository.
