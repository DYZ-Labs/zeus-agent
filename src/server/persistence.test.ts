import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AuthConfiguration } from "@/server/auth/config";
import { assertPersistentStoreConfigured } from "./persistence";

const CONFIGURED: AuthConfiguration = {
  mode: "configured",
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  siteUrl: "https://zeus.example",
  legacyOwnerEmail: null,
  allowedSignupEmails: [],
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function mountedVolume(): string {
  const directory = mkdtempSync(join(tmpdir(), "zeus-volume-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("hosted store persistence", () => {
  it("accepts a database on an existing writable volume", () => {
    const path = join(mountedVolume(), "zeus.db");

    expect(() =>
      assertPersistentStoreConfigured(CONFIGURED, { NODE_ENV: "production", ZEUS_DB: path }),
    ).not.toThrow();
  });

  it("refuses to start a hosted deployment with no ZEUS_DB", () => {
    expect(() =>
      assertPersistentStoreConfigured(CONFIGURED, { NODE_ENV: "production" }),
    ).toThrow(/ZEUS_DB is not set/u);
  });

  it("leaves a development server on the durable home-directory default", () => {
    expect(() =>
      assertPersistentStoreConfigured(CONFIGURED, { NODE_ENV: "development" }),
    ).not.toThrow();
  });

  it("refuses a directory that does not exist rather than creating one", () => {
    // openDb() would mkdir -p this path. On a container that silently manufactures a
    // directory on ephemeral storage when the volume failed to mount.
    const missing = join(mountedVolume(), "not-mounted", "zeus.db");

    expect(() =>
      assertPersistentStoreConfigured(CONFIGURED, { NODE_ENV: "production", ZEUS_DB: missing }),
    ).toThrow(/does not exist/u);
  });

  it.each([":memory:", "relative/zeus.db"])(
    "refuses a non-persistent ZEUS_DB value: %s",
    (value) => {
      expect(() =>
        assertPersistentStoreConfigured(CONFIGURED, { NODE_ENV: "production", ZEUS_DB: value }),
      ).toThrow();
    },
  );

  it("leaves local and misconfigured modes alone", () => {
    expect(() => assertPersistentStoreConfigured({ mode: "local" }, {})).not.toThrow();
    expect(() =>
      assertPersistentStoreConfigured({ mode: "misconfigured", message: "incomplete" }, {}),
    ).not.toThrow();
  });
});
