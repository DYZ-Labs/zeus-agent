import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "./db";
import { listStores, storeLabel } from "./stores";

const ACCOUNT_A = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const ACCOUNT_B = "12f81434-e99b-4208-a1a2-0a216579e393";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zeus-stores-"));
  temporaryDirectories.push(root);
  return root;
}

function createStore(path: string): void {
  openDb(path).close();
}

describe("store enumeration", () => {
  it("finds the primary store and every account store beside it", () => {
    const root = storeRoot();
    const primary = join(root, "zeus.db");
    createStore(primary);
    mkdirSync(join(root, "accounts"));
    createStore(join(root, "accounts", `${ACCOUNT_A}.db`));
    createStore(join(root, "accounts", `${ACCOUNT_B}.db`));

    const stores = listStores(primary);

    expect(stores.map((store) => store.kind)).toEqual(["primary", "account", "account"]);
    expect(stores.map((store) => store.account)).toEqual([
      null,
      ACCOUNT_A,
      ACCOUNT_B,
    ]);
    expect(storeLabel(stores[0]!)).toBe("primary");
    expect(storeLabel(stores[1]!)).toBe(`account ${ACCOUNT_A}`);
  });

  it("reports a single store when no account has ever signed up", () => {
    const root = storeRoot();
    const primary = join(root, "zeus.db");
    createStore(primary);

    expect(listStores(primary)).toHaveLength(1);
  });

  it("never mistakes a derived artifact or a symlink for a store", () => {
    const root = storeRoot();
    const primary = join(root, "zeus.db");
    createStore(primary);
    const accounts = join(root, "accounts");
    mkdirSync(accounts);
    createStore(join(accounts, `${ACCOUNT_A}.db`));

    // Sidecars, snapshots, migration backups, and partial writes all live here too.
    writeFileSync(join(accounts, `${ACCOUNT_A}.db-wal`), "");
    writeFileSync(join(accounts, `${ACCOUNT_A}.db-shm`), "");
    writeFileSync(join(accounts, `${ACCOUNT_B}.db.zeus-snapshot-abc123-x.db`), "");
    writeFileSync(join(accounts, `${ACCOUNT_B}.db.pre-migration-x.backup`), "");
    writeFileSync(join(accounts, `${ACCOUNT_B}.db.tmp`), "");
    symlinkSync(primary, join(accounts, "elsewhere.db"));

    const stores = listStores(primary);

    expect(stores.map((store) => store.account)).toEqual([null, ACCOUNT_A]);
  });

  it("omits a primary store that does not exist yet", () => {
    const root = storeRoot();

    expect(listStores(join(root, "zeus.db"))).toEqual([]);
  });

  it("refuses to enumerate an in-memory database", () => {
    expect(listStores(":memory:")).toEqual([]);
  });
});
