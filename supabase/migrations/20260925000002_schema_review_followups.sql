-- ============================================================================
-- Follow-up to 20260925000001_initial_schema.sql.
--
-- 20260925000001 was already applied to the remote database, and must not be
-- edited further. Review edits made to that file after it was pushed are carried
-- here instead.
--
-- This migration is intentionally IDEMPOTENT. From the environment it was
-- authored in there is no database password and no catalog access, and the anon
-- REST API cannot read information_schema / pg_indexes, so the live state of the
-- index, the privileges and the comments could not be fully inspected. Every
-- statement below is therefore safe to run whether or not the piece already
-- exists.
--
-- What WAS verified (anon REST, with a bogus-column control): the uploads.status
-- and uploads.error_message COLUMNS are already live. They are deliberately not
-- recreated here — only their comments are set, which is harmless if already set.
-- ============================================================================

-- --- Index (review change C) ------------------------------------------------
-- All-services date-range scan on slots. The UNIQUE (upload_id, service_id,
-- slot_ts) btree leads with service_id and cannot range-scan a slot_ts window
-- without naming a service, so the dashboard's main query needs an index that
-- leads with slot_ts. IF NOT EXISTS so this is a no-op when already present.
create index if not exists slots_upload_ts_idx on slots (upload_id, slot_ts);

-- --- Privileges -------------------------------------------------------------
-- Supabase grants ALL on new public tables to anon/authenticated by default, so
-- the tables were created with insert/update/delete already granted. RLS blocks
-- those writes, but the grants contradict the intent. Revoke everything, then
-- grant back SELECT only, so privileges and RLS say the same thing. Both
-- statements are idempotent. service_role bypasses both and is unaffected.
revoke all on uploads, checks, slots, incidents from anon, authenticated;
grant select on uploads, checks, slots, incidents to anon, authenticated;

-- --- Comments changed or added during review (COMMENT ON is idempotent) ------
comment on column uploads.status is
  'processing while the Edge Function runs, complete on success, failed on error. Read paths filter status = complete so a half-finished run is never shown as the newest upload.';
comment on column uploads.error_message is
  'Failure detail, set only when status = failed. NULL otherwise.';
comment on column uploads.values_corrected is
  'Rows kept but stored differently from raw (latency s->ms, timestamp normalised to UTC). NOT disjoint from values_nulled: a row can be both corrected and nulled (e.g. epoch timestamp + empty latency), and is counted in both.';
comment on column uploads.values_nulled is
  'Rows whose latency was set NULL because it was empty or negative. The status is still kept and counted. May overlap values_corrected.';
comment on column slots.latency_ms is
  'Mean latency of the slot''s valid readings, in ms. NULL when the slot has no valid readings. p50/p95 are computed as percentiles OVER these slot-level means, not over raw check rows; the two differ and verification.md uses the slot-mean definition, so stage 2 must aggregate from here.';
