import { afterEach, describe, expect, it, vi } from "vitest";

import { errorSignature, logEvent, serializeEvent } from "./observability";

afterEach(() => vi.restoreAllMocks());

/** A sentence of the kind Zeus's own error strings can quote back. */
const MEMORY_TEXT = "Jane Okafor moved to 12 Elm Street after leaving Acme";

/** An error carrying whatever the throwing library chose to put in `code`. */
function coded(code: unknown, name = "SqliteError"): Error {
  const error = new Error(MEMORY_TEXT);
  error.name = name;
  error.stack = [
    `${name}: ${MEMORY_TEXT}`,
    "    at recordFact (/app/src/core/facts.ts:88:3)",
  ].join("\n");
  return Object.assign(error, { code });
}

describe("allowlisted operational events", () => {
  it("emits one JSON line on stderr, never stdout", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent({ event: "chat_turn", outcome: "ok", duration_ms: 1234.6 });

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    const line = stderr.mock.calls[0]![0] as string;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      event: "chat_turn",
      outcome: "ok",
      duration_ms: 1235,
    });
  });

  it("drops any field that is not on the allowlist", () => {
    const payload = serializeEvent({
      event: "chat_turn",
      // @ts-expect-error deliberately passing a field the type does not permit
      input: MEMORY_TEXT,
      note: MEMORY_TEXT,
    });

    expect(Object.keys(payload)).toEqual(["event"]);
    expect(JSON.stringify(payload)).not.toContain("Elm");
  });

  it("refuses a sentence in an allowlisted field instead of truncating one in", () => {
    const payload = serializeEvent({
      event: "extraction_failed",
      reason: MEMORY_TEXT,
      error_name: MEMORY_TEXT,
      route: MEMORY_TEXT,
      model: MEMORY_TEXT,
      mode: MEMORY_TEXT,
    });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Elm");
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("Acme");
    // Rejection is visible rather than silent, so a bad call site is diagnosable.
    expect(payload.reason).toBe("invalid");
    expect(payload.error_name).toBe("invalid");
  });

  it("keeps a pseudonymous account id but rejects an email in the same field", () => {
    expect(
      serializeEvent({
        event: "http_denied",
        account: "019ff232-f8e0-7ce2-8e83-d416444aed06",
      }).account,
    ).toBe("019ff232-f8e0-7ce2-8e83-d416444aed06");

    expect(
      serializeEvent({ event: "http_denied", account: "jane@example.com" }).account,
    ).toBe("invalid");
  });

  it("keeps well-formed operational values", () => {
    expect(
      serializeEvent({
        event: "http_denied",
        outcome: "error",
        reason: "forbidden_origin",
        route: "/api/work-plans/[id]/run",
        method: "POST",
        status: 403,
        conversation_id: 42,
        model: "gpt-5.5",
        mode: "configured",
        store: "account",
      }),
    ).toEqual({
      event: "http_denied",
      outcome: "error",
      reason: "forbidden_origin",
      route: "/api/work-plans/[id]/run",
      method: "POST",
      status: 403,
      conversation_id: 42,
      model: "gpt-5.5",
      mode: "configured",
      store: "account",
    });
  });

  it("never emits an anonymous line", () => {
    // @ts-expect-error event is required; a call site that loses it must still be found
    expect(serializeEvent({}).event).toBe("invalid");
    expect(serializeEvent({ event: "Not A Code" }).event).toBe("invalid");
  });

  it("ignores a non-finite number rather than writing null", () => {
    expect(serializeEvent({ event: "chat_turn", duration_ms: Number.NaN }))
      .toEqual({ event: "chat_turn" });
  });
});

describe("error identification without error text", () => {
  it("reports the class and the first Zeus frame, never the message", () => {
    const error = new Error(MEMORY_TEXT);
    error.name = "ExtractionError";
    error.stack = [
      `ExtractionError: ${MEMORY_TEXT}`,
      "    at parse (/app/node_modules/zod/index.js:88:12)",
      "    at applyExtraction (/app/src/core/extract.ts:412:9)",
      "    at streamTurn (/app/src/core/chat.ts:120:5)",
    ].join("\n");

    const signature = errorSignature(error);

    expect(signature).toEqual({
      error_name: "ExtractionError",
      // The first application frame, with the vendored frame above it skipped.
      error_site: "src/core/extract.ts:412",
    });
    expect(JSON.stringify(signature)).not.toContain("Elm");
  });

  it("omits the site when no application frame is present", () => {
    const error = new Error(MEMORY_TEXT);
    error.stack = `Error: ${MEMORY_TEXT}\n    at internal (node:events:12:1)`;

    expect(errorSignature(error)).toEqual({ error_name: "Error" });
  });

  it("labels a thrown non-error rather than serializing it", () => {
    expect(errorSignature({ secret: MEMORY_TEXT })).toEqual({ error_name: "NonError" });
    expect(errorSignature(MEMORY_TEXT)).toEqual({ error_name: "NonError" });
  });

  it("omits the code when the error carries none", () => {
    const error = new Error(MEMORY_TEXT);
    error.stack = `Error: ${MEMORY_TEXT}\n    at run (/app/src/core/chat.ts:9:1)`;

    expect(errorSignature(error)).toEqual({
      error_name: "Error",
      error_site: "src/core/chat.ts:9",
    });
    expect(errorSignature(coded(""))).not.toHaveProperty("error_code");
  });
});

// A full volume, a damaged store, writer contention, and a read-only mount all arrive as
// SqliteError, and they call for four different responses. Collapsing them into one log
// line is how an operator ends up tuning concurrency while the disk is full.
describe("machine codes that separate incidents sharing an error class", () => {
  it("keeps the SQLite condition alongside the class", () => {
    expect(
      serializeEvent({
        event: "fact_write_failed",
        outcome: "error",
        ...errorSignature(coded("SQLITE_FULL")),
      }),
    ).toEqual({
      event: "fact_write_failed",
      outcome: "error",
      error_name: "SqliteError",
      error_code: "SQLITE_FULL",
      error_site: "src/core/facts.ts:88",
    });

    expect(
      ["SQLITE_CORRUPT", "SQLITE_BUSY", "SQLITE_READONLY"].map(
        (code) => errorSignature(coded(code)).error_code,
      ),
    ).toEqual(["SQLITE_CORRUPT", "SQLITE_BUSY", "SQLITE_READONLY"]);
  });

  it("keeps the errno behind a filesystem failure", () => {
    for (const code of ["ENOSPC", "EROFS", "EACCES", "ERR_MODULE_NOT_FOUND"]) {
      expect(
        serializeEvent({ event: "store_open_failed", ...errorSignature(coded(code, "Error")) })
          .error_code,
      ).toBe(code);
    }
  });

  it("refuses anything in `code` that is not a machine token", () => {
    // `code` belongs to whichever library threw, so it is not a trusted field.
    const hostile = [
      MEMORY_TEXT,
      "SQLITE_FULL: attempt to write Jane Okafor to a full disk",
      "/Users/jane/.zeus/zeus.db",
      "jane@example.com",
      "SELECT * FROM fact WHERE object = 'Elm Street'",
    ];

    for (const code of hostile) {
      const payload = serializeEvent({
        event: "store_write_failed",
        ...errorSignature(coded(code)),
      });
      expect(payload.error_code).toBe("invalid");
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("Elm");
      expect(serialized).not.toContain("Jane");
      expect(serialized).not.toContain("jane");
      expect(serialized).not.toContain(".zeus");
    }
  });

  it("keeps a code Zeus authored out of the field for someone else's", () => {
    // A connector's `handshake_failed` is a reason, and is already logged as one.
    expect(
      serializeEvent({
        event: "connector_verified",
        outcome: "error",
        reason: "handshake_failed",
        ...errorSignature(coded("handshake_failed", "ConnectorError")),
      }),
    ).toMatchObject({
      reason: "handshake_failed",
      error_name: "ConnectorError",
      error_code: "invalid",
    });
  });

  it("reports a non-string code as rejected rather than coercing it", () => {
    for (const code of [{ detail: MEMORY_TEXT }, [MEMORY_TEXT], 28, true]) {
      const payload = serializeEvent({
        event: "store_write_failed",
        ...errorSignature(coded(code)),
      });
      expect(payload.error_code).toBe("invalid");
      expect(JSON.stringify(payload)).not.toContain("Elm");
    }
  });
});
