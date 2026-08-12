"use client";

import { useState } from "react";

export function CoarseLocationControl({
  enabled,
  consent,
  currentZone,
  expiresAt,
}: {
  enabled: boolean;
  consent: boolean;
  currentZone: string | null;
  expiresAt: string | null;
}) {
  const [zone, setZone] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function sample() {
    const requestedZone = zone.replace(/\s+/gu, " ").trim();
    if (busy || !enabled || !consent) return;
    if (!("geolocation" in navigator)) {
      setStatus("This browser cannot provide a foreground location observation.");
      return;
    }
    setBusy(true);
    setStatus(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // The browser converts the observation into a coarse ~2 km cell. Only the
        // browser keeps the cell-to-name map; raw coordinates never leave this callback.
        const cell = coarseCell(position.coords.latitude, position.coords.longitude);
        const zones = browserZoneMap();
        const namedZone = requestedZone || zones[cell];
        if (!namedZone) {
          setStatus("Name this location once so the browser can recognize its coarse zone.");
          setBusy(false);
          return;
        }
        if (requestedZone) storeBrowserZone(cell, requestedZone);
        void postZone(namedZone, new Date(position.timestamp || Date.now()).toISOString())
          .then(() => {
            setZone("");
            setStatus(`${namedZone} is available to Zeus for 30 minutes.`);
          })
          .catch((error: unknown) =>
            setStatus(error instanceof Error ? error.message : "The coarse zone was rejected."),
          )
          .finally(() => setBusy(false));
      },
      (error) => {
        setStatus(error.message || "Location permission was not granted.");
        setBusy(false);
      },
      { enableHighAccuracy: false, maximumAge: 0, timeout: 10_000 },
    );
  }

  return (
    <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--shell-line)" }}>
      <p className="text-sm leading-5">Foreground coarse zone</p>
      <p className="mt-1 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
        Permission is requested only when you press Share. Your browser maps a coarse location
        cell to a name you choose; raw coordinates are immediately discarded and never sent to
        Zeus. The server receives only the zone name and a timestamp that expires in 30 minutes.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          disabled={!enabled || !consent || busy}
          maxLength={120}
          placeholder="Name a new zone, or leave blank to recognize one"
          aria-label="Coarse zone name"
          className="min-h-9 flex-1 rounded-lg border px-3 text-sm"
          style={{
            background: "var(--shell-elevated)",
            borderColor: "var(--shell-line-strong)",
          }}
        />
        <button
          type="button"
          onClick={sample}
          disabled={!enabled || !consent || busy}
          className="min-h-9 rounded-lg border px-3 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--shell-line-strong)" }}
        >
          {busy ? "Sampling…" : "Share current zone"}
        </button>
      </div>
      {(status || currentZone) && (
        <p className="mt-2 text-xs leading-4" style={{ color: "var(--shell-muted)" }}>
          {status ?? `${currentZone} · expires ${expiresAt ? new Date(expiresAt).toLocaleTimeString() : "soon"}`}
        </p>
      )}
    </div>
  );
}

const ZONE_MAP_KEY = "zeus.coarse-zone-map.v1";

function coarseCell(latitude: number, longitude: number): string {
  // 0.02° is roughly 2.2 km north/south. This intentionally trades precision for a
  // stable, local-only zone lookup; the server never receives this value.
  const cellSize = 0.02;
  return `${Math.floor(latitude / cellSize)}:${Math.floor(longitude / cellSize)}`;
}

function browserZoneMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ZONE_MAP_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([cell, label]) => /^-?\d+:-?\d+$/u.test(cell) && typeof label === "string",
      ),
    );
  } catch {
    return {};
  }
}

function storeBrowserZone(cell: string, zone: string): void {
  try {
    window.localStorage.setItem(ZONE_MAP_KEY, JSON.stringify({ ...browserZoneMap(), [cell]: zone }));
  } catch {
    // Private browsing may disable local storage. The current attestation still works;
    // the user will simply name the zone again next time.
  }
}

async function postZone(zoneId: string, observedAt: string): Promise<void> {
  const response = await fetch("/api/location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ zoneId, observedAt }),
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? "The coarse zone was rejected.");
}
