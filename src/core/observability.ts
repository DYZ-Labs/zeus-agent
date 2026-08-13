/**
 * Structured operational events.
 *
 * Zeus deliberately logs less than a typical service. Its error strings can quote the
 * person the store is about — a failed extraction, an ambiguous merge, a malformed FTS
 * query all carry text that came from the user — so this module is an **allowlist, not
 * a scrubber**. Only the fields declared below are ever serialized, each is validated
 * against a shape that cannot hold a sentence, and there is deliberately no free-form
 * message field and no `error.message`. A denylist over a memory system leaks
 * eventually; an allowlist cannot.
 *
 * What survives is enough to answer the operational questions: what failed, where in
 * the code, how often, for which account, and how slow. What does not survive is
 * anything the user said.
 *
 * Output is one JSON object per line on stderr. stdout belongs to the MCP protocol.
 */

export type EventOutcome = "ok" | "degraded" | "error";

export type ZeusEvent = {
  /** Stable snake_case name. The primary thing an operator groups and alerts on. */
  event: string;
  outcome?: EventOutcome;
  /** A short code chosen by the call site from a known set — never raw error text. */
  reason?: string;
  route?: string;
  method?: string;
  status?: number;
  duration_ms?: number;
  /** Supabase UUID. Pseudonymous by design; never an email or a display name. */
  account?: string;
  // Nullable so a call site can pass an optional id straight through; a null is
  // simply omitted rather than becoming a `null` in the log.
  conversation_id?: number | null;
  message_id?: number | null;
  plan_id?: number | null;
  run_id?: number | null;
  count?: number | null;
  error_name?: string;
  /** First application stack frame as `src/…:line`. A code location, not user data. */
  error_site?: string;
  model?: string;
  mode?: string;
  store?: string;
};

/** Per-field shapes. A value that does not match is replaced, never truncated into. */
const FIELD_PATTERNS = {
  event: /^[a-z][a-z0-9_]{0,63}$/u,
  outcome: /^(?:ok|degraded|error)$/u,
  reason: /^[a-z][a-z0-9_]{0,63}$/u,
  route: /^\/[A-Za-z0-9/_\-[\].]{0,127}$/u,
  method: /^[A-Z]{3,7}$/u,
  account: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  error_name: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u,
  error_site: /^[A-Za-z0-9/_\-.]{1,128}:\d{1,6}$/u,
  model: /^[A-Za-z0-9._-]{1,64}$/u,
  mode: /^[a-z][a-z0-9_]{0,31}$/u,
  store: /^[a-z][a-z0-9_]{0,31}$/u,
} as const;

const NUMERIC_FIELDS = [
  "status",
  "duration_ms",
  "conversation_id",
  "message_id",
  "plan_id",
  "run_id",
  "count",
] as const;

/** A rejected value reports that it was rejected rather than disappearing silently. */
const REJECTED = "invalid";

export function logEvent(event: ZeusEvent): void {
  emit(JSON.stringify(serializeEvent(event)));
}

/** Exported for tests: the exact object that would be written. */
export function serializeEvent(event: ZeusEvent): Record<string, string | number> {
  const payload: Record<string, string | number> = {};

  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    const value = event[field as keyof typeof FIELD_PATTERNS];
    if (value === undefined || value === null) continue;
    payload[field] = pattern.test(value) ? value : REJECTED;
  }

  for (const field of NUMERIC_FIELDS) {
    const value = event[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    payload[field] = Math.round(value);
  }

  // `event` is the one field an operator cannot do without; make its absence loud
  // rather than emitting an anonymous line.
  if (payload.event === undefined) payload.event = REJECTED;
  return payload;
}

/**
 * Identify an error by its class and the first line of Zeus code in its stack.
 *
 * Deliberately omits the message. A stack frame is a code location the operator wrote;
 * a message may be a sentence the user wrote.
 */
export function errorSignature(error: unknown): {
  error_name: string;
  error_site?: string;
} {
  if (!(error instanceof Error)) return { error_name: "NonError" };
  const site = applicationStackFrame(error.stack);
  return {
    error_name: error.name || "Error",
    ...(site ? { error_site: site } : {}),
  };
}

function applicationStackFrame(stack: string | undefined): string | undefined {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = /([^\s()]+):(\d+):\d+/u.exec(line);
    if (!match) continue;
    const [, file, lineNumber] = match as unknown as [string, string, string];
    if (file.includes("node_modules") || file.startsWith("node:")) continue;
    const index = file.lastIndexOf("/src/");
    if (index < 0) continue;
    return `${file.slice(index + 1)}:${lineNumber}`;
  }
  return undefined;
}

function emit(line: string): void {
  // console.error rather than process.stderr: the same call has to work in the Node
  // server, the edge proxy runtime, and the MCP process, whose stdout is a protocol.
  console.error(line);
}
