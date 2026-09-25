"use client";

import { useEffect, useRef, useState } from "react";
import { PROCESS_UPLOAD_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import type { UploadResult } from "@/lib/types";

type Phase = "idle" | "working" | "done" | "error";

export default function UploadPanel({
  onComplete,
}: {
  onComplete: (uploadId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick an elapsed-seconds counter while the request is in flight. The 30-day
  // file takes ~6.6s server-side, so the user needs to see time passing rather
  // than a frozen button.
  useEffect(() => {
    if (phase === "working") {
      const start = Date.now();
      timer.current = setInterval(() => {
        setElapsed((Date.now() - start) / 1000);
      }, 100);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [phase]);

  async function submit() {
    if (!file) return;
    setPhase("working");
    setElapsed(0);
    setResult(null);
    setError(null);

    try {
      const form = new FormData();
      form.append("file", file);

      // apikey is required by the gateway even with verify_jwt off; it is the
      // public anon key. No Authorization/JWT — there is no auth in this app.
      const res = await fetch(PROCESS_UPLOAD_URL, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY },
        body: form,
      });
      const body = await res.json();

      if (!res.ok || body.status !== "complete") {
        throw new Error(body.error ?? `Upload failed (HTTP ${res.status}).`);
      }

      setResult(body as UploadResult);
      setPhase("done");
      onComplete(body.upload_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <section className="panel">
      <div className="row spread">
        <div>
          <h2>Upload health-check CSV</h2>
          <div className="sub">
            Parsed, cleaned and stored by a deployed serverless function.
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <input
          type="file"
          accept=".csv"
          disabled={phase === "working"}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPhase("idle");
          }}
        />
        <button
          className="primary"
          disabled={!file || phase === "working"}
          onClick={submit}
        >
          {phase === "working" ? "Processing…" : "Upload & process"}
        </button>

        {phase === "working" && (
          <span className="row" style={{ gap: 8 }}>
            <span className="spinner" />
            <span className="muted">
              Uploading and processing — {elapsed.toFixed(1)}s. Large files take
              several seconds.
            </span>
          </span>
        )}
      </div>

      {phase === "error" && (
        <div
          className="badge bad"
          style={{ marginTop: 14, display: "block", padding: "10px 12px" }}
        >
          {error}
        </div>
      )}

      {phase === "done" && result && (
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <span className="badge ok">Complete in {elapsed.toFixed(1)}s</span>
            <span className="muted">
              {result.range_start?.slice(0, 10)} → {result.range_end?.slice(0, 10)}
            </span>
          </div>
          <div className="cards">
            <TrustStat label="Rows received" value={result.counts.rows_received} />
            <TrustStat
              label="Duplicates collapsed"
              value={result.counts.duplicates_collapsed}
            />
            <TrustStat
              label="Values corrected"
              value={result.counts.values_corrected}
            />
            <TrustStat label="Values nulled" value={result.counts.values_nulled} />
            <TrustStat
              label="Slots with no data"
              value={result.counts.slots_no_data}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function TrustStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="big">{value.toLocaleString()}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
