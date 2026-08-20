/**
 * Memory and Understanding merged into `/about-you`. These resolve where an old link now
 * belongs, so a bookmark, a chat citation, or a saved login destination keeps working.
 */

/** The three list views kept their names across the merge, so params forward unchanged. */
export function memoryRedirect(params: LegacyParams): string {
  return `/about-you${forwardedQuery(params)}`;
}

/**
 * Understanding's reflection view has no equivalent on the merged page: the question moved
 * to Today, which is where the user already answers things.
 */
export function understandingRedirect(params: LegacyParams): string {
  if (readParam(params.view) === "questions") return "/today";
  return `/about-you${forwardedQuery(params)}`;
}

type LegacyParams = Record<string, string | string[] | undefined>;

function forwardedQuery(params: LegacyParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = readParam(value);
    if (first !== null) query.set(key, first);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function readParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}
