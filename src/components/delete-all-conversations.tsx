"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { deleteAllConversationsAction } from "@/app/actions";

export function DeleteAllConversations({ disabled = false, label = "Delete" }: { disabled?: boolean; label?: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    if (pending) return;

    const formData = new FormData();
    formData.set("confirmation", "erase-all-sources");
    setPending(true);
    setError(null);

    try {
      await deleteAllConversationsAction(formData);
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Zeus data could not be cleared. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="group"
      className="flex shrink-0 items-center gap-2"
      aria-label="Permanently erase all Zeus data"
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
          Erase all Zeus data?
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
          {label}
        </button>
      )}
      {error && <span role="alert" className="max-w-48 text-xs" style={{ color: "#ff8585" }}>{error}</span>}
    </div>
  );
}
