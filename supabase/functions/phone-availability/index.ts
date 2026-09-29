import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// phone-availability (2026-09-09) — the "taking calls / AI answering" switch
// behind the Vapi phone system (Bayside + Fresh Meadows to start).
//
//   GET  ?studio=bayside            → { ok, studio, human_answering, updated_at }
//        (no auth; accepts underscore or hyphen slugs: fresh_meadows OK)
//   POST { studio, human_answering } with x-bbb-secret → upserts the flag
//        (called by the Homebase toggle)
//
// The Vapi/Twilio router calls GET on every inbound ring: true → dial the
// staff phones; false → send the caller straight to the AI. Default when no
// row exists: true (ring humans) — fail toward a human, never toward silence.
//
// Table: phone_availability (see migration phone-availability-migration.sql)
// Deploy: bbb deploy-fn phone-availability
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "bbb-test-2026-05-27";
const VALID = new Set(["astoria", "bayside", "fresh-meadows", "williamsburg"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-bbb-secret, x-phonedesk-secret, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, "-");
}
function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const client = sb();

  if (req.method === "GET") {
    const studio = norm(new URL(req.url).searchParams.get("studio") ?? "");
    if (!VALID.has(studio)) return json({ ok: false, error: "unknown studio" }, 400);
    const { data } = await client.from("phone_availability")
      .select("human_answering, updated_at, updated_by").eq("studio_slug", studio).maybeSingle();
    return json({
      ok: true, studio,
      // no row yet = ring humans (safe default)
      human_answering: data ? data.human_answering : true,
      updated_at: data?.updated_at ?? null,
    });
  }

  if (req.method === "POST") {
    if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
    const studio = norm(String(body.studio ?? ""));
    if (!VALID.has(studio)) return json({ ok: false, error: "unknown studio" }, 400);
    if (typeof body.human_answering !== "boolean") return json({ ok: false, error: "human_answering boolean required" }, 400);
    const updatedBy = String(body.updated_by ?? "homebase").slice(0, 60);
    const { error } = await client.from("phone_availability").upsert({
      studio_slug: studio,
      human_answering: body.human_answering,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    }, { onConflict: "studio_slug" });
    if (error) return json({ ok: false, error: error.message }, 500);
    console.log(`phone-availability: ${studio} -> ${body.human_answering ? "HUMANS" : "AI"} (by ${updatedBy})`);
    return json({ ok: true, studio, human_answering: body.human_answering });
  }

  return json({ ok: false, error: "GET or POST" }, 405);
});
