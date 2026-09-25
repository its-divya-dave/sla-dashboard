// Display helpers. Formatting only — no business logic lives here.

export function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(3)}%`;
}

export function fmtMs(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(1)} ms`;
}

// Minutes as a compact "Xh Ym" where it helps readability.
export function fmtMinutes(v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (v < 60) return `${v} min`;
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// UTC everywhere — the pipeline stores UTC, so the UI shows UTC to avoid
// reintroducing the timezone bug the pipeline exists to fix.
export function fmtDateTimeUTC(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function fmtDateUTC(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export function fmtMonth(iso: string): string {
  // e.g. "2025-04"
  return new Date(iso).toISOString().slice(0, 7);
}
