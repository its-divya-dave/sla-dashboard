# SLA Monitoring Dashboard — project context

Read `data-findings.md` and `verification.md` before writing any pipeline code.
The full assignment is in `problem_statement.md`.

## What we are building

A user uploads a CSV of health-check logs. A **deployed serverless function** parses,
validates and cleans it. The cleaned data goes to a **database**. A **single-page
dashboard** shows a collapsible stats section on top and a filterable logs table below.

### Hard requirements (from the assignment)

- The processing function must actually run in the cloud. Not locally, not in a
  container standing in for one. This is graded.
- Data must be re-queryable after the upload finishes. In-memory does not count.
- Everything must be reachable at a live URL at review time: upload UI, function, DB,
  dashboard.
- Free tier only. No paid plans.
- Commit as you go. The commit history is read.
- Every line must be explainable in a follow-up discussion. Working code that cannot be
  explained is treated as a failure. So: no clever one-liners, no copied abstractions we
  do not need, comments on anything non-obvious.

### Explicitly out of scope — do not build

Authentication, user accounts, multi-tenancy, CI pipelines.

## Stack

| Piece | Choice | Why |
| --- | --- | --- |
| Processing | Supabase Edge Function (Deno, TypeScript) | Real deployed serverless. No CPU-time ceiling that a 15k-row parse would hit. Same account as the DB, so one signup and no cross-provider credentials. |
| Database | Supabase Postgres | SQL date-range filtering and aggregation is exactly what the logs view and stats need. Free tier, no card. |
| UI | Next.js (App Router) on Vercel | Upload page and dashboard in one deploy. Free tier. |

Free-tier caveat to handle, not ignore: Supabase pauses a project after ~7 days of
inactivity. The README must state when the app was last verified live and give exact
redeploy/unpause steps. The assignment explicitly allows this if documented.

## Repo layout

```
/supabase/functions/process-upload/       Edge Function: parse → clean → insert
/supabase/migrations/                     SQL schema
/web/                                     Next.js app (upload page + dashboard)
/data/                                    Sample CSVs + dataset_incident_log.json
problem_statement.md                      The assignment
data-findings.md                          Data-quality findings (source for README section 2)
verification.md                           Expected output numbers — test against these
README.md                                 Written last, from the two files above
```

## Cleaning rules — implement exactly this

These come from profiling all five sample files. Detail and counts are in
`data-findings.md`.

1. **Timestamps.** Three formats in one column. All-digit → Unix epoch seconds.
   `+05:30` offset → convert to UTC. `Z` → already UTC. Store UTC always.
   Getting this wrong is the single biggest trap: treating `+05:30` as UTC creates
   ~100 phantom gaps and ~100 phantom duplicates in the 30-day file.
2. **Latency units.** Use each row's own `latency_unit`. `svc-search` reports seconds,
   everything else milliseconds. Normalise to ms. Never infer the unit from the
   service name.
3. **Empty latency.** Keep the row. Store latency `NULL`. Exclude from percentiles.
4. **Negative latency.** Store `NULL`, keep the status, flag the row.
5. **Invalid status codes.** Anything not matching `^[1-5]\d\d$` (the data has `999`) is
   a probe error, not a service failure. Exclude from availability. If a slot has no
   other valid reading, it is "no data" and drops out of the denominator.
6. **Deduplicate** on `(service_id, slot_ts, agent)`. When copies differ only by a
   missing field, keep the populated one.
7. **Slot verdict.** One verdict per `(service, 15-min slot)`. Down if any valid reading
   is a 5xx. Up if all valid readings are 2xx. No data if no valid readings.
   Slot latency is the mean of its valid readings.
8. **Validate, do not assume.** Do not hardcode day counts, date ranges, service lists,
   or a 15-minute grid offset. Derive them from the file. Handle missing slots and
   conflicting agent verdicts even though the samples do not contain them — say so in
   the README.
9. **Keep raw rows** in the DB with flags (`is_duplicate`, `latency_invalid`,
   `status_invalid`, `source_format`). The logs view shows what arrived and what was
   done to it. Never silently drop a row.

## Decisions already made

- **Strict downtime.** Every down slot counts as 15 minutes. No "N consecutive failures"
  confirmation rule — the spec gives none, and the failures flap, so a consecutive rule
  would under-count real incidents.
- **Consequence, stated openly:** every service in every sample file lands below 99.9%.
  The dashboard separates incident downtime from single-check blips so a reader can see
  where the breach comes from. Do not tune the definition to make the numbers look
  healthier.
- **Incident grouping is for display only**, never for the SLA number. Failures on one
  service merge into one incident when ≤30 minutes apart. 3+ failures = incident,
  fewer = blip.
- **SLA period** is the selected date range, with a per-calendar-month breakdown marked
  "partial month" where coverage is incomplete. Two sample files cross a month boundary.

## Stats section — what to show

Billing: availability % vs 99.9%, breach flag, downtime minutes, error budget
(minutes allowed vs used). No invented credit percentages — the tiers are not specified.

On-call: incident count, longest incident, incident timeline, blip count, p50/p95 latency
per service.

Pipeline trust: rows received, duplicates collapsed, values corrected, values nulled,
slots with no data. If the pipeline changed the data, the dashboard says so.

## Build order — pause after each stage

Stop at each gate, summarise what changed, and let me review and commit before moving on.
Do not run ahead to the next stage.

1. **Schema + migration.** Tables, indexes for date-range queries. Gate: show me the SQL.
2. **Cleaning logic as a standalone, unit-tested module.** Run it against all five
   sample CSVs and compare with `verification.md`. Gate: the numbers match.
3. **Edge Function** wrapping that module, deployed and returning a real summary.
   Gate: a live curl succeeds.
4. **Upload page + dashboard**, deployed. Gate: live URL works end to end.
5. **README**, written from the docs at repo root plus what we actually built.

## Working rules

- Do not run git commands unless I explicitly ask. I handle commits myself.
- When I do ask, use imperative mood explaining *why* not *what*, and end commit messages with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VYgdhw7HjZYP6gp58wCDXN
  ```
- `dataset_incident_log.json` is **ground truth for testing only**. It must never be
  read, imported or referenced by application or pipeline code. The pipeline has to find
  the incidents on its own.
- Never commit secrets. Supabase keys go in `.env.local` and Vercel env vars, with
  `.env.example` checked in.
- Prefer boring, readable code over abstraction. I have to defend every line.