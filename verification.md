# Verification targets

Expected output of the cleaning pipeline on the five sample files, computed
independently. Stage 2 of the build is not done until the pipeline reproduces these.

Rules used to produce them are the ones in `CLAUDE.md`: timestamps normalised to UTC,
latency normalised to ms, negative latency nulled, status codes outside `^[1-5]\d\d$`
excluded as probe errors, deduplicated on `(service, slot, agent)`, one verdict per
15-minute slot, down if any valid reading is a 5xx, 15 minutes of downtime per down slot.

## Parsing counts

| File | Rows in file | Rows after dedup | Epoch timestamps | `+05:30` timestamps | Empty latency | Negative latency | Invalid status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 9d_seed101 | 4,672 | 4,665 | 70 | 32 | 56 | 1 | 1 |
| 12d_seed505 | 6,230 | 6,220 | 93 | 43 | 74 | 1 | 1 |
| 14d_seed202 | 7,269 | 7,257 | 109 | 50 | 87 | 1 | 1 |
| 21d_seed303 | 10,904 | 10,886 | 163 | 76 | 130 | 1 | 1 |
| 30d_seed404 | 15,577 | 15,552 | 233 | 109 | 186 | 1 | 1 |

## Date ranges (UTC, derived from the data — never hardcoded)

| File | First slot | Last slot | Days |
| --- | --- | --- | --- |
| 9d_seed101 | 2025-05-08 00:00 | 2025-05-16 23:45 | 9 |
| 12d_seed505 | 2025-04-10 00:00 | 2025-04-21 23:45 | 12 |
| 14d_seed202 | 2025-05-19 00:00 | 2025-06-01 23:45 | 14 |
| 21d_seed303 | 2025-04-03 00:00 | 2025-04-23 23:45 | 21 |
| 30d_seed404 | 2025-04-06 00:00 | 2025-05-05 23:45 | 30 |

## Per-service results

`slots` is the number of slots with at least one valid reading. Where it is one short of
`96 × days`, that slot's only reading was the invalid `999`, so it is correctly "no data".
Every service breaches the 99.9% target in every file.

Percentiles (p50, p95) are compared with a tolerance of ±0.1 ms. These numbers were
generated in Python, whose `round()` breaks an exact `.5` tie to the nearest even digit,
while the pipeline runs in JavaScript, whose `Math.round` breaks half up. On an exact tie
(e.g. 838.35 → 838.3 in Python vs 838.4 in JS, or 113.25 → 113.2 vs 113.3) the two disagree
by 0.1 even though the underlying latency is identical. The pipeline stores percentiles at
full precision and rounds only for display, so this is a display tie-break, not a data
difference.

### 9d_seed101 (864 slots expected per service)

| Service | Slots | Down | Availability | Downtime (min) | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| svc-auth | 864 | 4 | 99.537% | 60 | 145.0 | 186.0 |
| svc-notify | 864 | 3 | 99.653% | 45 | 115.0 | 148.0 |
| svc-payments | 863 | 4 | 99.537% | 60 | 374.0 | 482.0 |
| svc-reports | 864 | 21 | 97.569% | 315 | 643.5 | 843.0 |
| svc-search | 864 | 9 | 98.958% | 135 | 543.0 | 701.0 |

### 12d_seed505 (1,152 expected)

| Service | Slots | Down | Availability | Downtime (min) | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| svc-auth | 1,151 | 6 | 99.479% | 90 | 145.8 | 187.0 |
| svc-notify | 1,152 | 3 | 99.740% | 45 | 113.0 | 148.0 |
| svc-payments | 1,152 | 13 | 98.872% | 195 | 372.0 | 484.0 |
| svc-reports | 1,152 | 27 | 97.656% | 405 | 645.0 | 839.1 |
| svc-search | 1,152 | 28 | 97.569% | 420 | 538.0 | 710.0 |

### 14d_seed202 (1,344 expected)

| Service | Slots | Down | Availability | Downtime (min) | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| svc-auth | 1,344 | 5 | 99.628% | 75 | 143.0 | 186.0 |
| svc-notify | 1,344 | 32 | 97.619% | 480 | 115.0 | 149.0 |
| svc-payments | 1,344 | 14 | 98.958% | 210 | 368.0 | 483.0 |
| svc-reports | 1,344 | 47 | 96.503% | 705 | 635.0 | 839.0 |
| svc-search | 1,344 | 7 | 99.479% | 105 | 546.0 | 704.0 |

### 21d_seed303 (2,016 expected)

| Service | Slots | Down | Availability | Downtime (min) | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| svc-auth | 2,016 | 4 | 99.802% | 60 | 146.0 | 187.0 |
| svc-notify | 2,016 | 3 | 99.851% | 45 | 115.0 | 148.0 |
| svc-payments | 2,016 | 46 | 97.718% | 690 | 374.0 | 485.0 |
| svc-reports | 2,016 | 54 | 97.321% | 810 | 644.0 | 838.3 |
| svc-search | 2,015 | 17 | 99.156% | 255 | 545.5 | 706.0 |

### 30d_seed404 (2,880 expected)

| Service | Slots | Down | Availability | Downtime (min) | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| svc-auth | 2,879 | 29 | 98.993% | 435 | 143.0 | 188.0 |
| svc-notify | 2,880 | 8 | 99.722% | 120 | 113.2 | 148.0 |
| svc-payments | 2,880 | 34 | 98.819% | 510 | 372.0 | 484.0 |
| svc-reports | 2,880 | 82 | 97.153% | 1,230 | 655.0 | 846.0 |
| svc-search | 2,880 | 29 | 98.993% | 435 | 538.0 | 700.8 |

## Incident detection check

Group failures per service, merging those ≤30 minutes apart, and keep clusters of 3+.
The result should match `data/dataset_incident_log.json`, allowing one check at the edges.
Check-points are 15-minute indexes from 00:00 UTC on the given day.

| File | Expected incident |
| --- | --- |
| 9d_seed101 | svc-reports, day 5, check-points 64–69 |
| 12d_seed505 | svc-search, day 4, 48–67 · svc-search, day 8, 49–54 |
| 14d_seed202 | svc-notify, day 0, 59–77 · svc-notify, day 6, 30–40 |
| 21d_seed303 | svc-payments, day 2, 38–60 |
| 30d_seed404 | svc-auth, day 16, 16–41 · svc-reports, day 3, 47–55 |

Known edge case: 9d_seed101 has failures at check-points 70 and 72, past the logged 64–69
window. They sit adjacent to the real incident and within the 3-slot merge gap, so any gap
rule pulls them in; the detected window comes out 64–72. Edge drift is therefore allowed up
to 3 check-points at either boundary. A missed incident, or a blip promoted to an incident,
is not allowed — those are the failures that matter, and the 2× latency-degradation test
(not the gap rule) is what prevents them.

Sanity signal that the grouping is working: inside these windows roughly 70% of checks
fail and the checks that still return 200 run 3–5× slower than the service's p50.
Everything outside them is a single failed check with healthy neighbours.