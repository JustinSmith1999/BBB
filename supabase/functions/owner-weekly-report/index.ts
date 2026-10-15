/**
 * owner-weekly-report — the Monday morning numbers email, per studio plus a
 * combined one. Built 2026-10-13.
 *
 * STRICTLY NUMBERS. Justin's instruction: no commentary, no advice, no verdicts.
 * Figures, one chart, a day table, and the member conversion. Nothing else.
 *
 * GROUND TRUTH. This function does not re-derive anything. It calls the three
 * functions that already own these numbers and renders what they return:
 *   daily-pulse            paid trials + leads per studio per day, from Mariana
 *                          Tek membership_instances (NOT the dashboard tiles,
 *                          which counted recurring member billing as trials)
 *   meta-ad-snapshot       ad spend for the window
 *   trial-conversion-stats trials that later bought a membership
 * One source of truth each, so this email can never drift from the dashboard.
 *
 * ROUTING (2026-10-13, per Justin)
 *   Astoria, Williamsburg  -> chris@betterbodybootcamp.com
 *   Bayside, Fresh Meadows -> carlos@betterbodybootcamp.com
 *   All four combined      -> carlos@betterbodybootcamp.com
 *   Justin is cc'd on everything.
 *   Steve is not on this list. Add him to ROUTES when that changes.
 *
 * SAFETY
 *   dry_run defaults TRUE and returns the rendered HTML without sending.
 *   Recipients live here in code, so a malformed call cannot mail a stranger.
 *   No other setup: deploy it and it works.
 *
 * Body: { "dry_run": true, "week_ending": "2026-10-12" }   // both optional
 *   week_ending defaults to the most recent Monday (inclusive). The window is
 *   the 7 days ending that day, Monday to Monday, matching what Justin asked for.
 *
 * Auth: x-bbb-secret. Env: RESEND_API_KEY (already set, winback-blast uses it).
 * Deploy: bbb deploy-fn owner-weekly-report
 * Schedule: Mondays 07:00 America/New_York, POST {"dry_run":false}
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const BASE = "https://uracuwugpxqjfgtuobal.supabase.co/functions/v1";
// 2026-10-13: send.betterbodybootcamp.com is NOT verified in Resend and every
// send 403s on it. The bare domain is the verified one that winback-blast and
// the rest of the live senders use. Do not "tidy" this back to the subdomain.
const FROM = "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const CC = ["Justin@j20solutions.com"];

const ROUTES: Record<string, string[]> = {
  "astoria": ["chris@betterbodybootcamp.com"],
  "williamsburg": ["chris@betterbodybootcamp.com"],
  "bayside": ["carlos@betterbodybootcamp.com"],
  "fresh-meadows": ["carlos@betterbodybootcamp.com"],
  "__all__": ["carlos@betterbodybootcamp.com"],
};

const LABEL: Record<string, string> = {
  astoria: "Astoria", bayside: "Bayside",
  "fresh-meadows": "Fresh Meadows", williamsburg: "Williamsburg",
};
const ORDER = ["astoria", "bayside", "fresh-meadows", "williamsburg"];

const RED = "#E11D2A", INK = "#111418", MUTE = "#6B7280", LINE = "#E6E8EC",
      BG = "#F7F8FA", GRN = "#17803D";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/** Most recent SUNDAY on or before today, in America/New_York. The report week
 *  is Monday to Sunday, so this Sunday is the last day of the window. Run on a
 *  Monday at 7am it gives the week that finished the night before. */
function lastSunday(): Date {
  const nyNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const back = nyNow.getDay();             // 0 Sun, 1 Mon .. 6 Sat
  return new Date(Date.UTC(nyNow.getFullYear(), nyNow.getMonth(), nyNow.getDate() - back));
}

async function call(path: string, body?: unknown) {
  const r = await fetch(`${BASE}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-bbb-secret": SECRET, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ── rendering ────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function arrow(x: number) {
  const c = x > 0 ? GRN : x < 0 ? "#B42318" : MUTE;
  const a = x > 0 ? "&#9650;" : x < 0 ? "&#9660;" : "&#9679;";
  return `<span style="color:${c};font-weight:700;">${a} ${Math.abs(x)}</span>`;
}
function statCell(v: string | number, l: string, accent = false) {
  // Five across since cost per lead was added 2026-10-13, so 20% each.
  return `<td width="20%" align="center" style="padding:16px 4px;background:#FFFFFF;border:1px solid ${LINE};border-radius:10px;">
    <div style="font:700 24px/1 Helvetica,Arial,sans-serif;color:${accent ? RED : INK};">${v}</div>
    <div style="font:400 10px/1.35 Helvetica,Arial,sans-serif;color:${MUTE};padding-top:6px;text-transform:uppercase;letter-spacing:.05em;">${l}</div></td>`;
}
function chart(vals: number[], labels: string[]) {
  const mx = Math.max(...vals, 1);
  const cells = vals.map((v, i) => {
    const cur = i === vals.length - 1;
    const h = v ? Math.round((v / mx) * 92) : 3;
    const col = cur ? RED : v ? "#C9CDD4" : "#E6E8EC";
    const lc = cur ? INK : MUTE, fw = cur ? 700 : 400;
    return `<td align="center" valign="bottom" style="padding:0 4px;">
      <div style="font:700 13px/1.2 Helvetica,Arial,sans-serif;color:${lc};margin-bottom:5px;">${v}</div>
      <div style="width:30px;height:${h}px;background:${col};border-radius:4px 4px 0 0;"></div>
      <div style="border-top:1px solid ${LINE};padding-top:7px;font:${fw} 11px/1.2 Helvetica,Arial,sans-serif;color:${lc};white-space:nowrap;">${labels[i]}</div></td>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>${cells}</tr></table>`;
}
function dayTable(days: string[], paid: number[], leads: number[]) {
  const h = days.map((d) => `<td align="center" style="padding:8px 4px;font:400 11px/1.2 Helvetica,Arial,sans-serif;color:${MUTE};border-bottom:1px solid ${LINE};">${d}</td>`).join("");
  const r1 = paid.map((v) => `<td align="center" style="padding:9px 4px;font:700 15px/1.2 Helvetica,Arial,sans-serif;color:${v ? INK : "#B6BBC3"};">${v}</td>`).join("");
  const r2 = leads.map((v) => `<td align="center" style="padding:0 4px 9px;font:400 12px/1.2 Helvetica,Arial,sans-serif;color:${MUTE};">${v}</td>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;">
    <tr><td style="padding:2px 6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>${h}</tr><tr>${r1}</tr><tr>${r2}</tr></table></td></tr></table>`;
}
function shell(title: string, head: string, inner: string, width = 620) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:26px 12px;"><tr><td align="center">
<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${LINE};">
  <tr><td style="background:${INK};padding:26px 30px;">
    <div style="font:700 11px/1 Helvetica,Arial,sans-serif;color:${RED};letter-spacing:.18em;text-transform:uppercase;">Better Body Bootcamp</div>
    <div style="font:700 25px/1.25 Helvetica,Arial,sans-serif;color:#FFFFFF;padding-top:9px;">${esc(head)}</div>
    <div style="font:400 14px/1.4 Helvetica,Arial,sans-serif;color:#9AA1AC;padding-top:5px;">${esc(title)}</div></td></tr>
  ${inner}
  <tr><td style="background:#FAFBFC;border-top:1px solid ${LINE};padding:18px 30px;">
    <div style="font:400 11px/1.6 Helvetica,Arial,sans-serif;color:#8B919B;">
      Paid trial: a $49 two week trial purchased, counted from Mariana Tek. Converted: that person later bought a paying
      membership. People still inside their trial are excluded from the rate. Weekly average covers the seven weeks before
      this one. Ad spend is Meta only. Cost per lead is ad spend divided by new leads, cost per trial is ad spend divided by paid trials. In the day table, the large number is paid trials and the small number is new leads.<br>
      Prepared by J20 Solutions</div></td></tr>
</table></td></tr></table></body></html>`;
}
function memberBlock(conv: number, fin: number, rate: number, sep: number | null, still: number, scope: string) {
  return `<tr><td style="padding:26px 24px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFBFC;border:1px solid ${LINE};border-radius:10px;">
      <tr><td style="padding:18px 20px;">
        <div style="font:700 11px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding-bottom:12px;">Trials that became members</div>
        <div style="font:700 26px/1.1 Helvetica,Arial,sans-serif;color:${INK};">${conv} of ${fin} <span style="font:400 15px/1.1 Helvetica,Arial,sans-serif;color:${MUTE};">finished trials since June, ${rate} percent</span></div>
        <div style="font:400 14px/1.6 Helvetica,Arial,sans-serif;color:#2B313A;padding-top:10px;">
          ${sep === null ? "" : `Last full month: ${sep} percent. `}${still} of this month's trials${scope} are still inside their two weeks and are not counted yet.</div>
      </td></tr></table></td></tr>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const dryRun = body.dry_run !== false;

  const end = body.week_ending ? new Date(body.week_ending + "T00:00:00Z") : lastSunday();
  const win: string[] = [];
  for (let i = 6; i >= 0; i--) win.push(iso(addDays(end, -i)));
  const dayLabels = win.map((d) => {
    const dt = new Date(d + "T12:00:00Z");
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()] + " " + dt.getUTCDate();
  });
  const label = `${dayLabels[0]} to ${dayLabels[6]}`;

  // Eight weekly buckets ending with this one
  const weeks: string[][] = [];
  for (let w = 7; w >= 0; w--) {
    const e = addDays(end, -7 * w);
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) days.push(iso(addDays(e, -i)));
    weeks.push(days);
  }
  const wkLabels = weeks.map((d) => {
    const dt = new Date(d[0] + "T12:00:00Z");
    return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][dt.getUTCMonth()] + " " + dt.getUTCDate();
  });

  const todayNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayIso = `${todayNY.getFullYear()}-${String(todayNY.getMonth() + 1).padStart(2, "0")}-${String(todayNY.getDate()).padStart(2, "0")}`;
  const spendDays = Math.max(7, Math.min(60,
    Math.round((Date.parse(todayIso) - Date.parse(win[0])) / 86400000) + 1));

  let pulse: any, snap: any, conv: any;
  try {
    [pulse, snap, conv] = await Promise.all([
      call("daily-pulse"),
      // meta-ad-snapshot only accepts a trailing-days window, so stretch it back
      // to the first day of the report week. Run on Monday morning that is 8
      // days, where the extra day is a few hours of today's spend.
      fetch(`${BASE}/meta-ad-snapshot?days=${spendDays}`, { headers: { "x-bbb-secret": SECRET } }).then((r) => r.json()),
      call("trial-conversion-stats"),
    ]);
  } catch (e) { return json({ ok: false, error: `source fetch failed: ${String(e)}` }, 502); }

  const spendBy: Record<string, number> = {};
  for (const s of snap.studios || []) spendBy[s.studio] = s.totals_window?.spend ?? 0;

  const per: any = {};
  for (const slug of ORDER) {
    const days = pulse.studios?.[slug]?.days || {};
    const sum = (ds: string[], k: string) => ds.reduce((a, d) => a + ((days[d]?.[k]) ?? 0), 0);
    const weekly = weeks.map((w) => sum(w, "paid"));
    const cs = conv.studios?.[slug] || {};
    const months = cs.months || {};
    const mk = Object.keys(months).sort();
    const thisMonth = mk[mk.length - 1];
    const prevFull = mk[mk.length - 2];
    per[slug] = {
      paid: sum(win, "paid"), leads: sum(win, "leads"),
      perDayPaid: win.map((d) => days[d]?.paid ?? 0),
      perDayLeads: win.map((d) => days[d]?.leads ?? 0),
      weekly, last: weekly[6], avg: Math.round((weekly.slice(0, 7).reduce((a, b) => a + b, 0) / 7) * 10) / 10,
      spend: spendBy[slug] ?? 0,
      conv: cs.since_cutover?.converted ?? 0, fin: cs.since_cutover?.ended ?? 0,
      rate: cs.since_cutover?.rate ?? 0,
      sep: prevFull ? (months[prevFull]?.rate ?? null) : null,
      still: thisMonth ? (months[thisMonth]?.still ?? 0) : 0,
    };
  }

  function studioHtml(slug: string) {
    const d = per[slug];
    const cac = d.paid ? d.spend / d.paid : 0;
    const cpl = d.leads ? d.spend / d.leads : 0;
    const inner = `
  <tr><td style="padding:26px 20px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="5" border="0"><tr>
    ${statCell(d.paid, "Paid trials", true)}${statCell(d.leads, "New leads")}
    ${statCell("$" + d.paid * 49, "Trial revenue")}
    ${statCell(d.leads ? "$" + Math.round(cpl) : "n/a", "Cost per lead")}
    ${statCell(d.paid ? "$" + Math.round(cac) : "n/a", "Cost per trial")}
  </tr></table></td></tr>
  <tr><td style="padding:26px 30px 10px;">
    <div style="font:700 12px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding-bottom:4px;">Paid trials, last eight weeks</div>
    <div style="font:400 13px/1.5 Helvetica,Arial,sans-serif;color:${MUTE};padding-bottom:16px;">This week ${d.paid}. Last week ${d.last} (${arrow(d.paid - d.last)}). Weekly average ${d.avg} (${arrow(Math.round((d.paid - d.avg) * 10) / 10)}).</div>
    ${chart(d.weekly, wkLabels)}</td></tr>
  <tr><td style="padding:26px 24px 6px;">
    <div style="font:700 12px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding:0 6px 12px;">This week, trials and leads by day</div>
    ${dayTable(dayLabels, d.perDayPaid, d.perDayLeads)}</td></tr>
  ${memberBlock(d.conv, d.fin, d.rate, d.sep, d.still, "")}`;
    return shell(label, LABEL[slug], inner);
  }

  function allHtml() {
    const paid = ORDER.reduce((a, s) => a + per[s].paid, 0);
    const leads = ORDER.reduce((a, s) => a + per[s].leads, 0);
    const spend = ORDER.reduce((a, s) => a + per[s].spend, 0);
    const weekly = wkLabels.map((_, i) => ORDER.reduce((a, s) => a + per[s].weekly[i], 0));
    const last = weekly[6], avg = Math.round((weekly.slice(0, 7).reduce((a, b) => a + b, 0) / 7) * 10) / 10;
    const pd = win.map((_, i) => ORDER.reduce((a, s) => a + per[s].perDayPaid[i], 0));
    const pl = win.map((_, i) => ORDER.reduce((a, s) => a + per[s].perDayLeads[i], 0));
    const cv = conv.overall?.converted_since_cutover ?? 0, fn = conv.overall?.ended_since_cutover ?? 0;
    const rt = conv.overall?.rate_since_cutover ?? 0;
    const still = ORDER.reduce((a, s) => a + per[s].still, 0);
    const th = `background:#FAFBFC;padding:10px;font:700 11px/1.2 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.05em;text-transform:uppercase;border-bottom:1px solid ${LINE};`;
    const td = `padding:12px 6px;font:400 14px/1.2 Helvetica,Arial,sans-serif;color:${INK};border-bottom:1px solid ${LINE};`;
    const rows = ORDER.map((s) => {
      const d = per[s];
      return `<tr><td style="padding:12px 10px;font:700 14px/1.2 Helvetica,Arial,sans-serif;color:${INK};border-bottom:1px solid ${LINE};">${LABEL[s]}</td>
        <td align="center" style="${td}color:${RED};font-weight:700;">${d.paid}</td>
        <td align="center" style="${td}">${d.leads}</td>
        <td align="center" style="${td}">$${d.paid * 49}</td>
        <td align="center" style="${td}">$${Math.round(d.spend)}</td>
        <td align="center" style="${td}">${d.leads ? "$" + Math.round(d.spend / d.leads) : "n/a"}</td>
        <td align="center" style="${td}">${d.paid ? "$" + Math.round(d.spend / d.paid) : "n/a"}</td>
        <td align="center" style="${td}">${d.conv}/${d.fin} &middot; ${d.rate}%</td></tr>`;
    }).join("");
    const inner = `
  <tr><td style="padding:26px 20px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="5" border="0"><tr>
    ${statCell(paid, "Paid trials", true)}${statCell(leads, "New leads")}
    ${statCell("$" + paid * 49, "Trial revenue")}
    ${statCell(leads ? "$" + Math.round(spend / leads) : "n/a", "Cost per lead")}
    ${statCell(paid ? "$" + Math.round(spend / paid) : "n/a", "Cost per trial")}
  </tr></table></td></tr>
  <tr><td style="padding:26px 30px 10px;">
    <div style="font:700 12px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding-bottom:4px;">Paid trials, last eight weeks</div>
    <div style="font:400 13px/1.5 Helvetica,Arial,sans-serif;color:${MUTE};padding-bottom:16px;">This week ${paid}. Last week ${last} (${arrow(paid - last)}). Weekly average ${avg} (${arrow(Math.round((paid - avg) * 10) / 10)}).</div>
    ${chart(weekly, wkLabels)}</td></tr>
  <tr><td style="padding:26px 24px 6px;">
    <div style="font:700 12px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding:0 6px 12px;">By studio</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;">
      <tr><td style="${th}">Studio</td><td align="center" style="${th}">Trials</td><td align="center" style="${th}">Leads</td>
      <td align="center" style="${th}">Revenue</td><td align="center" style="${th}">Spend</td>
      <td align="center" style="${th}">Per lead</td><td align="center" style="${th}">Per trial</td>
      <td align="center" style="${th}">Became members</td></tr>${rows}</table></td></tr>
  <tr><td style="padding:26px 24px 6px;">
    <div style="font:700 12px/1 Helvetica,Arial,sans-serif;color:${MUTE};letter-spacing:.1em;text-transform:uppercase;padding:0 6px 12px;">This week, trials and leads by day</div>
    ${dayTable(dayLabels, pd, pl)}</td></tr>
  ${memberBlock(cv, fn, rt, null, still, " across the four studios")}`;
    return shell(label, "All four studios", inner, 700);
  }

  const jobs: { key: string; subject: string; html: string; to: string[] }[] = [];
  for (const slug of ORDER) {
    jobs.push({ key: slug, subject: `${LABEL[slug]} numbers, ${label}`, html: studioHtml(slug), to: ROUTES[slug] ?? [] });
  }
  jobs.push({ key: "__all__", subject: `All four studios, ${label}`, html: allHtml(), to: ROUTES["__all__"] ?? [] });

  if (dryRun) {
    return json({
      ok: true, dry_run: true, window: { from: win[0], to: win[6], label },
      note: "Nothing sent. Re-run with dry_run:false to send.",
      spend_window_days: spendDays,
      plan: jobs.map((j) => ({ report: j.key, subject: j.subject, to: j.to, cc: CC, skipped: j.to.length === 0, html_chars: j.html.length })),
      totals: { paid: ORDER.reduce((a, s) => a + per[s].paid, 0), leads: ORDER.reduce((a, s) => a + per[s].leads, 0) },
      per_studio: Object.fromEntries(ORDER.map((s) => [s, { paid: per[s].paid, leads: per[s].leads, spend: Math.round(per[s].spend), converted: `${per[s].conv}/${per[s].fin}` }])),
      html: Object.fromEntries(jobs.map((j) => [j.key, j.html])),
    });
  }

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);

  const results: any[] = [];
  for (const j of jobs) {
    if (!j.to.length) { results.push({ report: j.key, skipped: true, reason: "no recipient configured" }); continue; }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: j.to, cc: CC, subject: j.subject, html: j.html }),
    });
    const rb = await r.json().catch(() => ({}));
    results.push({ report: j.key, to: j.to, cc: CC, ok: r.ok, id: rb?.id ?? null, error: r.ok ? undefined : rb });
  }
  return json({ ok: results.every((x) => x.skipped || x.ok), dry_run: false, window: label, results });
});
