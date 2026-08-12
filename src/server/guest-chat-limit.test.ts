import { describe, expect, it } from "vitest";

import { ChatVerificationLimiter, GuestChatLimiter } from "./guest-chat-limit";

describe("GuestChatLimiter", () => {
  it("caps concurrent work per client and releases idempotently", () => {
    const limiter = new GuestChatLimiter();
    const first = limiter.acquire("client", 0);
    const second = limiter.acquire("client", 0);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(limiter.acquire("client", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
    });

    if (first.allowed) {
      first.release();
      first.release();
    }
    expect(limiter.acquire("client", 0).allowed).toBe(true);
  });

  it("limits starts within a one-minute window and resets afterwards", () => {
    const limiter = new GuestChatLimiter();
    for (let index = 0; index < 10; index += 1) {
      const lease = limiter.acquire("client", 0);
      expect(lease.allowed).toBe(true);
      if (lease.allowed) lease.release();
    }

    expect(limiter.acquire("client", 30_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(limiter.acquire("client", 60_000).allowed).toBe(true);
  });

  it("applies a global concurrency ceiling across rotating clients", () => {
    const limiter = new GuestChatLimiter();
    const leases = Array.from({ length: 8 }, (_, index) =>
      limiter.acquire(`client-${index}`, 0),
    );
    expect(leases.every((lease) => lease.allowed)).toBe(true);
    expect(limiter.acquire("ninth-client", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 5,
    });

    for (const lease of leases) if (lease.allowed) lease.release();
  });

  it("caps total starts even when callers rotate client addresses", () => {
    const limiter = new GuestChatLimiter();
    for (let index = 0; index < 60; index += 1) {
      const lease = limiter.acquire(`client-${index}`, 1);
      expect(lease.allowed).toBe(true);
      if (lease.allowed) lease.release();
    }

    expect(limiter.acquire("rotated-client", 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });
});

describe("ChatVerificationLimiter", () => {
  it("bounds concurrent verification independently of client headers", () => {
    const limiter = new ChatVerificationLimiter();
    const leases = Array.from({ length: 16 }, () => limiter.acquire(0));
    expect(leases.every((lease) => lease.allowed)).toBe(true);
    expect(limiter.acquire(0)).toEqual({ allowed: false, retryAfterSeconds: 2 });

    const first = leases[0];
    if (first?.allowed) first.release();
    expect(limiter.acquire(0).allowed).toBe(true);
  });

  it("caps total verification starts in a one-minute window", () => {
    const limiter = new ChatVerificationLimiter();
    for (let index = 0; index < 120; index += 1) {
      const lease = limiter.acquire(0);
      expect(lease.allowed).toBe(true);
      if (lease.allowed) lease.release();
    }

    expect(limiter.acquire(30_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(limiter.acquire(60_000).allowed).toBe(true);
  });
});
