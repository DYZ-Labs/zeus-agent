# Hosted foundation (not launch-ready)

The existing SQLite runtime remains the local, single-owner edition. Nothing in
this directory routes public or multi-user traffic to SQLite, and the hosted
store is not wired into the application yet.

The first hosted migration is
[`supabase/migrations/202608120001_consumer_v1.sql`](../../supabase/migrations/202608120001_consumer_v1.sql).
It creates the consumer-v1 domains with UUID resources, a non-null `user_id` on
every private row, same-tenant composite foreign keys, exact 384-dimensional
pgvector storage, per-user `tsvector` search, and forced RLS policies whose only
tenant source is `auth.uid()`. The built-in predicate registry is the sole
unowned application table. There is intentionally no approximate vector index;
initial retrieval must filter the tenant before an exact cosine scan and fall
back to full-text/graph retrieval when embeddings are unavailable.

Application and worker connections must use `zeus_app` and `zeus_worker`. Both
roles are explicitly `NOBYPASSRLS`. Provision a login role as a member outside
the migration, then enter one of these roles only through
`TenantTransactionRunner`. Never use the Supabase `service_role`, a superuser,
or a `BYPASSRLS` role for application queries. Each transaction verifies a
server-side Supabase Auth user first, sets a local JWT claim from that verified
session, and checks the resulting database tenant before exposing SQL to an
adapter. Request bodies never select a tenant. Workers need an equivalently
verified, user-scoped signed job capability; a queued raw `user_id` is not
sufficient authority.

Adapter insert statements must obtain ownership inside SQL with
`zeus_private.require_verified_tenant()`; they must not bind a `user_id` from a
DTO. A worker must lock the tenant's conversation row `FOR UPDATE` before it
claims, extracts, and applies a memory job so jobs are serialized per
conversation. The `(user_id, source_message_id, prompt_version)` uniqueness
constraint is the independent idempotency boundary.

Run the migration and destructive isolation gate only against a fresh, disposable
Supabase/Postgres database. The explicit acknowledgement prevents an accidental run
against ordinary data:

```bash
HOSTED_TEST_DATABASE_URL="..." \
ZEUS_ALLOW_DESTRUCTIVE_HOSTED_TESTS=1 \
npm run check:hosted
```

The suite rolls back its fixtures and tests forced-RLS coverage, composite
ownership, guessed IDs, cross-tenant inserts/updates/deletes, response traces,
memory jobs and realtime-readable activity, export scope, and erasure requests.

Public beta remains blocked in code by `hostedLaunchReadiness()`. Before changing
that gate, concrete async adapters must be ported in this order: conversations
and response traces; facts, candidates, facets, and passages; intentions and
stewardship; then Labs. Each adapter must pass the same trust-policy corpus as
SQLite plus Postgres integration, temporary-chat zero-I/O, two-user isolation,
export/erasure, CSRF, account/IP rate-limit, backup-deletion, and end-to-end
tests. The app and extraction worker should then ship as separate containerized
Node services, both using the same non-bypass tenant transaction boundary.
