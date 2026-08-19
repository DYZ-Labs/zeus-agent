/**
 * The exact sentence that authorizes a prepared external request.
 *
 * Its own module, with no imports at all, because both sides of the boundary need it: the
 * browser puts it in the composer, and `effects.ts` looks for its hash in the message that
 * comes back. Reaching into `effects.ts` from a client component would drag SQLite and
 * node:crypto into the bundle, and restating the string in the UI would put the two copies
 * one edit apart from silently never matching again.
 *
 * These hash-bound confirmation and work-plan sentences are the only text Zeus may place in
 * the composer on the user's behalf, because the string *is* the evidence. The user still
 * has to send it, which is the whole point — the message is theirs, not something written
 * for them.
 *
 * Plural for a set, singular for one, and otherwise identical. The hash decides; the wording
 * only has to read like something a person would send.
 */
export function confirmationSentence(hash: string, count = 1): string {
  return count > 1
    ? `I confirm external requests ${hash}.`
    : `I confirm external request ${hash}.`;
}

/** The exact sentence that approves one immutable bounded-work plan. */
export function workPlanApprovalSentence(hash: string): string {
  return `I approve bounded work plan ${hash}.`;
}

/** The exact sentence that both approves and starts one immutable bounded-work plan. */
export function workPlanApprovalAndRunSentence(hash: string): string {
  return `I approve and run bounded work plan ${hash}.`;
}

export type WorkPlanApproval = {
  hash: string;
  run: boolean;
};

/** Parse only a complete, affirmative, hash-bound work-plan approval sentence. */
export function parseWorkPlanApproval(content: string): WorkPlanApproval | null {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const canonical = /^(?:i\s+)?approve\s+(and\s+run\s+)?bounded\s+work\s+plan\s*:?\s*([a-f0-9]{64})[.!]?$/iu.exec(
    normalized,
  );
  if (canonical) return { hash: canonical[2]!.toLowerCase(), run: Boolean(canonical[1]) };

  // Kept for stored approvals and clients that predate the canonical composer sentence.
  const legacy = /^(?:i\s+)?(?:approve|authorize)\s+(?:(?:this\s+)?exact\s+(?:bounded\s+work\s+)?)(?:plan)\s*:?\s*([a-f0-9]{64})[.!]?$/iu.exec(
    normalized,
  );
  return legacy ? { hash: legacy[1]!.toLowerCase(), run: false } : null;
}

/** Approval-looking text must never be reinterpreted as a fresh work request. */
export function isWorkPlanApprovalAttempt(content: string): boolean {
  const normalized = content.replace(/\s+/gu, " ").trim();
  return /^(?:i\s+)?(?:approve|authorize)\b.*\b(?:bounded\s+work\s+)?plan\b/iu.test(
    normalized,
  );
}
