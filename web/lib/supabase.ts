// Single Supabase client for the browser. Uses the publishable anon key, so it
// can only read (RLS grants SELECT; there is no write path from here — writes go
// through the Edge Function with the service-role key).
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.local.",
  );
}

export const supabase = createClient(url, anonKey);

export const PROCESS_UPLOAD_URL = process.env.NEXT_PUBLIC_PROCESS_UPLOAD_URL ?? "";
export const SUPABASE_ANON_KEY = anonKey;
