export const OPEN_AUTH_EVENT = "zeus:open-auth";

export type AuthIntent = "login" | "signup";

export function openAuth(intent: AuthIntent): void {
  window.dispatchEvent(
    new CustomEvent<{ intent: AuthIntent }>(OPEN_AUTH_EVENT, { detail: { intent } }),
  );
}
