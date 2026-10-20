/**
 * lead-journey — "was this person from an ad?", answered for ONE named person.
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing, sends nothing.
 *
 * Built 2026-10-19. Justin, on a Bayside trial that landed with no utm_content:
 * "How can you STILL not fucking tell me".
 *
 * He was right to ask. The data was already there and nothing read it.
 *
 * WHAT WAS MISSING. We store every ad landing in capi_events.visitor_meta
 * (utm_content, fbc, fbp, page_url, referrer, client_ip) and every trial in
 * trial_signups (fbp, client_ip, email, phone). Both sides of the join have
 * existed for months. But capi_events does NOT store visitor_id, so no report
 * could connect a landing to a named buyer, and every existing tool answers at
 * the STUDIO level: "Bayside took 135 ad landings and produced 2 trials."
 * Useless for "did THIS person come from an ad".
 *
 * THE JOIN KEY IS fbp. The Facebook browser id is written on the landing by
 * meta-capi-pageview and again on the trial row by mt-card-checkout, from the
 * same browser. Match on it and a person's whole visit history appears,
 * including the tagged landing they arrived on days earlier — even when the
 * checkout itself carried no utm, which is the exact case that kept coming up.
 *
 * MATCH STRENGTH is reported, never hidden:
 *   fbp        one browser. Strong. Treat as the same person.
 *   client_ip  a household or an office, and whole mobile carriers share them.
 *              Corroboration only. Never presented as proof on its own.
 *
 * Body: { "email": "x@y.com" } | { "phone": "9178630204" } | { "fbp": "fb.1..." }
 *       { "days": 90 }  how far back to search landings. Default 90.
 *
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn lead-journey
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const last10 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const phone = body.phone ? last10(body.phone) : null;
  let fbp = typeof body.fbp === "string" ? body.fbp : null;
  const days = Math.min(Math.max(Number(body.days ?? 90), 1), 365);
  if (!email && !phone && !fbp) return json({ ok: false, error: "give an email, phone or fbp" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── the person ───────────────────────────────────────────────────────────
  let person: any = null;
  if (email || phone) {
    const { data, error } = await sb
      .from("trial_signups")
      .select("id,name,email,phone,location_id,created_at,payment_date,payment_status," +
              "source_category,lead_source,utm_source,utm_medium,utm_campaign,utm_content," +
              "fbc,fbp,client_ip,visitor_id,ab_variant")
      .or([email ? `email.eq.${email}` : null, phone ? `phone.like.*${phone}*` : null]
          .filter(Boolean).join(","))
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) return json({ ok: false, error: `trial_signups: ${error.message}` }, 502);
    person = (data ?? [])[0] ?? null;
    if (person?.fbp && !fbp) fbp = person.fbp;
  }
  const ip = person?.client_ip ?? null;

  if (!fbp && !ip) {
    return json({
      ok: true, person,
      verdict: person
        ? "CANNOT TRACE. This row carries neither an fbp nor a client_ip, so there is nothing to join a landing to. Nothing can be said about where they came from."
        : "No trial_signups row matched that email or phone.",
      landings: [],
    });
  }

  // ── their landings ───────────────────────────────────────────────────────
  // capi_events has no visitor_id, so fbp (and, weakly, ip) is the only bridge.
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("capi_events")
      .select("studio_slug,event_name,visitor_meta,attempted_at")
      .eq("event_name", "PageView")
      .gte("attempted_at", since)
      .order("attempted_at", { ascending: true })
      .range(from, from + 999);
    if (error) return json({ ok: false, error: `capi_events: ${error.message}` }, 502);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    if (rows.length >= 120000) break;
  }

  const byFbp: any[] = [], byIp: any[] = [];
  for (const r of rows) {
    const m = r.visitor_meta || {};
    const hit = { at: r.attempted_at, studio: r.studio_slug,
      utm_source: m.utm_source ?? null, utm_medium: m.utm_medium ?? null,
      utm_campaign: m.utm_campaign ?? null, utm_content: m.utm_content ?? null,
      has_fbc: !!m.fbc, referrer_host: m.referrer_host ?? null,
      page_url: typeof m.page_url === "string" ? m.page_url.slice(0, 220) : null };
    if (fbp && m.fbp === fbp) byFbp.push(hit);
    else if (ip && m.client_ip === ip) byIp.push(hit);
  }

  const tagged = byFbp.filter((h) => h.utm_content || h.utm_campaign || h.has_fbc);
  const firstTagged = tagged[0] ?? null;
  const lastTagged = tagged[tagged.length - 1] ?? null;
  const ipTagged = byIp.filter((h) => h.utm_content || h.has_fbc);

  let verdict: string;
  if (firstTagged) {
    verdict = `FROM AN AD. This browser landed on a tagged ad link ${tagged.length} time(s). ` +
      `First ${firstTagged.at} (${firstTagged.utm_content ?? firstTagged.utm_campaign}), ` +
      `last ${lastTagged!.at}. Matched on fbp, which is one browser, so this is the same person.`;
  } else if (byFbp.length) {
    verdict = `NOT FROM AN AD, on the evidence. This exact browser visited ${byFbp.length} time(s) ` +
      `in the window and not one landing carried an ad tag or click id. Direct, organic or a non-ad referral.`;
  } else if (ipTagged.length) {
    verdict = `UNPROVEN, leaning ad. Nothing matched this browser, but ${ipTagged.length} tagged ad ` +
      `landing(s) came from the same IP. An IP is a household or a carrier, so this is a hint, not proof.`;
  } else {
    verdict = `UNPROVEN. No landing in the last ${days} days matches this browser or IP. ` +
      `Most likely they first clicked outside the window, or landed before the 2026-10-15 capture fix.`;
  }

  return json({
    ok: true, read_only: true, window_days: days,
    matched_on: { fbp: fbp ?? null, client_ip: ip ?? null },
    person: person && {
      name: person.name, email: person.email, phone: person.phone,
      created_at: person.created_at, payment_date: person.payment_date,
      source_category: person.source_category, lead_source: person.lead_source,
      utm_on_row: person.utm_content ?? person.utm_campaign ?? null,
      fbc_on_row: person.fbc || null, ab_variant: person.ab_variant,
    },
    verdict,
    how_to_read:
      "fbp matches are one browser and can be trusted as the same person. client_ip matches are a " +
      "household or a mobile carrier and are corroboration only. A landing with no utm_content but " +
      "has_fbc true is still an ad click; the per-ad tag is simply missing from that studio's link.",
    landings_this_browser: byFbp,
    landings_same_ip_only: byIp.slice(0, 30),
  });
});
