-- ============================================================================
-- Stats views, v2. Supersedes the definitions in 20260925000003 (which is
-- already applied and must not be edited). Changes:
--
--   * All three views are recreated WITH (security_invoker = true) — a
--     DELIBERATE choice, documented here. By default a Postgres view runs with
--     its OWNER's privileges and so bypasses RLS on the underlying tables.
--     0003 created these views that way. It was harmless because our RLS grants
--     public SELECT anyway, but "harmless by accident" is not a security model.
--     security_invoker = true makes each view run as the querying role (anon),
--     so it is subject to the same RLS SELECT policies as a direct table read.
--     Result is identical (public read), but now it is by design.
--
--   * SELECT is re-granted on every view. Table grants do NOT propagate to
--     views: a view is a separate object, so without an explicit grant the
--     anon/authenticated roles get "permission denied" no matter what the base
--     tables allow. (This grant already existed in 0003; repeated here because
--     the views are dropped and recreated.)
--
--   * v_service_incidents: "longest incident" now exposes BOTH its wall-clock
--     span and its attributed downtime, and blip_count is redefined (see below).
--
-- Percentile method (percentile_cont / R-7) and every other definition are
-- unchanged from 0003.
-- ============================================================================

drop view if exists v_service_stats;
drop view if exists v_service_incidents;
drop view if exists v_monthly_stats;

-- Per (upload, service): availability, downtime, error budget, latency spread.
create view v_service_stats
with (security_invoker = true) as
select
  s.upload_id,
  s.service_id,
  count(*) filter (where s.verdict <> 'no_data')            as valid_slots,
  count(*) filter (where s.verdict = 'down')                as down_slots,
  count(*) filter (where s.verdict = 'no_data')             as no_data_slots,
  round(
    (count(*) filter (where s.verdict = 'up'))::numeric
      / nullif(count(*) filter (where s.verdict <> 'no_data'), 0) * 100,
    3
  )                                                          as availability_pct,
  count(*) filter (where s.verdict = 'down') * u.grid_minutes as downtime_minutes,
  round(
    count(*) filter (where s.verdict <> 'no_data') * u.grid_minutes * 0.001,
    1
  )                                                          as budget_allowed_minutes,
  percentile_cont(0.5)  within group (order by s.latency_ms) as p50_ms,
  percentile_cont(0.95) within group (order by s.latency_ms) as p95_ms
from slots s
join uploads u on u.id = s.upload_id
group by s.upload_id, s.service_id, u.grid_minutes;

-- Per (upload, service): incident count, blip count, and the longest incident
-- expressed BOTH ways.
--
-- blip_count is the number of DOWN SLOTS that are not part of an incident — the
-- count of isolated failures an on-call reader cares about, not the number of
-- clusters they happened to form. Every down slot is in exactly one group in the
-- incidents table (incident or blip kind), so blip down-slots = the down_slot_count
-- summed over the blip-kind rows.
--
-- longest incident: the incident with the greatest wall-clock span. We surface
-- both its span (first down slot to last down slot, inclusive of the last slot's
-- width) and its attributed downtime (down_slot_count * grid). They differ
-- because incidents flap — showing only one misleads a reader comparing it to
-- the timeline.
create view v_service_incidents
with (security_invoker = true) as
with per_service as (
  select
    i.upload_id,
    i.service_id,
    count(*) filter (where i.kind = 'incident')                          as incident_count,
    coalesce(sum(i.down_slot_count) filter (where i.kind = 'blip'), 0)   as blip_count
  from incidents i
  group by i.upload_id, i.service_id
),
longest as (
  select distinct on (i.upload_id, i.service_id)
    i.upload_id,
    i.service_id,
    (extract(epoch from (i.ended_at - i.started_at)) / 60)::int + u.grid_minutes
                                                          as longest_incident_span_minutes,
    i.duration_minutes                                    as longest_incident_downtime_minutes
  from incidents i
  join uploads u on u.id = i.upload_id
  where i.kind = 'incident'
  order by i.upload_id, i.service_id, (i.ended_at - i.started_at) desc
)
select
  p.upload_id,
  p.service_id,
  p.incident_count,
  p.blip_count,
  coalesce(l.longest_incident_span_minutes, 0)     as longest_incident_span_minutes,
  coalesce(l.longest_incident_downtime_minutes, 0) as longest_incident_downtime_minutes
from per_service p
left join longest l using (upload_id, service_id);

-- Per (upload, service, calendar month): monthly SLA breakdown with a
-- partial-month flag. Unchanged from 0003 apart from security_invoker.
create view v_monthly_stats
with (security_invoker = true) as
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
  (
    first_slot > month
    or last_slot < (month + interval '1 month' - make_interval(mins => grid_minutes))
  )                                                          as partial_month
from monthly;

grant select on v_service_stats, v_service_incidents, v_monthly_stats
  to anon, authenticated;
