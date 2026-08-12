import { z } from "zod";

const RelativePath = z
  .string()
  .max(2_000)
  .refine((value) => value.startsWith("/") && !value.startsWith("//"));

/** Only same-origin relative paths can survive an auth round trip. */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  const parsed = RelativePath.safeParse(value);
  if (!parsed.success) return fallback;

  // WHATWG URLs treat backslashes as slashes for special schemes. Reject both raw
  // and encoded path separators before resolution so `/\\attacker.example` cannot
  // become a cross-origin redirect.
  if (
    /[\\\u0000-\u001f\u007f]/u.test(parsed.data) ||
    /%(?:2f|5c)/iu.test(parsed.data)
  ) {
    return fallback;
  }

  try {
    const base = new URL("https://zeus.invalid");
    return new URL(parsed.data, base).origin === base.origin ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
