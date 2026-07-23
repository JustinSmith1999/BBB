/**
 * meta-capi-backfill — retroactively send Meta Conversions API Purchase events
 * for every paid trial in stripe_paid_mirror within a requested window.
 *
 * Built 2026-06-03 after discovery that stripe-webhook has been silently
 * failing signature verification since launch — meaning the server-side
 * CAPI Purchase event has never fired. Meta has zero record of any paid
 * trial conversion. This rebuilds the missing history.
 *
 * REQUEST:
 *   POST /functions/v1/meta-capi-backfill
 *   { "since_hours": 168 }                  // default 168 (= 7 days)
 *   { "since": "2026-05-15T00:00:00Z" }     // explicit cutoff
 *   { "since_hours": 168, "dry_run": true } // preview without sending
 *
 * AUTH:
 *   x-bbb-secret header  OR  Authorization: Bearer <SERVICE_ROLE_KEY>
 *
 * BEHAVIOR:
 *   - Pulls paid rows from stripe_paid_mirror in window.
 *   - For each: joins trial_signups by email (to get fbp/fbc + phone fallback).
 *   - For each: looks up the studio's pixel_id + access_token from meta_accounts.
 *   - Sends server-side Purchase event using the same event_id format
 *     ("trial_<session_id>") so any future browser pixel fire dedupes.
 *   - Logs every attempt (success and failure) to capi_events for monitoring.
 *   - SKIPS rows that already have a successful capi_events row with the same
 *     event_id (idempotent across re-runs).
 *
 * NOTE: Meta's documented window is 7 days. Older events may be rejected
 * silently — Meta returns 200 but discards. We log the attempt either way.
 *
 * Deploy:
 *   supabase functions deploy meta-capi-backfill --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret, Authorization",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPII(raw: string | null | undefined): Promise<string | null> {
  const v = (raw ?? "").trim().toLowerCase();
  return v ? await sha256Hex(v) : null;
}

type Row = {
  stripe_payment_intent_id: string | null;
  studio_slug: string | null;
  amount_cents: number | null;
  paid_at: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth — secret OR service role
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const okAuth = secret === ADMIN_SECRET || (SR && bearer === SR);
  if (!okAuth) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch {}

  const sinceHours = Number.isFinite(body?.since_hours) ? Number(body.since_hours) : 168;
  const explicitSince = typeof body?.since === "string" ? body.since : null;
  const since = explicitSince ? new Date(explicitSince) : new Date(Date.now() - sinceHours * 3600 * 1000);
  const dryRun = body?.dry_run === true;

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supaUrl || !SR) return json({ ok: false, error: "supabase env missing" }, 500);
  const sb = createClient(supaUrl, SR);

  // 1. Pull paid trials in window
  const { data: rows, error: mirrorErr } = await sb
    .from("stripe_paid_mirror")
    .select("stripe_payment_intent_id, studio_slug, amount_cents, paid_at, customer_email, customer_name, customer_phone")
    .gte("paid_at", since.toISOString())
    .order("paid_at", { ascending: true });
  if (mirrorErr) return json({ ok: false, error: `mirror lookup failed: ${mirrorErr.message}` }, 500);
  if (!rows || rows.length === 0) {
    return json({ ok: true, since: since.toISOString(), processed: 0, message: "no paid trials in window" });
  }

  // 2. Pull meta_accounts per studio (pixel_id + access_token + api_version)
  const studios = Array.from(new Set((rows as Row[]).map((r) => r.studio_slug).filter(Boolean))) as string[];
  const { data: accts } = await sb
    .from("meta_accounts")
    .select("studio_slug, pixel_id, access_token, api_version")
    .in("studio_slug", studios);
  const acctBySlug = new Map<string, { pixel_id: string | null; access_token: string | null; api_version: string | null }>();
  for (const a of accts ?? []) {
    acctBySlug.set((a as any).studio_slug, {
      pixel_id: (a as any).pixel_id ?? null,
      access_token: (a as any).access_token ?? null,
      api_version: (a as any).api_version ?? null,
    });
  }

  // 3. Pull trial_signups by email for fbp / fbc / stripe_session_id fallback
  const emails = (rows as Row[]).map((r) => (r.customer_email ?? "").toLowerCase().trim()).filter(Boolean);
  const { data: trials } = await sb
    .from("trial_signups")
    .select("email, phone, fbc, stripe_session_id")
    .in("email", emails);
  const trialByEmail = new Map<string, any>();
  for (const t of trials ?? []) {
    const k = ((t as any).email ?? "").toLowerCase().trim();
    if (k && !trialByEmail.has(k)) trialByEmail.set(k, t);
  }

  // 4. Already-sent guard — query capi_events for successful Purchase events
  //    in window so re-running is idempotent. event_id = trial_<session_id>.
  const { data: already } = await sb
    .from("capi_events")
    .select("event_id")
    .eq("event_name", "Purchase")
    .eq("ok", true);
  const alreadySent = new Set(((already ?? []) as any[]).map((r) => r.event_id));

  const results: any[] = [];
  let sent = 0, skipped = 0, failed = 0, dryCount = 0;

  for (const r of rows as Row[]) {
    const studioSlug = r.studio_slug || "";
    const email = (r.customer_email ?? "").toLowerCase().trim();
    const trial = email ? trialByEmail.get(email) : null;
    const sessionId = trial?.stripe_session_id || r.stripe_payment_intent_id || "";
    const eventId = `trial_${sessionId}`;
    const valueUsd = (r.amount_cents ?? 4900) / 100;

    const out: any = {
      email, studio: studioSlug, paid_at: r.paid_at, value: valueUsd, event_id: eventId,
    };

    if (!sessionId) { out.skipped = "no session_id"; skipped++; results.push(out); continue; }
    if (alreadySent.has(eventId)) { out.skipped = "already sent (capi_events)"; skipped++; results.push(out); continue; }

    const acct = acctBySlug.get(studioSlug);
    if (!acct || !acct.pixel_id || !acct.access_token) {
      out.skipped = `missing meta_accounts (pixel/token) for ${studioSlug}`;
      skipped++; results.push(out); continue;
    }

    // Build user_data with hashed PII
    const parts = (r.customer_name || "").trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName  = parts.slice(1).join(" ");
    const phoneDigits = (r.customer_phone || trial?.phone || "").replace(/\D/g, "");
    const userData: Record<string, string[] | string> = {};
    const em = await hashPII(email);     if (em) userData.em = [em];
    const ph = await hashPII(phoneDigits); if (ph) userData.ph = [ph];
    const fn = await hashPII(firstName); if (fn) userData.fn = [fn];
    const ln = await hashPII(lastName);  if (ln) userData.ln = [ln];
    if (trial?.fbc) userData.fbc = trial.fbc;

    const apiVersion = acct.api_version || "v19.0";
    const eventTimeSec = r.paid_at ? Math.floor(new Date(r.paid_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const metaBody = {
      data: [{
        event_name: "Purchase",
        event_time: eventTimeSec,
        event_id: eventId,
        action_source: "website",
        event_source_url: `https://betterbodybootcamp.com/trial/${studioSlug}`,
        user_data: userData,
        custom_data: {
          value: valueUsd,
          currency: "USD",
          content_name: "BBB 2-Week Trial",
          content_category: "trial",
          content_ids: [studioSlug],
        },
      }],
    };

    if (dryRun) {
      out.dry_run = true; out.would_send = metaBody.data[0];
      dryCount++; results.push(out); continue;
    }

    try {
      const r2 = await fetch(
        `https://graph.facebook.com/${apiVersion}/${acct.pixel_id}/events?access_token=${encodeURIComponent(acct.access_token)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metaBody) },
      );
      const respText = await r2.text();
      let respJson: any = null;
      try { respJson = JSON.parse(respText); } catch {}
      const ok = r2.ok && !respJson?.error;
      out.ok = ok; out.http_status = r2.status;
      out.meta_event_id = respJson?.events_received != null ? `events_received:${respJson.events_received}` : null;
      out.error = ok ? null : (respJson?.error?.message || respText.slice(0, 300));
      if (ok) sent++; else failed++;

      // Log to capi_events (best-effort, never blocks)
      try {
        await sb.from("capi_events").insert({
          studio_slug: studioSlug,
          pixel_id: acct.pixel_id,
          event_name: "Purchase",
          event_id: eventId,
          value_usd: valueUsd,
          ok,
          http_status: r2.status,
          meta_event_id: out.meta_event_id,
          error: out.error,
          raw: { source: "meta-capi-backfill", paid_at: r.paid_at, response: respJson },
        });
      } catch (e) {
        out.log_error = (e as Error).message;
      }
    } catch (e) {
      out.ok = false; out.error = (e as Error).message; failed++;
      try {
        await sb.from("capi_events").insert({
          studio_slug: studioSlug,
          pixel_id: acct.pixel_id,
          event_name: "Purchase",
          event_id: eventId,
          value_usd: valueUsd,
          ok: false,
          http_status: null,
          meta_event_id: null,
          error: out.error,
          raw: { source: "meta-capi-backfill", paid_at: r.paid_at, exception: true },
        });
      } catch {}
    }

    results.push(out);
  }

  return json({
    ok: true,
    since: since.toISOString(),
    processed: rows.length,
    sent, skipped, failed,
    dry_run_count: dryCount,
    results,
  });
});
