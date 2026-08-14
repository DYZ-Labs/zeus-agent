import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { getProposedEffect } from "@/core/effects";
import { listToolReceipts } from "@/core/work-plans";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

/**
 * The full record of one external request.
 *
 * Zeus's whole claim about acting is that the user can check it afterwards, so this page
 * shows the chain end to end: what was proposed, which message confirmed it, whether it
 * was actually sent, and whether it was undone.
 */
export default async function EffectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = await requireOwnerPageDb();
  const effect = getProposedEffect(db, id);
  if (!effect) notFound();
  const receipts = listToolReceipts(db, effect.work_run_id).filter(
    (receipt) => receipt.proposed_effect_id === effect.id,
  );

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title={effect.preview_text} meta={`${effect.capability.slot} · ${STATUS_LABEL[effect.status]}`} />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link href="/today#confirmations" className="font-mono text-[0.68rem] underline underline-offset-2">
          ← waiting for confirmation
        </Link>

        <Section title="The request">
          <p className="text-[0.8rem] leading-6" style={{ color: "var(--shell-muted)" }}>
            {effect.capability.remote_tool_name} via {effect.connector.label}
          </p>
          <pre
            className="mt-3 overflow-x-auto rounded-lg border px-3 py-2 font-mono text-[0.72rem] leading-5"
            style={{ borderColor: "var(--shell-line)" }}
          >
            {JSON.stringify(effect.payload, null, 2)}
          </pre>
          <p className="mt-2 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
            {effect.payload_hash}
          </p>
        </Section>

        <Section title="What happened">
          <ol className="space-y-3 text-[0.82rem]">
            {effect.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-[0.66rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
                  {event.event_type}
                </span>
                <span style={{ color: "var(--shell-muted)" }}>{event.created_at}</span>
                {event.source_message_id !== null ? (
                  <Link
                    href={`/source/${event.source_message_id}`}
                    className="font-mono text-[0.66rem] underline underline-offset-2"
                  >
                    your message {event.source_message_id}
                  </Link>
                ) : null}
                {event.detail_json ? (
                  <span className="font-mono text-[0.66rem]" style={{ color: "var(--shell-faint)" }}>
                    {event.detail_json}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {effect.status === "pending_confirmation" ? (
            <p className="mt-4 text-[0.84rem] leading-6">
              Nothing has been sent. This expires {effect.expires_at.slice(0, 10)}.
            </p>
          ) : null}
        </Section>

        <Section title="Calls that left this machine">
          {receipts.length === 0 ? (
            <p className="text-[0.84rem] leading-6" style={{ color: "var(--shell-faint)" }}>
              None. Zeus prepared this request but never sent it.
            </p>
          ) : (
            <ul className="space-y-2 font-mono text-[0.7rem]" style={{ color: "var(--shell-muted)" }}>
              {receipts.map((receipt) => (
                <li key={receipt.id}>
                  {receipt.tool_name} · {receipt.status}
                  {receipt.error_code ? ` · ${receipt.error_code}` : ""} · {receipt.started_at}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <p className="mt-8 max-w-[68ch] text-[0.78rem] leading-6" style={{ color: "var(--shell-faint)" }}>
          Zeus stores no credential for {effect.connector.label}. It reached the service{" "}
          {effect.connector.preset_id === "google-calendar-official"
            ? "with a short-lived Google ADC token resolved in memory for that call."
            : "through a server you configured, using only the environment values you named."}
        </p>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: "waiting for you",
  confirmed: "confirmed, not yet sent",
  declined: "you declined it",
  expired: "expired unanswered",
  executed: "sent",
  failed: "failed",
  reverted: "undone",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 max-w-[76ch] border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
      <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
