export function PageHeader({
  title,
  meta,
  eyebrow,
}: {
  title: string;
  meta?: string;
  eyebrow?: string;
}) {
  return (
    <header
      className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-5 py-3 lg:px-8"
      style={{ borderColor: "var(--shell-line)" }}
    >
      <div className="flex items-baseline gap-2.5">
        {eyebrow && (
          <span
            className="font-mono text-[0.64rem] uppercase tracking-[0.14em]"
            style={{ color: "var(--shell-faint)" }}
          >
            {eyebrow}
          </span>
        )}
        <h1 className="text-[1rem] font-semibold tracking-[-0.015em]">{title}</h1>
      </div>
      {meta && (
        <p className="font-mono text-[0.68rem]" style={{ color: "var(--shell-faint)" }}>
          {meta}
        </p>
      )}
    </header>
  );
}
