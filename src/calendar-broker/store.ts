import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

const Ciphertext = z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const MIGRATION = `
CREATE TABLE IF NOT EXISTS broker_migration (
  id          TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_state (
  state_hash   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  return_url   TEXT NOT NULL,
  permission   TEXT NOT NULL CHECK (permission IN ('read','write')),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_state_expiry_idx ON oauth_state(expires_at);

CREATE TABLE IF NOT EXISTS calendar_grant (
  id                        TEXT PRIMARY KEY,
  account_id                TEXT NOT NULL UNIQUE,
  refresh_token_ciphertext  TEXT NOT NULL,
  scopes_json               TEXT NOT NULL CHECK (json_valid(scopes_json)),
  status                    TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','reconnect_required')),
  connected_at              TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calendar_grant_status_idx ON calendar_grant(status, id);
`;

export type OAuthState = {
  accountId: string;
  returnUrl: string;
  permission: "read" | "write";
  expiresAt: string;
};

export type CalendarGrant = {
  id: string;
  accountId: string;
  refreshToken: string;
  scopes: string[];
  status: "active" | "reconnect_required";
};

type GrantRow = {
  id: string;
  account_id: string;
  refresh_token_ciphertext: string;
  scopes_json: string;
  status: "active" | "reconnect_required";
};

export class CalendarBrokerStore {
  readonly db: Database.Database;
  readonly encryptionKey: Buffer;

  constructor(path: string, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) {
      throw new Error("Google Calendar token encryption key must decode to exactly 32 bytes");
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.encryptionKey = Buffer.from(encryptionKey);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.db.pragma("synchronous = FULL");
    this.db.exec(MIGRATION);
    this.db.prepare(
      "INSERT OR IGNORE INTO broker_migration (id, applied_at) VALUES ('001_init', ?)",
    ).run(new Date().toISOString());
    if (path !== ":memory:") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(`${path}${suffix}`, 0o600);
        } catch {
          // Sidecar files are created lazily, and mounted filesystems may ignore modes.
        }
      }
    }
  }

  createOAuthState(
    input: Omit<OAuthState, "expiresAt">,
    at: Date = new Date(),
  ): string {
    const state = randomBytes(32).toString("base64url");
    const createdAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + OAUTH_STATE_TTL_MS).toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM oauth_state WHERE expires_at <= ?").run(createdAt);
      this.db.prepare(
        `INSERT INTO oauth_state
           (state_hash, account_id, return_url, permission, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        stateHash(state),
        input.accountId,
        input.returnUrl,
        input.permission,
        expiresAt,
        createdAt,
      );
    })();
    return state;
  }

  consumeOAuthState(state: string, at: Date = new Date()): OAuthState | null {
    return this.db.transaction((): OAuthState | null => {
      const row = this.db.prepare<
        [string],
        {
          account_id: string;
          return_url: string;
          permission: "read" | "write";
          expires_at: string;
        }
      >(
        `SELECT account_id, return_url, permission, expires_at
         FROM oauth_state WHERE state_hash = ?`,
      ).get(stateHash(state));
      if (!row) return null;
      this.db.prepare("DELETE FROM oauth_state WHERE state_hash = ?").run(stateHash(state));
      if (row.expires_at <= at.toISOString()) return null;
      return {
        accountId: row.account_id,
        returnUrl: row.return_url,
        permission: row.permission,
        expiresAt: row.expires_at,
      };
    }).immediate();
  }

  upsertGrant(input: {
    accountId: string;
    refreshToken: string | null;
    scopes: readonly string[];
    at?: Date;
  }): CalendarGrant {
    const at = input.at ?? new Date();
    return this.db.transaction((): CalendarGrant => {
      const existing = this.grantRowForAccount(input.accountId);
      const id = existing?.id ?? randomUUID();
      const refreshToken = input.refreshToken ??
        (existing ? this.decrypt(existing.refresh_token_ciphertext, id, input.accountId) : null);
      if (!refreshToken) {
        throw new Error("Google did not return a refresh token; reconnect with consent");
      }
      const scopes = [...new Set(input.scopes)].sort();
      const ciphertext = this.encrypt(refreshToken, id, input.accountId);
      const timestamp = at.toISOString();
      this.db.prepare(
        `INSERT INTO calendar_grant
           (id, account_id, refresh_token_ciphertext, scopes_json, status,
            connected_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           refresh_token_ciphertext = excluded.refresh_token_ciphertext,
           scopes_json = excluded.scopes_json,
           status = 'active',
           updated_at = excluded.updated_at`,
      ).run(id, input.accountId, ciphertext, JSON.stringify(scopes), timestamp, timestamp);
      return this.requireGrant(id, input.accountId);
    }).immediate();
  }

  getGrant(id: string, accountId: string): CalendarGrant | null {
    const row = this.db.prepare<[string, string], GrantRow>(
      `SELECT id, account_id, refresh_token_ciphertext, scopes_json, status
       FROM calendar_grant WHERE id = ? AND account_id = ?`,
    ).get(id, accountId);
    return row ? this.grant(row) : null;
  }

  markReconnectRequired(id: string, accountId: string): void {
    this.db.prepare(
      `UPDATE calendar_grant SET status = 'reconnect_required', updated_at = ?
       WHERE id = ? AND account_id = ?`,
    ).run(new Date().toISOString(), id, accountId);
  }

  deleteGrant(id: string, accountId: string): boolean {
    return this.db.prepare(
      "DELETE FROM calendar_grant WHERE id = ? AND account_id = ?",
    ).run(id, accountId).changes > 0;
  }

  close(): void {
    this.db.close();
    this.encryptionKey.fill(0);
  }

  private requireGrant(id: string, accountId: string): CalendarGrant {
    const grant = this.getGrant(id, accountId);
    if (!grant) throw new Error("Calendar grant vanished after write");
    return grant;
  }

  private grantRowForAccount(accountId: string): GrantRow | null {
    return this.db.prepare<[string], GrantRow>(
      `SELECT id, account_id, refresh_token_ciphertext, scopes_json, status
       FROM calendar_grant WHERE account_id = ?`,
    ).get(accountId) ?? null;
  }

  private grant(row: GrantRow): CalendarGrant {
    const parsedScopes = z.array(z.string()).max(32).parse(JSON.parse(row.scopes_json) as unknown);
    return {
      id: row.id,
      accountId: row.account_id,
      refreshToken: this.decrypt(
        row.refresh_token_ciphertext,
        row.id,
        row.account_id,
      ),
      scopes: parsedScopes,
      status: row.status,
    };
  }

  private encrypt(value: string, grantId: string, accountId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${grantId}:${accountId}`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
  }

  private decrypt(value: string, grantId: string, accountId: string): string {
    const [version, ivValue, encryptedValue, tagValue] = Ciphertext.parse(value).split(".");
    if (version !== "v1" || !ivValue || !encryptedValue || !tagValue) {
      throw new Error("Invalid encrypted Google Calendar token");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${grantId}:${accountId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
