"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDateTimeUTC } from "@/lib/format";
import type { CheckRow } from "@/lib/types";

const PAGE_SIZE = 50;

export default function LogsTable({ uploadId }: { uploadId: string }) {
  // Filter: a single date (from only) or a range (from + to). Both empty = all.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<CheckRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the first page whenever the filter changes.
  useEffect(() => {
    setPage(0);
  }, [from, to, uploadId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);

      // Server-side pagination: order by ts (indexed with upload_id) and ask for
      // one page plus the exact total. The 15,577 rows are never all fetched.
      //
      // Offset pagination (.range) is used deliberately. Its known weakness is
      // that a large OFFSET still scans and discards the skipped rows, so deep
      // pages get slower. At 15.5k rows / 50 per page that is ~312 pages worst
      // case and stays fast on the (upload_id, ts) index. The scale-up, if a
      // single upload grew to millions of rows, is keyset pagination: instead of
      // OFFSET, carry the last row's ts and fetch `ts > lastTs limit N`, which is
      // O(page) regardless of depth. Not worth the extra state at this size.
      let query = supabase
        .from("checks")
        .select("*", { count: "exact" })
        .eq("upload_id", uploadId)
        .order("ts", { ascending: true });

      // Date filtering on the normalised UTC timestamp. A single date (from with
      // no to) selects that whole UTC day.
      if (from) query = query.gte("ts", `${from}T00:00:00Z`);
      const upper = to || from;
      if (upper) {
        // Exclusive upper bound = start of the day after `upper`.
        const next = new Date(`${upper}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        query = query.lt("ts", next.toISOString());
      }

      const start = page * PAGE_SIZE;
      const { data, error, count } = await query.range(start, start + PAGE_SIZE - 1);

      if (cancelled) return;
      if (error) {
        setError(error.message);
        setRows([]);
        setTotal(null);
      } else {
        setRows((data ?? []) as CheckRow[]);
        setTotal(count ?? null);
      }
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [uploadId, from, to, page]);

  const lastPage = total !== null ? Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) : 0;

  return (
    <section className="panel">
      <div className="row spread">
        <div>
          <h2>Logs</h2>
          <div className="sub">
            Raw values and normalised values side by side, with the flags the
            pipeline set.
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14, gap: 16 }}>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button
          onClick={() => {
            setFrom("");
            setTo("");
          }}
        >
          Clear
        </button>
        <span className="muted">
          {total !== null ? `${total.toLocaleString()} rows` : ""}
          {loading ? " · loading…" : ""}
        </span>
      </div>

      {error && (
        <div className="badge bad" style={{ display: "block", padding: "10px 12px", marginTop: 12 }}>
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 14 }}>
        <table>
          <thead>
            <tr>
              <th>Timestamp (UTC)</th>
              <th>Raw timestamp</th>
              <th>Service</th>
              <th>Agent</th>
              <th className="num">Status</th>
              <th className="num">Latency</th>
              <th className="num">Raw latency</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">{fmtDateTimeUTC(r.ts)}</td>
                <td className="mono muted">
                  {r.raw_timestamp}
                  {r.source_format && r.source_format !== "iso" && (
                    <span className="badge warn" style={{ marginLeft: 6 }}>
                      {r.source_format}
                    </span>
                  )}
                </td>
                <td className="mono">{r.service_id}</td>
                <td className="mono muted">{r.agent}</td>
                <td className="num mono">
                  {r.status_code ?? "—"}
                  {r.status_invalid && <span className="badge flag" style={{ marginLeft: 6 }}>probe err</span>}
                </td>
                <td className="num mono">{r.latency_ms === null ? "—" : `${r.latency_ms} ms`}</td>
                <td className="num mono muted">
                  {r.raw_latency === null ? "∅" : r.raw_latency}
                  {r.raw_latency_unit ? ` ${r.raw_latency_unit}` : ""}
                </td>
                <td>
                  {r.is_duplicate && <span className="badge flag">duplicate</span>}{" "}
                  {r.latency_invalid && <span className="badge flag">latency nulled</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="muted" style={{ padding: 20 }}>
                  No rows for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>
          ← Prev
        </button>
        <span className="muted">
          Page {page + 1}
          {total !== null ? ` of ${lastPage + 1}` : ""}
        </span>
        <button disabled={page >= lastPage || loading} onClick={() => setPage(page + 1)}>
          Next →
        </button>
      </div>
    </section>
  );
}
