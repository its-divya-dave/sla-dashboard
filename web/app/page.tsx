"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDateTimeUTC } from "@/lib/format";
import type { Upload } from "@/lib/types";
import UploadPanel from "@/components/UploadPanel";
import StatsSection from "@/components/StatsSection";
import LogsTable from "@/components/LogsTable";

export default function Page() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load completed uploads, newest first. Only status = 'complete' — a half-run
  // left at 'processing'/'failed' must never be shown as the current data.
  const loadUploads = useCallback(
    async (preferId?: string) => {
      const { data, error } = await supabase
        .from("uploads")
        .select("*")
        .eq("status", "complete")
        .order("uploaded_at", { ascending: false });

      if (error) {
        setError(error.message);
        setLoaded(true);
        return;
      }
      const rows = (data ?? []) as Upload[];
      setUploads(rows);
      // Prefer a just-uploaded id, else keep the current selection, else newest.
      setSelectedId((current) => {
        if (preferId && rows.some((u) => u.id === preferId)) return preferId;
        if (current && rows.some((u) => u.id === current)) return current;
        return rows[0]?.id ?? null;
      });
      setLoaded(true);
    },
    [],
  );

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  const selected = uploads.find((u) => u.id === selectedId) ?? null;

  return (
    <main className="container">
      <header style={{ marginBottom: 24 }}>
        <h1>SLA Monitoring Dashboard</h1>
        <div className="sub">
          Availability against a 99.9% monthly SLA, from uploaded health-check logs.
        </div>
      </header>

      <UploadPanel onComplete={(id) => loadUploads(id)} />

      {error && (
        <div className="panel">
          <div className="badge bad" style={{ display: "block", padding: "10px 12px" }}>
            Could not load uploads: {error}
          </div>
        </div>
      )}

      {loaded && uploads.length === 0 && !error && (
        <div className="panel muted">
          No completed uploads yet. Upload a CSV above to get started.
        </div>
      )}

      {selected && (
        <>
          <div className="panel">
            <div className="row spread">
              <div>
                <h2>Viewing upload</h2>
                <div className="sub">
                  {selected.filename} · uploaded {fmtDateTimeUTC(selected.uploaded_at)} ·{" "}
                  {selected.range_start?.slice(0, 10)} → {selected.range_end?.slice(0, 10)}
                </div>
              </div>
              {uploads.length > 1 && (
                <label className="row" style={{ gap: 8 }}>
                  <span className="muted">Upload</span>
                  <select
                    value={selectedId ?? ""}
                    onChange={(e) => setSelectedId(e.target.value)}
                  >
                    {uploads.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.filename} — {fmtDateTimeUTC(u.uploaded_at)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>

          <StatsSection upload={selected} />
          <LogsTable uploadId={selected.id} />
        </>
      )}
    </main>
  );
}
