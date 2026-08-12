import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { proxy } from "./proxy";

const AUTH_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "ZEUS_OWNER_EMAIL",
] as const;
const savedEnvironment = Object.fromEntries(
  AUTH_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTH_KEYS)[number], string | undefined>;

afterEach(() => {
  AUTH_KEYS.forEach((key) => {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

describe("local proxy boundary", () => {
  it("rejects DNS-rebinding hosts before a private page is rendered", async () => {
    localMode();
    const response = await proxy(
      new NextRequest("http://attacker.example/today", {
        headers: { host: "attacker.example", "sec-fetch-site": "none" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows direct loopback navigation with private response hardening", async () => {
    localMode();
    const response = await proxy(
      new NextRequest("http://127.0.0.1:3000/today", {
        headers: {
          host: "127.0.0.1:3000",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("requires exact Origin before an unsafe local request proceeds", async () => {
    localMode();
    const missing = await proxy(localPost());
    const crossOrigin = await proxy(localPost("https://attacker.example"));
    const sameOrigin = await proxy(localPost("http://127.0.0.1:3000"));

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("configured proxy mutation boundary", () => {
  it("rejects a cross-origin server action before session handling", async () => {
    configuredMode();
    const response = await proxy(
      new NextRequest("https://zeus.example/settings", {
        method: "POST",
        headers: {
          host: "zeus.example",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});

function localMode(): void {
  AUTH_KEYS.forEach((key) => delete process.env[key]);
}

function configuredMode(): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.ZEUS_OWNER_EMAIL = "owner@example.com";
  process.env.NEXT_PUBLIC_SITE_URL = "https://zeus.example";
}

function localPost(origin?: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/chat", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
      ...(origin ? { origin } : {}),
    },
  });
}
