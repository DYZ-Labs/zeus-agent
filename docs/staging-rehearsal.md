# Staging rehearsal

The recovery procedures in [README.md](../README.md) were written by reading the code. Until
someone runs them, the recovery time is a guess and every step is a hypothesis. This is the
script for turning them into measured facts.

**Run it once before the first real account joins, and again after any change to migrations,
snapshots, restore, or the deploy configuration.** It takes an afternoon.

The point is not to collect ticks. It is to find the runbook wrong while that is cheap. A
rehearsal where nothing surprises you usually means a step was skipped or quietly adapted —
if you find yourself improvising a command that is not written here, that improvisation *is*
the finding. Write it down.

## Before you start

- [ ] **Use a staging Railway service with its own volume.** Never point any step at the
      volume serving real accounts, and never at `~/.zeus/zeus.db` on your workstation.
- [ ] Confirm the staging service has its own `ZEUS_DB`, its own Supabase project (or none),
      and its own snapshot directory. `echo $ZEUS_DB` inside the container before anything else.
- [ ] Give staging at least two stores: the primary plus one `accounts/<uuid>.db`. A
      single-store rehearsal proves almost nothing, because every interesting failure in this
      system is about the *account* stores.
- [ ] Put a few recognisable conversations in each store, and note something specific from
      each — a fact, a conversation title. That is how you will tell a real restore from a
      plausible-looking empty one.
- [ ] Have a second terminal ready. Several steps need the server running in one while you
      work in the other.

Record the staging store paths here, because half the commands below need them exact:

| | Path |
|---|---|
| Primary store (`ZEUS_DB`) | |
| Account store under test | |
| Snapshot directory | |

## A. An off-box copy actually leaves the box

Closes the gap that remains after the code shipped: `ZEUS_SNAPSHOT_REPLICA_COMMAND` unset means
`replicateSnapshot` returns `not_configured` and does nothing at all.

- [ ] Set `ZEUS_SNAPSHOT_REPLICA_COMMAND` on the staging service, pointing at whatever you
      intend to use in production. Start with something trivial and observable if you like —
      `/bin/cp -v` writing to a second location proves the plumbing before restic proves the
      policy.
- [ ] Restart, then check the endpoint reports it: `curl -s $STAGING/api/health | jq .replication`
      → expect `"state": "configured"`.
- [ ] Force a snapshot rather than waiting for the timer: `npm run snapshot`
- [ ] Confirm the copy exists **at the far end**, not just locally. Listing the local
      `snapshots/` directory proves nothing about replication.
- [ ] `curl -s $STAGING/api/health | jq .replication` → `"lastResult": "ok"` with a recent
      `lastAttemptAt`.
- [ ] **Now break it on purpose.** Point the command at a path that does not exist, snapshot
      again, and confirm two things: `lastResult` becomes `"failed"` with a `lastReason`, and
      the snapshot itself still succeeded. A failed copy must never turn a good backup into a
      failed one.
- [ ] Restore the working command.

> Failure looks like: `state: "not_configured"` after a restart (the variable is not reaching
> the process), or `lastResult` staying `null` (the scheduler never ran — check
> `snapshots.state` is `running`).

## B. The monitor actually fires

Right now the health workflow runs every 15 minutes and skips, because `ZEUS_HEALTH_URL` is
unset. A green run currently means nothing was checked.

- [ ] Set the `ZEUS_HEALTH_URL` repository secret to the **staging** health endpoint for the
      duration of this rehearsal.
- [ ] Trigger it by hand: `gh workflow run health.yml`, then `gh run watch`.
- [ ] Confirm the log says it probed — not `ZEUS_HEALTH_URL is not set; skipping`.
- [ ] **Make it go red.** Stop the staging service, run the workflow again, and confirm it
      fails. A monitor nobody has seen fail is not a monitor.
- [ ] With the service back up, set `ZEUS_SNAPSHOT_SCHEDULER=off`, restart, and run the
      workflow again. Confirm it fails on the scheduler state, not just on reachability —
      this is the case the whole payload check exists for.
- [ ] Re-point the secret at production when you are done, and note that you did.

## C. Restoring one account store

This exercises the fix that made hosted backups findable at all. It also contains the trap most
likely to catch you at 3am.

> **`ZEUS_DB` must name the *primary* store during a recovery, even when you are recovering an
> account store.** Every store's copies live in one directory beside the primary one, and
> `restore` derives that directory from `ZEUS_DB`. Point `ZEUS_DB` at the account store you are
> recovering and it will look in `accounts/snapshots`, find nothing, and tell you a hosted user
> has no backups — at the exact moment that report is least survivable. `--db` names the target;
> `ZEUS_DB` names the deployment.

- [ ] With `ZEUS_DB` set to the **primary** store, list what exists for the account store:
      ```bash
      npm run restore -- --db /path/to/accounts/<uuid>.db --list
      ```
      Expect at least one verified snapshot, oldest first. **Empty output here is a stop-the-line
      finding** — it is exactly the symptom the snapshot-directory fix was meant to remove.
- [ ] Dry run it (no `--yes`). This verifies the copy rather than merely finding it, so a
      dry run that passes is evidence the snapshot is genuinely restorable:
      ```bash
      npm run restore -- --db /path/to/accounts/<uuid>.db --latest
      ```
- [ ] Now damage the account store deliberately — truncate it, or delete a conversation
      through the UI and note what you removed.
- [ ] Stop the web server, the MCP server, and any scheduled job. **Start the clock.**
- [ ] Restore for real:
      ```bash
      npm run restore -- --db /path/to/accounts/<uuid>.db --latest --yes
      ```
- [ ] Bring the server back up. **Stop the clock** and record the elapsed time.
- [ ] Log in as that account and confirm the specific thing you noted at the start is back,
      and that the *other* account is untouched.
- [ ] Confirm the replaced store was preserved as `<target>.pre-restore-<label>`, then remove it
      deliberately rather than leaving it to fill the volume.

## D. The live-writer guard, under a server that is merely idle

**This one is expected to fail.** The guard takes a `BEGIN IMMEDIATE` with a 250ms timeout, which
detects a writer holding a write transaction *at that instant* — not a server that is running but
idle between requests, which is the normal state of a deployment. The README says restore "refuses
to proceed if a writer is still attached", which is stronger than what the check does.

Rehearse it to find out how bad it is in practice, because the answer determines whether step C
above is safe to hand to someone who has not read the code.

- [ ] Start the staging server and leave it idle — no requests in flight.
- [ ] From the second terminal, attempt a restore with `--yes` against a store that server has
      open.
- [ ] Record which happened:
      - **Refused** with *"Another process is writing to … Stop the Zeus web server"* — the guard
        held. Good, and worth knowing.
      - **Proceeded** — the guard is as weak as predicted. Do not stop here: send a request to the
        running server afterwards and see where the write lands. Its cached handle still points at
        the *preserved* inode, so writes after the restore go into a file nobody will read again.
- [ ] If it proceeded, treat "stop the service first" as a hard manual precondition in every
      recovery procedure until the guard is replaced by an explicit lease, and say so in the
      README rather than relying on a check that does not check.

## E. Rolling back past a migration

The most important rehearsal, and the one nobody does until they need it. The ledger check refuses
a build older than the store, so the reflex — Railway's Rollback button — produces a deployment
that fails its own health check and never activates, on a service that keeps no previous container
serving.

- [ ] Confirm the trap is real before trusting the workaround. On staging, deploy a build
      containing a new migration, let it apply, then use Railway's **Rollback** to the previous
      deployment.
- [ ] Confirm it fails the health check and does not activate, and that the service is now
      **down** rather than serving the old version. Record what the logs actually say — an
      operator in an incident needs to recognise this from the log alone.
- [ ] Now run the documented recovery:
      1. Set the service start command to `sleep infinity` and redeploy. **Start the clock.**
      2. `railway ssh` into the container. Confirm the volume is mounted and `ZEUS_DB` is
         readable with no Zeus process attached.
      3. Restore each store from its `*.pre-migration-*` copy — the primary **and every**
         `accounts/<uuid>.db`. There is deliberately no restore-everything flag; name each one.
      4. Restore the original start command and deploy the older image. **Stop the clock.**
- [ ] Confirm the service comes up on the older build and serves real data for both accounts.
- [ ] Record the elapsed time. This is your true RTO for a bad release, and it is almost
      certainly longer than anyone assumes.
- [ ] Note every place the written procedure did not match reality — a missing flag, a step that
      needed sudo, a path that differed, a `railway` subcommand that has changed. Fix the README
      in the same sitting, while you still remember.

## What you now know

Fill this in at the end. It is the whole output of the exercise.

| Measure | Result |
|---|---|
| Restore one account store (C) | ___ min |
| Full rollback past a migration (E) | ___ min |
| Live-writer guard held? (D) | refused / proceeded |
| Off-box copy verified at the far end? (A) | yes / no |
| Monitor observed failing? (B) | yes / no |
| Steps where the runbook was wrong | |
| Fixes made to the README as a result | |

Two rules for what follows:

**Any step that surprised you is a bug, not a lesson.** Fix the procedure, the code, or both,
in the same sitting. A rehearsal whose findings live only in someone's memory has produced
nothing.

**Any step you improvised is missing from the runbook.** Add it. The person running this next
will not have your context, and may be you at 3am.

## Cleanup

- [ ] Re-point `ZEUS_HEALTH_URL` at production.
- [ ] Remove any `*.pre-restore-*` and `*.pre-migration-*` copies left on the staging volume.
- [ ] Reset `ZEUS_SNAPSHOT_SCHEDULER` and `ZEUS_SNAPSHOT_REPLICA_COMMAND` on staging to whatever
      you want them to be between rehearsals.
- [ ] Confirm production was untouched throughout: its health endpoint, its snapshot
      `lastRunAt`, and its account count.
