import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openTestDb } from "@/core/db";
import { bindAppOwner } from "@/core/owner";
import { accountDbPath } from "./db";

const LEGACY_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ID = "12f81434-e99b-4208-a1a2-0a216579e393";
const PRIMARY_PATH = "/var/lib/zeus/zeus.db";

describe("account database routing", () => {
  it("reserves an unbound legacy database for its configured email", () => {
    const primary = openTestDb();

    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: LEGACY_ID,
          email: "owner@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(PRIMARY_PATH);
    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: OTHER_ID,
          email: "other@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(`/var/lib/zeus/accounts/${OTHER_ID}.db`);
  });

  it("keeps a bound legacy database with its UUID and isolates every other UUID", () => {
    const primary = openTestDb();
    bindAppOwner(primary, {
      supabaseUserId: LEGACY_ID,
      email: "owner@example.com",
    });

    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: LEGACY_ID,
          email: "renamed@example.com",
          legacyOwnerEmail: null,
        },
        PRIMARY_PATH,
      ),
    ).toBe(PRIMARY_PATH);
    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: OTHER_ID,
          email: "owner@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(`/var/lib/zeus/accounts/${OTHER_ID}.db`);
  });

  it("rejects an identity that cannot safely become a database filename", () => {
    const primary = openTestDb();

    expect(() =>
      accountDbPath(
        primary,
        {
          supabaseUserId: "../../shared",
          email: "other@example.com",
          legacyOwnerEmail: null,
        },
        PRIMARY_PATH,
      ),
    ).toThrow();
  });
});
