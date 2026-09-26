# SLA Monitoring Dashboard

Upload a CSV of health-check logs; a deployed serverless function parses, cleans
and stores it; a single-page dashboard shows availability against a 99.9% SLA
and a filterable view of the underlying rows.

**Live:** https://sla-dashboard-rho.vercel.app
**Last verified live:** 2026-09-26 (see [Running and redeploying](#5-running-and-redeploying) for the free-tier idle-pause caveat).

Sample files to upload are in [`data/`](data/). The 14-day file
(`monitoring_checks_14d_seed202.csv`) exercises both incident rendering and the
partial-month labelling.

---

## 1. Architecture

```
  Browser (Vercel)                Supabase
  ────────────────                ────────────────────────────────
  Next.js upload page  ──POST──►  Edge Function  process-upload
   (multipart CSV,                (Deno/TS, service_role key)
    anon apikey header)                 │
                                        │ parse → clean → chunked INSERT
                                        ▼
                                   Postgres: uploads → checks → slots → incidents
                                        │
  Next.js dashboard  ◄──SELECT────  SQL views (anon key, RLS, security_invoker)
   (reads aggregated rows)          v_service_stats / v_service_incidents / v_monthly_stats
```

| Piece | Choice | Runs on |
| --- | --- | --- |
| Upload UI + dashboard | Next.js (App Router) | Vercel, free tier |
| Processing | Edge Function `process-upload` (Deno, TypeScript) | Supabase, deployed serverless |
| Persistence | Postgres | Supabase, free tier |
| Aggregation | SQL views | Postgres |

Function endpoint: `https://mrcxiogeofohnstxtyej.supabase.co/functions/v1/process-upload`

**Why serverless-on-Supabase, not Lambda.** The function's whole job is to write
to Postgres. Putting it on the same platform as the database means one signup, no
cross-provider credentials, and the `service_role` key never leaves the account
that owns the data — no VPC, no egress config, no second set of secrets to
rotate. On Lambda the function would need the Supabase URL and service-role key
injected as Lambda env vars and would reach the DB over the public internet
anyway, so the colocation buys real operational simplicity for nothing given up.
Deno on Supabase also has no short CPU-time ceiling that a ~15.5k-row parse would
risk; the 30-day file processes server-side in a few seconds.

**Why aggregation is in Postgres, not the browser.** The 30-day upload produces
14,400 slot rows (2,880 × 5 services). Availability, downtime, error budget and
p50/p95 are all reductions over those rows. Pulling every slot to the client to
sum and compute percentiles would move megabytes to do arithmetic the database
does in one indexed pass. Percentiles use `percentile_cont` (R-7 linear
interpolation, the method the verification file expects) computed over slot-level
mean latency. The dashboard fetches a handful of already-aggregated rows per
upload — one round trip per view, grouped by `upload_id`.

The processing function is deliberately split in two:
[`clean.ts`](supabase/functions/process-upload/clean.ts) is a single pure
function (no network, DB, filesystem or clock — everything comes from the CSV
text), and [`index.ts`](supabase/functions/process-upload/index.ts) is I/O only
(validate request → insert `uploads` as `processing` → call `processUpload()` →
chunked insert of `checks`/`slots`/`incidents` → mark `complete`; any throw flips
the row to `failed` so a dead run never sits stuck at `processing`). That split
is what lets the cleaning logic be unit-tested off-cloud and verified against
fixed numbers.

---

## 2. Data findings

Profiled across all five sample files (9, 12, 14, 21, 30 days). Counts below are
in that order. Nothing is silently dropped: every raw row is stored in `checks`
with flags (`is_duplicate`, `latency_invalid`, `status_invalid`, `source_format`)
and shown in the logs table, so the dashboard reflects what arrived *and* what
the pipeline did to it.

**Rows in file → rows after dedup:** 4,672→4,665 · 6,230→6,220 · 7,269→7,257 ·
10,904→10,886 · 15,577→15,552.

1. **Timestamps come in three formats in one column.** ISO `Z`, Unix epoch
   seconds, and a `+05:30` (IST) offset. Counts — epoch: 70/93/109/163/233;
   offset: 32/43/50/76/109. *Handling:* all-digit values parse as epoch seconds;
   everything is converted to UTC and stored UTC (`timestamptz`). This is the
   single biggest trap: treating `+05:30` as if it were UTC in the 30-day file
   creates ~100 phantom no-data gaps and ~100 phantom duplicates. Once converted,
   every reading lands exactly on the 15-minute grid.

2. **Latency units are mixed.** `svc-search` reports seconds (e.g. `0.486`);
   every other service reports milliseconds. *Handling:* normalise to ms using
   each row's own `latency_unit` column, never the service name — inferring from
   the name is exactly the kind of assumption that breaks on the next upload.

3. **Latency is sometimes empty.** Counts: 56/74/87/130/186. *Handling:* keep the
   row (the status still counts), store latency `NULL`, exclude from percentiles.

4. **Latency is sometimes negative** (one row per file, e.g. `-296`). *Handling:*
   impossible value — null it, keep the status, flag `latency_invalid`.

5. **Status code `999` appears once per file.** Not a real HTTP code.
   *Handling:* treat it as a probe error, not a service failure — anything not
   matching `^[1-5]\d\d$` is excluded from availability. If a slot has no other
   valid reading it becomes `no_data` and drops out of the denominator (in the
   14-day file agent-2 reported `200` for that same slot, so it stays counted).

6. **Two agents check some of the same slots.** agent-2 re-checks a subset of
   agent-1's slots. Overlapping slots: 345/460/537/806/1,153. *Handling:* collapse
   to one verdict per service per 15-minute slot (availability is measured per
   slot, not per row — see assumptions).

7. **The same agent sometimes reports the same slot twice.** Counts:
   7/10/12/18/25. Some are exact copies; some are the same check written once as
   epoch and once as ISO, so they only collide *after* normalisation; in one case
   one copy had a latency and the other was empty. *Handling:* deduplicate on the
   normalised `(service_id, slot_ts, agent)` key; when copies differ only by a
   missing field the more populated row wins (ties keep the earlier row, so the
   result is deterministic). Losers are flagged `is_duplicate`, not deleted.

8. **Rows are shuffled and line endings are CRLF.** *Handling:* split on `\r?\n`,
   map cells by header name (not position), trim values, assume nothing about
   input order.

**Derived, never hardcoded.** The date range, the day count, the service list and
the grid interval all come from the file. The grid is the smallest positive gap
between distinct normalised timestamps (15 minutes in every sample, but the code
never assumes it); downtime is `down_slots × grid_minutes`, so 15 is not a magic
constant anywhere. Missing slots, off-grid timestamps, and agents disagreeing on
status are all handled even though the samples don't contain them (a 5xx from any
agent wins a slot); the unit test suite covers the disagreement case explicitly.

---

## 3. Assumptions

Where the spec was silent, these are the calls made and why.

**Strict downtime — every down slot is 15 minutes, and every service breaches
99.9% in every file.** The check is the only evidence there is, so a failed check
stands for its whole interval. There is no "N consecutive failures" confirmation
rule because the spec gives none and the failures flap — a consecutive rule would
under-count real incidents. The plain consequence: under this rule every service
in every sample file lands below 99.9% (svc-reports between 96.5% and 97.7%).
That is arithmetic, not alarm — 99.9% over 30 days allows ~43 minutes, which
three failed 15-minute checks exhaust. **I did not tune the definition to make
the numbers look healthier.** Instead the dashboard separates incident downtime
from scattered single-check blips so a reader can see *where* the breach comes
from: two incidents account for ~25 down slots and 157 scattered blips account
for the rest in the 30-day file, and that ratio is the story.

**Incident grouping — three conditions, and why a gap rule alone provably cannot
work.** Down slots on one service are grouped for *display only* (never for the
SLA number). A group is an incident when all three hold: (1) its down slots are
≤3 grid slots (45 min) apart, (2) it has ≥3 down slots, and (3) its window median
latency is ≥2× the service's baseline. Condition 3 does the real work. A pure gap
rule cannot separate the two failure patterns, because real incidents contain
internal recovery gaps (the longest unbroken failure run is only 5–8 checks) while
isolated blips happen to fall adjacent to each other — so *any* gap threshold
either splits real incidents or promotes blip clusters. The degradation signature
is what separates them cleanly: during an incident even the checks that still
return 200 run 3–5× slower. Measured over all five files, true incidents score
**3.16–3.99×** baseline and blip clusters score **1.05–1.14×**, so the 2.0×
threshold sits in an empty band, not on a knife edge. A "blip" the dashboard
counts is a single down slot that isn't part of an incident — isolated failures,
which is what on-call actually wants counted, not how many ways they clumped.

**Availability is measured per slot, not per row.** One verdict per service per
15-minute slot. Counting rows would give extra weight to whichever slots agent-2
happened to re-check. Down if any valid reading is 5xx; up if all valid readings
are 2xx; no_data if there are no valid readings (excluded from the denominator,
shown separately). Slot latency is the mean of its valid readings.

**SLA period is the selected range, with a per-calendar-month breakdown.** SLAs
are monthly, but uploads cover any range and two sample files cross a month
boundary. The headline number covers the uploaded range; `v_monthly_stats` also
breaks it down per calendar month and flags `partial_month` where coverage is
incomplete, because a credit decision should only be made on a full month.

**Stats are chosen for two readers.** *Billing:* availability % vs 99.9%, breach
yes/no, downtime minutes, error budget (minutes allowed vs used). No invented
credit percentages — the tiers aren't specified, so breach status is shown
instead. *On-call:* incident count, longest incident (shown both ways — wall-clock
span and attributed downtime, which differ because incidents flap), incident
timeline, blip count, and p50/p95 latency per service (latency is here because
degradation starts before failures do). *Trust:* rows received, duplicates
collapsed, values corrected, values nulled, slots with no data — if the pipeline
changed the data, the dashboard says so. "Corrected" (timestamp reformatted or
latency unit converted) and "nulled" (empty/negative latency) are independent
tallies that can overlap on the same row: 11/15/21/38/39 rows are both.

---

## 4. Verification

The numbers are checked against an independently computed expected-output file,
not against the pipeline's own output.

- [`verification.md`](verification.md) lists the expected parsing counts, date
  ranges, and per-service availability / downtime / p50 / p95 for all five files,
  computed separately in Python.
- [`verify.ts`](supabase/functions/process-upload/verify.ts) runs the pipeline
  against all five sample CSVs and compares every figure PASS/FAIL. Latest run:
  **193/193 figures pass** (`deno run --allow-read supabase/functions/process-upload/verify.ts`).
- [`clean.test.ts`](supabase/functions/process-upload/clean.test.ts) has **10
  unit tests**, one per parsing edge case (epoch, offset→UTC, seconds→ms,
  empty/negative latency, the `999` probe error, exact and cross-format dedup,
  agent disagreement resolving to down). All pass (`deno test --allow-read …`).
- [`dataset_incident_log.json`](data/) is ground truth for testing only. It is
  **never read, imported or referenced by any application or pipeline code** —
  the pipeline detects the incidents on its own, and `verify.ts` compares against
  the windows transcribed into `verification.md`, not against that file. (One
  edge case is documented in `verification.md`: two failures just past the logged
  window fall inside the merge gap, so the detected window is allowed to drift up
  to 3 check-points at each boundary; a missed incident or a promoted blip is
  not allowed, and the 2× latency test is what prevents them.)

The percentile display can differ from the Python figures by ±0.1 ms on an exact
`.5` tie, because Python's `round()` breaks ties to even and JS `Math.round`
breaks half up. The pipeline stores full precision and rounds only for display,
so this is a display tie-break, not a data difference; `verify.ts` compares
percentiles with a ±0.1 ms tolerance for exactly this reason.

---

## 5. Running and redeploying

### Local setup

```bash
cd web
# web/.env.local — all three are public browser values (URL + publishable anon
# key + function URL). See web/.env.example. Real secrets never go here.
#   NEXT_PUBLIC_SUPABASE_URL=...
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
#   NEXT_PUBLIC_PROCESS_UPLOAD_URL=.../functions/v1/process-upload
npm install
npm run dev            # http://localhost:3000
```

**Pre-push check — always run this.** Vercel type-checks on build; the Next.js
dev server does not, so a type error only surfaces on deploy (it has broken a
deploy before). Run the production build from `web/` before every push and fix
anything it surfaces:

```bash
cd web
npm run build
```

### Redeploying each piece

- **Web (Vercel):** deploys automatically on push to `main` (project linked to
  the GitHub repo). No manual step.
- **Edge Function:** `supabase functions deploy process-upload`. It reads
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the platform environment;
  neither is hardcoded or committed. `verify_jwt = false` is set in
  [`supabase/config.toml`](supabase/config.toml) (no auth is in scope; writes are
  still safe — see security note below).
- **Database:** `supabase db push` applies the migrations in
  [`supabase/migrations/`](supabase/migrations/).

### Free-tier idle-pause

Supabase pauses a free project after ~7 days of inactivity, which takes the
database — and therefore the dashboard's reads and any upload — offline. The
assignment explicitly allows this if documented. **To resume:** open the project
in the Supabase dashboard and click *Restore*; it comes back in a minute or two,
after which the live URL works again with no redeploy needed (Vercel and the Edge
Function stay up regardless; only the database sleeps). This is why the "last
verified live" date is stated at the top — if you're reviewing well after it,
resume the project first.

---

## 6. What I'd do differently with more time

- **Keyset pagination for the logs table.** It currently uses offset pagination
  (`.range`) over the `(upload_id, ts)` index — fine at 15.5k rows / 50 per page
  (~312 pages worst case), but a deep OFFSET still scans and discards skipped
  rows. If a single upload grew to millions of rows the fix is keyset: carry the
  last row's `ts` and fetch `ts > lastTs limit N`, which is O(page) regardless of
  depth. Not worth the extra client state at this scale, but that's where it goes.
- **Stream the parse.** `processUpload` reads the whole CSV into memory and builds
  full arrays before inserting. It's well inside Edge limits for a 1.1 MB file,
  but a streaming parse (row-by-row into fixed-size insert batches) would cut peak
  memory and CPU and raise the ceiling on file size well past the current 10 MB
  cap.
- **Upload deduplication.** Re-uploading the same file just creates another
  `uploads` row. A content hash on the CSV would let the function detect a
  re-upload and either skip it or point at the existing one.
- **Dependency advisories.** `npm audit` flags advisories in `next@14` (self-hosted
  DoS / image-optimizer / middleware / cache-poisoning classes) and one transitive
  `@supabase/auth-js` issue pulled in by `supabase-js`. Most don't map to this
  deployment — it's statically hosted on Vercel, uses no `next/image`, no
  middleware, no server actions and no auth — but the clean fix is `next@16`,
  which is a major upgrade held back deliberately rather than rushed in at the end.
- **Revisit the 2× latency threshold with more data.** The 3.16–3.99× vs
  1.05–1.14× separation is measured on five files. The threshold is safe for them,
  but with more real data I'd re-fit it (or make it a per-service multiple of
  baseline variance) rather than trusting one empirical band.

---

## Two decisions worth calling out

**Four migrations, not one.** An applied migration is immutable — editing SQL that
has already run against the remote database would put the migration history out of
sync with reality. So `20260925000001` (schema) and `20260925000003` (stats views)
are the originals, and review changes went into follow-ups rather than back-edits:
`20260925000002` is an idempotent follow-up carrying an index, the privilege
revoke/grant, and comment changes (idempotent because it was authored without
catalog access, so every statement is safe whether or not the piece already
existed); `20260925000004` drops and recreates the three views to add
`security_invoker` and to redefine the incident aggregates. Squashing them into
one file would misrepresent what was actually applied and when.

**Security posture (no auth, but not open to writes).** Authentication is out of
scope, but the tables are not left world-writable:

- **RLS is enabled with anon SELECT only.** A Supabase table with RLS *off* is
  readable *and writable* by the public anon key — the opposite of what's wanted.
  RLS is on, with a `SELECT` policy for `anon`/`authenticated` and no
  insert/update/delete policy.
- **Default grants revoked, then SELECT granted back.** Supabase grants `ALL` on
  new public tables to `anon`/`authenticated` by default, which contradicts the
  intent even though RLS blocks the writes. The migration revokes everything and
  grants back `SELECT` only, so table privileges and RLS say the same thing.
- **Views are `security_invoker = true`.** By default a view runs with its
  owner's privileges and bypasses RLS on the base tables. That was harmless here
  (the data is public-read) but "harmless by accident" isn't a security model —
  `security_invoker` makes each view run as the querying role, subject to the same
  policies as a direct read.
- **`service_role` is confined to the Edge Function.** The only writer is the
  function, using the service-role key (which has `BYPASSRLS`) server-side. That
  key never reaches the browser. A leaked anon key can read the monitoring data
  but can never insert, alter or delete it.
- **CORS is deliberately wildcarded** (`Access-Control-Allow-Origin: *`). The
  endpoint is unauthenticated and carries no credentials or cookies, and the anon
  `apikey` the browser sends is public and SELECT-only, so there is nothing for a
  same-origin policy to protect — a specific origin would add friction (every
  Vercel preview URL is a different origin) without adding security.
