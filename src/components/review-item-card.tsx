"use client";

import { useState } from "react";

import {
  openAboutYouSourceAction,
  rejectReviewItemAction,
  saveReviewItemAction,
} from "@/app/about-you/actions";
import type { ConsumerReviewItem } from "@/core/consumer-dtos";

const REASON_COPY: Readonly<Record<ConsumerReviewItem["reason"], string>> = {
  uncertain: "Zeus isn’t certain this is a detail you want remembered.",
  sensitive: "This may be sensitive, so Zeus is waiting for your approval.",
  conflict: "This may replace or change something you already saved.",
  ambiguous: "This could mean more than one thing, so Zeus needs your confirmation.",
};

export function ReviewItemCard({ item }: { item: ConsumerReviewItem }) {
  const [editing, setEditing] = useState(false);

  return (
    <li
      id={item.id}
      className="rounded-xl border px-4 py-4"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
    >
      <p className="text-xs font-medium" style={{ color: "var(--shell-accent)" }}>
        {item.category}
      </p>
      <form action={saveReviewItemAction} className="mt-2">
        <input type="hidden" name="id" value={item.id} />
        {editing ? (
          <>
            <label htmlFor={`review-statement-${item.id}`} className="sr-only">
              Edit the wording Zeus should save
            </label>
            <textarea
              id={`review-statement-${item.id}`}
              name="editedText"
              defaultValue={item.editableText}
              required
              autoFocus
              maxLength={1_000}
              rows={2}
              className="w-full resize-y rounded-lg border px-3 py-2 text-[0.94rem] leading-6"
              style={{
                background: "var(--shell-elevated)",
                borderColor: "var(--shell-accent-line)",
                color: "var(--shell-fg)",
              }}
            />
          </>
        ) : (
          <p className="text-[0.96rem] leading-6">{item.statement}</p>
        )}

        <p className="mt-2 text-xs leading-5" style={{ color: "var(--shell-muted)" }}>
          {REASON_COPY[item.reason]}
        </p>

        <div className="mt-4 space-y-2">
          {item.evidence.map((evidence, index) => (
            <blockquote
              key={`${evidence.sourceId}-${index}`}
              className="rounded-lg border-l-2 px-3 py-2 text-sm leading-5"
              style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-accent-line)" }}
            >
              <p>“{evidence.quote}”</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs" style={{ color: "var(--shell-faint)" }}>
                <time dateTime={evidence.date}>{displayDate(evidence.date)}</time>
                <SourceButton sourceId={evidence.sourceId} />
              </div>
            </blockquote>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <button
            type="submit"
            className="rounded-lg px-3 py-1.5 font-medium"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            {editing ? "Save edited wording" : "Save"}
          </button>
          {!editing && (
            <button type="button" onClick={() => setEditing(true)} style={{ color: "var(--shell-muted)" }}>
              Edit
            </button>
          )}
          {editing && (
            <button type="button" onClick={() => setEditing(false)} style={{ color: "var(--shell-muted)" }}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {!editing && (
        <form action={rejectReviewItemAction} className="mt-2">
          <input type="hidden" name="id" value={item.id} />
          <button type="submit" className="text-sm" style={{ color: "var(--shell-muted)" }}>
            Don’t save
          </button>
        </form>
      )}
    </li>
  );
}

function SourceButton({ sourceId }: { sourceId: string }) {
  return (
    <button
      type="submit"
      formAction={openAboutYouSourceAction}
      name="sourceId"
      value={sourceId}
      className="underline underline-offset-2"
    >
      View chat
    </button>
  );
}

function displayDate(value: string): string {
  return value.slice(0, 10);
}
