"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteAllRecentChatsAction } from "@/app/actions";

export function DeleteAllRecentChats({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirmDelete() {
    if (pending) return;

    const formData = new FormData();
    formData.set("confirmation", "delete-all-recent");
    setPending(true);

    try {
      await deleteAllRecentChatsAction(formData);
      setConfirming(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="group"
      className="flex shrink-0 items-center gap-2"
      aria-label="Delete all recent chats"
    >
      {confirming ? (
        <button
          key="confirm-delete-all"
          type="button"
          disabled={pending}
          onClick={() => void confirmDelete()}
          className="h-9 rounded-full border px-3.5 text-sm font-medium transition-colors hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-70"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "#ff6767",
          }}
        >
          Are you sure?
        </button>
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
    </div>
  );
}
