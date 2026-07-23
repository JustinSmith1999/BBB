// mt-purchase-alerts — texts Carlos on every NEW membership/package purchase
// over $49 at Bayside and Fresh Meadows.
//
// Source of truth: mariana_tek_sales (populated by mt-orders-sync). We re-use
// mt-orders-sync's exact classifier so "membership" here means the same thing
// it does everywhere else, and the $49 trial is excluded by definition.
//
// Dedupe: purchase_alerts_sent ledger keyed on mt_sale_id, so a sale is texted
// at most once even though the sync re-scans overlapping windows.
//
// Body:
//   { "dry_run": true }        -> return what WOULD be texted, send nothing, write nothing
//   { "lookback_hours": 168 }  -> how far back to scan (default 72h)
//   {}                          -> live: text Carlos + record each sale in the ledger
//
// Auth: x-bbb-secret header.  Recipient: CARLOS_ALERT_PHONE env (E.164).
// Deploy: bbb deploy-fn mt-purchase-alerts   (then schedule every 5 min)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const MIN_CENTS = 4900; // strictly ABOVE $49.00

// Only these two studios, by locations.id.
const STUDIOS: Record<string, string> = {
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "Bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "Fresh Meadows",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// ── same classifier mt-orders-sync uses, so "membership" is consistent ──
function classifyOrder(summary: string, total: number): string {
  const s = (summary || "").toLowerCase();
  if (total === 0) return "zero";
  if (s.includes("two weeks trial") || s.includes("$49") || s.includes("week trial")) return "trial";
  if (s.includes("membership") || s.includes(" pif") || s.includes("pif ") || s.includes("contract") || s.includes("month to month")) return "membership";
  if (s.includes("drop in") || s.includes("late cancel") || s.includes("no show") || s.includes("water") || s.includes("celcius")) return "ancillary";
  return "other";
}

// Carlos wants memberships AND packages, but not the trial or retail/incidentals.
function qualifies(itemNames: string, totalCents: number): boolean {
  if (totalCents <= MIN_CENTS) return false;                 // must be ABOVE $49
  const kind = classifyOrder(itemNames, totalCents);
  if (kind === "trial" || kind === "zero" || kind === "ancillary") return false;
  const looksLikePackage = /\bpack\b|package|sessions|class\s*pack/i.test(itemNames || "");
  return kind === "membership" || looksLikePackage;          // membership or a real package
}

function money(cents: number): string {
  return "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") || Deno.env.get("TWILIO_FROM");
  if (!sid || !token || !from) return { ok: false, error: "twilio env missing" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, sid: j.sid } : { ok: false, error: j.message || `HTTP ${r.status}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body = live run */ }
  const dryRun = body.dry_run === true;
  // seed = mark every existing qualifying purchase as "already alerted" WITHOUT
  // texting, so going live never re-sends anything from the past. Run once.
  const seed = body.seed === true;
  const lookbackHours = seed
    ? 720                                                         // seed: sweep 30 days of history
    : Math.min(Math.max(Number(body.lookback_hours ?? 72), 1), 720);
  const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1. Candidate sales: our 2 studios, above $49, within the window.
  const { data: sales, error } = await sb
    .from("mariana_tek_sales")
    .select("mt_sale_id, location_id, sale_date_time, customer_mt_id, customer_first_name, customer_last_name, item_names, total_cents")
    .in("location_id", Object.keys(STUDIOS))
    .gt("total_cents", MIN_CENTS)
    .gte("sale_date_time", sinceIso)
    .order("sale_date_time", { ascending: true })
    .limit(500);
  if (error) return json({ ok: false, error: error.message }, 500);

  const passesFilter = (sales || []).filter((s) => qualifies(s.item_names || "", Number(s.total_cents || 0)));

  // 1b. NEW memberships only — drop recurring monthly-autopay renewals.
  // A monthly-membership charge is a renewal (not new business) when the same
  // customer already has an earlier monthly-membership charge on file. PIF and
  // class packs are one-time purchases, so they always count as new.
  const qualifying: any[] = [];
  for (const s of passesFilter) {
    const isMonthly = /monthly/i.test(s.item_names || "");
    if (isMonthly && s.customer_mt_id) {
      const { data: prior } = await sb
        .from("mariana_tek_sales")
        .select("mt_sale_id")
        .eq("customer_mt_id", s.customer_mt_id)
        .ilike("item_names", "%monthly%")
        .lt("sale_date_time", s.sale_date_time)
        .limit(1);
      if (prior && prior.length) continue; // existing member's recurring charge -> skip
    }
    qualifying.push(s);
  }

  // 2. Drop any already texted.
  const ids = qualifying.map((s) => s.mt_sale_id);
  let alreadySent = new Set<string>();
  if (ids.length) {
    const { data: sent } = await sb.from("purchase_alerts_sent").select("mt_sale_id").in("mt_sale_id", ids);
    alreadySent = new Set((sent || []).map((r: any) => r.mt_sale_id));
  }
  const toAlert = qualifying.filter((s) => !alreadySent.has(s.mt_sale_id));

  const fullName = (s: any) => [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ").trim() || "Customer";
  const preview = toAlert.map((s) => ({
    studio: STUDIOS[s.location_id],
    amount: money(s.total_cents),
    item: s.item_names,
    customer: fullName(s),
    when: s.sale_date_time,
    text: `New ${STUDIOS[s.location_id]} purchase: ${fullName(s)}, ${s.item_names} (${money(s.total_cents)})`,
  }));

  if (dryRun) {
    return json({ ok: true, dry_run: true, window_hours: lookbackHours, candidates: (sales || []).length, qualifying: qualifying.length, would_text: preview });
  }

  // SEED: record all current qualifying purchases as sent, text nothing. This
  // is how "don't resend the past" works — run it once before going live.
  if (seed) {
    const rows = toAlert.map((s) => ({
      mt_sale_id: s.mt_sale_id, studio_slug: STUDIOS[s.location_id], total_cents: s.total_cents,
      recipient: "seed", sms_sid: null, sent_at: new Date().toISOString(),
    }));
    if (rows.length) await sb.from("purchase_alerts_sent").upsert(rows, { onConflict: "mt_sale_id" });
    return json({ ok: true, seeded: rows.length, note: "these will never be texted; only purchases after this point will alert" });
  }

  // 3. LIVE: text Carlos + record each in the ledger.
  const to = Deno.env.get("CARLOS_ALERT_PHONE");
  if (!to) return json({ ok: false, error: "CARLOS_ALERT_PHONE env not set" }, 400);

  const results: any[] = [];
  for (const p of preview) {
    const sale = toAlert.find((s) => STUDIOS[s.location_id] === p.studio && money(s.total_cents) === p.amount && s.item_names === p.item);
    const r = await sendSms(to, p.text);
    if (r.ok) {
      await sb.from("purchase_alerts_sent").insert({
        mt_sale_id: sale!.mt_sale_id, studio_slug: p.studio, total_cents: sale!.total_cents,
        recipient: to, sms_sid: r.sid ?? null, sent_at: new Date().toISOString(),
      });
    }
    results.push({ studio: p.studio, amount: p.amount, ok: r.ok, error: r.error });
  }
  return json({ ok: true, texted: results.filter((x) => x.ok).length, results });
});
