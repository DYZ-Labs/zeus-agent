"use client";

import { useState } from "react";

import { deleteAllConversationsAction } from "@/app/actions";

export function DeleteAllConversations({ disabled = false }: { disabled?: boolean }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <form
      action={deleteAllConversationsAction}
      className="flex shrink-0 items-center gap-3"
      aria-label="Delete all conversations"
    >
      <input type="hidden" name="confirmation" value="delete-all" />
      {confirming ? (
        <>
          <button
            key="cancel-delete-all"
            type="button"
            onClick={() => setConfirming(false)}
            className="text-sm"
            style={{ color: "var(--shell-muted)" }}
          >
            Cancel
          </button>
          <button
            key="confirm-delete-all"
            type="submit"
            className="min-w-[7.5rem] rounded-lg border px-3 py-2 text-sm font-medium"
            style={{ background: "#7f1d1d", borderColor: "#b91c1c", color: "#ffffff" }}
          >
            Are you sure?
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
          className="min-w-[7.5rem] rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        >
          Delete
        </button>
      )}
    </form>
  );
}
