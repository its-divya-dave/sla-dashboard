// ============================================================================
// verify.ts — runs processUpload against all five sample CSVs and compares the
// output to every number in verification.md, PASS/FAIL per figure.
//
// Run: deno run --allow-read supabase/functions/process-upload/verify.ts
//
// The expected values below are transcribed from verification.md ONLY. This
// runner never reads or imports dataset_incident_log.json; the incident windows
// it compares against are the ones written in verification.md.
// ============================================================================

import { processUpload } from "./clean.ts";
import type { ProcessResult, SlotRow } from "./clean.ts";

const DATA_DIR = new URL("../../../data/", import.meta.url);
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

interface ServiceExpect {
  slots: number;
  down: number;
  availability: number; // percent
  downtime: number; // minutes
  p50: number;
  p95: number;
}

interface IncidentExpect {
  service: string;
  day: number;
  cpStart: number;
  cpEnd: number;
}

interface FileExpect {
  file: string;
  rowsInFile: number;
  rowsAfterDedup: number;
  epoch: number;
  offset: number;
  emptyLatency: number;
  negativeLatency: number;
  invalidStatus: number;
  services: Record<string, ServiceExpect>;
  incidents: IncidentExpect[];
}

// ---- Expected values, transcribed from verification.md. --------------------
const EXPECTED: FileExpect[] = [
  {
    file: "monitoring_checks_9d_seed101.csv",
    rowsInFile: 4672, rowsAfterDedup: 4665,
    epoch: 70, offset: 32, emptyLatency: 56, negativeLatency: 1, invalidStatus: 1,
    services: {
      "svc-auth": { slots: 864, down: 4, availability: 99.537, downtime: 60, p50: 145.0, p95: 186.0 },
      "svc-notify": { slots: 864, down: 3, availability: 99.653, downtime: 45, p50: 115.0, p95: 148.0 },
      "svc-payments": { slots: 863, down: 4, availability: 99.537, downtime: 60, p50: 374.0, p95: 482.0 },
      "svc-reports": { slots: 864, down: 21, availability: 97.569, downtime: 315, p50: 643.5, p95: 843.0 },
      "svc-search": { slots: 864, down: 9, availability: 98.958, downtime: 135, p50: 543.0, p95: 701.0 },
    },
    incidents: [{ service: "svc-reports", day: 5, cpStart: 64, cpEnd: 69 }],
  },
  {
    file: "monitoring_checks_12d_seed505.csv",
    rowsInFile: 6230, rowsAfterDedup: 6220,
    epoch: 93, offset: 43, emptyLatency: 74, negativeLatency: 1, invalidStatus: 1,
    services: {
      "svc-auth": { slots: 1151, down: 6, availability: 99.479, downtime: 90, p50: 145.8, p95: 187.0 },
      "svc-notify": { slots: 1152, down: 3, availability: 99.740, downtime: 45, p50: 113.0, p95: 148.0 },
      "svc-payments": { slots: 1152, down: 13, availability: 98.872, downtime: 195, p50: 372.0, p95: 484.0 },
      "svc-reports": { slots: 1152, down: 27, availability: 97.656, downtime: 405, p50: 645.0, p95: 839.1 },
      "svc-search": { slots: 1152, down: 28, availability: 97.569, downtime: 420, p50: 538.0, p95: 710.0 },
    },
    incidents: [
      { service: "svc-search", day: 4, cpStart: 48, cpEnd: 67 },
      { service: "svc-search", day: 8, cpStart: 49, cpEnd: 54 },
    ],
  },
  {
    file: "monitoring_checks_14d_seed202.csv",
    rowsInFile: 7269, rowsAfterDedup: 7257,
    epoch: 109, offset: 50, emptyLatency: 87, negativeLatency: 1, invalidStatus: 1,
    services: {
      "svc-auth": { slots: 1344, down: 5, availability: 99.628, downtime: 75, p50: 143.0, p95: 186.0 },
      "svc-notify": { slots: 1344, down: 32, availability: 97.619, downtime: 480, p50: 115.0, p95: 149.0 },
      "svc-payments": { slots: 1344, down: 14, availability: 98.958, downtime: 210, p50: 368.0, p95: 483.0 },
      "svc-reports": { slots: 1344, down: 47, availability: 96.503, downtime: 705, p50: 635.0, p95: 839.0 },
      "svc-search": { slots: 1344, down: 7, availability: 99.479, downtime: 105, p50: 546.0, p95: 704.0 },
    },
    incidents: [
      { service: "svc-notify", day: 0, cpStart: 59, cpEnd: 77 },
      { service: "svc-notify", day: 6, cpStart: 30, cpEnd: 40 },
    ],
  },
  {
    file: "monitoring_checks_21d_seed303.csv",
    rowsInFile: 10904, rowsAfterDedup: 10886,
    epoch: 163, offset: 76, emptyLatency: 130, negativeLatency: 1, invalidStatus: 1,
    services: {
      "svc-auth": { slots: 2016, down: 4, availability: 99.802, downtime: 60, p50: 146.0, p95: 187.0 },
      "svc-notify": { slots: 2016, down: 3, availability: 99.851, downtime: 45, p50: 115.0, p95: 148.0 },
      "svc-payments": { slots: 2016, down: 46, availability: 97.718, downtime: 690, p50: 374.0, p95: 485.0 },
      "svc-reports": { slots: 2016, down: 54, availability: 97.321, downtime: 810, p50: 644.0, p95: 838.3 },
      "svc-search": { slots: 2015, down: 17, availability: 99.156, downtime: 255, p50: 545.5, p95: 706.0 },
    },
    incidents: [{ service: "svc-payments", day: 2, cpStart: 38, cpEnd: 60 }],
  },
  {
    file: "monitoring_checks_30d_seed404.csv",
    rowsInFile: 15577, rowsAfterDedup: 15552,
    epoch: 233, offset: 109, emptyLatency: 186, negativeLatency: 1, invalidStatus: 1,
    services: {
      "svc-auth": { slots: 2879, down: 29, availability: 98.993, downtime: 435, p50: 143.0, p95: 188.0 },
      "svc-notify": { slots: 2880, down: 8, availability: 99.722, downtime: 120, p50: 113.2, p95: 148.0 },
      "svc-payments": { slots: 2880, down: 34, availability: 98.819, downtime: 510, p50: 372.0, p95: 484.0 },
      "svc-reports": { slots: 2880, down: 82, availability: 97.153, downtime: 1230, p50: 655.0, p95: 846.0 },
      "svc-search": { slots: 2880, down: 29, availability: 98.993, downtime: 435, p50: 538.0, p95: 700.8 },
    },
    incidents: [
      { service: "svc-auth", day: 16, cpStart: 16, cpEnd: 41 },
      { service: "svc-reports", day: 3, cpStart: 47, cpEnd: 55 },
    ],
  },
];

// ---- Small helpers duplicated from the module's private logic. -------------
// (Percentile must use the same R-7 method the module uses for slot means.)
function percentileR7(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

let totalChecks = 0;
let totalFails = 0;

function check(label: string, actual: number, expected: number, tol: number): string {
  totalChecks++;
  // 1e-9 absorbs binary float error at the tolerance boundary (e.g. 838.4-838.3
  // evaluates to 0.10000000000004, which would fail a bare <= 0.1).
  const pass = Math.abs(actual - expected) <= tol + 1e-9;
  if (!pass) totalFails++;
  const mark = pass ? "PASS" : "FAIL";
  const detail = pass ? "" : `  (expected ${expected}, got ${round(actual, 3)})`;
  return `    ${mark}  ${label}${detail}`;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Compute a slot's (day, checkpoint) relative to the file's range start.
function dayAndCheckpoint(slotMs: number, rangeStartMs: number, gridMs: number) {
  const startMidnight = Math.floor(rangeStartMs / MS_PER_DAY) * MS_PER_DAY;
  const dayMidnight = Math.floor(slotMs / MS_PER_DAY) * MS_PER_DAY;
  const day = Math.round((dayMidnight - startMidnight) / MS_PER_DAY);
  const cp = Math.round((slotMs - dayMidnight) / gridMs);
  return { day, cp };
}

function serviceSlots(result: ProcessResult, service: string): SlotRow[] {
  return result.slots.filter((s) => s.service_id === service);
}

async function run(): Promise<void> {
  for (const exp of EXPECTED) {
    const text = await Deno.readTextFile(new URL(exp.file, DATA_DIR));
    const result = processUpload(text, exp.file);
    const { upload, checks } = result;

    console.log("\n" + "=".repeat(72));
    console.log(exp.file);
    console.log("=".repeat(72));

    // --- Parsing counts ---
    const rowsAfterDedup = upload.rows_received - upload.duplicates_collapsed;
    const epoch = checks.filter((c) => c.source_format === "epoch").length;
    const offset = checks.filter((c) => c.source_format === "offset").length;
    const empty = checks.filter((c) => c.raw_latency === null).length;
    const negative = checks.filter(
      (c) => c.raw_latency !== null && Number(c.raw_latency) < 0,
    ).length;
    const invalid = checks.filter((c) => c.status_invalid).length;

    console.log("  Parsing:");
    console.log(check("rows in file", upload.rows_received, exp.rowsInFile, 0));
    console.log(check("rows after dedup", rowsAfterDedup, exp.rowsAfterDedup, 0));
    console.log(check("epoch timestamps", epoch, exp.epoch, 0));
    console.log(check("+05:30 timestamps", offset, exp.offset, 0));
    console.log(check("empty latency", empty, exp.emptyLatency, 0));
    console.log(check("negative latency", negative, exp.negativeLatency, 0));
    console.log(check("invalid status", invalid, exp.invalidStatus, 0));

    // --- Per-service results ---
    const gridMs = (upload.grid_minutes ?? 15) * MS_PER_MINUTE;
    const rangeStartMs = Date.parse(upload.range_start!);

    for (const [service, se] of Object.entries(exp.services)) {
      const slots = serviceSlots(result, service);
      const withData = slots.filter((s) => s.verdict !== "no_data");
      const down = slots.filter((s) => s.verdict === "down").length;
      const availability = ((withData.length - down) / withData.length) * 100;
      const downtime = down * (upload.grid_minutes ?? 15);
      const latencies = slots
        .map((s) => s.latency_ms)
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      const p50 = percentileR7(latencies, 50) ?? NaN;
      const p95 = percentileR7(latencies, 95) ?? NaN;

      console.log(`  ${service}:`);
      console.log(check("slots with data", withData.length, se.slots, 0));
      console.log(check("down slots", down, se.down, 0));
      console.log(check("availability %", round(availability, 3), se.availability, 0.0005));
      console.log(check("downtime min", downtime, se.downtime, 0));
      // +/-0.1 tolerance: verification.md was generated in Python, whose round()
      // breaks exact .5 ties to even, while JS Math.round breaks half-up. The
      // underlying latency is identical (e.g. 838.3499999999999, 113.25); only
      // the tie-break differs. See the note under the tables in verification.md.
      console.log(check("p50 ms", round(p50, 1), se.p50, 0.1));
      console.log(check("p95 ms", round(p95, 1), se.p95, 0.1));
    }

    // --- Incident windows (compared to verification.md, not the JSON) ---
    console.log("  Incidents (kind = incident):");
    const detected = result.incidents
      .filter((i) => i.kind === "incident")
      .map((i) => {
        const s = dayAndCheckpoint(Date.parse(i.started_at), rangeStartMs, gridMs);
        const e = dayAndCheckpoint(Date.parse(i.ended_at), rangeStartMs, gridMs);
        return { service: i.service_id, day: s.day, cpStart: s.cp, cpEnd: e.cp };
      })
      .sort((a, b) => a.day - b.day || a.cpStart - b.cpStart);

    for (const d of detected) {
      console.log(`      detected: ${d.service} day ${d.day} cp ${d.cpStart}-${d.cpEnd}`);
    }
    // Match each expected incident to a detected one: same service and day,
    // check-point boundaries within 3. Edge drift is allowed up to 3 checks
    // because failures adjacent to a real incident (e.g. 9d svc-reports at 70
    // and 72) sit within the merge gap of the real window, so any gap rule pulls
    // them in. See the note in verification.md.
    const EDGE_TOLERANCE = 3;
    for (const ie of exp.incidents) {
      totalChecks++;
      const match = detected.find(
        (d) =>
          d.service === ie.service &&
          d.day === ie.day &&
          Math.abs(d.cpStart - ie.cpStart) <= EDGE_TOLERANCE &&
          Math.abs(d.cpEnd - ie.cpEnd) <= EDGE_TOLERANCE,
      );
      if (!match) totalFails++;
      const mark = match ? "PASS" : "FAIL";
      console.log(
        `    ${mark}  expected ${ie.service} day ${ie.day} cp ${ie.cpStart}-${ie.cpEnd}`,
      );
    }
    // Flag any detected incident with no expected counterpart (a blip promoted).
    for (const d of detected) {
      const expectedMatch = exp.incidents.find(
        (ie) => ie.service === d.service && ie.day === d.day,
      );
      if (!expectedMatch) {
        totalChecks++;
        totalFails++;
        console.log(
          `    FAIL  unexpected incident ${d.service} day ${d.day} cp ${d.cpStart}-${d.cpEnd}`,
        );
      }
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(
    `SUMMARY: ${totalChecks - totalFails}/${totalChecks} figures PASS, ${totalFails} FAIL`,
  );
  console.log("=".repeat(72));
  if (totalFails > 0) Deno.exit(1);
}

await run();
