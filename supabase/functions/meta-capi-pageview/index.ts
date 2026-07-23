/**
 * meta-capi-pageview — server-side PageView event to Meta with hashed email.
 *
 * Why: Meta Ads Manager Opportunity Score flagged "Improve event match quality
 * by sending Email for PageView" (+9 points, 2.10% median conversion lift on
 * similar advertisers). The browser-side fbq fires PageView anonymously
 * because we don't know who the visitor is on first paint. This function
 * complements that: any time we DO know the visitor's email (URL param from
 * tracked email link, or form submission), we fire a server-side PageView
 * with the hashed email so Meta can match it to a real user.
 *
 * POST body:
 *   {
 *     studio_slug: "williamsburg",
 *     email:       "jane@example.com",     // plaintext — we hash here
 *     name?:       "Jane Doe",              // optional, also hashed if present
 *     phone?:      "+15551234567",          // optional, also hashed
 *     fbp?:        "fb.1.1700000000000.xx", // browser cookie, plaintext
 *     fbc?:        "fb.1.1700000000000.xx", // browser cookie, plaintext
 *     page_url:    "https://betterbodybootcamp.com/trial/williamsburg?utm_source=email",
 *     event_id?:   "pv_<trial_signup_id>_<timestamp>" // pass-through to dedupe with browser-side
 *   }
 *
 * Returns: { ok, http_status, meta_event_id, error? }
 *
 * Every attempt logs a capi_events row (event_name='PageView') so the
 * stripe-webhook heartbeat and /ops monitor pick up failures.
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

  const studioSlug = String(body.studio_slug || "").trim().toLowerCase();
  const email      = String(body.email || "").trim();
  const name       = String(body.name  || "").trim();
  const phone      = String(body.phone || "").trim();
  const fbp        = String(body.fbp   || "").trim();
  const fbc        = String(body.fbc   || "").trim();
  const pageUrl    = String(body.page_url || `https://betterbodybootcamp.com/trial/${studioSlug}`);
  const eventId    = String(body.event_id || `pv_${studioSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  if (!studioSlug)       return json({ ok: false, error: "studio_slug required" }, 400);
  if (!email && !fbp && !fbc) {
    return json({ ok: false, error: "at least one of email / fbp / fbc required" }, 400);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Build the visitor_meta blob ONCE so every logAttempt (success + error
  // paths) writes the same rich context for dashboard attribution.
  // 2026-06-11: added so "Trial Page Visitors" tile can break down ad-driven
  // traffic by fbc / ad_click_id / utms without re-decoding fbc downstream.
  const userAgent = req.headers.get("user-agent") || "";
  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "";

  // ── Geo from Cloudflare edge headers (free, server-side) ──────────────
  const geoCountry = req.headers.get("cf-ipcountry") || "";
  const geoCity    = req.headers.get("cf-ipcity") || "";
  const geoRegion  = req.headers.get("cf-region") || "";
  const geoPostal  = req.headers.get("cf-postal-code") || "";
  const geoLat     = req.headers.get("cf-iplatitude") || "";
  const geoLon     = req.headers.get("cf-iplongitude") || "";

  // Cheap UA → browser/OS classifier (avoid bringing in a parser library).
  const uaLower = userAgent.toLowerCase();
  let browser = "other", os = "other", device = "other";
  if      (uaLower.includes("edg/"))     browser = "edge";
  else if (uaLower.includes("opera"))    browser = "opera";
  else if (uaLower.includes("firefox"))  browser = "firefox";
  else if (uaLower.includes("chrome"))   browser = "chrome";
  else if (uaLower.includes("safari"))   browser = "safari";
  if      (uaLower.includes("iphone") || uaLower.includes("ipad") || uaLower.includes("ipod")) { os = "ios"; device = "mobile"; }
  else if (uaLower.includes("android"))                                                        { os = "android"; device = uaLower.includes("mobile") ? "mobile" : "tablet"; }
  else if (uaLower.includes("mac os") || uaLower.includes("macintosh"))                        { os = "macos"; device = "desktop"; }
  else if (uaLower.includes("windows"))                                                         { os = "windows"; device = "desktop"; }
  else if (uaLower.includes("linux"))                                                           { os = "linux"; device = "desktop"; }

  let adClickId = "";
  if (fbc) {
    const parts = fbc.split(".");
    if (parts.length >= 4) adClickId = parts.slice(3).join(".");
  }

  // Multi-platform click IDs from URL params — gclid (Google), ttclid (TikTok),
  // msclkid (Microsoft/Bing), li_fat_id (LinkedIn), twclid (X/Twitter).
  let urlUtmSource = "", urlUtmMedium = "", urlUtmCampaign = "", urlUtmContent = "";
  let gclid = "", ttclid = "", msclkid = "", liFatId = "", twclid = "";
  try {
    if (pageUrl) {
      const u = new URL(pageUrl);
      urlUtmSource   = u.searchParams.get("utm_source")   || "";
      urlUtmMedium   = u.searchParams.get("utm_medium")   || "";
      urlUtmCampaign = u.searchParams.get("utm_campaign") || "";
      urlUtmContent  = u.searchParams.get("utm_content")  || "";
      gclid   = u.searchParams.get("gclid")    || "";
      ttclid  = u.searchParams.get("ttclid")   || "";
      msclkid = u.searchParams.get("msclkid")  || "";
      liFatId = u.searchParams.get("li_fat_id")|| "";
      twclid  = u.searchParams.get("twclid")   || "";
    }
  } catch { /* malformed URL — ignore */ }

  const visitorMeta: Record<string, unknown> = {};
  // Meta attribution
  if (fbp)            visitorMeta.fbp = fbp;
  if (fbc)            visitorMeta.fbc = fbc;
  if (adClickId)      visitorMeta.ad_click_id = adClickId;
  // Other ad-platform attribution
  if (gclid)          visitorMeta.gclid    = gclid;
  if (ttclid)         visitorMeta.ttclid   = ttclid;
  if (msclkid)        visitorMeta.msclkid  = msclkid;
  if (liFatId)        visitorMeta.li_fat_id = liFatId;
  if (twclid)         visitorMeta.twclid   = twclid;
  // UTMs + page
  if (email)          visitorMeta.email_present = true;
  if (urlUtmSource)   visitorMeta.utm_source   = urlUtmSource;
  if (urlUtmMedium)   visitorMeta.utm_medium   = urlUtmMedium;
  if (urlUtmCampaign) visitorMeta.utm_campaign = urlUtmCampaign;
  if (urlUtmContent)  visitorMeta.utm_content  = urlUtmContent;
  if (pageUrl)        visitorMeta.page_url     = pageUrl;
  // Device classification
  if (userAgent)      visitorMeta.user_agent   = userAgent;
  visitorMeta.browser = browser;
  visitorMeta.os      = os;
  visitorMeta.device  = device;
  // Geo (server-side from Cloudflare)
  if (geoCountry)     visitorMeta.geo_country = geoCountry;
  if (geoCity)        visitorMeta.geo_city    = geoCity;
  if (geoRegion)      visitorMeta.geo_region  = geoRegion;
  if (geoPostal)      visitorMeta.geo_postal  = geoPostal;
  if (geoLat)         visitorMeta.geo_lat     = geoLat;
  if (geoLon)         visitorMeta.geo_lon     = geoLon;
  // IP
  if (clientIp)       visitorMeta.client_ip   = clientIp;
  // Client-side context (only present if the React form posts it)
  if (body.screen_width)        visitorMeta.screen_width   = Number(body.screen_width);
  if (body.viewport_width)      visitorMeta.viewport_width = Number(body.viewport_width);
  if (body.language)            visitorMeta.language       = String(body.language).slice(0, 16);
  if (body.timezone)            visitorMeta.timezone       = String(body.timezone).slice(0, 64);
  if (body.connection_type)     visitorMeta.connection_type = String(body.connection_type).slice(0, 16);
  if (body.color_scheme)        visitorMeta.color_scheme   = String(body.color_scheme).slice(0, 8);
  if (Number.isFinite(body.visit_number))   visitorMeta.visit_number   = Math.floor(body.visit_number);
  if (Number.isFinite(body.days_since_first)) visitorMeta.days_since_first = Math.floor(body.days_since_first);
  visitorMeta.captured_at = new Date().toISOString();

  const logAttempt = async (fields: { ok: boolean; pixel_id?: string | null; http_status?: number | null; meta_event_id?: string | null; error?: string | null; raw?: unknown; }) => {
    try {
      await sb.from("capi_events").insert({
        studio_slug:   studioSlug,
        pixel_id:      fields.pixel_id ?? null,
        event_name:    "PageView",
        event_id:      eventId,
        value_usd:     null,
        ok:            fields.ok,
        http_status:   fields.http_status ?? null,
        meta_event_id: fields.meta_event_id ?? null,
        error:         fields.error ?? null,
        raw:           fields.raw ? (fields.raw as Record<string, unknown>) : null,
        visitor_meta:  Object.keys(visitorMeta).length > 1 ? visitorMeta : null,
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
  const em = await hashPII(email);     if (em) userData.em = [em];
  const ph = await hashPII(phoneDigits); if (ph) userData.ph = [ph];
  const fnH = await hashPII(fn);       if (fnH) userData.fn = [fnH];
  const lnH = await hashPII(ln);       if (lnH) userData.ln = [lnH];
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const apiVersion = acct.api_version || "v19.0";
  const requestBody = {
    data: [{
      event_name:       "PageView",
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         eventId,
      action_source:    "website",
      event_source_url: pageUrl,
      user_data:        userData,
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
