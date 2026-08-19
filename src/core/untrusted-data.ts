/**
 * The one guard every piece of third-party text passes before a model sees it.
 *
 * Calendar titles, artifact bodies, effect previews, and the standing schedule block all
 * descend from text somebody else wrote — anyone who can send an invite can author it.
 * AGENTS.md requires each of those payloads through `inspectUntrustedWorkData` first, and
 * keeping the inspection in one pure module means the work executor, the chat renderer, and
 * the schedule context cannot drift into three different ideas of "safe".
 *
 * Classification, not sanitization: callers decide whether a hit becomes a pause (the work
 * engine) or a per-field redaction (`guardExternalText`).
 */

export type UntrustedWorkDataIssue = "sensitive_data" | "instruction_injection";

export function containsSensitiveSecret(value: string): boolean {
  return /\bsk-[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/iu.test(value) ||
    /\b(?:password|passcode|api[_ -]?key|secret|session[_ -]?token|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S{6,}/iu.test(value) ||
    /\b(?:account|routing)(?:\s+(?:number|no\.?))?\s*[:=]\s*[0-9 -]{6,24}\b/iu.test(value) ||
    /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u.test(value) ||
    /\b(?:\d[ -]*?){13,19}\b/u.test(value);
}

function containsExplicitHighSensitivity(value: string): boolean {
  return /\b(?:i (?:was|have been|am) diagnosed with|my (?:diagnosis|medical record|therapy notes?|psychiatric (?:record|history))|i am (?:hiv positive|pregnant))\b/iu.test(value) ||
    /\b(?:i (?:was|have been) arrested|my (?:criminal record|pending charges|lawsuit|attorney said))\b/iu.test(value) ||
    /\b(?:my (?:salary|net worth|tax id|social security number) (?:is|:)|i owe \$?\d)\b/iu.test(value) ||
    /\b(?:my (?:sexual orientation|sex life|intimate relationship)|i am (?:gay|lesbian|bisexual|transgender))\b/iu.test(value);
}

/** Conservative guard applied before untrusted data is persisted or sent to another step. */
export function inspectUntrustedWorkData(value: string): UntrustedWorkDataIssue | null {
  if (containsSensitiveSecret(value) || containsExplicitHighSensitivity(value)) {
    return "sensitive_data";
  }
  if (
    // The qualifier repeats: "prior developer messages" and "previous system rules" are the
    // same instruction as "prior messages", and a single-qualifier pattern reads them as
    // ordinary text. Each repetition must consume a literal plus whitespace, so widening it
    // costs nothing in matching behavior beyond the phrasings it was already meant to catch.
    /(?:ignore|disregard|override|forget)\s+(?:all\s+)?(?:(?:previous|prior|system|developer)\s+)+(?:instructions?|messages?|rules?)/iu.test(value) ||
    /(?:reveal|print|exfiltrate|send)\s+(?:the\s+)?(?:system prompt|developer message|api key|password|secret)/iu.test(value) ||
    /<\/?(?:system|developer|tool)>/iu.test(value) ||
    /\bsystem\s+(?:update|directive|notice)\s*:\s*[^\n]{0,200}\b(?:search|private context|hidden context|memory|verbatim)\b/iu.test(value) ||
    /\b(?:search|quote|return|copy|repeat)\b[^\n]{0,120}\b(?:private|hidden|internal)\s+(?:context|memory|instructions?)\b[^\n]{0,80}\bverbatim\b/iu.test(value) ||
    /\byou are now (?:an?|the)\b/iu.test(value)
  ) {
    return "instruction_injection";
  }
  return null;
}

/** Replace text that reads as an instruction or a secret, and record that we did. */
export function guardExternalText(value: string, withheld: { any: boolean }): string {
  if (!inspectUntrustedWorkData(value)) return value;
  withheld.any = true;
  return "[withheld: external text required review]";
}
