-- ============================================================================
-- SLA Monitoring Dashboard — initial schema
--
-- Four tables model the pipeline: uploads (one per file) -> checks (every raw
-- CSV line, kept forever, with normalised values + flags) -> slots (one derived
-- verdict per service per 15-min interval) -> incidents (down-slot groupings,
-- for display only).
--
-- Everything is scoped by upload_id. Re-uploading the same file makes a new
-- upload row; nothing is overwritten. ON DELETE CASCADE lets a bad upload be
-- removed cleanly.
--
-- Timestamps are timestamptz and always UTC (see cleaning rule 1). Latency is
-- stored in milliseconds as nullable numeric; the raw value and unit are kept
-- alongside so the logs view can show what arrived and what we did to it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- uploads — one row per uploaded CSV, plus the derived range and the numbers
-- the dashboard's "trust" section reports.
-- ----------------------------------------------------------------------------
create table uploads (
  id           uuid primary key default gen_random_uuid(),
  filename     text        not null,
  uploaded_at  timestamptz not null default now(),

  -- Lifecycle. A run that dies halfway leaves its row at 'processing' or
  -- 'failed'; every dashboard read path filters status = 'complete' so a
  -- partial run is never picked as the newest upload.
  status        text not null default 'processing'
                 check (status in ('processing', 'complete', 'failed')),
  error_message text,  -- populated only when status = 'failed'

  -- Derived from the data, never hardcoded (cleaning rule 8).
  range_start  timestamptz,  -- earliest slot_ts across all services in the file
  range_end    timestamptz,  -- latest slot_ts
  grid_minutes integer,      -- derived slot width (expected 15). Downtime is
                             -- down_slots * grid_minutes, so 15 is not a magic
                             -- constant anywhere in the code.

  -- Trust stats. Each number is independently defined below. They are NOT
  -- mutually exclusive: a row with an epoch timestamp AND an empty latency is
  -- both corrected and nulled, so it is counted in both. This overlap occurs in
  -- every sample file (11 rows in 9d, 15 in 12d, 21 in 14d, 38 in 21d, 39 in
  -- 30d). The counts are per-reason tallies, not a partition of the rows.
  rows_received        integer not null default 0,  -- raw CSV data lines parsed
  duplicates_collapsed integer not null default 0,  -- checks removed by dedup on
                                                    -- (service_id, slot_ts, agent);
                                                    -- equals count of is_duplicate=true
  values_corrected     integer not null default 0,  -- rows kept but whose stored
                                                    -- normalised value differs from raw:
                                                    -- latency unit convert (s->ms),
                                                    -- timestamp reformat (epoch/offset->UTC)
  values_nulled        integer not null default 0,  -- latency set NULL: empty or negative
  slots_no_data        integer not null default 0,  -- derived slots with no valid reading
                                                    -- (requires the grid to be generated)

  created_at   timestamptz not null default now()
);

comment on table uploads is
  'One row per uploaded CSV. Holds the file-derived date range, the grid width, and the pipeline trust counts shown on the dashboard. Never overwritten; a re-upload is a new row.';
comment on column uploads.status is
  'processing while the Edge Function runs, complete on success, failed on error. Read paths filter status = complete so a half-finished run is never shown as the newest upload.';
comment on column uploads.error_message is
  'Failure detail, set only when status = failed. NULL otherwise.';
comment on column uploads.grid_minutes is
  'Derived interval between slots (expected 15). Downtime minutes = down slots * grid_minutes, so the 15-minute assumption is data-derived, not hardcoded.';
comment on column uploads.values_corrected is
  'Rows kept but stored differently from raw (latency s->ms, timestamp normalised to UTC). NOT disjoint from values_nulled: a row can be both corrected and nulled (e.g. epoch timestamp + empty latency), and is counted in both.';
comment on column uploads.values_nulled is
  'Rows whose latency was set NULL because it was empty or negative. The status is still kept and counted. May overlap values_corrected.';
comment on column uploads.slots_no_data is
  'Count of derived slots with zero valid readings. Depends on the pipeline generating the expected grid, not on a count of rows that happened to arrive.';


-- ----------------------------------------------------------------------------
-- checks — every raw CSV line exactly as received, with normalised values and
-- the cleaning flags beside it. Nothing is ever dropped; this is what the logs
-- table reads. Deduplication marks rows (is_duplicate) rather than deleting.
-- ----------------------------------------------------------------------------
create table checks (
  id         bigint generated always as identity primary key,
  upload_id  uuid not null references uploads(id) on delete cascade,

  -- As received. Text, so nothing is coerced or lost before we can flag it.
  service_id       text not null,
  service_name     text,
  raw_timestamp    text not null,  -- original string: ISO 'Z', Unix epoch, or +05:30 offset
  raw_status       text,           -- may be a non-HTTP value such as '999'
  raw_latency      text,           -- original; may be empty or negative
  raw_latency_unit text,           -- 'ms' or 's' as reported by the row itself
  agent            text,           -- e.g. agent-1 / agent-2; part of the dedup key
  region           text,           -- always ap-south-1 in the samples; stored, never used

  -- Normalised.
  ts          timestamptz,  -- raw_timestamp parsed to UTC; NULL if unparseable
  slot_ts     timestamptz,  -- ts floored to the derived grid; the join key to slots
  status_code integer,      -- raw_status parsed to int (999 fits); validity is the flag below
  latency_ms  numeric,      -- normalised to milliseconds; NULL when empty or negative

  -- Flags (cleaning rule 9). The logs view surfaces these so a reader sees what
  -- the pipeline changed.
  is_duplicate    boolean not null default false, -- lost the dedup tie-break on (service_id, slot_ts, agent)
  latency_invalid boolean not null default false, -- raw latency empty or negative
  status_invalid  boolean not null default false, -- raw_status not matching ^[1-5]\d\d$ (probe error, e.g. 999)
  source_format   text  check (source_format in ('iso', 'epoch', 'offset'))
                                                  -- which timestamp format this row arrived in
);

comment on table checks is
  'Every raw CSV line as received, with normalised values and cleaning flags alongside. Nothing is dropped: dedup and invalid values are flagged, never deleted. Source for the logs table.';
comment on column checks.raw_timestamp is
  'Original timestamp string before parsing. Three formats occur: ISO UTC, Unix epoch seconds, and a +05:30 offset. See source_format.';
comment on column checks.slot_ts is
  'Normalised ts floored to the derived grid boundary. Join key to slots and part of the dedup key.';
comment on column checks.status_code is
  'raw_status parsed to integer. status_invalid says whether it is a real HTTP code; 999 is stored here but flagged invalid.';
comment on column checks.latency_ms is
  'Latency normalised to milliseconds using this row''s own unit (svc-search reports seconds). NULL when the raw value was empty or negative.';
comment on column checks.is_duplicate is
  'True when this row lost the dedup tie-break on (service_id, slot_ts, agent). When copies differ only by a missing field, the populated one is kept.';
comment on column checks.status_invalid is
  'True when raw_status is not ^[1-5]\d\d$. Such rows are probe errors, excluded from availability, not counted as service failures.';
comment on column checks.source_format is
  'Timestamp format this row arrived in: iso, epoch, or offset. Feeds the parsing counts.';


-- ----------------------------------------------------------------------------
-- slots — the derived verdict, one row per (upload, service, 15-min slot).
-- Availability, downtime and latency percentiles aggregate from here, not from
-- raw checks (counting rows would over-weight slots that agent-2 re-checked).
-- ----------------------------------------------------------------------------
create table slots (
  id        bigint generated always as identity primary key,
  upload_id uuid not null references uploads(id) on delete cascade,

  service_id text        not null,
  slot_ts    timestamptz not null,  -- start of the 15-min interval, UTC

  verdict text not null check (verdict in ('up', 'down', 'no_data')),
                                    -- down if any valid reading is 5xx; up if all valid are 2xx;
                                    -- no_data if there were no valid readings
  latency_ms          numeric,     -- mean of this slot's valid-reading latencies; NULL if none
  valid_reading_count integer not null default 0,  -- how many valid readings backed the verdict

  -- One verdict per service per slot (cleaning rule 7). Also the index that
  -- serves per-service date-range aggregation.
  unique (upload_id, service_id, slot_ts)
);

comment on table slots is
  'One derived verdict per (upload, service, 15-min slot). Availability, downtime and latency stats aggregate from here. no_data slots are excluded from the availability denominator.';
comment on column slots.verdict is
  'up = all valid readings 2xx; down = any valid reading 5xx; no_data = no valid readings in the slot. Invalid-status probe errors do not count as failures.';
comment on column slots.latency_ms is
  'Mean latency of the slot''s valid readings, in ms. NULL when the slot has no valid readings. p50/p95 are computed as percentiles OVER these slot-level means, not over raw check rows; the two differ and verification.md uses the slot-mean definition, so stage 2 must aggregate from here.';
comment on column slots.valid_reading_count is
  'Number of valid readings that produced the verdict. Zero implies no_data.';


-- ----------------------------------------------------------------------------
-- incidents — down-slot groupings, FOR DISPLAY ONLY. Never feeds the SLA
-- number (that comes straight from slots). Rebuilt per upload: derived, not a
-- source of truth. Failures on one service merge into one row when <=30 min
-- apart; a cluster of 3+ is an incident, fewer is a blip. Both kinds are stored
-- so the dashboard can show incident count, longest incident, timeline, and
-- blip count from one table.
-- ----------------------------------------------------------------------------
create table incidents (
  id        bigint generated always as identity primary key,
  upload_id uuid not null references uploads(id) on delete cascade,

  service_id       text        not null,
  kind             text        not null check (kind in ('incident', 'blip')),
                                             -- 3+ merged failures = incident, fewer = blip
  started_at       timestamptz not null,     -- slot_ts of the first down slot in the group
  ended_at         timestamptz not null,     -- slot_ts of the last down slot in the group
  down_slot_count  integer     not null,     -- down slots inside the group (flapping means < span)
  duration_minutes integer     not null      -- down_slot_count * uploads.grid_minutes; the
                                             -- downtime attributable to this group, not wall span
);

comment on table incidents is
  'Down-slot groupings for display only (timeline, incident/blip counts). Never used to compute availability. Rebuilt per upload from slots. Failures merge when <=30 min apart; 3+ = incident, fewer = blip.';
comment on column incidents.kind is
  'incident = 3+ merged down slots; blip = 1-2. Lets the dashboard count both from one table.';
comment on column incidents.down_slot_count is
  'Number of down slots in the group. Less than the wall-clock span because incidents flap (some checks still return 200).';
comment on column incidents.duration_minutes is
  'down_slot_count * grid_minutes. The downtime this group contributes, consistent with the SLA number, not the start-to-end wall span.';


-- ----------------------------------------------------------------------------
-- Indexes for the two queries that matter.
-- ----------------------------------------------------------------------------

-- Logs table: rows for an upload filtered by a date or date range, newest-first.
create index checks_upload_ts_idx on checks (upload_id, ts);

-- Optional narrower path when the logs view is also filtered by service.
create index checks_upload_service_ts_idx on checks (upload_id, service_id, ts);

-- Stats, per named service over a date range: the UNIQUE (upload_id, service_id,
-- slot_ts) btree already serves this — it leads with service_id.
-- Stats across ALL services over a date range (the dashboard's main query): that
-- unique btree can't range-scan a slot_ts window without a service_id, so add an
-- index that leads with slot_ts.
create index slots_upload_ts_idx on slots (upload_id, slot_ts);

-- Incident timeline for an upload, per service, in time order.
create index incidents_upload_service_start_idx on incidents (upload_id, service_id, started_at);


-- ============================================================================
-- Row Level Security
--
-- No authentication is in scope, but RLS is left ENABLED rather than disabled,
-- because a Supabase table with RLS off is readable AND writable by the public
-- anon key. We want the opposite: the public can read (the dashboard uses the
-- anon key in the browser) but cannot write.
--
-- So: enable RLS, grant anon/authenticated SELECT only, and add NO insert or
-- update policy. All writes come from the Edge Function using the service_role
-- key, which has BYPASSRLS and is never exposed to the browser. This means a
-- leaked anon key can read the monitoring data but can never insert, alter, or
-- delete it.
-- ============================================================================

alter table uploads   enable row level security;
alter table checks    enable row level security;
alter table slots     enable row level security;
alter table incidents enable row level security;

-- Read-only access for the public (anon) and any signed-in (authenticated) role.
create policy "public read uploads"   on uploads   for select to anon, authenticated using (true);
create policy "public read checks"    on checks    for select to anon, authenticated using (true);
create policy "public read slots"     on slots     for select to anon, authenticated using (true);
create policy "public read incidents" on incidents for select to anon, authenticated using (true);

-- Supabase's default privileges grant ALL on new public-schema tables to anon
-- and authenticated, so these tables were created with insert/update/delete
-- already granted. RLS blocks those writes (enabled, with no insert/update/
-- delete policy), but the grants themselves contradict the intent. Revoke
-- everything first, then grant back only SELECT, so table privileges and RLS
-- say the same thing. service_role is unaffected and still bypasses both.
revoke all on uploads, checks, slots, incidents from anon, authenticated;
grant select on uploads, checks, slots, incidents to anon, authenticated;