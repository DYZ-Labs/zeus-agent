import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";

import { defaultDbPath } from "./db";

/**
 * Every Zeus store on this machine.
 *
 * A multi-account deployment keeps the primary store at `ZEUS_DB` and one isolated
 * database per account in a sibling `accounts/` directory. Operational tooling that
 * only ever opened `defaultDbPath()` therefore covered exactly one person: snapshots,
 * exports, and reindexing silently skipped everyone else. Enumerating stores is the
 * shared fix, so no future tool has to rediscover that the store is not singular.
 */
export const ACCOUNTS_DIRECTORY = "accounts";

/** Artifacts that live beside a store and must never be mistaken for one. */
const DERIVED_ARTIFACT = /(?:\.zeus-snapshot-|\.pre-migration-|\.tmp$|\.backup$)/u;

export type StoreKind = "primary" | "account";

export type StoreLocation = {
  path: string;
  kind: StoreKind;
  /** Account UUID for an account store; null for the primary store. */
  account: string | null;
};

/**
 * List the primary store and every account store beside it.
 *
 * Missing paths are omitted rather than invented: a deployment that has never had an
 * account simply reports one store. Symlinks are refused for the same reason the rest
 * of the store handling refuses them — a link is an instruction to write somewhere the
 * operator did not name.
 */
export function listStores(primaryPath: string = defaultDbPath()): StoreLocation[] {
  if (primaryPath === ":memory:") return [];
  const exactPrimary = resolve(normalize(primaryPath));
  const stores: StoreLocation[] = [];

  if (isRegularFile(exactPrimary)) {
    stores.push({ path: exactPrimary, kind: "primary", account: null });
  }

  const accountsDirectory = join(dirname(exactPrimary), ACCOUNTS_DIRECTORY);
  let entries: string[];
  try {
    entries = readdirSync(accountsDirectory);
  } catch {
    return stores;
  }

  for (const name of entries.sort()) {
    if (!name.endsWith(".db") || DERIVED_ARTIFACT.test(name)) continue;
    const path = join(accountsDirectory, name);
    if (!isRegularFile(path)) continue;
    stores.push({ path, kind: "account", account: basename(name, ".db") });
  }

  return stores;
}

/** A short, non-identifying label for operator output. Never print account emails. */
export function storeLabel(store: StoreLocation): string {
  return store.kind === "primary" ? "primary" : `account ${store.account}`;
}

function isRegularFile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}
