"use client";

import Link from "next/link";
import { useState } from "react";

import {
  editFactAction,
  forgetFactAction,
  reviveFactAction,
  supersedeFactAction,
} from "@/app/actions";
import type { FactView } from "@/core/schema";

/**
 * One fact, with everything needed to judge it: what it says, how sure Zeus is, when
 * it was learned, whether it is still true, and the message it came from.
 *
 * Superseded facts are dimmed rather than flagged red — going out of date is the
 * normal life of a fact, not an error condition.
 */
export function FactRow({ fact, showSubject = true }: { fact: FactView; showSubject?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const closed = fact.valid_to !== null;

  return (
    <li
      className="group border-b py-3.5"
      style={{ borderColor: "var(--shell-line)", opacity: closed ? 0.55 : 1 }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {showSubject && (
          <Link
            href={`/entity/${fact.subject_slug}`}
            className="text-[0.92rem] font-medium underline-offset-2 hover:underline"
          >
            {fact.subject_slug === "self" ? "You" : fact.subject_name}
          </Link>
        )}

        {/* Left as snake_case on purpose: it reads as a field identifier rather than
            as broken prose ("You works at Beta Systems"). */}
        <span
          className="font-mono text-[0.72rem] tracking-[0.02em]"
          style={{ color: "var(--shell-faint)" }}
        >
          {fact.predicate}
        </span>

        {editing ? (
          <form action={editFactAction} className="flex flex-1 items-center gap-2">
            <input type="hidden" name="id" value={fact.id} />
            <input
              name="object"
              defaultValue={fact.object}
              autoFocus
              className="min-h-[36px] min-w-0 flex-1 rounded-[3px] border px-2 py-1 text-[0.92rem]"
              style={{
                background: "var(--shell-panel)",
                borderColor: "var(--shell-accent)",
                color: "var(--shell-fg)",
              }}
            />
            <button type="submit" className="text-[0.78rem]" style={{ color: "var(--shell-accent)" }}>
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[0.78rem]"
              style={{ color: "var(--shell-faint)" }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <span className="text-[0.92rem]" style={{ color: "var(--shell-fg)" }}>
            {fact.object_entity_slug ? (
              <Link
                href={`/entity/${fact.object_entity_slug}`}
                className="underline-offset-2 hover:underline"
              >
                {fact.object}
              </Link>
            ) : (
              fact.object
            )}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.66rem]">
        <span style={{ color: "var(--shell-faint)" }}>learned {fact.created_at.slice(0, 10)}</span>

        {fact.valid_from.slice(0, 10) !== fact.created_at.slice(0, 10) && (
          <span style={{ color: "var(--shell-faint)" }}>
            effective {fact.valid_from.slice(0, 10)}
          </span>
        )}

        {closed && (
          <span style={{ color: "var(--shell-faint)" }}>
            ended {fact.valid_to?.slice(0, 10)}
          </span>
        )}

        <Confidence value={fact.confidence} />

        {fact.assertion_count > 1 && (
          <span style={{ color: "var(--shell-faint)" }}>said {fact.assertion_count}×</span>
        )}

        {fact.source_message_id !== null && (
          <Link
            href={`/source/${fact.source_message_id}`}
            className="underline underline-offset-2"
            style={{ color: "var(--shell-faint)" }}
          >
            source
          </Link>
        )}

        {!editing && (
          // Always present, dimmed until hover or focus. A hover-only reveal would be
          // unreachable on touch, and these are the controls that make the memory
          // correctable.
          <span className="ml-auto flex items-center gap-3 opacity-60 transition-opacity duration-150 ease-out focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => setEditing(true)}
              style={{ color: "var(--shell-muted)" }}
            >
              edit
            </button>

            <form action={closed ? reviveFactAction : supersedeFactAction}>
              <input type="hidden" name="id" value={fact.id} />
              <button type="submit" style={{ color: "var(--shell-muted)" }}>
                {closed ? "still true" : "no longer true"}
              </button>
            </form>

            {confirming ? (
              <form action={forgetFactAction} className="flex items-center gap-2">
                <input type="hidden" name="id" value={fact.id} />
                <button type="submit" style={{ color: "var(--shell-accent)" }}>
                  confirm forget
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  style={{ color: "var(--shell-faint)" }}
                >
                  keep
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                style={{ color: "var(--shell-muted)" }}
              >
                forget
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** A four-segment meter. Reads faster than a decimal when scanning a long list. */
function Confidence({ value }: { value: number }) {
  const filled = Math.max(1, Math.round(value * 4));

  return (
    <span
      className="inline-flex items-center gap-1"
      title={`confidence ${value.toFixed(2)}`}
      style={{ color: "var(--shell-faint)" }}
    >
      <span aria-hidden className="inline-flex gap-[2px]">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className="inline-block h-[8px] w-[3px]"
            style={{
              background:
                index < filled ? "var(--shell-accent)" : "var(--shell-line-strong)",
            }}
          />
        ))}
      </span>
      <span className="sr-only">confidence {value.toFixed(2)}</span>
    </span>
  );
}
