"use client";

import { useEffect, useState } from "react";

import { AuthForm } from "@/components/auth-form";
import { OPEN_AUTH_EVENT, type AuthIntent } from "@/components/auth-events";
import type { AccountSummary, AuthMode } from "@/lib/auth-types";

type OpenAuthState = {
  intent: AuthIntent;
  next: string;
};

export function AuthModalHost({
  authMode,
  canonicalSiteUrl,
  blockedAccount,
}: {
  authMode: AuthMode;
  canonicalSiteUrl: string | null;
  blockedAccount: AccountSummary | null;
}) {
  const [open, setOpen] = useState<OpenAuthState | null>(null);

  useEffect(() => {
    function showAuth(event: Event) {
      const intent = (event as CustomEvent<{ intent?: AuthIntent }>).detail?.intent;
      if (intent !== "login" && intent !== "signup") return;
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      setOpen({ intent, next });
    }

    window.addEventListener(OPEN_AUTH_EVENT, showAuth);
    return () => window.removeEventListener(OPEN_AUTH_EVENT, showAuth);
  }, []);

  if (!open) return null;

  return (
    <AuthForm
      key={open.intent}
      intent={open.intent}
      next={open.next}
      authMode={authMode}
      canonicalSiteUrl={canonicalSiteUrl}
      googleEnabled={null}
      initialMessage={null}
      blockedAccount={blockedAccount}
      onClose={() => setOpen(null)}
      onIntentChange={(intent) => setOpen((current) => current && { ...current, intent })}
    />
  );
}
