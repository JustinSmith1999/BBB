// Supabase Edge Function: free3-claim (2026-08-21)
//
// Receives the "3 Free Classes" claim form from /freeclasses. Creates or
// updates the person's lead row so they land on the Homebase board, then
// notifies the studio (email) + owners (SMS) so someone books them in.
// Studio/owner notifications are gated by BBB_SEND_PATHS_ENABLED containing
// 'free3_claim' — they only ever fire on a real customer form submit.
//
// POST body: { studioSlug, firstName, lastName, email, phone, utm_* }
// Deploy: bbb deploy-fn free3-claim

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const LOCATION_BY_SLUG: Record<string, { id: string; name: string; email: string; mtId: string }> = {
  "astoria":       { id: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45", name: "Astoria",       email: "astoria@betterbodybootcamp.com",      mtId: "48717" },
  "bayside":       { id: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7", name: "Bayside",       email: "bayside@betterbodybootcamp.com",      mtId: "48718" },
  "fresh-meadows": { id: "6bbbe077-bcc6-4d9d-a10b-7605c1484752", name: "Fresh Meadows", email: "freshmeadows@betterbodybootcamp.com", mtId: "48719" },
  "williamsburg":  { id: "80536b45-df0e-42d1-880c-e9301372e1cf", name: "Williamsburg",  email: "williamsburg@betterbodybootcamp.com", mtId: "48720" },
};

// ── MT auto-provisioning (2026-08-22, Justin: "people who sign up here need
// to be made MT accounts so they can book. Make it easier.") ────────────────
// On every claim we find-or-create the person's Mariana Tek profile so the
// front desk only has to add the $0 "3 Free Classes (Winback)" pass and book.
// Auth: MT_ADMIN_API_KEY secret wins (Joe's key, when it lands); until then we
// READ the current access token from the mt_oauth store that mt-orders-sync
// maintains (we never refresh here — rotation belongs to mt-orders-sync).
// All failures are soft: the claim still succeeds and the staff email says so.
const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const MT_ACCEPT = "application/vnd.api+json";

async function mtToken(sb: ReturnType<typeof createClient>): Promise<string | null> {
  const adminKey = Deno.env.get("MT_ADMIN_API_KEY");
  if (adminKey && adminKey.trim()) return adminKey.trim();
  try {
    const { data } = await sb.from("mt_oauth").select("access_token").eq("id", "default").maybeSingle();
    return (data as { access_token?: string } | null)?.access_token || null;
  } catch { return null; }
}

async function mtFindOrCreateUser(
  sb: ReturnType<typeof createClient>,
  first: string, last: string, email: string, phone: string, mtLocId: string,
): Promise<{ status: "existing" | "created" | "failed"; mtUserId?: string; error?: string }> {
  const token = await mtToken(sb);
  if (!token) return { status: "failed", error: "no MT token" };
  const headers = { "Authorization": `Bearer ${token}`, "Accept": MT_ACCEPT };
  try {
    const q = await fetch(`${MT_BASE}/api/users?query=${encodeURIComponent(email)}&page_size=3`, { headers });
    if (q.status === 401) return { status: "failed", error: "MT token expired" };
    const qd = await q.json().catch(() => ({} as Record<string, unknown>));
    const hits = ((qd as { data?: Array<{ id: string; attributes?: { email?: string } }> }).data ?? [])
      .filter((u) => (u.attributes?.email || "").toLowerCase() === email);
    if (hits.length > 0) return { status: "existing", mtUserId: hits[0].id };
    const c = await fetch(`${MT_BASE}/api/users`, {
      method: "POST",
      headers: { ...headers, "Content-Type": MT_ACCEPT },
      body: JSON.stringify({
        data: {
          type: "users",
          attributes: { first_name: first, last_name: last, email, phone_number: phone },
          relationships: { home_location: { data: { type: "locations", id: mtLocId } } },
        },
      }),
    });
    const cd = await c.json().catch(() => ({} as Record<string, unknown>));
    if (c.status === 201) return { status: "created", mtUserId: (cd as { data?: { id?: string } }).data?.id };
    return { status: "failed", error: `MT create ${c.status}` };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "MT error" };
  }
}

// 2026-08-24: auto-grant the 3 free classes so staff don't have to add the
// $0 "3 Free Classes (Winback)" package by hand. Uses MT's "Give Credits"
// endpoint (POST /api/credit_transactions) against the "Class Pricing" credit
// type (id 2323) — same credits the winback package grants. Skips the grant if
// the user already has ANY active class credits (front desk may have added the
// pass already; never stack). Soft-fails: a claim must never break on this.
const MT_CLASS_CREDIT_ID = "2323";
async function mtGrantFree3(
  sb: ReturnType<typeof createClient>, mtUserId: string,
): Promise<{ granted: boolean; already?: boolean; error?: string }> {
  const token = await mtToken(sb);
  if (!token) return { granted: false, error: "no MT token" };
  const headers = { "Authorization": `Bearer ${token}`, "Accept": MT_ACCEPT };
  try {
    const q = await fetch(`${MT_BASE}/api/credit_transactions?user=${mtUserId}`, { headers });
    const qd = await q.json().catch(() => ({} as Record<string, unknown>));
    const active = ((qd as { data?: Array<{ attributes?: { remaining_credits_cache?: number; is_expired?: boolean } }> }).data ?? [])
      .filter((t) => !t.attributes?.is_expired && (t.attributes?.remaining_credits_cache ?? 0) > 0);
    if (active.length > 0) return { granted: false, already: true };
    const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const c = await fetch(`${MT_BASE}/api/credit_transactions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": MT_ACCEPT },
      body: JSON.stringify({
        data: {
          type: "credit_transactions",
          attributes: { transaction_amount: 3, expiration_datetime: exp, note: "3 Free Classes (Winback) - auto-granted on claim" },
          relationships: {
            credit: { data: { type: "credits", id: MT_CLASS_CREDIT_ID } },
            user: { data: { type: "users", id: mtUserId } },
          },
        },
      }),
    });
    if (c.status === 201) return { granted: true };
    return { granted: false, error: `MT grant ${c.status}` };
  } catch (e) {
    return { granted: false, error: e instanceof Error ? e.message : "MT error" };
  }
}

function normalizePhone(p: string): string | null {
  const d = (p || "").replace(/\D+/g, "");
  if (d.length === 11 && d[0] === "1") return "+" + d;
  if (d.length === 10) return "+1" + d;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const slug = String(body.studioSlug || "");
  const loc = LOCATION_BY_SLUG[slug];
  const first = String(body.firstName || "").trim();
  const last = String(body.lastName || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = normalizePhone(String(body.phone || ""));
  if (!loc) return json({ ok: false, error: "unknown studio" }, 400);
  if (first.length < 2 || last.length < 2) return json({ ok: false, error: "name required" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "valid email required" }, 400);
  if (!phone) return json({ ok: false, error: "valid US phone required" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const name = `${first} ${last}`;

  // Upsert the lead: reuse their existing (non-shadow) row at this studio if
  // one exists, otherwise insert. payment_status 'free3_claimed' keeps them
  // OUT of the paid-trials sheets while showing on the Homebase board.
  let trialId: string | null = null;
  const { data: existing } = await sb.from("trial_signups")
    .select("id, deleted_at, payment_status")
    .eq("email", email).eq("location_id", loc.id)
    .neq("payment_status", "attribution_only")
    .order("created_at", { ascending: false }).limit(1);
  const utm: Record<string, unknown> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
    if (typeof body[k] === "string" && body[k]) utm[k] = body[k];
  }
  if (existing && existing.length > 0 && existing[0].payment_status !== "completed") {
    trialId = existing[0].id;
    await sb.from("trial_signups").update({
      name, phone, deleted_at: null,
      payment_status: "free3_claimed",
      front_desk_stage: "new_lead",
      ...utm,
    }).eq("id", trialId);
  } else if (!existing || existing.length === 0) {
    const { data: ins, error: insErr } = await sb.from("trial_signups").insert({
      name, email, phone, location_id: loc.id,
      payment_status: "free3_claimed",
      front_desk_stage: "new_lead",
      newsletter_opted_in: false,
      ...utm,
    }).select("id").single();
    if (insErr) return json({ ok: false, error: "could not save: " + insErr.message }, 500);
    trialId = ins?.id ?? null;
  } else {
    // they already have a COMPLETED paid trial row here; just log the claim
    trialId = existing[0].id;
  }

  // Find-or-create their Mariana Tek profile so they can be booked immediately,
  // then auto-grant the 3 free class credits (no manual package step for staff).
  const mt = await mtFindOrCreateUser(sb, first, last, email, phone, loc.mtId);
  const grant = mt.mtUserId
    ? await mtGrantFree3(sb, mt.mtUserId)
    : { granted: false as const, error: mt.error };
  const ready = mt.status !== "failed" && (grant.granted || grant.already === true);

  // Notify studio + owners (gated).
  const paths = (Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "").split(",").map((s) => s.trim());
  const notify = { studio_email: false, owner_sms: 0 };
  if (paths.includes("free3_claim")) {
    // studio email via Resend
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
      if (resendKey) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>",
            to: [loc.email],
            subject: `New 3 Free Classes claim — ${name} · ${loc.name}`,
            html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F4F5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
<tr><td style="background-color:#0D0D0D;padding:20px 28px">
  <img src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png" alt="Better Body Bootcamp" width="64" style="display:block;border:0">
</td></tr>
<tr><td style="background-color:#E11D2A;padding:10px 28px;color:#ffffff;font-size:13px;font-weight:bold;letter-spacing:3px">NEW 3 FREE CLASSES CLAIM &middot; ${loc.name.toUpperCase()}</td></tr>
<tr><td style="padding:26px 28px 6px 28px;font-size:15px;line-height:24px;color:#111111">
  <p style="margin:0 0 14px 0"><span style="font-size:20px;font-weight:bold">${name}</span><br>
  Phone: <a href="tel:${phone}" style="color:#E11D2A;font-weight:bold;text-decoration:none">${phone}</a><br>
  Email: <span style="color:#111111">${email}</span></p>
  ${ready
    ? `<p style="margin:0 0 16px 0;padding:10px 14px;background-color:#F0FDF4;border-left:4px solid #16A34A;font-size:14px"><b>All set in Mariana Tek</b> &mdash; profile ${mt.status === "created" ? "created" : "found"}, 3 free class credits on the account${grant.already ? " (they had active credits)" : ""}. Credits expire in 1 month.</p>`
    : mt.status !== "failed"
    ? `<p style="margin:0 0 8px 0;padding:10px 14px;background-color:#FEF9C3;border-left:4px solid #CA8A04;font-size:14px"><b>Their Mariana Tek profile is ready</b> (${mt.status === "created" ? "we just created it" : "they already had one"}) but the credits could not be added automatically. Two steps left:</p>
  <ol style="margin:0 0 16px 20px;padding:0">
    <li style="margin-bottom:6px">MT Admin &gt; <b>Find Customer</b> &gt; <b>${email}</b> &gt; add the <b>"3 Free Classes (Winback)"</b> package ($0.00 &mdash; under Credits).</li>
    <li style="margin-bottom:6px">Text them today and book their first class. Credits expire 1 month after they are added.</li>
  </ol>`
    : `<p style="margin:0 0 8px 0;font-weight:bold">Set them up in Mariana Tek so they can book (2 minutes):</p>
  <ol style="margin:0 0 16px 20px;padding:0">
    <li style="margin-bottom:6px">MT Admin &gt; <b>Find Customer</b> &gt; search <b>${email}</b>. No profile? Create one with the info above.</li>
    <li style="margin-bottom:6px">On their profile, add the <b>"3 Free Classes (Winback)"</b> credit package ($0.00 &mdash; under Credits, not on the buy page).</li>
    <li style="margin-bottom:6px">Text them today and book their first class. Credits expire 1 month after they are added.</li>
  </ol>`}
</td></tr>
<tr><td style="padding:0 28px 26px 28px">
  <a href="https://betterbodybootcamp.marianatek.com/admin" style="display:inline-block;background-color:#E11D2A;color:#ffffff;font-size:14px;font-weight:bold;letter-spacing:1px;text-decoration:none;padding:12px 22px;border-radius:6px">OPEN MT ADMIN</a>
</td></tr>
<tr><td style="background-color:#F4F4F5;padding:14px 28px;font-size:12px;color:#8A8A8A">Better Than Yesterday. &middot; Better Body Bootcamp ${loc.name}</td></tr>
</table></td></tr></table>`,
          }),
        });
        notify.studio_email = r.ok;
        await sb.from("email_log").insert({
          event_type: r.ok ? "email.sent" : "email.failed",
          from_addr: "free3-claim", to_addrs: [loc.email],
          subject: `3 FREE CLASSES claim — ${name} · ${loc.name}`,
          send_path: "free3_claim", trial_signup_id: trialId,
          raw: { studio: slug },
        });
      }
    } catch (_e) { /* never fail the claim on notify errors */ }
    // owner SMS
    try {
      const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
      const twToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
      const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
      if (twSid && twToken && twFrom) {
        const { data: owners } = await sb.from("location_owners").select("phone").eq("location_id", loc.id);
        const smsBody = ready
          ? `BBB ${loc.name}: ${name} claimed 3 FREE CLASSES. All set in MT. ${phone}`
          : mt.status !== "failed"
          ? `BBB ${loc.name}: ${name} claimed 3 FREE CLASSES. MT profile ready - add the $0 "3 Free Classes (Winback)" pass and text them to book: ${phone}`
          : `BBB ${loc.name}: ${name} claimed 3 FREE CLASSES. Create their MT profile, add the $0 "3 Free Classes (Winback)" pass, then text them to book: ${phone}`;
        for (const o of (owners ?? [])) {
          if (!o.phone) continue;
          const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
            method: "POST",
            headers: { "Authorization": "Basic " + btoa(`${twSid}:${twToken}`), "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ From: twFrom, To: o.phone, Body: smsBody }),
          });
          const j = await resp.json().catch(() => ({} as Record<string, unknown>));
          await sb.from("sms_messages").insert({
            studio_slug: slug, direction: "outbound", from_phone: twFrom, to_phone: o.phone,
            body: smsBody, twilio_sid: (j as { sid?: string }).sid ?? null,
            status: resp.ok ? "queued" : "failed",
            sent_by: "free3-claim", sent_at: new Date().toISOString(), send_path: "free3_claim",
          });
          if (resp.ok) notify.owner_sms++;
        }
      }
    } catch (_e) { /* ignore */ }
  }

  return json({ ok: true, trial_id: trialId, notified: notify, mt: { status: mt.status, user_id: mt.mtUserId ?? null, credits: grant.granted ? "granted" : grant.already ? "already_had" : "failed" } });
});
