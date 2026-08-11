"use client";

import { useState } from "react";

import { deleteAllConversationsAction } from "@/app/actions";

export function DeleteAllConversations({ disabled = false }: { disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={deleteAllConversationsAction} className="flex shrink-0 items-center gap-3">
      <input type="hidden" name="confirmation" value="delete-all" />
      {confirming && (
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[0.78rem]"
          style={{ color: "var(--shell-muted)" }}
        >
          Cancel
        </button>
      )}
      <button
        type={confirming ? "submit" : "button"}
        disabled={disabled}
        onClick={() => {
          if (!confirming) setConfirming(true);
        }}
        className="min-w-[9.5rem] rounded-lg border px-3 py-2 text-[0.78rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: confirming ? "#7f1d1d" : "var(--shell-panel)",
          borderColor: confirming ? "#b91c1c" : "var(--shell-line-strong)",
          color: confirming ? "#ffffff" : "var(--shell-fg)",
        }}
      >
        {confirming ? "Are you sure?" : "Delete all conversations"}
      </button>
    </form>
  );
}
