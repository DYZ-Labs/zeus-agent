"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Chat", icon: "chat" },
  { href: "/memory", label: "Memory", icon: "memory" },
  { href: "/open-loops", label: "Open loops", icon: "loops" },
  { href: "/timeline", label: "Timeline", icon: "timeline" },
  { href: "/conversations", label: "Sources", icon: "sources" },
] as const;

type IconName = (typeof LINKS)[number]["icon"];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-b px-3 py-3 lg:h-screen lg:w-[260px] lg:border-b-0 lg:px-3"
      style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
    >
      <Link
        href="/"
        className="flex h-10 shrink-0 items-center gap-3 rounded-lg px-2 transition-colors hover:bg-white/[0.06]"
      >
        <ZeusMark />
        <span className="text-[0.95rem] font-semibold tracking-[-0.01em]">Zeus</span>
      </Link>

      <ul className="mt-2 flex w-full min-w-0 gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {LINKS.map((link) => {
          const active =
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);

          return (
            <li key={link.href} className="shrink-0 lg:w-full">
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className="flex h-10 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors hover:bg-white/[0.06] lg:w-full"
                style={{
                  color: active ? "var(--shell-fg)" : "var(--shell-muted)",
                  background: active ? "var(--shell-elevated)" : undefined,
                }}
              >
                <NavIcon name={link.icon} />
                <span>{link.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <div
        className="mt-auto hidden border-t px-2 pt-3 lg:flex lg:items-center lg:gap-3"
        style={{ borderColor: "var(--shell-line)" }}
      >
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full text-[0.7rem] font-semibold"
          style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
        >
          Z
        </span>
        <div className="min-w-0">
          <p className="text-[0.82rem] font-medium">Local memory</p>
          <p className="truncate text-[0.7rem]" style={{ color: "var(--shell-faint)" }}>
            Private on this device
          </p>
        </div>
      </div>
    </nav>
  );
}

function ZeusMark() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 items-center justify-center rounded-full text-[0.72rem] font-bold"
      style={{ background: "var(--shell-accent)", color: "#000000" }}
    >
      Z
    </span>
  );
}

function NavIcon({ name }: { name: IconName }) {
  if (name === "chat") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 18.5 3.5 21v-5A8.5 8.5 0 1 1 7 18.5Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "memory") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 5.5a3 3 0 0 1 5.4-1.8A3.2 3.2 0 0 1 18 6.6a3.5 3.5 0 0 1 1 6.7A3.5 3.5 0 0 1 15.5 18H14a3 3 0 0 1-5.5.6A3.5 3.5 0 0 1 5 13.2a3.5 3.5 0 0 1 3-6.7Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 5v14M8 9h4M12 14h4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "loops") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 7h10v10H7z" strokeLinejoin="round" />
        <path d="m9.5 12 1.7 1.7 3.5-3.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "timeline") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M5 6h14M5 12h9M5 18h6" strokeLinecap="round" />
        <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="15" cy="18" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 5.5h14v13H5z" strokeLinejoin="round" />
      <path d="M8 9h8M8 12h8M8 15h5" strokeLinecap="round" />
    </svg>
  );
}
