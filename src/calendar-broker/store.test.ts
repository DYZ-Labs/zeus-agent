import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CalendarBrokerStore } from "./store";

let store: CalendarBrokerStore;

beforeEach(() => {
  store = new CalendarBrokerStore(":memory:", randomBytes(32));
});

afterEach(() => store.close());

describe("encrypted Google Calendar grants", () => {
  it("never stores a refresh token in plaintext", () => {
    const accountId = randomUUID();
    const grant = store.upsertGrant({
      accountId,
      refreshToken: "google-refresh-token-secret",
      scopes: ["scope:read"],
    });
    const raw = store.db.prepare("SELECT * FROM calendar_grant").get() as Record<string, unknown>;

    expect(JSON.stringify(raw)).not.toContain("google-refresh-token-secret");
    expect(grant.refreshToken).toBe("google-refresh-token-secret");
    expect(store.getGrant(grant.id, accountId)?.refreshToken).toBe(
      "google-refresh-token-secret",
    );
  });

  it("binds every grant to one immutable Zeus account", () => {
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    const grant = store.upsertGrant({
      accountId,
      refreshToken: "refresh",
      scopes: ["scope:read"],
    });

    expect(store.getGrant(grant.id, otherAccountId)).toBeNull();
    expect(store.deleteGrant(grant.id, otherAccountId)).toBe(false);
    expect(store.getGrant(grant.id, accountId)).not.toBeNull();
  });

  it("consumes OAuth state once and rejects it after expiry", () => {
    const at = new Date("2026-08-14T10:00:00.000Z");
    const state = store.createOAuthState({
      accountId: randomUUID(),
      returnUrl: "https://www.zeusagent.dev/api/integrations/google-calendar/callback",
      permission: "read",
    }, at);

    expect(store.consumeOAuthState(state, at)?.permission).toBe("read");
    expect(store.consumeOAuthState(state, at)).toBeNull();

    const expired = store.createOAuthState({
      accountId: randomUUID(),
      returnUrl: "https://www.zeusagent.dev/api/integrations/google-calendar/callback",
      permission: "write",
    }, at);
    expect(
      store.consumeOAuthState(expired, new Date("2026-08-14T10:20:00.000Z")),
    ).toBeNull();
  });

  it("keeps an existing refresh token when incremental consent omits a replacement", () => {
    const accountId = randomUUID();
    const first = store.upsertGrant({
      accountId,
      refreshToken: "refresh",
      scopes: ["scope:read"],
    });
    const upgraded = store.upsertGrant({
      accountId,
      refreshToken: null,
      scopes: ["scope:read", "scope:write"],
    });

    expect(upgraded.id).toBe(first.id);
    expect(upgraded.refreshToken).toBe("refresh");
    expect(upgraded.scopes).toEqual(["scope:read", "scope:write"]);
  });
});
