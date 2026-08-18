import Link from "next/link";

import { confirmEffectAction, declineEffectAction } from "@/app/actions";
import type { ProposedEffectView } from "@/core/effects";

/**
 * The one screen where Zeus asks permission to change something outside itself.
 *
 * It shows the plain-language preview *and* the exact request, because those answer
 * different questions — "what am I agreeing to?" and "what precisely will be sent?" — and
 * a person can only really consent to the second. The hash is displayed because it is
 * what the confirming message will contain: the record of consent names the bytes.
 */
export function PendingEffectsPanel({
  pending,
  recentlyExecuted,
  errorMessage,
}: {
  pending: ProposedEffectView[];
  recentlyExecuted: ProposedEffectView[];
  errorMessage: string | null;
}) {
  if (pending.length === 0 && recentlyExecuted.length === 0 && errorMessage === null) return null;

  return (
    <section id="confirmations" className="mt-10 max-w-[54rem]">
      <h2 className="text-[0.95rem] font-medium leading-5">Waiting for your confirmation</h2>
      <p className="mt-1 max-w-[64ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
        I prepared these. None of them has happened.
      </p>

      {errorMessage ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border px-3 py-2 text-[0.82rem] leading-5"
          style={{ borderColor: "#7f1d1d" }}
        >
          {errorMessage}
        </p>
      ) : null}

      {pending.length === 0 ? (
        <p className="mt-3 text-[0.84rem] leading-6" style={{ color: "var(--shell-faint)" }}>
          Nothing is waiting.
        </p>
      ) : (
        <ul className="mt-4 space-y-4">
          {pending.map((effect) => (
            <PendingEffectCard key={effect.id} effect={effect} />
          ))}
        </ul>
      )}

      {recentlyExecuted.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-[0.84rem] font-medium leading-5">Done recently</h3>
          <ul className="mt-3 space-y-3">
            {recentlyExecuted.map((effect) => (
              <ExecutedEffectRow key={effect.id} effect={effect} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PendingEffectCard({ effect }: { effect: ProposedEffectView }) {
  return (
    <li className="rounded-xl border px-5 py-5" style={{ borderColor: "var(--shell-line-strong)" }}>
      <span
        className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
        style={{ color: "var(--shell-faint)" }}
      >
        {effect.capability.slot} · {effect.connector.label}
      </span>
      <h3 className="mt-2 text-[1rem] font-medium leading-6">{effect.preview_text}</h3>

      <details className="mt-3">
        <summary className="cursor-pointer text-[0.8rem]" style={{ color: "var(--shell-muted)" }}>
          Exactly what will be sent
        </summary>
        <pre
          className="mt-2 overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[0.7rem] leading-5"
          style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
        >
          {JSON.stringify(effect.payload, null, 2)}
        </pre>
        <p className="mt-2 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
          {effect.capability.remote_tool_name} · {effect.payload_hash}
        </p>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-[0.8rem]">
        <form action={confirmEffectAction}>
          <input type="hidden" name="id" value={effect.id} />
          <input type="hidden" name="payloadHash" value={effect.payload_hash} />
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 font-medium"
            style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
          >
            Confirm and send
          </button>
        </form>
        <form action={declineEffectAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={effect.id} />
          <label className="sr-only" htmlFor={`decline-${effect.id}`}>
            Why not
          </label>
          <input
            id={`decline-${effect.id}`}
            name="reason"
            placeholder="Why not (optional)"
            maxLength={500}
            className="min-h-[32px] w-[16rem] max-w-full rounded-md border px-2.5 text-[0.8rem]"
            style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-elevated)" }}
          />
          <button type="submit" className="underline underline-offset-2" style={{ color: "var(--shell-muted)" }}>
            Do not send
          </button>
        </form>
      </div>

      <p className="mt-3 text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
        Expires {effect.expires_at.slice(0, 10)}. If you do nothing, nothing happens.
      </p>
    </li>
  );
}

function ExecutedEffectRow({ effect }: { effect: ProposedEffectView }) {
  const reverted = effect.status === "reverted";
  return (
    <li className="rounded-lg border px-4 py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[0.84rem] leading-5">{effect.preview_text}</span>
        <span
          className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
          style={{ color: "var(--shell-faint)" }}
        >
          {reverted ? "undone" : "done"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
        <Link href={`/effects/${effect.id}`} className="underline underline-offset-2">
          receipt
        </Link>
      </div>
    </li>
  );
}
