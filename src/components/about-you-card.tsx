"use client";

import { useState } from "react";

import {
  closeAboutYouItemAction,
  correctAboutYouItemAction,
  openAboutYouSourceAction,
  removeAboutYouItemAction,
  restoreAboutYouItemAction,
} from "@/app/about-you/actions";
import type { AboutYouItem } from "@/core/consumer-dtos";

export function AboutYouCard({ item }: { item: AboutYouItem }) {
  const [mode, setMode] = useState<"idle" | "correct" | "remove">("idle");
  const historical = item.endedAt !== null;

  return (
    <li
      id={item.id}
      className="rounded-xl border px-4 py-4"
      style={{
        background: "var(--shell-panel)",
        borderColor: "var(--shell-line)",
        opacity: historical ? 0.78 : 1,
      }}
    >
      {mode === "correct" ? (
        <form action={correctAboutYouItemAction}>
          <input type="hidden" name="id" value={item.id} />
          <label htmlFor={`correction-${item.id}`} className="text-xs font-medium" style={{ color: "var(--shell-muted)" }}>
            Correct this saved detail
          </label>
          <textarea
            id={`correction-${item.id}`}
            name="correction"
            defaultValue={item.editableText}
            required
            autoFocus
            maxLength={2_000}
            rows={2}
            className="mt-2 w-full resize-y rounded-lg border px-3 py-2 text-sm leading-6"
            style={{
              background: "var(--shell-elevated)",
              borderColor: "var(--shell-accent-line)",
              color: "var(--shell-fg)",
            }}
          />
          <div className="mt-3 flex items-center gap-3 text-sm">
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 font-medium"
              style={{ background: "var(--shell-accent)", color: "#000000" }}
            >
              Save correction
            </button>
            <button type="button" onClick={() => setMode("idle")} style={{ color: "var(--shell-muted)" }}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-[0.94rem] leading-6">{item.statement}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs" style={{ color: "var(--shell-faint)" }}>
            <span>
              {historical && item.endedAt
                ? `No longer true since ${displayDate(item.endedAt)}`
                : `Saved ${displayDate(item.learnedAt)}`}
            </span>
            {item.sourceId && (
              <form action={openAboutYouSourceAction}>
                <input type="hidden" name="sourceId" value={item.sourceId} />
                <button type="submit" className="underline underline-offset-2">
                  See where this came from
                </button>
              </form>
            )}
          </div>

          {mode === "remove" ? (
            <div
              className="mt-4 rounded-lg border px-3 py-3 text-sm"
              style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
            >
              <p className="font-medium">Remove this from memory?</p>
              <p className="mt-1 text-xs leading-5" style={{ color: "var(--shell-muted)" }}>
                The saved detail will be removed. Its source chat will stay in your chat history.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <form action={removeAboutYouItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <button type="submit" className="font-medium" style={{ color: "#ff7b7b" }}>
                    Remove from memory
                  </button>
                </form>
                <button type="button" onClick={() => setMode("idle")} style={{ color: "var(--shell-muted)" }}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              {!historical && (
                <button type="button" onClick={() => setMode("correct")} style={{ color: "var(--shell-muted)" }}>
                  Correct
                </button>
              )}
              {historical ? (
                item.canRestore && (
                  <form action={restoreAboutYouItemAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" style={{ color: "var(--shell-muted)" }}>
                      This is true again
                    </button>
                  </form>
                )
              ) : (
                <form action={closeAboutYouItemAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <button type="submit" style={{ color: "var(--shell-muted)" }}>
                    No longer true
                  </button>
                </form>
              )}
              <button type="button" onClick={() => setMode("remove")} style={{ color: "var(--shell-muted)" }}>
                Remove from memory
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

function displayDate(value: string): string {
  return value.slice(0, 10);
}
