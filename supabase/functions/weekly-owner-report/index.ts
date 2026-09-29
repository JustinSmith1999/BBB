// Supabase Edge Function: weekly-owner-report
//
// Monday-morning owner report for Chris, Carlos, and Steve. Pulls last week's
// clean numbers (paid trials per studio with promo buyers excluded, converts,
// revenue, BTS promo sales, campaign sends) and emails one HTML summary.
//
// ── Recipients ──────────────────────────────────────────────────────────────
// OWNER_RECIPIENTS below. Justin is always cc'd. EMPTY by default so this can
// be deployed and dry-run before a single owner sees anything.
//
// ── Gates ───────────────────────────────────────────────────────────────────
// x-bbb-secret required. BBB_SEND_PATHS_ENABLED must include
// "weekly_owner_report". dry_run:true returns the HTML without sending.
//
// Deploy: bbb deploy-fn weekly-owner-report
// Trigger: Cowork scheduled task, Mondays 8:00 AM ET.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = "bbb-test-2026-05-27";
const OWNER_RECIPIENTS: string[] = []; // e.g. ["chris@...", "carlos@...", "steve@..."] — set before enabling
const CC = ["Justin@j20solutions.com"];
const FROM = "Better Body Bootcamp <hello@send.betterbodybootcamp.com>";

const LOC: Record<string, string> = {
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": "Astoria",
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "Bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "Fresh Meadows",
};
const NON_TRIAL = new Set(["direct_membership", "mb_direct", "walk_in", "in_person", "walk-in", "mt_direct_member", "legacy_archived"]);
const STUDIOS = ["Astoria", "Bayside", "Fresh Meadows", "Williamsburg"];

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const money = (c: number) => "$" + Math.round(c / 100).toLocaleString("en-US");

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  let body: { dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* default */ }
  const dryRun = body.dry_run !== false; // DRY RUN unless explicitly false

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // window: last full week, Monday 00:00 ET through Sunday 23:59 ET (approx via UTC-4)
  const now = new Date();
  const day = now.getUTCDay(); // run on Monday
  const end = new Date(now); end.setUTCDate(now.getUTCDate() - ((day + 6) % 7)); end.setUTCHours(4, 0, 0, 0); // this Mon 00:00 ET
  const start = new Date(end); start.setUTCDate(end.getUTCDate() - 7);
  const sIso = start.toISOString(), eIso = end.toISOString();
  const label = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  // locations (fill WB id dynamically)
  const { data: locs } = await sb.from("locations").select("id,name");
  const locName: Record<string, string> = { ...LOC };
  for (const l of (locs ?? [])) locName[l.id] = l.name;

  // trials this week + converts, clean filter
  const { data: trials } = await sb.from("trial_signups")
    .select("location_id,front_desk_stage,payment_date,created_at,source_category,lead_source")
    .eq("payment_status", "completed").is("deleted_at", null)
    .gte("payment_date", sIso).lt("payment_date", eIso);
  const tClean = (trials ?? []).filter((r) =>
    !NON_TRIAL.has(r.source_category ?? "") && !["mt-renewal", "bts299-backfill"].includes(r.lead_source ?? ""));
  const perStudio: Record<string, { trials: number; conv: number }> = {};
  for (const s of STUDIOS) perStudio[s] = { trials: 0, conv: 0 };
  for (const r of tClean) {
    const s = locName[r.location_id] ?? "?";
    if (!perStudio[s]) perStudio[s] = { trials: 0, conv: 0 };
    perStudio[s].trials++;
    if (r.front_desk_stage === "member") perStudio[s].conv++;
    if (r.front_desk_stage === "attended" || r.front_desk_stage === "member") (perStudio[s] as any).att = ((perStudio[s] as any).att ?? 0) + 1;
  }

  // prior week trials (week-over-week)
  const pStart = new Date(start); pStart.setUTCDate(start.getUTCDate() - 7);
  const { data: prevTrials } = await sb.from("trial_signups")
    .select("location_id,source_category,lead_source")
    .eq("payment_status", "completed").is("deleted_at", null)
    .gte("payment_date", pStart.toISOString()).lt("payment_date", sIso);
  const pClean = (prevTrials ?? []).filter((r) =>
    !NON_TRIAL.has(r.source_category ?? "") && !["mt-renewal", "bts299-backfill"].includes(r.lead_source ?? ""));
  const prevPer: Record<string, number> = {};
  for (const r of pClean) { const s = locName[r.location_id] ?? "?"; prevPer[s] = (prevPer[s] ?? 0) + 1; }

  // best performing ad, last 7 days (by leads, then purchases, then link clicks)
  const { data: ins } = await sb.from("meta_ad_insights_daily")
    .select("ad_id,studio_slug,spend_cents,leads,purchases,inline_link_clicks")
    .gte("date_start", sIso.slice(0, 10)).lt("date_start", eIso.slice(0, 10));
  const byAd: Record<string, { spend: number; leads: number; purch: number; clicks: number; studio: string }> = {};
  for (const i of (ins ?? [])) {
    const a = byAd[i.ad_id] ?? { spend: 0, leads: 0, purch: 0, clicks: 0, studio: i.studio_slug };
    a.spend += i.spend_cents ?? 0; a.leads += i.leads ?? 0; a.purch += i.purchases ?? 0; a.clicks += i.inline_link_clicks ?? 0;
    byAd[i.ad_id] = a;
  }
  const bestId = Object.keys(byAd).sort((x, y) =>
    (byAd[y].leads - byAd[x].leads) || (byAd[y].purch - byAd[x].purch) || (byAd[y].clicks - byAd[x].clicks))[0];
  let bestAdLine = "No ad data this week.";
  if (bestId) {
    const { data: adRow } = await sb.from("meta_ads").select("ad_name,studio_slug").eq("ad_id", bestId).maybeSingle();
    const b = byAd[bestId];
    bestAdLine = `${adRow?.ad_name ?? bestId} (${(adRow?.studio_slug ?? b.studio ?? "").replace(/-/g, " ")}) · ${money(b.spend)} spent · ${b.leads} leads · ${b.purch} purchases · ${b.clicks} link clicks`;
  }

  // BTS sold per studio this week
  const btsPer: Record<string, number> = {};

  // revenue + BTS this week
  const { data: sales } = await sb.from("mariana_tek_sales")
    .select("studio_slug,total_cents,item_names").gte("sale_date_time", sIso).lt("sale_date_time", eIso);
  const revByStudio: Record<string, number> = {};
  let btsCount = 0, btsCents = 0, totalCents = 0;
  for (const s of (sales ?? [])) {
    totalCents += s.total_cents;
    const nm = (s.studio_slug || "").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    revByStudio[nm] = (revByStudio[nm] ?? 0) + s.total_cents;
    if ((s.item_names || "").toLowerCase().includes("back to school")) { btsCount++; btsCents += s.total_cents; btsPer[nm] = (btsPer[nm] ?? 0) + 1; }
  }

  // new leads (contact/schedule inquiries) this week per studio
  const { data: leads } = await sb.from("trial_signups")
    .select("location_id,source_category")
    .is("deleted_at", null).gte("created_at", sIso).lt("created_at", eIso)
    .in("source_category", ["contact_form", "schedule_request"]);
  const leadsPer: Record<string, number> = {};
  for (const r of (leads ?? [])) { const s = locName[r.location_id] ?? "?"; leadsPer[s] = (leadsPer[s] ?? 0) + 1; }

  // campaign sends this week
  const { data: em } = await sb.from("email_log").select("send_path").gte("created_at", sIso).lt("created_at", eIso).limit(5000);
  const winbacks = (em ?? []).filter((r) => String(r.send_path || "").includes("winback")).length;

  const wow = (s: string) => {
    const n = perStudio[s]?.trials ?? 0, p = prevPer[s] ?? 0, d = n - p;
    const c = d > 0 ? "#0E9F6E" : d < 0 ? "#C31624" : "#9AA3B5";
    const a = d > 0 ? "&#9650;" : d < 0 ? "&#9660;" : "&#8212;";
    return `<span style="color:${c};font-size:11px;font-weight:bold;">&nbsp;${a}${d === 0 ? "" : Math.abs(d)}</span>`;
  };
  const rows = STUDIOS.map((s) => `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #EEE;font-weight:bold;">${s}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #EEE;text-align:center;">${perStudio[s]?.trials ?? 0}${wow(s)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #EEE;text-align:center;">${(perStudio[s] as any)?.att ?? 0}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #EEE;text-align:center;">${perStudio[s]?.conv ?? 0}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #EEE;text-align:center;">${leadsPer[s] ?? 0}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #EEE;text-align:center;">${btsPer[s] ?? 0}</td></tr>`).join("");

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F8FA;font-family:Arial,Helvetica,sans-serif;color:#0F172A;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:100%;background:#FFF;border:1px solid #EBEDF2;border-radius:10px;">
<tr><td style="padding:22px 26px 6px 26px;">
<div style="font-size:11px;letter-spacing:3px;font-weight:bold;color:#9AA3B5;">BETTER BODY BOOTCAMP</div>
<div style="font-size:22px;font-weight:800;padding-top:6px;">Weekly Report &middot; ${label}</div></td></tr>
<tr><td style="padding:14px 26px 0 26px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
<tr style="font-size:11px;letter-spacing:1px;color:#55607A;"><td style="padding:8px 12px;">STUDIO</td>
<td style="padding:8px 12px;text-align:center;">PAID TRIALS</td><td style="padding:8px 12px;text-align:center;">TOOK 1ST CLASS</td><td style="padding:8px 12px;text-align:center;">NEW MEMBERS</td>
<td style="padding:8px 12px;text-align:center;">NEW LEADS</td><td style="padding:8px 12px;text-align:center;">BTS SOLD</td></tr>${rows}
<tr><td style="padding:10px 12px;font-weight:800;">Total</td>
<td style="padding:10px 12px;text-align:center;font-weight:800;">${tClean.length}</td>
<td style="padding:10px 12px;text-align:center;font-weight:800;">${tClean.filter((r) => r.front_desk_stage === "attended" || r.front_desk_stage === "member").length}</td>
<td style="padding:10px 12px;text-align:center;font-weight:800;">${tClean.filter((r) => r.front_desk_stage === "member").length}</td>
<td style="padding:10px 12px;text-align:center;font-weight:800;">${Object.values(leadsPer).reduce((a, b) => a + b, 0)}</td>
<td style="padding:10px 12px;text-align:center;font-weight:800;">${btsCount}</td></tr></table></td></tr>
<tr><td style="padding:16px 26px 0 26px;font-size:13px;line-height:21px;color:#334;">
<b>vs last week:</b> ${tClean.length} paid trials vs ${pClean.length} the week before.<br>
<b>Best performing ad:</b> ${bestAdLine}<br>
<b>Back to School promo:</b> ${btsCount} sold this week (${money(btsCents)}).<br>
<b>Marketing emails sent:</b> ${winbacks} winback/offer emails this week.<br>
<span style="color:#8A94A3;">Trial counts exclude promo purchases and renewals; new members counted when their membership starts.</span></td></tr>
<tr><td style="padding:20px 26px 24px 26px;font-size:12px;color:#9AA3B5;">Questions? Reply here and Justin will follow up. &middot; J20 Solutions</td></tr>
</table></td></tr></table></body></html>`;

  if (dryRun) return json({ ok: true, dry_run: true, window: label, html });

  const paths = (Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "").split(",").map((s) => s.trim());
  if (!paths.includes("weekly_owner_report")) return json({ ok: false, error: "send path not enabled" }, 403);
  if (OWNER_RECIPIENTS.length === 0) return json({ ok: false, error: "OWNER_RECIPIENTS is empty" }, 400);

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: OWNER_RECIPIENTS, cc: CC, subject: `BBB Weekly Report · ${label}`, html }),
  });
  return json({ ok: r.ok, sent_to: OWNER_RECIPIENTS, cc: CC, window: label });
});
