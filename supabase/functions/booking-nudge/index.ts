import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// booking-nudge (2026-08-28) — the promo-leak fix.
//
// Finds people who committed but never booked, and sends ONE nudge text:
//   A. free3 claimants: claimed 48h+ ago (≤14d), zero MT reservations since.
//   B. paid trials: bought 2–10 days ago, zero MT reservations ever.
//
// Booking truth comes live from the MT Admin API (reservations by user), so
// this is accurate to the minute — not dependent on the visits mirror.
//
// SAFETY: dry-run by default. Live requires BOTH:
//   1. BBB_SEND_PATHS_ENABLED contains 'booking_nudge'
//   2. POST { "live": true }
// One nudge per phone EVER (sms_messages send_path='booking_nudge' registry).
// Default limit 25/run. Respects opted_out_at.
//
// Schedule (after first live run looks right): pg_cron hourly, body {"live":true}.
// Deploy: bbb deploy-fn booking-nudge
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "bbb-test-2026-05-27";
const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const MT_ACCEPT = "application/vnd.api+json";

const SLUG_BY_LOCATION: Record<string, string> = {
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "bayside",
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": "astoria",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "fresh-meadows",
  "80536b45-df0e-42d1-880c-e9301372e1cf": "williamsburg",
};
const TITLE: Record<string, string> = {
  "bayside": "Bayside", "astoria": "Astoria",
  "fresh-meadows": "Fresh Meadows", "williamsburg": "Williamsburg",
};

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });
const first = (n: string) => (n || "").trim().split(/\s+/)[0] || "there";

async function mtToken(client: ReturnType<typeof sb>): Promise<string | null> {
  const k = Deno.env.get("MT_ADMIN_API_KEY");
  if (k && k.trim()) return k.trim();
  const { data } = await client.from("mt_oauth").select("access_token").eq("id", "default").maybeSingle();
  return (data as { access_token?: string } | null)?.access_token || null;
}

async function mtUserId(token: string, email: string): Promise<string | null> {
  const r = await fetch(`${MT_BASE}/api/users?query=${encodeURIComponent(email)}&page_size=5`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT },
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  const hit = ((d as { data?: Array<{ id: string; attributes?: { email?: string } }> }).data ?? [])
    .find((u) => String(u.attributes?.email || "").toLowerCase() === email);
  return hit?.id ?? null;
}

async function hasReservations(token: string, userId: string): Promise<boolean | null> {
  const r = await fetch(`${MT_BASE}/api/reservations?user=${userId}&page_size=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT },
  });
  if (!r.ok) return null; // unknown — skip rather than mis-nudge
  const d = await r.json().catch(() => ({}));
  const count = (d as { meta?: { pagination?: { count?: number } } })?.meta?.pagination?.count ?? 0;
  return count > 0;
}

function e164(p: string | null): string | null {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length === 10) return "+1" + d;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* dry run */ }

  const paths = (Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "").split(",").map((s) => s.trim());
  const pathOn = paths.includes("booking_nudge");
  const live = body.live === true && pathOn;
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 50) : 25;

  const client = sb();
  const token = await mtToken(client);
  if (!token) return json({ ok: false, error: "no MT token" }, 503);

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  // A. free3 claimants — claim time approximated by the claim's studio email log
  const { data: claimLogs } = await client.from("email_log")
    .select("trial_signup_id, created_at")
    .eq("send_path", "free3_claim").eq("event_type", "email.sent")
    .gte("created_at", iso(now - 14 * 86400_000))
    .lte("created_at", iso(now - 48 * 3600_000));
  const claimAt = new Map<string, string>();
  for (const l of (claimLogs ?? [])) if (l.trial_signup_id) claimAt.set(l.trial_signup_id, l.created_at);

  let candidates: Array<{ id: string; name: string; email: string; phone: string | null; location_id: string; kind: string }> = [];
  if (claimAt.size) {
    const { data } = await client.from("trial_signups")
      .select("id, name, email, phone, location_id, opted_out_at, payment_status")
      .in("id", Array.from(claimAt.keys()));
    for (const t of (data ?? [])) {
      if (t.opted_out_at || t.payment_status !== "free3_claimed") continue;
      candidates.push({ ...t, kind: "free3" });
    }
  }

  // B. paid trials 2–10 days old
  const { data: trials } = await client.from("trial_signups")
    .select("id, name, email, phone, location_id, opted_out_at")
    .eq("payment_status", "completed")
    .gte("payment_date", iso(now - 10 * 86400_000))
    .lte("payment_date", iso(now - 2 * 86400_000))
    .is("opted_out_at", null);
  for (const t of (trials ?? [])) candidates.push({ ...t, kind: "trial" });

  // already-nudged registry
  const { data: sent } = await client.from("sms_messages")
    .select("to_phone").eq("send_path", "booking_nudge");
  const nudged = new Set((sent ?? []).map((s) => s.to_phone));

  const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const twTok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

  const results: Array<Record<string, unknown>> = [];
  let sends = 0;
  for (const c of candidates) {
    if (sends >= limit) break;
    const phone = e164(c.phone);
    const slug = SLUG_BY_LOCATION[c.location_id];
    if (!phone || !slug) { results.push({ email: c.email, skip: "no phone/studio" }); continue; }
    if (nudged.has(phone)) { results.push({ email: c.email, skip: "already nudged" }); continue; }

    const uid = await mtUserId(token, c.email.toLowerCase());
    if (!uid) { results.push({ email: c.email, skip: "no MT user" }); continue; }
    const booked = await hasReservations(token, uid);
    if (booked !== false) { results.push({ email: c.email, skip: booked ? "has booking" : "mt lookup failed" }); continue; }

    const fn = first(c.name);
    const studio = TITLE[slug];
    const msg = c.kind === "free3"
      ? `Hi ${fn}, your 3 free classes at Better Body ${studio} are waiting. Pick a time that works: https://betterbodybootcamp.com/schedule/${slug} Reply STOP to opt out.`
      : `Hi ${fn}, your 2-week trial at Better Body ${studio} is ticking - don't let it slip. Grab a class: https://betterbodybootcamp.com/schedule/${slug} Reply STOP to opt out.`;

    if (!live) { results.push({ email: c.email, kind: c.kind, would_text: phone, studio }); sends++; continue; }

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${twSid}:${twTok}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: twFrom, To: phone, Body: msg }),
    });
    const j = await resp.json().catch(() => ({} as Record<string, unknown>));
    await client.from("sms_messages").insert({
      studio_slug: slug, direction: "outbound", from_phone: twFrom, to_phone: phone,
      body: msg, twilio_sid: (j as { sid?: string }).sid ?? null,
      status: resp.ok ? "queued" : "failed",
      sent_by: "booking-nudge", sent_at: new Date().toISOString(), send_path: "booking_nudge",
    });
    results.push({ email: c.email, kind: c.kind, sent: resp.ok, studio });
    if (resp.ok) { sends++; nudged.add(phone); }
    await new Promise((r) => setTimeout(r, 350));
  }

  return json({
    ok: true, live, path_enabled: pathOn, candidates: candidates.length, acted: sends, results,
    note: live ? undefined : "DRY RUN — add 'booking_nudge' to BBB_SEND_PATHS_ENABLED and POST {live:true} to send.",
  });
});
