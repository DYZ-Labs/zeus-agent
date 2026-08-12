"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

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
}: {
  intent: "login" | "signup";
  next: string;
  authMode: AuthMode;
  canonicalSiteUrl: string | null;
  googleEnabled: boolean | null;
  initialMessage: string | null;
  blockedAccount: AccountSummary | null;
}) {
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

  return (
    <div className="h-full w-full overflow-y-auto bg-white text-[#2d2d2d]">
      <div className="flex min-h-full w-full items-center justify-center px-5 py-10">
        <div className="w-full max-w-[25rem] text-center" aria-busy={!originReady}>
        <Link
          href="/"
          className="mx-auto inline-flex h-10 items-center gap-2 text-lg font-semibold tracking-[-0.025em]"
          aria-label="Zeus home"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black text-xs font-bold text-white">
            Z
          </span>
          Zeus
        </Link>

        <h1 className="mt-7 text-[2rem] font-semibold leading-tight tracking-[-0.035em] text-[#202020]">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-5 text-[#6f6f6f]">
          {intent === "login"
            ? "Continue to the personal AI that remembers with receipts."
            : "Give Zeus a verified account for your private memory store."}
        </p>
        {!originReady && (
          <p role="status" className="mt-4 text-sm text-[#6f6f6f]">
            Opening secure login…
          </p>
        )}

        {blockedAccount ? (
          <section className="mt-7 rounded-xl border border-[#d9d9d9] bg-[#f7f7f7] px-4 py-4 text-left">
            <p className="text-sm font-medium text-[#202020]">Different account detected</p>
            <p className="mt-1 text-sm leading-5 text-[#6f6f6f]">
              {blockedAccount.email} is signed in, but it is not linked to this Zeus store.
            </p>
            <form action={logoutAction} className="mt-4">
              <button
                type="submit"
                className="h-11 w-full rounded-lg bg-black px-4 text-sm font-medium text-white hover:bg-[#2b2b2b]"
              >
                Log out and try another account
              </button>
            </form>
          </section>
        ) : (
          <>
            <form action={formAction} className="mt-8 text-left">
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
                autoFocus={originReady}
                disabled={!configured || !originReady || pending}
                placeholder="Email address"
                className="h-[3.25rem] w-full rounded-lg border border-[#b8b8b8] bg-white px-4 text-base text-[#202020] outline-none transition-shadow placeholder:text-[#777] focus:border-[#202020] focus:ring-1 focus:ring-[#202020] disabled:bg-[#f4f4f4]"
              />
              <button
                type="submit"
                disabled={!configured || !originReady || pending}
                className="mt-3 h-[3.25rem] w-full rounded-lg bg-black px-4 text-base font-medium text-white transition-colors hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:bg-[#aaa]"
              >
                {pending ? "Sending…" : "Continue"}
              </button>
            </form>

            <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-[0.08em] text-[#8a8a8a]">
              <span className="h-px flex-1 bg-[#dedede]" />
              or
              <span className="h-px flex-1 bg-[#dedede]" />
            </div>

            <form action={startGoogleAuthAction}>
              <input type="hidden" name="next" value={next} />
              <button
                type="submit"
                disabled={!configured || !originReady || googleEnabled === false}
                className="relative flex h-[3.25rem] w-full items-center justify-center rounded-lg border border-[#b8b8b8] bg-white px-12 text-base font-medium text-[#202020] transition-colors hover:bg-[#f7f7f7] disabled:cursor-not-allowed disabled:bg-[#f4f4f4] disabled:text-[#999]"
              >
                <GoogleIcon />
                {googleEnabled === false ? "Google not enabled" : "Continue with Google"}
              </button>
            </form>
            {googleEnabled === false && (
              <p className="mt-2 text-xs leading-5 text-[#7f1d1d]">
                Enable Google under Supabase Authentication → Sign In / Providers.
              </p>
            )}
          </>
        )}

        {(initialMessage || state.message || !configured) && !blockedAccount && (
          <p
            role="status"
            className="mt-5 rounded-lg px-3 py-2.5 text-sm leading-5"
            style={{
              color: state.status === "sent" ? "#166534" : "#7f1d1d",
              background: state.status === "sent" ? "#f0fdf4" : "#fef2f2",
            }}
          >
            {state.message ||
              initialMessage ||
              (authMode === "local"
                ? "Supabase login is not configured yet. See .env.example to enable it."
                : "Supabase login configuration is incomplete.")}
          </p>
        )}

        <p className="mt-7 text-sm text-[#6f6f6f]">
          {intent === "login" ? "New to Zeus?" : "Already have an account?"}{" "}
          <Link
            href={alternateHref}
            className="font-medium text-[#202020] underline underline-offset-4"
          >
            {intent === "login" ? "Sign up" : "Log in"}
          </Link>
        </p>
        </div>
      </div>
    </div>
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
