import { describe, expect, it } from "vitest";

import { openTestDb } from "./db";
import { MIGRATIONS } from "./migrations";
import { bindAppOwner, getAppOwner } from "./owner";

const FIRST_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ID = "12f81434-e99b-4208-a1a2-0a216579e393";

describe("app owner migration", () => {
  it("appends the singleton owner table without changing prior migration indices", () => {
    const db = openTestDb();

    expect(MIGRATIONS[10]?.id).toBe("011_conversation_history_state");
    expect(MIGRATIONS[11]?.id).toBe("012_app_owner");
    expect(
      db
        .prepare<[string], { id: string }>("SELECT id FROM schema_migration WHERE id = ?")
        .get("012_app_owner"),
    ).toEqual({ id: "012_app_owner" });
    expect(getAppOwner(db)).toBeNull();
  });

  it("enforces the singleton and normalized identity constraints in SQLite", () => {
    const db = openTestDb();
    db.prepare<[number, string, string, string]>(
      `INSERT INTO app_owner (id, supabase_user_id, email, bound_at)
       VALUES (?, ?, ?, ?)`,
    ).run(1, FIRST_ID, "owner@example.com", "2026-08-12T00:00:00.000Z");

    expect(() =>
      db.prepare<[number, string, string, string]>(
        `INSERT INTO app_owner (id, supabase_user_id, email, bound_at)
         VALUES (?, ?, ?, ?)`,
      ).run(2, OTHER_ID, "other@example.com", "2026-08-12T00:00:00.000Z"),
    ).toThrow();
    expect(() =>
      db.prepare<[string, number]>(
        `UPDATE app_owner SET email = ? WHERE id = ?`,
      ).run("OWNER@example.com", 1),
    ).toThrow();
  });
});

describe("app owner binding", () => {
  it("normalizes and transactionally binds the first authenticated identity", () => {
    const db = openTestDb();

    const result = bindAppOwner(db, {
      supabaseUserId: ` ${FIRST_ID.toUpperCase()} `,
      email: " Owner@Example.COM ",
    });

    expect(result.bound).toBe(true);
    expect(result.owner).toMatchObject({
      id: 1,
      supabase_user_id: FIRST_ID,
      email: "owner@example.com",
    });
    expect(result.owner.bound_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(getAppOwner(db)).toEqual(result.owner);
  });

  it("is idempotent for the same identity and never replaces it with another", () => {
    const db = openTestDb();
    const first = bindAppOwner(db, {
      supabaseUserId: FIRST_ID,
      email: "owner@example.com",
    });

    const repeated = bindAppOwner(db, {
      supabaseUserId: FIRST_ID,
      email: "changed@example.com",
    });
    const attemptedReplacement = bindAppOwner(db, {
      supabaseUserId: OTHER_ID,
      email: "other@example.com",
    });

    expect(repeated).toEqual({ owner: first.owner, bound: false });
    expect(attemptedReplacement).toEqual({ owner: first.owner, bound: false });
    expect(getAppOwner(db)).toEqual(first.owner);
    expect(
      db.prepare<[], { count: number }>("SELECT count(*) AS count FROM app_owner").get(),
    ).toEqual({ count: 1 });
  });

  it("rejects malformed identities without claiming the store", () => {
    const db = openTestDb();

    expect(() =>
      bindAppOwner(db, { supabaseUserId: "not-a-uuid", email: "owner@example.com" }),
    ).toThrow();
    expect(() => bindAppOwner(db, { supabaseUserId: FIRST_ID, email: "not-email" })).toThrow();
    expect(getAppOwner(db)).toBeNull();
  });
});
