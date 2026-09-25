// Row shapes returned by the DB, matching the schema and the stats views.

export interface Upload {
  id: string;
  filename: string;
  uploaded_at: string;
  status: "processing" | "complete" | "failed";
  error_message: string | null;
  range_start: string | null;
  range_end: string | null;
  grid_minutes: number | null;
  rows_received: number;
  duplicates_collapsed: number;
  values_corrected: number;
  values_nulled: number;
  slots_no_data: number;
}

// v_service_stats
export interface ServiceStat {
  service_id: string;
  valid_slots: number;
  down_slots: number;
  no_data_slots: number;
  availability_pct: number | null;
  downtime_minutes: number;
  budget_allowed_minutes: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

// v_service_incidents
export interface ServiceIncidentAgg {
  service_id: string;
  incident_count: number;
  // Down slots that are NOT part of an incident — isolated failures, not clusters.
  blip_count: number;
  // Longest incident, both ways: wall-clock span and attributed downtime.
  longest_incident_span_minutes: number;
  longest_incident_downtime_minutes: number;
}

// v_monthly_stats
export interface MonthlyStat {
  service_id: string;
  month: string;
  valid_slots: number;
  down_slots: number;
  availability_pct: number | null;
  downtime_minutes: number;
  partial_month: boolean;
}

// incidents (kind = 'incident') for the timeline
export interface Incident {
  service_id: string;
  kind: "incident" | "blip";
  started_at: string;
  ended_at: string;
  down_slot_count: number;
  duration_minutes: number;
}

// checks — one raw log row with normalised values and flags
export interface CheckRow {
  id: number;
  service_id: string;
  service_name: string | null;
  raw_timestamp: string;
  raw_status: string | null;
  raw_latency: string | null;
  raw_latency_unit: string | null;
  agent: string | null;
  region: string | null;
  ts: string | null;
  slot_ts: string | null;
  status_code: number | null;
  latency_ms: number | null;
  is_duplicate: boolean;
  latency_invalid: boolean;
  status_invalid: boolean;
  source_format: "iso" | "epoch" | "offset" | null;
}

// Summary the Edge Function returns on a successful upload.
export interface UploadResult {
  upload_id: string;
  status: string;
  range_start: string | null;
  range_end: string | null;
  grid_minutes: number | null;
  counts: {
    rows_received: number;
    duplicates_collapsed: number;
    values_corrected: number;
    values_nulled: number;
    slots_no_data: number;
    checks_inserted: number;
    slots_inserted: number;
    incidents_inserted: number;
  };
}

export const SLA_TARGET_PCT = 99.9;
