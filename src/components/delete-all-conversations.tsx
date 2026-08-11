"use client";

import { useState } from "react";

import { deleteAllConversationsAction } from "@/app/actions";

export function DeleteAllConversations({ disabled = false }: { disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <form
      action={deleteAllConversationsAction}
      className="flex shrink-0 items-center gap-2"
      aria-label="Delete all conversations"
    >
      <input type="hidden" name="confirmation" value="delete-all" />
      {confirming ? (
        <>
          <button
            key="cancel-delete-all"
            type="button"
            onClick={() => setConfirming(false)}
            className="h-9 rounded-lg px-2.5 text-sm"
            style={{ color: "var(--shell-muted)" }}
          >
            Cancel
          </button>
          <button
            key="confirm-delete-all"
            type="submit"
            className="h-9 rounded-lg border px-3 text-sm font-medium"
            style={{ background: "#7f1d1d", borderColor: "#b91c1c", color: "#ffffff" }}
          >
            Confirm delete
          </button>
        </>
      ) : (
        <button
          key="arm-delete-all"
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            setConfirming(true);
          }}
          className="h-9 rounded-full border px-3.5 text-sm font-medium transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "#ff6767",
          }}
        >
          Delete
        </button>
      )}
    </form>
  );
}
