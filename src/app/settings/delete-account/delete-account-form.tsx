"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  deleteAccountAction,
  initialDeleteAccountState,
} from "./actions";

export function DeleteAccountForm({ available }: { available: boolean }) {
  const [state, action, pending] = useActionState(
    deleteAccountAction,
    initialDeleteAccountState,
  );

  return (
    <form action={action} className="mt-7">
      <label htmlFor="delete-account-confirmation" className="block text-sm font-medium">
        Type DELETE to confirm
      </label>
      <input
        id="delete-account-confirmation"
        name="confirmation"
        autoComplete="off"
        disabled={!available || pending}
        className="mt-2 h-11 w-full rounded-xl border px-3 text-sm outline-none disabled:opacity-50"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      />
      {state.status === "error" && (
        <p role="alert" className="mt-3 text-sm leading-5" style={{ color: "#ff8b8b" }}>
          {state.message}
        </p>
      )}
      {!available && (
        <p className="mt-3 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          Account deletion is temporarily unavailable. You can still clear all Zeus data from
          Data controls.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={!available || pending}
          className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ borderColor: "#7f1d1d", color: "#ff8585" }}
        >
          {pending ? "Deleting…" : "Delete account permanently"}
        </button>
        <Link href="/settings#data" className="text-sm underline underline-offset-4" style={{ color: "var(--shell-muted)" }}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
