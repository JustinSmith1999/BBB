/**
 * daily-lead-digest — yesterday's unworked leads, emailed to each studio.
 * ═══════════════════════════════════════════════════════════════════════════
 * Built 2026-10-19 (Justin: "have it send them an email every day saying these
 * are the leads from yesterday and give a list. To Williamsburg@ etc").
 *
 * WHY THIS EXISTS. These people are already on the Homebase board — capture-lead
 * writes them to trial_signups and the board reads that table. The problem was
 * never that the data was missing. It was that nothing TOLD anyone. A paid trial
 * fires a text via location_owners.notify_signups; somebody who typed their name,
 * email and phone and then bailed at the card lands silently. On 2026-10-19 there
 * were 20 of those sitting unworked across six days, 8 of them at Fresh Meadows.
 *
 * WHO GETS IT: the studio's own mailbox from _shared/studios.ts, so a studio only
 * ever sees its own leads. Justin is cc'd.
 *
 * WHAT COUNTS AS A LEAD HERE: created yesterday (America/New_York), has a real
 * contact method, and has NOT paid. Paid trials are excluded on purpose — those
 * already trigger their own alert and welcome sequence, and mixing them in would
 * train staff to skim.
 *
 * SAFETY
 *   dry_run defaults TRUE and returns the rendered HTML plus the exact recipient
 *   list without sending.
 *   Recipients come from _shared/studios.ts, never from the request body, so a
 *   malformed call cannot mail a stranger.
 *   Every Resend response is returned per studio. The info@ incident (a mailbox
 *   that did not exist, hard-bounced, and got the domain suppressed) happened
 *   because a send failed silently. A failure here is visible in the response.
 *
 * Body: { "dry_run": true, "date": "2026-10-18", "send_if_empty": false }
 *   date defaults to yesterday in ET. send_if_empty defaults false — a studio
 *   with no new leads gets no email, rather than a daily "0 leads" nobody reads.
 *
 * CATCH-UP: { "since": "2026-10-13" } covers since..today inclusive in ONE email
 *   per studio, instead of seven daily ones. Added 2026-10-19 to clear the
 *   backlog that had built up before this function existed. `until` is optional
 *   and defaults to today.
 *
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn daily-lead-digest
 * Schedule: daily 07:00 America/New_York, POST {"dry_run":false}
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { STUDIOS } from "../_shared/studios.ts";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
// 2026-10-13: send.betterbodybootcamp.com is NOT verified in Resend and every
// send 403s on it. The bare domain is the verified one. Do not "tidy" this.
const FROM = "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const CC = ["Justin@j20solutions.com"];
const BOARD_URL = "https://bbbmarketing.netlify.app/frontdesk.html";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Rows that are not a lead anybody should ring.
const NOT_A_LEAD = new Set(["direct_membership", "mb_direct", "walk_in", "in_person",
  "walk-in", "mt_direct_member", "legacy_archived"]);
const PLACEHOLDER = "@no-email.bbb.local";

/**
 * repairEmail — fix the handful of domain typos people actually make on a phone.
 * 2026-10-19 (Justin: "make sure you add .com if its a gmail and its done wrong").
 * Real case: vixmour@gmail.co — the trailing m missed on an iPhone keyboard.
 * Anything we send that address bounces, and bounces are what poisoned the
 * sending domain last time.
 *
 * DELIBERATELY NARROW. Only exact, unambiguous misses on the big consumer
 * domains. We do not guess at anything else, because a wrong guess means
 * mailing a stranger. Note `yahoo.co.uk` and `hotmail.co.uk` are REAL, so the
 * patterns anchor to end-of-string and never touch a valid ccTLD.
 */
const DOMAIN_FIXES: Array<[RegExp, string]> = [
  [/@gmail\.(co|cm|con|comm|c0m|om)$/i, "@gmail.com"],
  [/@(gmai|gmial|gmil|gnail|gmaill)\.com$/i, "@gmail.com"],
  [/@yahoo\.(co|cm|con|comm)$/i, "@yahoo.com"],
  [/@hotmail\.(co|cm|con)$/i, "@hotmail.com"],
  [/@outlook\.(co|cm|con)$/i, "@outlook.com"],
  [/@icloud\.(co|cm|con)$/i, "@icloud.com"],
  [/@aol\.(co|cm|con)$/i, "@aol.com"],
];
function repairEmail(raw: unknown): { email: string; original: string | null } {
  const e = String(raw ?? "").trim().toLowerCase();
  for (const [re, good] of DOMAIN_FIXES) {
    if (re.test(e)) return { email: e.replace(re, good), original: e };
  }
  return { email: e, original: null };
}

/** A row counts as paid only with BOTH a payment date and a settled status. */
function isPaid(r: any): boolean {
  if (!r.payment_date) return false;
  const st = String(r.payment_status || "").toLowerCase();
  return st === "completed" || st === "paid" || st === "succeeded";
}

/** Human label for how this person reached us. */
function entryLabel(sc: string | null): string {
  switch (sc) {
    case "trial_partial":    return "Started checkout, stopped at the card";
    case "contact_form":     return "Contact form";
    case "schedule_request": return "Asked us to text the schedule";
    case "mt_app":           return "Mariana Tek app";
    case "meta_lead":        return "Facebook lead form";
    default:                 return "Trial page";
  }
}

/** Yesterday in America/New_York as YYYY-MM-DD. ET is UTC-4 (EDT) / -5 (EST). */
function yesterdayET(): string {
  const nowEt = new Date(Date.now() - 4 * 3600 * 1000);
  return new Date(nowEt.getTime() - 86400000).toISOString().slice(0, 10);
}
const fmtTime = (iso: string) => {
  const d = new Date(new Date(iso).getTime() - 4 * 3600 * 1000);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m}${ap}`;
};

/** Date + time in ET, e.g. "Fri Oct 16, 9:30am". Used when the list spans days. */
const fmtDayTime = (iso: string) => {
  const d = new Date(new Date(iso).getTime() - 4 * 3600 * 1000);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${fmtTime(iso)}`;
};

function render(studioName: string, dateLabel: string, rows: any[], isRange = false): string {
  const INK = "#14161A", MUTE = "#6B7280", LINE = "#E6E8EC", RED = "#E11D2A";
  const cards = rows.map((r) => {
    const tel = r.phone ? String(r.phone).replace(/[^\d+]/g, "") : "";
    const fixed = repairEmail(r.email);
    const mail = fixed.email && !fixed.email.endsWith(PLACEHOLDER) ? fixed.email : "";
    return `
    <tr><td style="padding:14px 18px;border-bottom:1px solid ${LINE};">
      <div style="font:700 16px/1.3 Helvetica,Arial,sans-serif;color:${INK};">${esc(r.name || "(no name given)")}</div>
      <div style="font:400 13px/1.6 Helvetica,Arial,sans-serif;color:${MUTE};padding-top:3px;">
        ${esc(entryLabel(r.source_category))} &middot; ${esc(isRange ? fmtDayTime(r.created_at) : fmtTime(r.created_at))}
      </div>
      <div style="font:400 15px/1.7 Helvetica,Arial,sans-serif;padding-top:6px;">
        ${tel ? `<a href="tel:${esc(tel)}" style="color:${RED};font-weight:700;text-decoration:none;">${esc(r.phone)}</a>` : `<span style="color:${MUTE};">no phone</span>`}
        ${mail ? ` &nbsp;·&nbsp; <a href="mailto:${esc(mail)}" style="color:${INK};">${esc(mail)}</a>` : ""}
      </div>
      ${fixed.original ? `<div style="font:400 12px/1.5 Helvetica,Arial,sans-serif;color:${MUTE};padding-top:4px;">
        Typed <span style="text-decoration:line-through;">${esc(fixed.original)}</span>, corrected above. Confirm it when you call.
      </div>` : ""}
    </td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(studioName)} leads</title></head>
<body style="margin:0;padding:0;background:#F7F8FA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F8FA;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
    <tr><td style="background:${INK};padding:22px 18px;">
      <div style="font:700 11px/1 Helvetica,Arial,sans-serif;color:${RED};letter-spacing:.14em;text-transform:uppercase;">Better Body Bootcamp</div>
      <div style="font:700 21px/1.25 Helvetica,Arial,sans-serif;color:#fff;padding-top:7px;">${esc(studioName)}: ${rows.length} ${rows.length === 1 ? "lead" : "leads"} to call</div>
      <div style="font:400 13px/1.4 Helvetica,Arial,sans-serif;color:#A8AEB8;padding-top:5px;">${esc(dateLabel)}</div>
    </td></tr>
    <tr><td style="padding:16px 18px 4px;font:400 14px/1.6 Helvetica,Arial,sans-serif;color:${INK};">
      ${isRange
        ? "These people gave us their details and did not buy. Some have been waiting several days. They are the warmest calls you have."
        : "These people gave us their details yesterday and did not buy. They are the warmest calls you have today."}
      Tap a number to ring it.
    </td></tr>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cards}</table>
    <tr><td style="padding:18px;">
      <a href="${BOARD_URL}" style="display:inline-block;background:${RED};color:#fff;font:700 14px/1 Helvetica,Arial,sans-serif;padding:13px 20px;border-radius:8px;text-decoration:none;">Open Homebase</a>
    </td></tr>
    <tr><td style="padding:0 18px 20px;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:${MUTE};">
      Mark each one contacted in Homebase so it drops off tomorrow's list.
      Paid trials are not shown here, only people who have not bought yet.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const dryRun = body.dry_run !== false;
  const sendIfEmpty = body.send_if_empty === true;
  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const todayET = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);

  // Single day (the daily run) or an inclusive range (the catch-up run).
  const startDay = isDate(body.since) ? body.since as string
    : isDate(body.date) ? body.date as string
    : yesterdayET();
  const endDay = isDate(body.since) ? (isDate(body.until) ? body.until as string : todayET) : startDay;

  // ET day window -> UTC. ET is UTC-4 during EDT.
  const fromUtc = new Date(`${startDay}T04:00:00.000Z`).toISOString();
  const toUtc = new Date(new Date(`${endDay}T04:00:00.000Z`).getTime() + 86400000).toISOString();
  const day = startDay;

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await sb
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_status,payment_date,created_at,source_category,front_desk_stage,deleted_at")
    .gte("created_at", fromUtc)
    .lt("created_at", toUtc)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) return json({ ok: false, error: `trial_signups: ${error.message}` }, 502);

  const byUuid: Record<string, any> = {};
  for (const s of Object.values(STUDIOS)) byUuid[s.locationUuid] = s;

  /**
   * Identity key for a human. A person can own SEVERAL trial_signups rows:
   * capture-lead writes one when they fill in step 1, and the checkout writes
   * another when they pay. Vicky Mourkakos had an unpaid row at 23:04 and a
   * paid row at 23:05, so a per-ROW paid test put a buyer on the call list.
   * Justin, 2026-10-19: "if they bought dont include them".
   */
  const keysOf = (r: any): string[] => {
    const k: string[] = [];
    const e = repairEmail(r.email).email;
    if (e && !e.endsWith(PLACEHOLDER)) k.push("e:" + e);
    const p = String(r.phone || "").replace(/\D/g, "").slice(-10);
    if (p.length === 10) k.push("p:" + p);
    return k;
  };

  // Anyone who has EVER paid, looked up well beyond the digest window — a
  // person can bail on Monday and buy on Friday, and Friday's purchase is
  // outside a one-day window.
  const buyers = new Set<string>();
  {
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const { data: paidRows } = await sb
      .from("trial_signups")
      .select("email,phone,payment_status,payment_date")
      .gte("payment_date", since)
      .not("payment_date", "is", null);
    for (const r of paidRows ?? []) if (isPaid(r)) for (const k of keysOf(r)) buyers.add(k);
  }

  const perStudio: Record<string, any[]> = {};
  const skipped = { paid: 0, bought_later: 0, duplicate_person: 0,
                    not_a_lead: 0, no_contact: 0, unknown_studio: 0 };
  const unknownStudioIds = new Set<string>();
  const seen = new Set<string>();   // one card per human, not per row
  for (const r of data ?? []) {
    const studio = byUuid[r.location_id];
    if (!studio) { skipped.unknown_studio++; unknownStudioIds.add(String(r.location_id)); continue; }
    if (isPaid(r)) { skipped.paid++; continue; }
    if (NOT_A_LEAD.has(String(r.source_category || ""))) { skipped.not_a_lead++; continue; }
    const hasMail = !!repairEmail(r.email).email && !repairEmail(r.email).email.endsWith(PLACEHOLDER);
    if (!r.phone && !hasMail) { skipped.no_contact++; continue; }
    const keys = keysOf(r);
    if (keys.some((k) => buyers.has(k))) { skipped.bought_later++; continue; }
    if (keys.some((k) => seen.has(k))) { skipped.duplicate_person++; continue; }
    for (const k of keys) seen.add(k);
    (perStudio[studio.slug] ||= []).push(r);
  }

  const fmtDay = (d: string, withWeekday: boolean) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US",
      withWeekday ? { weekday: "long", month: "long", day: "numeric" } : { month: "short", day: "numeric" });
  const isRange = startDay !== endDay;
  const dateLabel = isRange
    ? `${fmtDay(startDay, false)} to ${fmtDay(endDay, false)}`
    : fmtDay(startDay, true);

  const jobs = Object.values(STUDIOS).map((s) => {
    const rows = perStudio[s.slug] ?? [];
    return {
      studio: s.slug,
      to: [s.mailbox],
      cc: CC,
      subject: rows.length
        ? `${rows.length} ${rows.length === 1 ? "lead" : "leads"} to call — ${s.name}, ${dateLabel}`
        : `No new leads — ${s.name}, ${dateLabel}`,
      count: rows.length,
      names: rows.map((r) => r.name || "(no name)"),
      html: rows.length ? render(s.name, dateLabel, rows, isRange) : null,
      will_send: rows.length > 0 || sendIfEmpty,
    };
  });

  if (dryRun) {
    return json({
      ok: true, dry_run: true, date: day, date_label: dateLabel,
      note: "Nothing sent. Re-run with dry_run:false to send.",
      totals: { leads: Object.values(perStudio).reduce((n, a) => n + a.length, 0), skipped },
      unknown_studio_location_ids: [...unknownStudioIds],
      plan: jobs.map(({ html, ...rest }) => ({ ...rest, html_chars: html?.length ?? 0 })),
      sample_html: jobs.find((j) => j.html)?.html ?? null,
    });
  }

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);

  const results: any[] = [];
  for (const j of jobs) {
    if (!j.will_send) { results.push({ studio: j.studio, skipped: "no leads" }); continue; }
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: j.to, cc: j.cc, subject: j.subject, html: j.html }),
      });
      const b = await r.json().catch(() => ({}));
      // Surface the failure. A silently-dropped send is how info@ bounced for
      // weeks without anyone noticing.
      results.push({ studio: j.studio, to: j.to, count: j.count, ok: r.ok, id: (b as any)?.id ?? null,
                     error: r.ok ? null : JSON.stringify(b).slice(0, 300) });
    } catch (e) {
      results.push({ studio: j.studio, to: j.to, count: j.count, ok: false, error: String((e as Error).message) });
    }
  }
  return json({ ok: results.every((r) => r.ok !== false), dry_run: false, date: day, results });
});
