// ============================================================================
// index.ts — the process-upload Edge Function. I/O ONLY.
//
// It accepts the uploaded CSV, calls the pure processUpload() from clean.ts
// (which holds all the cleaning logic and is never touched here), writes the
// results to Postgres, and returns a summary. Every cleaning decision lives in
// clean.ts so it stays unit-testable off-cloud; this file just moves bytes.
//
// Flow: validate request -> insert uploads(status=processing) -> processUpload
// -> chunked insert of checks/slots/incidents -> uploads(status=complete).
// Any throw flips the row to status=failed with the message, so a run that dies
// never leaves a row stuck at 'processing'.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { processUpload } from "./clean.ts";

// CORS: the dashboard is served from a different origin (Vercel), so the browser
// sends a preflight and expects these on every response.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Size cap. The largest sample (30 days) is ~1.1 MB; 10 MB leaves generous room
// for a bigger real upload while refusing anything that could exhaust memory.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Rows per insert. ~30k rows total (≈15.5k checks + ≈14.4k slots for the 30-day
// file) is far past what one insert can carry, so we chunk. 1000 keeps each
// request payload to a few hundred KB — well inside PostgREST and Edge-Function
// memory limits — while needing only ~30 round trips, so per-request latency
// stays a small fraction of the wall-clock budget. Larger chunks would cut round
// trips further but grow the payload; 1000 is the safe middle.
const INSERT_CHUNK_SIZE = 1000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type Db = any;

// Insert an array of rows in fixed-size chunks. Throws (with the table and the
// offset) on the first failed chunk so the caller can mark the upload failed.
async function insertChunked(
  db: Db,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const { error } = await db.from(table).insert(chunk);
    if (error) {
      throw new Error(`${table} insert failed at row ${i}: ${error.message}`);
    }
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Use POST." });
  }

  // Runtime env, injected by Supabase for the deployed (and locally served)
  // function. Never hardcoded, never supplied by the caller. The service-role
  // key bypasses RLS so the function can write; it never leaves the server.
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, {
      error: "Server missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    });
  }
  const db = createClient(supabaseUrl, serviceRoleKey);

  // --- Validate the request: multipart with a .csv file, under the size cap. --
  let file: File;
  try {
    const form = await req.formData();
    const field = form.get("file");
    if (!(field instanceof File)) {
      return jsonResponse(400, {
        error: "Expected multipart form-data with a 'file' field.",
      });
    }
    file = field;
  } catch {
    return jsonResponse(400, { error: "Expected multipart form-data." });
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    return jsonResponse(400, { error: "File must be a .csv." });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonResponse(413, {
      error: `File exceeds ${MAX_UPLOAD_BYTES} bytes.`,
    });
  }

  const csvText = await file.text();

  // --- Insert the uploads row FIRST, as 'processing'. A crash after this point
  // leaves a visible row we can mark failed, rather than nothing at all. --------
  const { data: created, error: insertError } = await db
    .from("uploads")
    .insert({ filename: file.name, status: "processing" })
    .select("id")
    .single();

  if (insertError || !created) {
    return jsonResponse(500, {
      error: `Could not create upload row: ${insertError?.message ?? "unknown"}`,
    });
  }
  const uploadId: string = created.id;

  try {
    // All cleaning happens here, in the pure module. No logic in this file.
    const result = processUpload(csvText, file.name);

    // Stamp every child row with the upload id, then chunk-insert.
    await insertChunked(
      db,
      "checks",
      result.checks.map((r) => ({ ...r, upload_id: uploadId })),
    );
    await insertChunked(
      db,
      "slots",
      result.slots.map((r) => ({ ...r, upload_id: uploadId })),
    );
    if (result.incidents.length > 0) {
      await insertChunked(
        db,
        "incidents",
        result.incidents.map((r) => ({ ...r, upload_id: uploadId })),
      );
    }

    // Fill the derived fields and the trust counts, and mark complete.
    const u = result.upload;
    const { error: updateError } = await db
      .from("uploads")
      .update({
        status: "complete",
        range_start: u.range_start,
        range_end: u.range_end,
        grid_minutes: u.grid_minutes,
        rows_received: u.rows_received,
        duplicates_collapsed: u.duplicates_collapsed,
        values_corrected: u.values_corrected,
        values_nulled: u.values_nulled,
        slots_no_data: u.slots_no_data,
      })
      .eq("id", uploadId);
    if (updateError) throw new Error(`Finalise failed: ${updateError.message}`);

    // Return enough for the UI to show a summary without a second round trip.
    return jsonResponse(200, {
      upload_id: uploadId,
      status: "complete",
      range_start: u.range_start,
      range_end: u.range_end,
      grid_minutes: u.grid_minutes,
      counts: {
        rows_received: u.rows_received,
        duplicates_collapsed: u.duplicates_collapsed,
        values_corrected: u.values_corrected,
        values_nulled: u.values_nulled,
        slots_no_data: u.slots_no_data,
        checks_inserted: result.checks.length,
        slots_inserted: result.slots.length,
        incidents_inserted: result.incidents.length,
      },
    });
  } catch (e) {
    // Never leave the row at 'processing'.
    const message = e instanceof Error ? e.message : String(e);
    await db
      .from("uploads")
      .update({ status: "failed", error_message: message })
      .eq("id", uploadId);
    return jsonResponse(500, {
      upload_id: uploadId,
      status: "failed",
      error: message,
    });
  }
});
