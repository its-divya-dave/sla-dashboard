# Data Findings

Each row is one health check: service, timestamp, status code, latency, agent, region.
Expected volume is 5 services x 96 checks/day x N days. Every file has more rows than
that (4,672 vs 4,320 for 9 days), because of duplicate and overlapping reports.

Counts below are listed for the 9, 12, 14, 21 and 30 day files, in that order.

**1. Timestamps come in three formats.**
Most are ISO UTC. Some are Unix epoch seconds. Some carry a `+05:30` (IST) offset.
Counts: epoch 70 / 93 / 109 / 163 / 233. Offset 32 / 43 / 50 / 76 / 109.
Fix: parse all-digit values as epoch, convert everything to UTC.
If the offset is ignored, the 30-day file loses about 100 slots and gains 100 fake
duplicates. Once converted, every one of those rows lands exactly on the 15-minute grid.

**2. Latency units are mixed.**
`svc-search` reports seconds (0.486). Every other service reports milliseconds.
Fix: convert to milliseconds using each row's own unit column, never the service name.

**3. Latency is sometimes missing.**
Counts: 56 / 74 / 87 / 130 / 186.
Fix: keep the row, since the status still counts. Store latency as NULL and leave it
out of the latency percentiles.

**4. Latency is sometimes negative.**
One row per file, e.g. -296 ms.
Fix: impossible value. Null the latency, keep the status, flag the row.

**5. Status code 999 appears once per file.**
Not a real HTTP code. In the 14-day file, agent-2 reported 200 for the same slot.
Fix: treat it as a probe error, not a service failure. Drop it from availability.
If a slot has no other valid reading, it counts as "no data".

**6. Two agents check some of the same slots.**
agent-2 re-checks a subset of agent-1's slots.
Counts: 345 / 460 / 537 / 806 / 1,153 slots.
Fix: collapse to one result per service per 15-minute slot. The agents never disagree
on status, apart from the 999 case above.

**7. The same agent sometimes reports the same slot twice.**
Counts: 7 / 10 / 12 / 18 / 25.
Some are exact copies. Some are the same check written once as epoch and once as ISO,
so they only appear after timestamps are normalised. In one case, one copy had a
latency and the other was empty.
Fix: deduplicate on the normalised service + slot + agent key, merging missing fields.

**8. Rows are shuffled, and line endings are CRLF.**
Fix: sort after parsing, trim values, assume nothing about input order.

## Checked for, not present

The code still handles these, since a later upload could contain them.

- Missing slots. Every service has exactly 96 checks a day in every file.
- Timestamps off the 15-minute grid, or outside the file's date range.
- Service ID and service name disagreeing.
- Agents disagreeing on status, apart from the 999 case.
- Region is always `ap-south-1`, so it carries no information. Stored, never used.

## What the failures look like

Failures fall into two clear patterns.

- **Incidents.** Sustained windows of 1.5 to 6 hours. About 70% of checks fail, and the
  checks that still return 200 are 3 to 5 times slower than normal. svc-reports runs at
  about 650 ms normally and about 3,000 ms during its incident. These windows flap, so
  the longest unbroken run of failures is only 5 to 8 checks.
- **Blips.** A blip is a down slot that is not part of an incident — an isolated failure,
  usually with healthy slots either side. This is the definition the dashboard uses and
  counts (down slots, not clusters), because what an on-call reader wants is how many
  isolated failures there were, not how many ways they clumped. 35 / 58 / 81 / 108 / 157
  per file (9, 12, 14, 21, 30 day), mostly on svc-reports.

# Assumptions

**Availability is measured in slots, not rows.**
One verdict per service per 15-minute slot. Counting rows would give extra weight to
whichever slots agent-2 happened to check.

- Down if any valid reading is a 5xx.
- Up if all valid readings are 2xx.
- No data if there are no valid readings. Excluded from the total, shown separately.
- Slot latency is the mean of its valid readings.

**Raw rows are kept in the database, with flags.**
`is_duplicate`, `latency_invalid`, `status_invalid`, `source_format`. The logs view can
then show what arrived and what was done to it. Nothing is silently deleted.

**Every down slot counts as 15 minutes of downtime.**
The check is the only evidence there is, so a failed check stands for its interval.
I chose this over a "N consecutive failures" rule because the spec gives no confirmation
rule, and because the flapping pattern means a consecutive rule would under-count real
incidents.

Under this rule every service in every sample file is below 99.9%, with svc-reports
between 96.5% and 97.7%. That is expected: 99.9% allows about 43 minutes per 30 days,
so three failed checks exhaust it. I would rather state that than tune the definition
until the numbers look healthy. The dashboard splits incident downtime from blip
downtime so a reader can see where the breach comes from.

**Incidents are grouped for display only, not for the SLA number.**
Failures on one service merge into one incident when they are 30 minutes or less apart.
Three or more failures make an incident, fewer make a blip. This recovers the real
windows, give or take an edge check: the 9-day file has one failure at check-point 70,
just outside the logged 64 to 69 window.

**The SLA period is the selected date range, with a monthly breakdown.**
SLAs are monthly, but uploads cover any range, and two sample files cross a month
boundary (May to June, April to May). The headline number covers the selected range.
The stats section also breaks it down per calendar month, marked "partial month" where
the data does not cover the full month. A credit decision should only be made on a
complete month.

**Stats are chosen for two readers.**

Billing:
- Availability % per service against 99.9%
- Breach yes/no
- Downtime minutes
- Error budget, minutes allowed against minutes used

Credit tiers are not specified, so I show breach status rather than inventing
credit percentages.

On-call:
- Incident count, longest incident, incident timeline
- Blip count
- p50 and p95 latency per service

Latency is there because degradation starts before failures do. During incidents even
the successful checks are 3 to 5 times slower.

Trust in the numbers:
- Rows received, duplicates collapsed, values corrected, values nulled, slots with no data

If the pipeline changed the data, the dashboard says so.
