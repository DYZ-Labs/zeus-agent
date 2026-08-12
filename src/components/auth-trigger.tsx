"use client";

import type { CSSProperties, ReactNode } from "react";

import { openAuth, type AuthIntent } from "@/components/auth-events";

export function AuthTrigger({
  intent,
  children,
  className,
  style,
  ariaLabel,
  title,
}: {
  intent: AuthIntent;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openAuth(intent)}
      className={className}
      style={style}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  );
}
