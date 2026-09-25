// ============================================================================
// clean.test.ts — unit tests for the parsing edge cases, one Deno.test each.
//
// Run: deno test supabase/functions/process-upload/clean.test.ts
//
// Assertions are hand-rolled so the file needs no imports and no network. Each
// test builds a tiny in-memory CSV, runs the real processUpload, and asserts on
// the one behaviour it is about.
// ============================================================================

import { processUpload } from "./clean.ts";
import type { CheckRow } from "./clean.ts";

const HEADER =
  "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";

function csv(...dataLines: string[]): string {
  // CRLF on purpose: the real files use it, so the parser is exercised the same
  // way the Edge Function will exercise it.
  return [HEADER, ...dataLines].join("\r\n");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

// Find the single row matching a predicate, failing if not exactly one.
function only<T>(rows: T[], pred: (r: T) => boolean): T {
  const hits = rows.filter(pred);
  assertEqual(hits.length, 1, "expected exactly one matching row");
  return hits[0];
}

Deno.test("epoch timestamp is parsed as Unix seconds and flagged epoch", () => {
  // 1746938700 = 2025-05-11T04:45:00Z.
  const { checks } = processUpload(
    csv("svc-auth,auth,1746938700,200,120,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  const c = checks[0];
  assertEqual(c.source_format, "epoch", "source_format");
  assertEqual(c.ts, "2025-05-11T04:45:00.000Z", "converted UTC instant");
  assertEqual(c.slot_ts, "2025-05-11T04:45:00.000Z", "slot boundary");
});

Deno.test("+05:30 offset is converted to UTC and flagged offset", () => {
  // 02:00 IST == 20:30 UTC the previous day. If the offset were ignored this
  // would land at 02:00Z and create a phantom slot — the biggest trap.
  const { checks } = processUpload(
    csv("svc-reports,reports,2025-05-13T02:00:00+05:30,200,800,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  const c = checks[0];
  assertEqual(c.source_format, "offset", "source_format");
  assertEqual(c.ts, "2025-05-12T20:30:00.000Z", "shifted to UTC");
});

Deno.test("latency in seconds is normalised to milliseconds", () => {
  const { checks } = processUpload(
    csv("svc-search,search,2025-05-10T15:45:00Z,200,0.717,s,agent-1,ap-south-1"),
    "t.csv",
  );
  const c = checks[0];
  assertEqual(c.latency_ms, 717, "0.717 s -> 717 ms");
  assertEqual(c.latency_invalid, false, "valid latency");
});

Deno.test("latency in ms is kept as-is", () => {
  const { checks } = processUpload(
    csv("svc-auth,auth,2025-05-10T15:45:00Z,200,145,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  assertEqual(checks[0].latency_ms, 145, "145 ms unchanged");
});

Deno.test("empty latency is nulled but the row and status are kept", () => {
  const { checks } = processUpload(
    csv("svc-notify,notify,2025-05-08T20:30:00Z,200,,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  const c = checks[0];
  assertEqual(c.latency_ms, null, "latency nulled");
  assertEqual(c.latency_invalid, true, "flagged invalid");
  assertEqual(c.status_code, 200, "status still present");
  assertEqual(checks.length, 1, "row not dropped");
});

Deno.test("negative latency is nulled and flagged, status kept", () => {
  const { checks } = processUpload(
    csv("svc-reports,reports,2025-05-11T21:15:00Z,200,-286,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  const c = checks[0];
  assertEqual(c.latency_ms, null, "negative nulled");
  assertEqual(c.latency_invalid, true, "flagged invalid");
  assertEqual(c.status_code, 200, "status kept");
});

Deno.test("status 999 is flagged invalid and makes a lone-reading slot no_data", () => {
  const { checks, slots } = processUpload(
    csv("svc-payments,payments,2025-05-10T22:30:00Z,999,389,ms,agent-1,ap-south-1"),
    "t.csv",
  );
  assertEqual(checks[0].status_invalid, true, "999 flagged");
  // Its only reading is a probe error, so the slot has no valid reading.
  const slot = only(slots, (s) => s.slot_ts === "2025-05-10T22:30:00.000Z");
  assertEqual(slot.verdict, "no_data", "no valid reading -> no_data");
});

Deno.test("exact duplicate: one row kept, the copy flagged is_duplicate", () => {
  const line = "svc-auth,auth,2025-05-10T15:45:00Z,200,145,ms,agent-1,ap-south-1";
  const { checks, upload } = processUpload(csv(line, line), "t.csv");
  assertEqual(checks.length, 2, "both rows kept");
  assertEqual(
    checks.filter((c) => c.is_duplicate).length,
    1,
    "exactly one flagged duplicate",
  );
  assertEqual(upload.duplicates_collapsed, 1, "counted once");
});

Deno.test("same check in two formats dedups after normalisation, populated wins", () => {
  // Same instant, same service, same agent: one as ISO with a latency, one as
  // epoch with an empty latency. They collide only once timestamps are
  // normalised; the populated (ISO) row must be the survivor.
  const iso = "svc-auth,auth,2025-05-11T04:45:00Z,200,145,ms,agent-1,ap-south-1";
  const epochEmpty = "svc-auth,auth,1746938700,200,,ms,agent-1,ap-south-1";
  const { checks, upload } = processUpload(csv(iso, epochEmpty), "t.csv");

  assertEqual(upload.duplicates_collapsed, 1, "collapsed to one");
  const survivor = only(checks, (c) => !c.is_duplicate);
  assertEqual(survivor.latency_ms, 145, "the row carrying latency survived");
  const loser = only(checks, (c) => c.is_duplicate);
  assertEqual(loser.latency_ms, null, "the empty copy is the duplicate");
});

Deno.test("agents disagreeing on a slot resolve to down (5xx wins)", () => {
  // Fabricated — the samples never contain disagreement. agent-1 says 200,
  // agent-2 says 500 for the same service and slot. Something was down.
  const { slots } = processUpload(
    csv(
      "svc-auth,auth,2025-05-11T04:45:00Z,200,145,ms,agent-1,ap-south-1",
      "svc-auth,auth,2025-05-11T04:45:00Z,500,145,ms,agent-2,ap-south-1",
    ),
    "t.csv",
  );
  const slot = only(slots, (s) => s.slot_ts === "2025-05-11T04:45:00.000Z");
  assertEqual(slot.verdict, "down", "any 5xx -> down");
  assertEqual(slot.valid_reading_count, 2, "both readings valid and counted");
});
