import { describe, expect, it } from "vitest";

import { checkBrowserBoundary } from "./browser-origin";

const LOCAL = { mode: "local" } as const;
const CONFIGURED = {
  mode: "configured" as const,
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  ownerEmail: "owner@example.com",
  siteUrl: "https://zeus.example",
};

describe("local browser origin boundary", () => {
  it("allows a direct navigation and a same-origin private read", () => {
    expect(
      checkBrowserBoundary(
        request("/today", { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }),
        "private-read",
        LOCAL,
      ),
    ).toMatchObject({ allowed: true });

    expect(
      checkBrowserBoundary(
        request("/api/location", {
          referer: "http://127.0.0.1:3000/today",
          "sec-fetch-site": "same-origin",
        }),
        "private-read",
        LOCAL,
      ),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    ["a DNS-rebinding hostname", "http://attacker.example/today", "attacker.example"],
    ["localhost instead of the canonical literal", "http://localhost:3000/today", "localhost:3000"],
    ["a mismatched Host authority", "http://127.0.0.1:3000/today", "127.0.0.1:4000"],
  ])("rejects %s", (_label, url, host) => {
    expect(
      checkBrowserBoundary(
        new Request(url, { headers: { host, "sec-fetch-site": "none" } }),
        "private-read",
        LOCAL,
      ),
    ).toMatchObject({ allowed: false });
  });

  it("rejects cross-site reads even when the target Host is loopback", () => {
    expect(
      checkBrowserBoundary(
        request("/today", {
          referer: "https://attacker.example/",
          "sec-fetch-site": "cross-site",
        }),
        "private-read",
        LOCAL,
      ),
    ).toMatchObject({ allowed: false });
  });

  it("requires an exact same-origin capability for mutations", () => {
    const exact = request("/api/chat", {
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    }, "POST");
    expect(checkBrowserBoundary(exact, "private-mutation", LOCAL)).toMatchObject({
      allowed: true,
    });

    const rejectedHeaders: Array<Record<string, string>> = [
      { "sec-fetch-site": "same-origin" },
      { origin: "http://127.0.0.1:4000", "sec-fetch-site": "same-origin" },
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      { origin: "null", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of rejectedHeaders) {
      expect(
        checkBrowserBoundary(request("/api/chat", headers, "POST"), "private-mutation", LOCAL),
      ).toMatchObject({ allowed: false });
    }
  });
});

describe("configured browser origin boundary", () => {
  it("binds mutations to the configured public origin", () => {
    const allowed = new Request("https://zeus.example/api/chat", {
      method: "POST",
      headers: { origin: "https://zeus.example", "sec-fetch-site": "same-origin" },
    });
    const wrongHost = new Request("https://preview.example/api/chat", {
      method: "POST",
      headers: { origin: "https://preview.example", "sec-fetch-site": "same-origin" },
    });

    expect(checkBrowserBoundary(allowed, "private-mutation", CONFIGURED)).toMatchObject({
      allowed: true,
    });
    expect(checkBrowserBoundary(wrongHost, "private-mutation", CONFIGURED)).toMatchObject({
      allowed: false,
    });
  });
});

function request(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}
