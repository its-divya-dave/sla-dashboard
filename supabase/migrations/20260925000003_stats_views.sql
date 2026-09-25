-- ============================================================================
-- Read-side aggregation views. The dashboard reads with the anon key and RLS;
-- all aggregation happens HERE, in Postgres, never in the browser (the 30-day
-- upload has 14,400 slots — far too many to pull client-side to sum). Each view
-- is grouped by upload_id so the dashboard filters to one upload.
--
-- Percentiles use percentile_cont (linear interpolation between adjacent ranks),
-- which is the R-7 method verification.md expects, computed over slot-level mean
-- latency — the same definition the pipeline and the verify runner use.
--
-- Views are owned by the migration role, so they read the underlying tables
-- without being blocked by those tables' RLS; anon is granted SELECT on the
-- views only. The data is public-read anyway (see the RLS note in the initial
-- schema), so this exposes nothing that a direct table read would not.
-- ============================================================================

-- Per (upload, service): availability, downtime, error budget, latency spread.
create view v_service_stats as
select
  s.upload_id,
  s.service_id,
  count(*) filter (where s.verdict <> 'no_data')            as valid_slots,
  count(*) filter (where s.verdict = 'down')                as down_slots,
  count(*) filter (where s.verdict = 'no_data')             as no_data_slots,
  -- Availability over slots that had a valid reading (no_data drops out of the
  -- denominator). up = valid - down, so up/valid == (valid-down)/valid.
  round(
    (count(*) filter (where s.verdict = 'up'))::numeric
      / nullif(count(*) filter (where s.verdict <> 'no_data'), 0) * 100,
    3
  )                                                          as availability_pct,
  -- Every down slot is one grid step of downtime (strict rule from CLAUDE.md).
  count(*) filter (where s.verdict = 'down') * u.grid_minutes as downtime_minutes,
  -- Error budget: 99.9% leaves 0.1% of the measured period as allowed downtime.
  round(
    count(*) filter (where s.verdict <> 'no_data') * u.grid_minutes * 0.001,
    1
  )                                                          as budget_allowed_minutes,
  -- Percentiles over slot mean latency; percentile_cont ignores the NULLs
  -- (no_data slots), so they are naturally excluded.
  percentile_cont(0.5)  within group (order by s.latency_ms) as p50_ms,
  percentile_cont(0.95) within group (order by s.latency_ms) as p95_ms
from slots s
join uploads u on u.id = s.upload_id
group by s.upload_id, s.service_id, u.grid_minutes;

-- Per (upload, service): incident / blip counts and the longest incident, from
-- the pre-grouped incidents table. Longest is measured in attributed downtime.
create view v_service_incidents as
select
  i.upload_id,
  i.service_id,
  count(*) filter (where i.kind = 'incident')                    as incident_count,
  count(*) filter (where i.kind = 'blip')                        as blip_count,
  coalesce(max(i.duration_minutes) filter (where i.kind = 'incident'), 0)
                                                                 as longest_incident_minutes
from incidents i
group by i.upload_id, i.service_id;

-- Per (upload, service, calendar month): the monthly SLA breakdown. partial_month
-- is true when the upload does not cover the whole calendar month, so a reader
-- knows not to make a credit decision on it.
create view v_monthly_stats as
with monthly as (
  select
    s.upload_id,
    s.service_id,
    date_trunc('month', s.slot_ts)                  as month,
    count(*) filter (where s.verdict = 'up')         as up_slots,
    count(*) filter (where s.verdict = 'down')       as down_slots,
    count(*) filter (where s.verdict <> 'no_data')   as valid_slots,
    min(s.slot_ts)                                   as first_slot,
    max(s.slot_ts)                                   as last_slot,
    u.grid_minutes
  from slots s
  join uploads u on u.id = s.upload_id
  group by s.upload_id, s.service_id, date_trunc('month', s.slot_ts), u.grid_minutes
)
select
  upload_id,
  service_id,
  month,
  valid_slots,
  down_slots,
  round(up_slots::numeric / nullif(valid_slots, 0) * 100, 3) as availability_pct,
  down_slots * grid_minutes                                  as downtime_minutes,
  -- Full coverage means the first slot is the month's first slot and the last
  -- slot is the month's last slot (one grid step before the next month starts).
  (
    first_slot > month
    or last_slot < (month + interval '1 month' - make_interval(mins => grid_minutes))
  )                                                          as partial_month
from monthly;

grant select on v_service_stats, v_service_incidents, v_monthly_stats
  to anon, authenticated;
