/**
 * meta-capi-lead — server-side Lead event to Meta with hashed PII.
 *
 * WHY: The browser-side `fbq('track', 'Lead', ...)` call on the trial form
 * silently drops when blocked by Safari ITP, Brave, ad blockers, iOS 17+
 * privacy mode, etc. We discovered Bayside dashboard shows only 6 Meta-
 * reported Leads while we have 7+ real paid trials — meaning the browser
 * Pixel Lead event is being eaten on a chunk of traffic. Meta's algorithm
 * then has no idea what a "good lead" looks like at Bayside, and optimizes
 * blindly → high CPL (~$91) vs Williamsburg's $33.
 *
 * FIX: Fire Lead server-side too, exactly like we do with PageView/Purchase.
 * Server-side CAPI runs from Supabase Edge → graph.facebook.com directly, so
 * it can't be blocked by client. Dedup'd against the browser Lead via
 * event_id (Meta merges same event_id within 48h window).
 *
 * Wired from `create-trial-checkout` immediately after the pending
 * trial_signups row is written and before Stripe checkout redirect.
 *
 * POST body:
 *   {
 *     studio_slug:      "bayside",
 *     email:            "jane@example.com",          // plaintext — we hash here
 *     name?:            "Jane Doe",                  // optional
 *     phone?:           "+15551234567",              // optional
 *     fbp?:             "fb.1.1700000000000.xx",
 *     fbc?:             "fb.1.1700000000000.xx",
 *     client_ip?:       "1.2.3.4",                   // forwarded from create-trial-checkout
 *     client_user_agent?: "Mozilla/...",
 *     page_url:         "https://betterbodybootcamp.com/trial/bayside",
 *     value?:           49,
 *     currency?:        "USD",
 *     content_name?:    "Bayside 2-Week Trial",
 *     content_category?: "trial",
 *     event_id?:        "lead_<trial_signup_id>_<timestamp>"
 *   }
 *
 * Returns: { ok, http_status, meta_event_id, event_id, error? }
 *
 * Every attempt logs a capi_events row (event_name='Lead') so the
 * /ops heartbeat sees silent failures.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPII(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  return await sha256Hex(v);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }

  const studioSlug      = String(body.studio_slug || "").trim().toLowerCase();
  const email           = String(body.email || "").trim();
  const name            = String(body.name  || "").trim();
  const phone           = String(body.phone || "").trim();
  const fbp             = String(body.fbp   || "").trim();
  const fbc             = String(body.fbc   || "").trim();
  const clientIp        = String(body.client_ip || "").trim();
  const clientUA        = String(body.client_user_agent || "").trim();
  const pageUrl         = String(body.page_url || `https://betterbodybootcamp.com/trial/${studioSlug}`);
  const value           = Number.isFinite(Number(body.value)) ? Number(body.value) : 49;
  const currency        = String(body.currency || "USD").toUpperCase();
  const contentName     = String(body.content_name || `${studioSlug} 2-Week Trial`);
  const contentCategory = String(body.content_category || "trial");
  const eventId         = String(body.event_id || `lead_${studioSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  if (!studioSlug) return json({ ok: false, error: "studio_slug required" }, 400);
  if (!email && !fbp && !fbc) {
    return json({ ok: false, error: "at least one of email / fbp / fbc required" }, 400);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const logAttempt = async (fields: { ok: boolean; pixel_id?: string | null; http_status?: number | null; meta_event_id?: string | null; error?: string | null; raw?: unknown; }) => {
    try {
      await sb.from("capi_events").insert({
        studio_slug:   studioSlug,
        pixel_id:      fields.pixel_id ?? null,
        event_name:    "Lead",
        event_id:      eventId,
        value_usd:     value,
        ok:            fields.ok,
        http_status:   fields.http_status ?? null,
        meta_event_id: fields.meta_event_id ?? null,
        error:         fields.error ?? null,
        raw:           fields.raw ? (fields.raw as Record<string, unknown>) : null,
      });
    } catch (e) {
      console.error("capi_events insert failed:", (e as Error).message);
    }
  };

  const { data: acct, error: acctErr } = await sb
    .from("meta_accounts")
    .select("pixel_id, access_token, api_version")
    .eq("studio_slug", studioSlug)
    .maybeSingle();

  if (acctErr || !acct?.pixel_id || !acct?.access_token) {
    const reason = acctErr
      ? `meta_accounts lookup error: ${acctErr.message}`
      : !acct          ? "no meta_accounts row for studio"
      : !acct.pixel_id ? "meta_accounts.pixel_id is NULL"
      :                  "meta_accounts.access_token is NULL/empty";
    await logAttempt({ ok: false, pixel_id: acct?.pixel_id ?? null, error: reason });
    return json({ ok: false, error: reason }, 200);
  }

  // Hash PII per CAPI spec.
  const parts = name.split(/\s+/);
  const fn = parts[0] || "";
  const ln = parts.slice(1).join(" ");
  const phoneDigits = phone.replace(/\D/g, "");

  const userData: Record<string, string[] | string> = {};
  const em  = await hashPII(email);        if (em)  userData.em = [em];
  const ph  = await hashPII(phoneDigits);  if (ph)  userData.ph = [ph];
  const fnH = await hashPII(fn);           if (fnH) userData.fn = [fnH];
  const lnH = await hashPII(ln);           if (lnH) userData.ln = [lnH];
  if (fbp)      userData.fbp               = fbp;
  if (fbc)      userData.fbc               = fbc;
  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUA) userData.client_user_agent = clientUA;

  const apiVersion = acct.api_version || "v19.0";
  const requestBody = {
    data: [{
      event_name:       "Lead",
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         eventId,
      action_source:    "website",
      event_source_url: pageUrl,
      user_data:        userData,
      custom_data: {
        value,
        currency,
        content_name:     contentName,
        content_category: contentCategory,
      },
    }],
    access_token: acct.access_token,
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${acct.pixel_id}/events`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) },
    );
    const respText = await res.text();
    let respJson: Record<string, unknown> | null = null;
    try { respJson = JSON.parse(respText); } catch { /* not JSON */ }
    const metaEventId = typeof respJson?.fbtrace_id === "string" ? respJson.fbtrace_id as string : null;

    await logAttempt({
      ok:            res.ok,
      pixel_id:      acct.pixel_id,
      http_status:   res.status,
      meta_event_id: metaEventId,
      error:         res.ok ? null : respText.slice(0, 500),
      raw:           respJson,
    });

    return json({ ok: res.ok, http_status: res.status, meta_event_id: metaEventId, event_id: eventId });
  } catch (e) {
    const msg = (e as Error).message;
    await logAttempt({ ok: false, pixel_id: acct.pixel_id, error: msg });
    return json({ ok: false, error: msg }, 200);
  }
});
