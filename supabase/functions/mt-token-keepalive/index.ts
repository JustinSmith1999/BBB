/**
 * mt-token-keepalive — keep the shared Mariana Tek OAuth token alive so the
 * five functions that read it never run on a dead credential.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WENT WRONG (found 2026-10-05).
 * sync-health-watchdog reported mt_oauth.expires_at = 2026-09-04 — expired a
 * month ago — while mariana_tek_sales was 25 minutes fresh. Both were true:
 *
 *   • mt-orders-sync prefers MT_ADMIN_API_KEY when it is set. That path has no
 *     expiry, so SALES kept flowing and nothing looked broken.
 *   • mt-orders-sync is also the ONLY function that can refresh the OAuth
 *     token. Because the admin key short-circuits before the refresh branch,
 *     the refresh stopped being exercised, and mt_oauth quietly rotted.
 *   • mariana_tek_clients last synced 2026-09-08 and has been dark since.
 *
 * FIVE functions read mt_oauth.access_token and NONE can refresh it:
 *     book-class, booking-nudge, daily-pulse, free3-claim,
 *     trial-conversion-stats
 * free3-claim is the one that auto-grants the free pass in MT, so a customer-
 * facing flow has been running on an expired token since early September.
 *
 * THE FIX IS ARCHITECTURAL, not another re-seed. Refreshing was a side effect
 * of a sync that no longer takes that code path. This function does nothing
 * else: it keeps the token warm on a schedule, so every reader gets a live one.
 * Re-seeding by hand every seven days is not a fix, it is a recurring outage.
 *
 * Invoke (header: x-bbb-secret):
 *   {}                  -> refresh if expiring within 24h, else report and stop
 *   { "force": true }   -> refresh regardless of remaining life
 *   { "check": true }   -> report only, never write
 *
 * Deploy: bbb deploy-fn mt-token-keepalive
 * Schedule: every 6 hours is ample for a 7-day token and leaves many retries
 * before anything can expire.
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const MT_TENANT = Deno.env.get("MT_TENANT") || "betterbodybootcamp";
const MT_BASE = `https://${MT_TENANT}.marianatek.com`;
const MT_TOKEN_URL = Deno.env.get("MT_OAUTH_TOKEN_URL") || `${MT_BASE}/o/token/`;
const MT_CLIENT_ID = Deno.env.get("MT_OAUTH_CLIENT_ID") || "";
const TOKEN_ROW_ID = "default";

// Refresh once under a day of life remains. The token lasts ~7 days, so at a
// 6-hourly cadence that is ~4 attempts before expiry — plenty of slack for a
// transient MT outage.
const REFRESH_WHEN_HOURS_LEFT = 24;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sb = () => createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;
  const checkOnly = body?.check === true;
  const db = sb();

  const { data: row, error: readErr } = await db
    .from("mt_oauth").select("access_token, refresh_token, expires_at, updated_at")
    .eq("id", TOKEN_ROW_ID).maybeSingle();
  if (readErr) return json({ ok: false, error: `mt_oauth read: ${readErr.message}` }, 500);

  const now = Date.now();
  const expMs = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  const hoursLeft = expMs ? (expMs - now) / 3600000 : -1;

  const state = {
    has_row: !!row,
    has_refresh_token: !!row?.refresh_token,
    expires_at: row?.expires_at ?? null,
    last_updated: row?.updated_at ?? null,
    hours_left: expMs ? Math.round(hoursLeft * 10) / 10 : null,
    expired: expMs ? hoursLeft <= 0 : null,
  };

  if (checkOnly) return json({ ok: true, action: "check_only", state });

  if (!row?.refresh_token) {
    return json({
      ok: false, action: "cannot_refresh", state,
      error: "no refresh_token stored — this needs a human re-seed, it cannot self-heal",
      reseed: [
        "Log into MT admin in a browser",
        "DevTools → Application → Local Storage → the `ember_simple_auth-session` key",
        "Copy access_token and refresh_token out of it",
        "UPDATE public.mt_oauth SET access_token=…, refresh_token=…, expires_at=now()+interval '7 days', updated_at=now() WHERE id='default';",
        "Then call this function with {\"force\":true} to confirm the chain is alive",
      ],
    }, 409);
  }

  if (!force && hoursLeft > REFRESH_WHEN_HOURS_LEFT) {
    return json({ ok: true, action: "skipped_still_fresh", state });
  }

  if (!MT_CLIENT_ID) return json({ ok: false, action: "no_client_id", state, error: "MT_OAUTH_CLIENT_ID not set" }, 500);

  // Always refresh from the STORED token. MT rotates the refresh token on every
  // use, so replaying an older copy from an env var poisons the chain — that is
  // what killed it before (see the 2026-07-31 note in mt-orders-sync).
  const r = await fetch(MT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: MT_CLIENT_ID,
    }),
  });
  const text = await r.text();

  if (!r.ok) {
    return json({
      ok: false, action: "refresh_rejected", state,
      http_status: r.status,
      // Never echo the body wholesale — it can carry token material.
      error: r.status === 400
        ? "MT rejected the refresh token (invalid_grant). The chain is dead and needs a one-time re-seed from a fresh MT admin login."
        : `MT token endpoint HTTP ${r.status}`,
      detail: text.slice(0, 200),
    }, 502);
  }

  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return json({ ok: false, action: "bad_json", state }, 502); }
  if (!parsed?.access_token) return json({ ok: false, action: "no_access_token", state }, 502);

  const expiresIn = Number(parsed.expires_in) || 604800;
  const { error: writeErr } = await db.from("mt_oauth").upsert({
    id: TOKEN_ROW_ID,
    access_token: parsed.access_token,
    // Persist the ROTATED refresh token. Keeping the old one is what breaks the
    // chain on the next call.
    refresh_token: parsed.refresh_token || row.refresh_token,
    expires_at: new Date(now + expiresIn * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
  }, { onConflict: "id" });
  if (writeErr) return json({ ok: false, action: "refreshed_but_not_saved", error: writeErr.message }, 500);

  return json({
    ok: true,
    action: "refreshed",
    was: state,
    now: {
      expires_at: new Date(now + expiresIn * 1000).toISOString(),
      hours_left: Math.round((expiresIn / 3600) * 10) / 10,
      rotated_refresh_token: !!parsed.refresh_token,
    },
    note: "book-class, booking-nudge, daily-pulse, free3-claim and trial-conversion-stats all read this row, so they are live again.",
  });
});
