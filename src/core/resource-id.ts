import type { ResourceId } from "./contracts";

export type NumericResourceKind =
  | "candidate"
  | "commitment"
  | "conversation"
  | "fact"
  | "facet"
  | "goal"
  | "message"
  | "opportunity"
  | "passage"
  | "project";

/** Keep local SQLite keys out of browser contracts without pretending they are UUIDs. */
export function resourceId(kind: NumericResourceKind, id: number): ResourceId {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid ${kind} id`);
  return `${kind}_${id.toString(36)}`;
}

export function numericResourceId(
  value: string | number | null | undefined,
  kind: NumericResourceKind,
): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const normalized = value?.trim() ?? "";
  const prefix = `${kind}_`;
  if (normalized.startsWith(prefix)) {
    const encoded = normalized.slice(prefix.length);
    if (!/^[1-9a-z][0-9a-z]*$/u.test(encoded)) return null;
    const id = Number.parseInt(encoded, 36);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  // Transitional compatibility for bookmarked local URLs and older clients. The
  // response boundary always emits opaque ids.
  if (/^[1-9]\d*$/u.test(normalized)) {
    const id = Number(normalized);
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}
