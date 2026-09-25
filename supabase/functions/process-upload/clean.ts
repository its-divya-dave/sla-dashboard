// ============================================================================
// clean.ts — the cleaning pipeline as one pure function.
//
// processUpload(csvText, filename) takes the raw CSV text of a monitoring file
// and returns the four sets of rows the schema needs: the uploads row, the
// checks rows (every raw line, flagged), the slots rows (one verdict per
// service per grid interval) and the incidents rows (down-slot groupings).
//
// It is deliberately pure: no network, no database, no filesystem, no clock.
// Everything it needs comes from the CSV text. That makes it unit-testable and
// lets the Edge Function import it unchanged and stay a thin wrapper.
//
// Runs under Deno with no imports. Standard JS/TS only.
// ============================================================================

// ---- Output shapes. snake_case to match the DB columns for a direct insert. --

export type SourceFormat = "iso" | "epoch" | "offset";
export type Verdict = "up" | "down" | "no_data";
export type IncidentKind = "incident" | "blip";

export interface CheckRow {
  service_id: string;
  service_name: string | null;
  raw_timestamp: string;
  raw_status: string | null;
  raw_latency: string | null;
  raw_latency_unit: string | null;
  agent: string | null;
  region: string | null;
  ts: string | null; // ISO-8601 UTC, or null if the raw value could not be parsed
  slot_ts: string | null; // ts floored to the derived grid boundary
  status_code: number | null;
  latency_ms: number | null;
  is_duplicate: boolean;
  latency_invalid: boolean;
  status_invalid: boolean;
  source_format: SourceFormat | null;
}

export interface SlotRow {
  service_id: string;
  slot_ts: string; // ISO-8601 UTC
  verdict: Verdict;
  latency_ms: number | null; // mean of the slot's valid-reading latencies
  valid_reading_count: number;
}

export interface IncidentRow {
  service_id: string;
  kind: IncidentKind;
  started_at: string;
  ended_at: string;
  down_slot_count: number;
  duration_minutes: number;
}

export interface UploadRow {
  filename: string;
  range_start: string | null;
  range_end: string | null;
  grid_minutes: number | null;
  rows_received: number;
  duplicates_collapsed: number;
  values_corrected: number;
  values_nulled: number;
  slots_no_data: number;
}

export interface ProcessResult {
  upload: UploadRow;
  checks: CheckRow[];
  slots: SlotRow[];
  incidents: IncidentRow[];
}

// Down slots on one service join the same candidate group when they are this
// many grid slots apart or fewer. 3 slots (45 min at a 15-min grid) not 2:
// real incidents flap with internal recovery gaps that long, and a 2-slot rule
// splits 21d svc-payments and truncates both 30d windows. Expressed in slots,
// not minutes, so it stays tied to the derived grid rather than assuming 15.
const MERGE_GAP_SLOTS = 3;
// A group needs at least this many down slots to be an incident; fewer is a blip.
const INCIDENT_MIN_SLOTS = 3;
// A candidate group is only an incident if its window median latency is at least
// this multiple of the service's baseline (see buildIncidents for the rationale
// and the measured separation).
const INCIDENT_LATENCY_MULTIPLE = 2.0;
const MS_PER_MINUTE = 60_000;

// ---------------------------------------------------------------------------
// CSV parsing. The files are plain comma-separated with a header, CRLF line
// endings, and no quoted fields (verified against all five samples). We map by
// header name, not position, so a reordered column would not silently corrupt
// the data. Values are trimmed; rows are otherwise untouched at this stage.
// ---------------------------------------------------------------------------
function parseCsv(csvText: string): Record<string, string>[] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = (cells[c] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Timestamp normalisation (cleaning rule 1). Three formats occur in one column:
//   - all digits            -> Unix epoch SECONDS
//   - ends with an offset   -> local time with e.g. +05:30, convert to UTC
//   - ends with Z           -> already UTC
// Returns the instant in epoch milliseconds plus which format it was, or null
// if unparseable. JS Date stores an absolute UTC instant, so parsing an offset
// string already yields the correct UTC moment — we do not shift by hand.
// ---------------------------------------------------------------------------
function parseTimestamp(
  raw: string,
): { ms: number; format: SourceFormat } | null {
  const value = raw.trim();
  if (value === "") return null;

  // All-digit value is epoch seconds (not milliseconds: the samples are 10-digit
  // second timestamps, and treating them as ms would land them in 1970).
  if (/^\d+$/.test(value)) {
    return { ms: Number(value) * 1000, format: "epoch" };
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;

  // Distinguish a trailing numeric offset (+05:30 / -04:00) from a Z. Both are
  // valid UTC once parsed; the flag is only for the source_format audit column.
  const isOffset = /[+-]\d{2}:?\d{2}$/.test(value) && !value.endsWith("Z");
  return { ms, format: isOffset ? "offset" : "iso" };
}

// Latency normalisation (cleaning rules 2, 3, 4). Uses the row's OWN unit column,
// never the service name. Empty or negative -> null + invalid (the status still
// counts). Seconds -> milliseconds. Reports whether the stored value differs
// from the raw value, for the "values corrected" trust count.
function normaliseLatency(
  rawLatency: string,
  rawUnit: string,
): { ms: number | null; invalid: boolean; corrected: boolean } {
  const value = rawLatency.trim();
  if (value === "") {
    return { ms: null, invalid: true, corrected: false };
  }

  const n = Number(value);
  if (Number.isNaN(n) || n < 0) {
    // Negative or non-numeric latency is impossible; null it, keep the status.
    return { ms: null, invalid: true, corrected: false };
  }

  if (rawUnit.trim() === "s") {
    // svc-search reports seconds; multiplying changes the stored value.
    return { ms: n * 1000, invalid: false, corrected: true };
  }
  return { ms: n, invalid: false, corrected: false };
}

// A real HTTP status is 1xx–5xx. Anything else (the data has 999) is a probe
// error, not a service failure, and is excluded from availability (rule 5).
function isValidStatus(rawStatus: string): boolean {
  return /^[1-5]\d\d$/.test(rawStatus.trim());
}

// ---------------------------------------------------------------------------
// Grid derivation (cleaning rule 8). The interval between checks is NOT assumed
// to be 15 minutes — it is derived as the smallest positive gap between distinct
// timestamps. Because every reading lands exactly on the grid once normalised,
// that smallest gap is one grid step. Slots are then floored from the epoch
// origin (00:00:00 UTC), which is itself a grid boundary, so no offset is
// assumed either.
// ---------------------------------------------------------------------------
function deriveGridMs(instantsMs: number[]): number {
  const distinct = Array.from(new Set(instantsMs)).sort((a, b) => a - b);
  let smallestGap = Infinity;
  for (let i = 1; i < distinct.length; i++) {
    const gap = distinct[i] - distinct[i - 1];
    if (gap > 0 && gap < smallestGap) smallestGap = gap;
  }
  // Fallback for a degenerate file with 0 or 1 distinct instant: 15 minutes.
  // Flagged here rather than hidden so the assumption is visible.
  if (!Number.isFinite(smallestGap)) return 15 * MS_PER_MINUTE;
  return smallestGap;
}

function floorToGrid(ms: number, gridMs: number): number {
  return Math.floor(ms / gridMs) * gridMs;
}

// R-7 / Excel PERCENTILE.INC: linear interpolation between the two nearest
// ranks. Nearest-rank does not match verification.md. Input must be sorted asc.
function percentileR7(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];

  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

// Intermediate parsed row, before dedup and slotting.
interface ParsedRow {
  check: CheckRow;
  tsMs: number | null;
  slotMs: number | null;
}

// ===========================================================================
// The one exported function.
// ===========================================================================
export function processUpload(
  csvText: string,
  filename: string,
): ProcessResult {
  const rawRows = parseCsv(csvText);

  // --- Pass 1: normalise every row into a check, without slotting yet. --------
  // We can only floor to the grid after we know the grid, and we only know the
  // grid after we have parsed every timestamp. So collect instants first.
  const parsed: ParsedRow[] = [];
  const instantsMs: number[] = [];
  let valuesCorrected = 0;
  let valuesNulled = 0;

  for (const row of rawRows) {
    const rawTimestamp = row["timestamp"] ?? "";
    const rawStatus = row["status_code"] ?? "";
    const rawLatency = row["latency"] ?? "";
    const rawUnit = row["latency_unit"] ?? "";

    const parsedTs = parseTimestamp(rawTimestamp);
    const latency = normaliseLatency(rawLatency, rawUnit);
    const statusValid = isValidStatus(rawStatus);
    const statusNum = Number(rawStatus);

    // A row is "corrected" if its stored form differs from what arrived: the
    // timestamp was reformatted (epoch/offset -> UTC ISO) or the latency unit
    // was converted (s -> ms). Counted once per row.
    const timestampCorrected =
      parsedTs !== null && parsedTs.format !== "iso";
    const corrected = timestampCorrected || latency.corrected;
    if (corrected) valuesCorrected++;
    // "nulled" means the latency was dropped to null (empty or negative). This
    // is a separate tally and CAN overlap "corrected" for the same row.
    if (latency.invalid) valuesNulled++;

    const check: CheckRow = {
      service_id: row["service_id"] ?? "",
      service_name: row["service_name"] || null,
      raw_timestamp: rawTimestamp,
      raw_status: rawStatus || null,
      raw_latency: rawLatency === "" ? null : rawLatency,
      raw_latency_unit: rawUnit || null,
      agent: row["agent"] || null,
      region: row["region"] || null,
      ts: parsedTs ? new Date(parsedTs.ms).toISOString() : null,
      slot_ts: null, // filled in pass 2
      status_code: Number.isNaN(statusNum) ? null : statusNum,
      latency_ms: latency.ms,
      is_duplicate: false, // decided during dedup
      latency_invalid: latency.invalid,
      status_invalid: !statusValid,
      source_format: parsedTs ? parsedTs.format : null,
    };

    parsed.push({ check, tsMs: parsedTs?.ms ?? null, slotMs: null });
    if (parsedTs) instantsMs.push(parsedTs.ms);
  }

  const gridMs = deriveGridMs(instantsMs);
  const gridMinutes = Math.round(gridMs / MS_PER_MINUTE);

  // --- Pass 2: assign each row to its slot. -----------------------------------
  for (const p of parsed) {
    if (p.tsMs === null) continue;
    p.slotMs = floorToGrid(p.tsMs, gridMs);
    p.check.slot_ts = new Date(p.slotMs).toISOString();
  }

  // --- Deduplicate on (service_id, slot_ts, agent) (cleaning rule 6). ---------
  // Losers are kept in checks with is_duplicate = true, never deleted. When
  // copies differ only by a missing field, the more populated row wins; ties
  // keep the earlier row (stable), so the result is deterministic.
  const bestByKey = new Map<string, ParsedRow>();
  let duplicatesCollapsed = 0;

  for (const p of parsed) {
    if (p.slotMs === null) continue; // unparseable ts: cannot key it, leave alone
    const key = `${p.check.service_id}|${p.slotMs}|${p.check.agent ?? ""}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, p);
      continue;
    }
    // Both rows share the key: one must be a duplicate. Keep the more complete.
    duplicatesCollapsed++;
    if (completeness(p.check) > completeness(existing.check)) {
      existing.check.is_duplicate = true;
      bestByKey.set(key, p);
    } else {
      p.check.is_duplicate = true;
    }
  }

  // --- Derive services and the global slot range from the winners. ------------
  const winners = parsed.filter(
    (p) => p.slotMs !== null && !p.check.is_duplicate,
  );
  const services = Array.from(
    new Set(winners.map((p) => p.check.service_id)),
  ).sort();

  let minSlot = Infinity;
  let maxSlot = -Infinity;
  for (const p of winners) {
    if (p.slotMs! < minSlot) minSlot = p.slotMs!;
    if (p.slotMs! > maxSlot) maxSlot = p.slotMs!;
  }

  // Index winners by service -> slotMs -> readings, so slotting is a lookup.
  const readingsBySlot = new Map<string, Map<number, CheckRow[]>>();
  for (const p of winners) {
    let perService = readingsBySlot.get(p.check.service_id);
    if (!perService) {
      perService = new Map<number, CheckRow[]>();
      readingsBySlot.set(p.check.service_id, perService);
    }
    const list = perService.get(p.slotMs!) ?? [];
    list.push(p.check);
    perService.set(p.slotMs!, list);
  }

  // --- Generate the full expected grid per service (cleaning rule 7 + 8). -----
  // Every service gets every slot in [minSlot, maxSlot]. A slot with no valid
  // reading exists as verdict 'no_data' rather than being absent, so gaps are
  // explicit and drop out of the availability denominator instead of silently
  // shrinking it.
  const slots: SlotRow[] = [];
  let slotsNoData = 0;

  const haveRange = Number.isFinite(minSlot) && Number.isFinite(maxSlot);
  for (const service of services) {
    const perService = readingsBySlot.get(service);
    if (!haveRange) continue;
    for (let slotMs = minSlot; slotMs <= maxSlot; slotMs += gridMs) {
      const readings = perService?.get(slotMs) ?? [];
      // Valid readings only: a probe error (status_invalid) is not a reading.
      const valid = readings.filter((r) => !r.status_invalid);

      let verdict: Verdict;
      if (valid.length === 0) {
        verdict = "no_data";
        slotsNoData++;
      } else {
        // Down if ANY valid reading is 5xx — this is also how disagreeing agents
        // are resolved (a 500 from one agent beats a 200 from another: something
        // was down). Up only when there is at least one valid reading and none
        // is 5xx. Non-2xx/non-5xx codes do not occur in the data.
        const anyServerError = valid.some(
          (r) => r.status_code !== null &&
            r.status_code >= 500 && r.status_code <= 599,
        );
        verdict = anyServerError ? "down" : "up";
      }

      // Slot latency is the mean of its valid readings' latencies, ignoring the
      // ones that were nulled. Null if none remain (excluded from percentiles).
      const latencies = valid
        .map((r) => r.latency_ms)
        .filter((v): v is number => v !== null);
      const meanLatency = latencies.length === 0
        ? null
        : latencies.reduce((a, b) => a + b, 0) / latencies.length;

      slots.push({
        service_id: service,
        slot_ts: new Date(slotMs).toISOString(),
        verdict,
        latency_ms: meanLatency,
        valid_reading_count: valid.length,
      });
    }
  }

  // --- Incidents: group down slots per service (display only). ----------------
  const incidents = buildIncidents(slots, gridMs);

  // --- Assemble the uploads row. ----------------------------------------------
  const upload: UploadRow = {
    filename,
    range_start: haveRange ? new Date(minSlot).toISOString() : null,
    range_end: haveRange ? new Date(maxSlot).toISOString() : null,
    grid_minutes: gridMinutes,
    rows_received: rawRows.length,
    duplicates_collapsed: duplicatesCollapsed,
    values_corrected: valuesCorrected,
    values_nulled: valuesNulled,
    slots_no_data: slotsNoData,
  };

  return {
    upload,
    checks: parsed.map((p) => p.check),
    slots,
    incidents,
  };
}

// Completeness score for the dedup tie-break: how many optional fields are
// populated. The row that carries a latency (or more fields) beats the one that
// left them empty.
function completeness(c: CheckRow): number {
  let score = 0;
  if (c.latency_ms !== null) score++;
  if (c.status_code !== null) score++;
  if (c.service_name !== null) score++;
  if (c.region !== null) score++;
  return score;
}

// Median of a list of numbers, or null if empty. Even length averages the two
// middle values. Robust to the few slow-but-successful checks inside a window.
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Group a service's down slots into incidents/blips. FOR DISPLAY ONLY; never
// feeds availability. Three conditions together separate a real incident from a
// cluster of coincidental blips — a gap rule alone cannot, because blips flap
// next to real incidents and real incidents have internal recovery gaps:
//
//   1. Merge down slots that are <= MERGE_GAP_SLOTS apart into one candidate.
//   2. The candidate must have >= INCIDENT_MIN_SLOTS down slots.
//   3. The candidate's window median latency (over ALL its slots, including the
//      healthy ones between failures) must be >= INCIDENT_LATENCY_MULTIPLE times
//      the service's baseline, where baseline is the median latency of its
//      non-down slots across the whole file.
//
// Condition 3 does the real work. It is the degradation signature already noted
// in data-findings.md: during an incident even the successful checks run 3-5x
// slower. Measured over all five sample files, true incidents score 3.16-3.99x
// and blip clusters score 1.05-1.14x, so the 2.0x threshold sits in an empty
// band, not on a knife edge. Anything failing 2 or 3 is recorded as a blip.
function buildIncidents(slots: SlotRow[], gridMs: number): IncidentRow[] {
  const gridMinutes = Math.round(gridMs / MS_PER_MINUTE);
  const mergeGapMs = MERGE_GAP_SLOTS * gridMs;
  const incidents: IncidentRow[] = [];

  // Per service: every slot (for the window median and the baseline) indexed by
  // instant, plus the sorted down-slot instants.
  const slotsByService = new Map<string, SlotRow[]>();
  for (const s of slots) {
    const list = slotsByService.get(s.service_id) ?? [];
    list.push(s);
    slotsByService.set(s.service_id, list);
  }

  for (const [service, serviceSlots] of slotsByService) {
    // Baseline: median latency of the service's non-down slots across the file.
    // no_data slots carry a null latency and drop out here automatically.
    const baseline = median(
      serviceSlots
        .filter((s) => s.verdict !== "down")
        .map((s) => s.latency_ms)
        .filter((v): v is number => v !== null),
    );

    // Latency by instant, for computing a window median quickly.
    const latencyByMs = new Map<number, number | null>();
    for (const s of serviceSlots) latencyByMs.set(Date.parse(s.slot_ts), s.latency_ms);

    const downMs = serviceSlots
      .filter((s) => s.verdict === "down")
      .map((s) => Date.parse(s.slot_ts))
      .sort((a, b) => a - b);
    if (downMs.length === 0) continue;

    let groupStart = downMs[0];
    let groupEnd = downMs[0];
    let count = 1;

    const flush = () => {
      // Window median over every slot from first to last down, healthy included.
      const windowLatencies: number[] = [];
      for (let ms = groupStart; ms <= groupEnd; ms += gridMs) {
        const lat = latencyByMs.get(ms);
        if (lat !== undefined && lat !== null) windowLatencies.push(lat);
      }
      const windowMedian = median(windowLatencies);

      const degraded = baseline !== null && windowMedian !== null &&
        windowMedian >= INCIDENT_LATENCY_MULTIPLE * baseline;
      const isIncident = count >= INCIDENT_MIN_SLOTS && degraded;

      incidents.push({
        service_id: service,
        kind: isIncident ? "incident" : "blip",
        started_at: new Date(groupStart).toISOString(),
        ended_at: new Date(groupEnd).toISOString(),
        down_slot_count: count,
        // Downtime attributable to the group, consistent with the SLA number:
        // one grid step per down slot, not the wall-clock span (flapping inflates
        // the span but not the counted downtime).
        duration_minutes: count * gridMinutes,
      });
    };

    for (let i = 1; i < downMs.length; i++) {
      if (downMs[i] - groupEnd <= mergeGapMs) {
        groupEnd = downMs[i];
        count++;
      } else {
        flush();
        groupStart = downMs[i];
        groupEnd = downMs[i];
        count = 1;
      }
    }
    flush();
  }

  return incidents;
}
