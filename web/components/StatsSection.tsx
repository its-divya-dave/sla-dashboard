"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  fmtMinutes,
  fmtMs,
  fmtMonth,
  fmtPct,
} from "@/lib/format";
import {
  type Incident,
  type MonthlyStat,
  type ServiceIncidentAgg,
  type ServiceStat,
  SLA_TARGET_PCT,
  type Upload,
} from "@/lib/types";

// Per-service view row merged from the two stats views.
interface MergedService extends ServiceStat, Partial<ServiceIncidentAgg> {}

export default function StatsSection({ upload }: { upload: Upload }) {
  const [open, setOpen] = useState(true);
  const [services, setServices] = useState<MergedService[]>([]);
  const [monthly, setMonthly] = useState<MonthlyStat[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      // Four small reads, all aggregated in Postgres. Run them together.
      const [statsRes, incAggRes, monthlyRes, timelineRes] = await Promise.all([
        supabase
          .from("v_service_stats")
          .select("*")
          .eq("upload_id", upload.id)
          .order("service_id"),
        supabase.from("v_service_incidents").select("*").eq("upload_id", upload.id),
        supabase
          .from("v_monthly_stats")
          .select("*")
          .eq("upload_id", upload.id)
          .order("service_id")
          .order("month"),
        // Both kinds: the timeline shows incidents prominently and blips as
        // subordinate ticks, so the noise-vs-incident story is visible.
        supabase
          .from("incidents")
          .select("*")
          .eq("upload_id", upload.id)
          .order("started_at"),
      ]);

      if (cancelled) return;

      const firstError =
        statsRes.error || incAggRes.error || monthlyRes.error || timelineRes.error;
      if (firstError) {
        setError(firstError.message);
        setLoading(false);
        return;
      }

      // Merge incident aggregates onto the service stats by service_id.
      const aggById = new Map<string, ServiceIncidentAgg>();
      for (const a of (incAggRes.data ?? []) as ServiceIncidentAgg[]) {
        aggById.set(a.service_id, a);
      }
      const merged = ((statsRes.data ?? []) as ServiceStat[]).map((s) => ({
        ...s,
        ...aggById.get(s.service_id),
      }));

      setServices(merged);
      setMonthly((monthlyRes.data ?? []) as MonthlyStat[]);
      setIncidents((timelineRes.data ?? []) as Incident[]);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [upload.id]);

  return (
    <section className="panel">
      <div className="row spread" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <h2>Stats {open ? "▾" : "▸"}</h2>
        <span className="muted">{open ? "Click to collapse" : "Click to expand"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 20 }}>
          {loading && <div className="muted">Loading stats…</div>}
          {error && (
            <div className="badge bad" style={{ display: "block", padding: "10px 12px" }}>
              Could not load stats: {error}
              <div style={{ marginTop: 6, fontWeight: 400 }}>
                If this mentions a missing relation, the stats-views migration
                (20260925000003) has not been pushed yet.
              </div>
            </div>
          )}

          {!loading && !error && (
            <>
              <ServiceCards services={services} />
              <IncidentTimeline incidents={incidents} upload={upload} />
              <MonthlyBreakdown monthly={monthly} />
              <TrustBlock upload={upload} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ServiceCards({ services }: { services: MergedService[] }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3>Per service — availability &amp; on-call</h3>
      <div className="cards">
        {services.map((s) => {
          const breach = s.availability_pct !== null && s.availability_pct < SLA_TARGET_PCT;
          return (
            <div className="card" key={s.service_id}>
              <div className="row spread" style={{ marginBottom: 10 }}>
                <span className="service">{s.service_id}</span>
                <span className={`badge ${breach ? "bad" : "ok"}`}>
                  {breach ? "SLA breach" : "Meets SLA"}
                </span>
              </div>

              <div className="big" style={{ color: breach ? "var(--bad)" : "var(--ok)" }}>
                {fmtPct(s.availability_pct)}
              </div>
              <div className="muted" style={{ marginBottom: 12 }}>
                against {SLA_TARGET_PCT}% target
              </div>

              <Metric label="Downtime" value={fmtMinutes(s.downtime_minutes)} />
              <Metric
                label="Error budget"
                value={`${fmtMinutes(s.downtime_minutes)} used / ${fmtMinutes(
                  s.budget_allowed_minutes,
                )} allowed`}
              />
              <Metric label="p50 latency" value={fmtMs(s.p50_ms)} />
              <Metric label="p95 latency" value={fmtMs(s.p95_ms)} />
              <Metric label="Incidents" value={String(s.incident_count ?? 0)} />
              <Metric
                label="Longest incident"
                value={
                  (s.incident_count ?? 0) === 0
                    ? "—"
                    : `${fmtMinutes(s.longest_incident_span_minutes ?? 0)} span · ${fmtMinutes(
                        s.longest_incident_downtime_minutes ?? 0,
                      )} down`
                }
              />
              <Metric
                label="Blips (isolated down slots)"
                value={String(s.blip_count ?? 0)}
              />
              {s.no_data_slots > 0 && (
                <Metric label="No-data slots" value={String(s.no_data_slots)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

function IncidentTimeline({
  incidents,
  upload,
}: {
  incidents: Incident[];
  upload: Upload;
}) {
  const startMs = upload.range_start ? Date.parse(upload.range_start) : 0;
  const endMs = upload.range_end ? Date.parse(upload.range_end) : 0;
  const span = Math.max(1, endMs - startMs);
  const pct = (iso: string) => ((Date.parse(iso) - startMs) / span) * 100;

  // Group by service; keep a stable service order.
  const byService = new Map<string, Incident[]>();
  for (const i of incidents) {
    const list = byService.get(i.service_id) ?? [];
    list.push(i);
    byService.set(i.service_id, list);
  }
  const services = [...byService.keys()].sort();

  // The story, in one line: how much of the downtime is the two incidents vs
  // scattered single-check noise.
  const incidentDown = incidents
    .filter((i) => i.kind === "incident")
    .reduce((a, i) => a + i.down_slot_count, 0);
  const blipDown = incidents
    .filter((i) => i.kind === "blip")
    .reduce((a, i) => a + i.down_slot_count, 0);
  const incidentCount = incidents.filter((i) => i.kind === "incident").length;

  return (
    <div style={{ marginBottom: 28 }}>
      <h3>Incident timeline</h3>

      <div className="sub" style={{ marginBottom: 12 }}>
        {incidentCount} incident{incidentCount === 1 ? "" : "s"} account for{" "}
        {incidentDown} down slots; {blipDown} more are scattered single-check
        blips. Both count fully against the SLA — the noise is why every service
        breaches. Tall bars are incidents; faint ticks are blips.
      </div>

      {services.map((svc) => {
        const items = byService.get(svc)!;
        return (
          <div key={svc} className="row" style={{ gap: 12, marginBottom: 6 }}>
            <div className="mono muted" style={{ width: 110, flexShrink: 0 }}>
              {svc}
            </div>
            <div
              style={{
                position: "relative",
                flex: 1,
                height: 26,
                background: "#f0f2f5",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              {items.map((i, idx) => {
                const left = pct(i.started_at);
                if (i.kind === "incident") {
                  const width = Math.max(0.8, pct(i.ended_at) - left);
                  return (
                    <div
                      key={idx}
                      title={`${svc} incident · ${i.started_at.slice(0, 16).replace("T", " ")}–${i.ended_at.slice(11, 16)} UTC · ${i.down_slot_count} down slots`}
                      style={{
                        position: "absolute",
                        left: `${left}%`,
                        width: `${width}%`,
                        top: 3,
                        bottom: 3,
                        background: "var(--bad)",
                        borderRadius: 2,
                      }}
                    />
                  );
                }
                // Blip: subordinate — thin, low-contrast, no label.
                return (
                  <div
                    key={idx}
                    title={`blip · ${i.started_at.slice(0, 16).replace("T", " ")} UTC`}
                    style={{
                      position: "absolute",
                      left: `${left}%`,
                      width: 2,
                      top: 9,
                      bottom: 9,
                      background: "#c2321f66",
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="sub" style={{ marginTop: 8 }}>
        {upload.range_start?.slice(0, 10)} → {upload.range_end?.slice(0, 10)} (UTC)
      </div>
    </div>
  );
}

function MonthlyBreakdown({ monthly }: { monthly: MonthlyStat[] }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3>Per-calendar-month breakdown</h3>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>Month</th>
            <th className="num">Availability</th>
            <th className="num">Downtime</th>
            <th className="num">Down slots</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {monthly.map((m, idx) => {
            const breach =
              m.availability_pct !== null && m.availability_pct < SLA_TARGET_PCT;
            return (
              <tr key={idx}>
                <td className="mono">{m.service_id}</td>
                <td>{fmtMonth(m.month)}</td>
                <td className="num" style={{ color: breach ? "var(--bad)" : undefined }}>
                  {fmtPct(m.availability_pct)}
                </td>
                <td className="num">{fmtMinutes(m.downtime_minutes)}</td>
                <td className="num">{m.down_slots}</td>
                <td>
                  {m.partial_month ? (
                    <span className="badge warn">partial month</span>
                  ) : (
                    <span className="badge ok">full month</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 8 }}>
        A credit decision should only be made on a full month. Partial months are
        shown for context.
      </div>
    </div>
  );
}

function TrustBlock({ upload }: { upload: Upload }) {
  return (
    <div>
      <h3>Pipeline trust — what changed on the way in</h3>
      <div className="cards">
        <TrustCard label="Rows received" value={upload.rows_received} />
        <TrustCard label="Duplicates collapsed" value={upload.duplicates_collapsed} />
        <TrustCard label="Values corrected" value={upload.values_corrected} />
        <TrustCard label="Values nulled" value={upload.values_nulled} />
        <TrustCard label="Slots with no data" value={upload.slots_no_data} />
      </div>
      <div className="sub" style={{ marginTop: 10 }}>
        &ldquo;Corrected&rdquo; (timestamp reformatted to UTC, or latency converted
        from seconds) and &ldquo;nulled&rdquo; (empty or negative latency) are
        counted independently and <strong>can overlap</strong>: a row with an epoch
        timestamp and an empty latency is both.
      </div>
    </div>
  );
}

function TrustCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="big">{value.toLocaleString()}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
