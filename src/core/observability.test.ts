import { afterEach, describe, expect, it, vi } from "vitest";

import { errorSignature, logEvent, serializeEvent } from "./observability";

afterEach(() => vi.restoreAllMocks());

/** A sentence of the kind Zeus's own error strings can quote back. */
const MEMORY_TEXT = "Jane Okafor moved to 12 Elm Street after leaving Acme";

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
});
