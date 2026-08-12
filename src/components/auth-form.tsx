"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  logoutAction,
  requestEmailLinkAction,
  startGoogleAuthAction,
  type AuthActionState,
} from "@/app/auth/actions";
import type { AccountSummary, AuthMode } from "@/lib/auth-types";

const INITIAL_AUTH_ACTION_STATE: AuthActionState = {
  status: "idle",
  message: "",
};

export function AuthForm({
  intent,
  next,
  authMode,
  canonicalSiteUrl,
  googleEnabled,
  initialMessage,
  blockedAccount,
  onClose,
  onIntentChange,
}: {
  intent: "login" | "signup";
  next: string;
  authMode: AuthMode;
  canonicalSiteUrl: string | null;
  googleEnabled: boolean | null;
  initialMessage: string | null;
  blockedAccount: AccountSummary | null;
  onClose?: () => void;
  onIntentChange?: (intent: "login" | "signup") => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLElement>(null);
  const [state, formAction, pending] = useActionState(
    requestEmailLinkAction.bind(null, intent),
    INITIAL_AUTH_ACTION_STATE,
  );
  const configured = authMode === "configured";
  const title = intent === "login" ? "Welcome back" : "Create your account";
  const alternatePath = intent === "login" ? "/auth/signup" : "/auth/login";
  const alternateHref =
    next === "/" ? alternatePath : `${alternatePath}?${new URLSearchParams({ next })}`;
  const [originReady, setOriginReady] = useState(canonicalSiteUrl === null);

  const close = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    if (window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [onClose, router]);

  useEffect(() => {
    if (!canonicalSiteUrl) return;
    if (window.location.origin === canonicalSiteUrl) {
      const frame = window.requestAnimationFrame(() => setOriginReady(true));
      return () => window.cancelAnimationFrame(frame);
    }

    const destination = new URL(
      `${window.location.pathname}${window.location.search}`,
      canonicalSiteUrl,
    );
    window.location.replace(destination.toString());
    return undefined;
  }, [canonicalSiteUrl]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;

    const focusFrame = window.requestAnimationFrame(() => {
      (
        dialog.querySelector<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), a[href]',
        ) ?? dialog
      ).focus();
    });

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (focused === last || !dialog.contains(focused))) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", keepFocusInside);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keepFocusInside);
      previouslyFocused?.focus();
    };
  }, [close]);

  useEffect(() => {
    if (!originReady) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>("#auth-email")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [originReady]);

  const message =
    state.message ||
    initialMessage ||
    (!configured
      ? authMode === "local"
        ? "Account access is not available in this edition."
        : "Account access is temporarily unavailable."
      : "");
  const messageIsSuccess = state.status === "sent";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={!originReady}
        tabIndex={-1}
        className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[400px] flex-col overflow-hidden rounded-2xl border text-sm leading-5 shadow-2xl sm:max-h-[calc(100vh-3rem)]"
        style={{
          background: "var(--shell-panel)",
          borderColor: "var(--shell-line-strong)",
        }}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close account access"
          title="Close"
          className="absolute right-3 top-3 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg transition-[background-color,transform] duration-150 hover:bg-white/[0.08] active:scale-95 disabled:pointer-events-none"
          style={{ color: "var(--shell-fg)" }}
        >
          <CloseIcon />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8 sm:py-8">
          <div className="mx-auto w-full max-w-[23rem] text-center">
            <Link
              href="/"
              className="inline-flex rounded-md text-sm font-semibold tracking-[-0.01em] transition-opacity duration-150 hover:opacity-75 active:opacity-60"
              aria-label="Zeus home"
            >
              Zeus
            </Link>

            <h1 className="mt-5 text-[1.65rem] font-semibold leading-tight tracking-[-0.035em]">
              {title}
            </h1>
            <p className="mt-2 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
              Continue with email or Google.
            </p>
            {!originReady && (
              <p role="status" className="mt-4 text-sm" style={{ color: "var(--shell-muted)" }}>
                Opening secure login…
              </p>
            )}

            {blockedAccount ? (
              <section
                className="mt-7 rounded-xl border px-4 py-4 text-left"
                style={{
                  background: "var(--shell-elevated)",
                  borderColor: "var(--shell-line-strong)",
                }}
              >
                <p className="text-sm font-medium">Different account detected</p>
                <p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
                  {blockedAccount.email} is signed in, but it is not linked to this Zeus store.
                </p>
                <form action={logoutAction} className="mt-4">
                  <button
                    type="submit"
                    className="h-11 w-full cursor-pointer rounded-lg px-4 text-sm font-medium transition-[filter,transform,opacity] duration-150 hover:brightness-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 disabled:active:scale-100"
                    style={{ background: "var(--shell-accent)", color: "#000000" }}
                  >
                    Log out and try another account
                  </button>
                </form>
              </section>
            ) : (
              <>
                <form action={formAction} className="mt-6 text-left">
                  <input type="hidden" name="next" value={next} />
                  <label htmlFor="auth-email" className="sr-only">
                    Email address
                  </label>
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    disabled={!configured || !originReady || pending}
                    placeholder="Email address"
                    className="h-12 w-full rounded-none border-0 border-b border-[var(--shell-line-strong)] bg-transparent px-0 text-base text-[var(--shell-fg)] outline-none transition-[border-color,opacity] duration-150 hover:border-[var(--shell-muted)] focus:border-[var(--shell-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ outline: "none" }}
                  />
                  <button
                    type="submit"
                    disabled={!configured || !originReady || pending}
                    className="mt-4 h-12 w-full cursor-pointer rounded-lg px-4 text-base font-medium transition-[filter,transform,opacity] duration-150 hover:brightness-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 disabled:active:scale-100"
                    style={{ background: "var(--shell-accent)", color: "#000000" }}
                  >
                    {pending ? "Sending…" : "Continue"}
                  </button>
                </form>

                <div
                  className="my-4 flex items-center gap-3 text-xs uppercase tracking-[0.08em]"
                  style={{ color: "var(--shell-faint)" }}
                >
                  <span className="h-px flex-1" style={{ background: "var(--shell-line-strong)" }} />
                  or
                  <span className="h-px flex-1" style={{ background: "var(--shell-line-strong)" }} />
                </div>

                <form action={startGoogleAuthAction}>
                  <input type="hidden" name="next" value={next} />
                  <button
                    type="submit"
                    disabled={!configured || !originReady || googleEnabled === false}
                    className="relative flex h-12 w-full cursor-pointer items-center justify-center rounded-lg border px-12 text-base font-medium transition-[filter,transform,opacity] duration-150 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 disabled:active:scale-100"
                    style={{
                      background: "var(--shell-elevated)",
                      borderColor: "var(--shell-line-strong)",
                      color: "var(--shell-fg)",
                    }}
                  >
                    <GoogleIcon />
                    {googleEnabled === false ? "Google not enabled" : "Continue with Google"}
                  </button>
                </form>
                {googleEnabled === false && (
                  <p className="mt-2 text-xs leading-5" style={{ color: "#fca5a5" }}>
                    Google sign-in is unavailable. Continue with email instead.
                  </p>
                )}
              </>
            )}

            {message && !blockedAccount && (
              <p
                role="status"
                className="mt-5 rounded-lg border px-3 py-2.5 text-sm leading-5"
                style={{
                  color: messageIsSuccess ? "#86efac" : "#fca5a5",
                  background: messageIsSuccess
                    ? "rgba(22, 101, 52, 0.24)"
                    : "rgba(127, 29, 29, 0.24)",
                  borderColor: messageIsSuccess
                    ? "rgba(134, 239, 172, 0.28)"
                    : "rgba(252, 165, 165, 0.28)",
                }}
              >
                {message}
              </p>
            )}

            <p className="mt-7 text-sm" style={{ color: "var(--shell-muted)" }}>
              {intent === "login" ? "New to Zeus?" : "Already have an account?"}{" "}
              {onIntentChange ? (
                <button
                  type="button"
                  onClick={() => onIntentChange(intent === "login" ? "signup" : "login")}
                  className="cursor-pointer rounded-sm font-medium underline underline-offset-4 transition-opacity duration-150 hover:opacity-75 active:opacity-60"
                  style={{ color: "var(--shell-fg)" }}
                >
                  {intent === "login" ? "Sign up" : "Log in"}
                </button>
              ) : (
                <Link
                  href={alternateHref}
                  replace
                  className="rounded-sm font-medium underline underline-offset-4 transition-opacity duration-150 hover:opacity-75 active:opacity-60"
                  style={{ color: "var(--shell-fg)" }}
                >
                  {intent === "login" ? "Sign up" : "Log in"}
                </Link>
              )}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="absolute left-4 h-5 w-5">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.4-4H3.3v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.6 14a6 6 0 0 1 0-3.9V7.5H3.3a10 10 0 0 0 0 9.1L6.6 14Z" />
      <path fill="#EA4335" d="M12 6a5.4 5.4 0 0 1 3.8 1.5l2.8-2.8A9.5 9.5 0 0 0 12 2a10 10 0 0 0-8.7 5.5l3.3 2.6A5.8 5.8 0 0 1 12 6Z" />
    </svg>
  );
}
