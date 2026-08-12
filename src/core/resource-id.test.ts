import { describe, expect, it } from "vitest";

import { numericResourceId, resourceId } from "./resource-id";

describe("opaque local resource ids", () => {
  it("round-trips a typed id without exposing the decimal database key", () => {
    const value = resourceId("conversation", 12345);
    expect(value).toBe("conversation_9ix");
    expect(numericResourceId(value, "conversation")).toBe(12345);
    expect(numericResourceId(value, "message")).toBeNull();
  });

  it("temporarily accepts positive legacy route ids but rejects malformed values", () => {
    expect(numericResourceId("42", "message")).toBe(42);
    expect(numericResourceId("0", "message")).toBeNull();
    expect(numericResourceId("message_nope!", "message")).toBeNull();
  });
});
