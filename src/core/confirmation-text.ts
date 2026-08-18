/**
 * The exact sentence that authorizes a prepared external request.
 *
 * Its own module, with no imports at all, because both sides of the boundary need it: the
 * browser puts it in the composer, and `effects.ts` looks for its hash in the message that
 * comes back. Reaching into `effects.ts` from a client component would drag SQLite and
 * node:crypto into the bundle, and restating the string in the UI would put the two copies
 * one edit apart from silently never matching again.
 *
 * This is the one piece of text Zeus may place in the composer on the user's behalf, because
 * the string *is* the evidence: `assertExactConfirmationMessage` requires this hash in a
 * stored user message and nothing else will do. The user still has to send it, which is the
 * whole point — the message is theirs, not something written for them.
 *
 * Plural for a set, singular for one, and otherwise identical. The hash decides; the wording
 * only has to read like something a person would send.
 */
export function confirmationSentence(hash: string, count = 1): string {
  return count > 1
    ? `I confirm external requests ${hash}.`
    : `I confirm external request ${hash}.`;
}
