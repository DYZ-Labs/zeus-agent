"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { clearConversationHistoryAction } from "@/app/actions";

export function DeleteAllConversations({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function deleteAll() {
    if (pending) return;

    setPending(true);

    try {
      await clearConversationHistoryAction();
      router.refresh();
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  function handleClick() {
    if (!confirming) {
      setConfirming(true);
      return;
    }

    void deleteAll();
  }

  return (
    <div
      role="group"
      className="flex shrink-0 items-center gap-2"
      aria-label="Delete all conversations"
    >
      <button
        type="button"
        disabled={disabled || pending}
        onClick={handleClick}
        className="h-9 rounded-full border px-3.5 text-sm font-medium transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: "var(--shell-panel)",
          borderColor: "var(--shell-line-strong)",
          color: "#ff6767",
        }}
      >
        {confirming ? "Are you sure?" : "Delete"}
      </button>
    </div>
  );
}
