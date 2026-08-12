const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 10;
const GLOBAL_REQUESTS_PER_WINDOW = 60;
const MAX_CONCURRENT_PER_CLIENT = 2;
const MAX_CONCURRENT_GUESTS = 8;
const VERIFICATIONS_PER_WINDOW = 120;
const MAX_CONCURRENT_VERIFICATIONS = 16;

type ClientState = {
  windowStartedAt: number;
  requests: number;
  active: number;
  lastSeenAt: number;
};

export type GuestChatLease =
  | { allowed: true; release: () => void }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Small in-process guard for the loopback-first Zeus server. The global concurrency
 * cap still limits spend if a caller rotates its client address; deployments with
 * multiple app instances should additionally enforce a shared edge limit.
 */
export class GuestChatLimiter {
  private readonly clients = new Map<string, ClientState>();
  private totalActive = 0;
  private globalWindowStartedAt: number | null = null;
  private globalRequests = 0;

  acquire(clientKey: string, now = Date.now()): GuestChatLease {
    this.prune(now);
    if (this.globalWindowStartedAt === null || now - this.globalWindowStartedAt >= WINDOW_MS) {
      this.globalWindowStartedAt = now;
      this.globalRequests = 0;
    }
    if (this.globalRequests >= GLOBAL_REQUESTS_PER_WINDOW) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((this.globalWindowStartedAt ?? now) + WINDOW_MS - now) / 1_000),
        ),
      };
    }
    if (this.totalActive >= MAX_CONCURRENT_GUESTS) {
      return { allowed: false, retryAfterSeconds: 5 };
    }

    const state = this.clients.get(clientKey) ?? {
      windowStartedAt: now,
      requests: 0,
      active: 0,
      lastSeenAt: now,
    };

    if (now - state.windowStartedAt >= WINDOW_MS) {
      state.windowStartedAt = now;
      state.requests = 0;
    }
    state.lastSeenAt = now;
    this.clients.set(clientKey, state);

    if (state.requests >= REQUESTS_PER_WINDOW) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((state.windowStartedAt + WINDOW_MS - now) / 1_000),
        ),
      };
    }
    if (state.active >= MAX_CONCURRENT_PER_CLIENT) {
      return { allowed: false, retryAfterSeconds: 5 };
    }

    state.requests += 1;
    this.globalRequests += 1;
    state.active += 1;
    this.totalActive += 1;
    let released = false;

    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        this.totalActive = Math.max(0, this.totalActive - 1);
      },
    };
  }

  private prune(now: number): void {
    for (const [key, state] of this.clients) {
      if (state.active === 0 && now - state.lastSeenAt >= WINDOW_MS * 2) {
        this.clients.delete(key);
      }
    }
  }
}

/**
 * Coarse global protection around account verification. This intentionally has no
 * caller-derived key: forwarded address headers are not trustworthy on the default
 * loopback server, and the purpose of this guard is to bound total auth-service work.
 */
export class ChatVerificationLimiter {
  private windowStartedAt: number | null = null;
  private requests = 0;
  private active = 0;

  acquire(now = Date.now()): GuestChatLease {
    if (this.windowStartedAt === null || now - this.windowStartedAt >= WINDOW_MS) {
      this.windowStartedAt = now;
      this.requests = 0;
    }
    if (this.requests >= VERIFICATIONS_PER_WINDOW) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((this.windowStartedAt ?? now) + WINDOW_MS - now) / 1_000),
        ),
      };
    }
    if (this.active >= MAX_CONCURRENT_VERIFICATIONS) {
      return { allowed: false, retryAfterSeconds: 2 };
    }

    this.requests += 1;
    this.active += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

const limiter = new GuestChatLimiter();
const verificationLimiter = new ChatVerificationLimiter();

export function acquireChatVerification(): GuestChatLease {
  return verificationLimiter.acquire();
}

export function acquireGuestChat(): GuestChatLease {
  // Zeus binds to loopback by default, so all unauthenticated generation belongs to
  // one local guest budget. Do not weaken this by trusting caller-supplied IP headers.
  return limiter.acquire("local-guest");
}
