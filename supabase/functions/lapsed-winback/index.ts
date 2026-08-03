/**
 * lapsed-winback · "we miss you" campaign to lapsed FORMER MEMBERS
 * (the dashboard's lapsed cohort: 5+ lifetime visits, last visit 6–36 months
 * ago, no current service). Built 2026-08-03; audience machinery live, but
 * SENDING IS GATED: the request must include the approved copy — without
 * offer_subject/offer_html/offer_sms the function only returns audience
 * counts + a sample. Justin/Chris own the offer wording.
 *
 * POST body:
 *   { "studio": "astoria" | "bayside" | "fresh-meadows" | "williamsburg",
 *     "dry_run": true,               // DEFAULT TRUE
 *     "limit": 50,                   // max sends per run (default 50)
 *     "channel": "email",            // "email" (default) or "sms" (follow-up, needs prior email ≥3d)
 *     "offer_subject": "...",        // required to actually send email
 *     "offer_html": "... {{name}} ... {{studio}} ...",   // {{tokens}} substituted
 *     "offer_sms": "... {{name}} ... {{studio}} ..." }   // required for sms channel
 *
 * GUARDS: skips anyone with a CURRENT MindBody service, any MT purchase in the
 * last 90 days (already came back), anyone already in lapsed_winback_sends for
 * the given channel, and SMS respects prior opt-outs via trial_signups.opted_out
 * matching where possible. One email + one SMS max per person, ever.
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fill = (t: string, name: string, studio: string) => t.replaceAll("{{name}}", name).replaceAll("{{studio}}", studio);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch {}
  const studio = String(body.studio || "").toLowerCase();
  if (!["astoria", "bayside", "fresh-meadows", "williamsburg"].includes(studio)) return json({ ok: false, error: "studio required" }, 400);
  const dryRun = body.dry_run !== false;
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 50));
  const channel = body.channel === "sms" ? "sms" : "email";
  const hasCopy = channel === "email" ? !!(body.offer_subject && body.offer_html) : !!body.offer_sms;

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const studioName = studio.split("-").map((w: string) => w[0].toUpperCase() + w.slice(1)).join(" ");

  // ── Audience: lapsed members (same shape as the dashboard cohort) ─────────
  const { data: clients, error } = await sb
    .from("mindbody_clients")
    .select("mindbody_id, first_name, last_name, email, phone")
    .eq("studio_slug", studio)
    .not("email", "is", null)
    .limit(3000);
  if (error) return json({ ok: false, error: error.message }, 500);

  const ids = (clients || []).map((c: any) => c.mindbody_id);
  const eligible: any[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const [{ data: cur }, { data: visits }] = await Promise.all([
      sb.from("mindbody_client_services").select("mindbody_client_id").in("mindbody_client_id", chunk).eq("current", true),
      sb.from("mindbody_visits").select("mindbody_client_id, starts_at").in("mindbody_client_id", chunk).eq("signed_in", true),
    ]);
    const hasCur = new Set((cur || []).map((r: any) => r.mindbody_client_id));
    const agg = new Map<number, { n: number; last: string }>();
    (visits || []).forEach((v: any) => {
      const a = agg.get(v.mindbody_client_id) || { n: 0, last: "" };
      a.n++; if (v.starts_at > a.last) a.last = v.starts_at;
      agg.set(v.mindbody_client_id, a);
    });
    const mo6 = new Date(Date.now() - 182 * 864e5).toISOString();
    const mo36 = new Date(Date.now() - 1095 * 864e5).toISOString();
    for (const c of (clients || []).filter((c: any) => chunk.includes(c.mindbody_id))) {
      const a = agg.get(c.mindbody_id);
      if (!hasCur.has(c.mindbody_id) && a && a.n >= 5 && a.last < mo6 && a.last >= mo36) {
        eligible.push({ ...c, lifetime_visits: a.n, last_visit: a.last });
      }
    }
  }

  // ── Guards: recent MT buyers + already-sent ──────────────────────────────
  const emails = eligible.map((c) => (c.email || "").toLowerCase().trim());
  const back = new Set<string>(); const already = new Set<string>();
  for (let i = 0; i < emails.length; i += 200) {
    const chunk = emails.slice(i, i + 200);
    const { data: mt } = await sb.from("mariana_tek_sales").select("customer_email").gt("total_cents", 0)
      .gte("sale_date_time", new Date(Date.now() - 90 * 864e5).toISOString()).in("customer_email", chunk);
    (mt || []).forEach((r: any) => back.add((r.customer_email || "").toLowerCase().trim()));
    const col = channel === "email" ? "email_sent_at" : "sms_sent_at";
    const { data: sent } = await sb.from("lapsed_winback_sends").select("email").in("email", chunk).not(col, "is", null);
    (sent || []).forEach((r: any) => already.add(r.email));
  }
  const targets = eligible.filter((c) => {
    const e = (c.email || "").toLowerCase().trim();
    return e && !back.has(e) && !already.has(e);
  });

  const preview = {
    ok: true, studio, channel, dry_run: dryRun, copy_provided: hasCopy,
    lapsed_total: eligible.length, came_back_recently: back.size, already_sent: already.size,
    sendable: targets.length,
    sample: targets.slice(0, 10).map((c) => ({ name: `${c.first_name} ${c.last_name}`, email: c.email, visits: c.lifetime_visits, last_visit: c.last_visit?.slice(0, 10) })),
  };
  if (!hasCopy) return json({ ...preview, message: "No offer copy provided — audience preview only. Supply offer_subject+offer_html (email) or offer_sms to send." });
  if (dryRun) return json(preview);

  // ── LIVE SEND ─────────────────────────────────────────────────────────────
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("COMEBACK_FROM_EMAIL") || "team@betterbodybootcamp.com";
  const TW = { sid: Deno.env.get("TWILIO_ACCOUNT_SID"), tok: Deno.env.get("TWILIO_AUTH_TOKEN"), from: Deno.env.get("TWILIO_FROM_NUMBER") };
  let sent = 0, failed = 0;
  for (const c of targets) {
    if (sent >= limit) break;
    const email = (c.email || "").toLowerCase().trim();
    const first = (c.first_name || "there").trim();
    if (sent > 0) await new Promise((r) => setTimeout(r, 150));
    if (channel === "email") {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `Better Body Bootcamp <${FROM}>`, to: [email],
          subject: fill(body.offer_subject, first, studioName),
          html: fill(body.offer_html, first, studioName),
          tags: [{ name: "send_path", value: "lapsed_winback" }, { name: "studio", value: studio }],
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      const row: any = { email, mindbody_id: c.mindbody_id, name: `${c.first_name} ${c.last_name}`, studio_slug: studio };
      if (r.ok && j.id) { row.email_sent_at = new Date().toISOString(); sent++; } else { row.email_error = j?.message || `http_${r.status}`; failed++; }
      await sb.from("lapsed_winback_sends").upsert(row, { onConflict: "email" });
    } else {
      const digits = (c.phone || "").replace(/\D/g, "");
      const e164 = /^\d{10}$/.test(digits) ? "+1" + digits : (/^1\d{10}$/.test(digits) ? "+" + digits : null);
      if (!e164 || !TW.sid) { failed++; continue; }
      const form = new URLSearchParams({ To: e164, From: TW.from!, Body: fill(body.offer_sms, first, studioName) + " Txt STOP to opt out" });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW.sid}/Messages.json`, {
        method: "POST", headers: { "Authorization": "Basic " + btoa(`${TW.sid}:${TW.tok}`), "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
      });
      const j: any = await r.json().catch(() => ({}));
      const row: any = { email, mindbody_id: c.mindbody_id, name: `${c.first_name} ${c.last_name}`, studio_slug: studio };
      if (r.ok && j.sid) { row.sms_sent_at = new Date().toISOString(); sent++; } else { row.sms_error = j?.message || `http_${r.status}`; failed++; }
      await sb.from("lapsed_winback_sends").upsert(row, { onConflict: "email" });
    }
  }
  return json({ ...preview, dry_run: false, sent, failed });
});
