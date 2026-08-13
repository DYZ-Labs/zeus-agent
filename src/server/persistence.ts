import "server-only";

import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { AuthConfiguration } from "@/server/auth/config";

/**
 * A hosted deployment must prove its store is on persistent storage before it serves
 * anyone.
 *
 * `defaultDbPath()` resolves to `~/.zeus/zeus.db`, which on a container platform lives
 * in the image layer and is discarded on every deploy. `openDb()` then creates the
 * file, runs every migration, and serves a perfectly healthy *empty* memory — the user
 * simply finds their history gone, with nothing logged anywhere. That silence is the
 * whole problem, so this converts it into a refusal to start.
 *
 * Scoped to a production serve in configured mode. `next dev` is skipped because a
 * developer's `~/.zeus/zeus.db` is the durable store, not an artifact of a container —
 * the default path is only dangerous where the filesystem is disposable. Local and
 * misconfigured modes are untouched for the same reason.
 */
export function assertPersistentStoreConfigured(
  configuration: AuthConfiguration,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (configuration.mode !== "configured") return;
  if (environment.NODE_ENV !== "production") return;

  const configured = environment.ZEUS_DB?.trim();
  if (!configured) {
    throw new PersistentStoreError(
      "ZEUS_DB is not set. A hosted Zeus deployment must point ZEUS_DB at a file on a " +
        "mounted volume. The default ~/.zeus/zeus.db is inside the container " +
        "filesystem and is discarded on every deploy, which would silently replace " +
        "every account's memory with an empty store.",
    );
  }
  if (configured === ":memory:") {
    throw new PersistentStoreError(
      "ZEUS_DB is :memory:. A hosted deployment would lose every account's memory on " +
        "restart.",
    );
  }
  if (!isAbsolute(configured)) {
    throw new PersistentStoreError(
      `ZEUS_DB must be an absolute path on the mounted volume; received "${configured}".`,
    );
  }

  // openDb() would `mkdir -p` this directory. On a container that quietly manufactures
  // a directory on ephemeral storage whenever the volume failed to mount — the exact
  // silent-loss path. Requiring the mount point to already exist catches it here.
  const directory = dirname(configured);
  let entry;
  try {
    entry = statSync(directory);
  } catch {
    throw new PersistentStoreError(
      `The ZEUS_DB directory ${directory} does not exist. Zeus will not create it: on a ` +
        "hosted deployment a missing directory usually means the persistent volume is " +
        "not mounted, and creating it would put every account's memory on storage that " +
        "disappears at the next deploy. Mount the volume at this path, then restart.",
    );
  }
  if (!entry.isDirectory()) {
    throw new PersistentStoreError(
      `The ZEUS_DB parent path ${directory} is not a directory.`,
    );
  }
  try {
    accessSync(directory, constants.W_OK);
  } catch {
    throw new PersistentStoreError(
      `The ZEUS_DB directory ${directory} is not writable by this process. Zeus cannot ` +
        "persist memory, WAL files, or migration backups there.",
    );
  }
}

export class PersistentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistentStoreError";
  }
}
