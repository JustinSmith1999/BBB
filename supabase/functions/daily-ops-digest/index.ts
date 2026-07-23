// Supabase Edge Function: daily-ops-digest
//
// Justin's 6am inbox briefing. Pulls yesterday's numbers (paid trials per
// studio, CAC, CAPI health, system errors) and emails him a single HTML
// summary so he doesn't have to log into /ops every morning.
//
// ── Recipient ───────────────────────────────────────────────────────────────
// Hard-coded to Justin@J20solutions.com so an env-var typo can't ever fan it
// out to owners. If you want to add cc/bcc, edit DIGEST_TO below.
//
// ── Send-path gate ──────────────────────────────────────────────────────────
// Gated by BBB_SEND_PATHS_ENABLED — path name "justin_daily_digest". OFF by
// default until Justin flips it on; first run after enabling sends the digest.
//
// ── Trigger ─────────────────────────────────────────────────────────────────
// Designed to run via pg_cron at 6am ET (10am UTC EST / 11am UTC EDT).
// Idempotent: re-running same day re-sends with the same numbers (Resend
// dedups via email id if you pass headers["X-Entity-Ref-ID"]).
//
// POST body (optional):
//   { dry_run?: boolean,    // log + return body, don't send
//     for_date?: string }    // override the "yesterday" anchor (YYYY-MM-DD ET)

// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const DIGEST_TO = "Justin@J20solutions.com";
const DIGEST_FROM = "BBB Ops <ops@betterbodybootcamp.com>";
const SEND_PATH = "justin_daily_digest";

// Send-path gate (mirrors stripe-webhook's pattern so the seatbelt rule
// applies here too — accidental enables can't ship surprise blasts).
function isSendPathEnabled(): boolean {
  const raw = Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)).has(SEND_PATH);
}

// ── ET date helpers ─────────────────────────────────────────────────────────
function etDateString(d: Date): string {
  // YYYY-MM-DD in America/New_York
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function etYesterdayBounds(forDate?: string) {
  // Compute the start/end of "yesterday in ET" as UTC timestamps so SQL queries
  // can filter cleanly. forDate (YYYY-MM-DD) overrides "yesterday".
  const todayET = forDate
    ? new Date(`${forDate}T12:00:00-05:00`) // anchor inside the ET day
    : new Date();
  const yET = new Date(todayET);
  yET.setDate(yET.getDate() - (forDate ? 0 : 1));
  const ymd = etDateString(yET);
  return {
    label: ymd, // "2026-05-31"
    startUtc: new Date(`${ymd}T00:00:00-04:00`).toISOString(), // EDT
    endUtc: new Date(`${ymd}T23:59:59.999-04:00`).toISOString(),
  };
}

// ── Numbers we want in the digest ───────────────────────────────────────────
async function gatherStats(supabase: ReturnType<typeof createClient>, forDate?: string) {
  const day = etYesterdayBounds(forDate);

  // 1. Paid trials yesterday by studio (stripe_paid_mirror = SSOT).
  //
  // CRITICAL: count distinct CUSTOMERS, not raw rows. Real cases observed:
  //   • Bridget Walsh: paid 3x on 5/31 — and used TWO email spellings
  //     (bwals1194@gmail.com typo + bwalsh1194@gmail.com correct, x2).
  //     Email-only dedup misses her; we need name as a fallback.
  //   • Vanessa Cruz: paid 2x in 10 minutes (same email).
  //   • Margot Chirikjian: paid 2x in 2 minutes (same email).
  //
  // Dedup rule: a row is a duplicate of any earlier row in the same studio
  // that shares ANY of {normalized email, last-10-digit phone, normalized
  // full name}. Last-resort key when all three are empty: payment_intent_id.
  const { data: paidRows, error: paidErr } = await supabase
    .from("stripe_paid_mirror")
    .select("studio_slug, paid_at, customer_name, customer_email, customer_phone, stripe_payment_intent_id")
    .gte("paid_at", day.startUtc)
    .lte("paid_at", day.endUtc);
  if (paidErr) throw new Error(`paid mirror query: ${paidErr.message}`);

  const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const normName  = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const normPhone = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);

  const paidByStudio: Record<string, number> = {};
  const rawByStudio: Record<string, number> = {};
  // Track per-studio sets of every email/phone/name we've already credited.
  // If a new row matches ANY of those sets, it's a duplicate of an existing
  // customer (different email spelling but same name, etc.).
  const seen: Record<string, { emails: Set<string>; phones: Set<string>; names: Set<string> }> = {};
  for (const r of paidRows ?? []) {
    const studio = r.studio_slug as string;
    rawByStudio[studio] = (rawByStudio[studio] ?? 0) + 1;
    if (!seen[studio]) seen[studio] = { emails: new Set(), phones: new Set(), names: new Set() };
    const e = normEmail(r.customer_email);
    const p = normPhone(r.customer_phone);
    const n = normName(r.customer_name);
    const isDup =
      (e && seen[studio].emails.has(e)) ||
      (p && seen[studio].phones.has(p)) ||
      (n && seen[studio].names.has(n));
    if (isDup) continue;
    // Register every non-empty identifier we now know about this customer
    if (e) seen[studio].emails.add(e);
    if (p) seen[studio].phones.add(p);
    if (n) seen[studio].names.add(n);
    paidByStudio[studio] = (paidByStudio[studio] ?? 0) + 1;
  }
  // Track duplicate-charges so we can surface "X duplicates collapsed" in the
  // digest. If raw > dedup'd, we caught a Bridget-Walsh-style billing event.
  const dupesByStudio: Record<string, number> = {};
  for (const s of Object.keys(rawByStudio)) {
    const d = rawByStudio[s] - (paidByStudio[s] ?? 0);
    if (d > 0) dupesByStudio[s] = d;
  }

  // 2. CAPI per-studio health (uses the RPC we built tonight)
  let capi: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await supabase.rpc("get_capi_status");
    if (!error) capi = (data as Array<Record<string, unknown>>) ?? [];
  } catch { /* ignore — RPC may not exist on older DBs */ }

  // 3. meta_sync_runs — did the cron run successfully yesterday?
  let metaSync: { last_ok: string | null; failures_24h: number } = { last_ok: null, failures_24h: 0 };
  try {
    const { data, error } = await supabase
      .from("meta_sync_runs")
      .select("ran_at, ok")
      .gte("ran_at", new Date(Date.now() - 36 * 3600 * 1000).toISOString())
      .order("ran_at", { ascending: false })
      .limit(20);
    if (!error && data) {
      const okRow = data.find((r) => r.ok);
      metaSync.last_ok = okRow?.ran_at ?? null;
      metaSync.failures_24h = data.filter((r) => !r.ok).length;
    }
  } catch { /* ignore */ }

  // 4. Spend / clicks per studio for yesterday — best-effort from meta_insights_daily
  let spendByStudio: Record<string, { spend: number; impressions: number; clicks: number }> = {};
  try {
    const { data, error } = await supabase
      .from("meta_insights_daily")
      .select("studio_slug, spend_cents, impressions, clicks, date_start")
      .eq("date_start", day.label);
    if (!error && data) {
      for (const r of data) {
        const s = String(r.studio_slug);
        const prev = spendByStudio[s] ?? { spend: 0, impressions: 0, clicks: 0 };
        prev.spend       += Number(r.spend_cents ?? 0) / 100;
        prev.impressions += Number(r.impressions  ?? 0);
        prev.clicks      += Number(r.clicks       ?? 0);
        spendByStudio[s] = prev;
      }
    }
  } catch { /* ignore */ }

  // 5. Reconcile + dup health (added 2026-06-24 — surfaces autonomous safety net)
  let reconcile: any = null;
  try {
    const { data, error } = await supabase.rpc("get_reconcile_digest_24h");
    if (!error) reconcile = data;
  } catch { /* RPC may not exist on older DBs */ }

  let reconcileHealth: any = null;
  try {
    const { data, error } = await supabase.rpc("get_reconcile_health");
    if (!error && data) reconcileHealth = Array.isArray(data) ? data[0] : data;
  } catch { /* ignore */ }

  return { day, paidByStudio, dupesByStudio, capi, metaSync, spendByStudio, reconcile, reconcileHealth };
}

function studioLabel(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderHtml(s: Awaited<ReturnType<typeof gatherStats>>): string {
  const studios = ["williamsburg", "astoria", "bayside", "fresh-meadows"];
  const paidTotal = studios.reduce((a, x) => a + (s.paidByStudio[x] ?? 0), 0);
  const spendTotal = studios.reduce((a, x) => a + (s.spendByStudio[x]?.spend ?? 0), 0);
  const cac = paidTotal > 0 ? spendTotal / paidTotal : null;

  const studioRows = studios.map((slug) => {
    const paid = s.paidByStudio[slug] ?? 0;
    const sp = s.spendByStudio[slug] ?? { spend: 0, impressions: 0, clicks: 0 };
    const studioCac = paid > 0 ? sp.spend / paid : null;
    const cacText = studioCac == null
      ? (sp.spend > 0 ? `$${sp.spend.toFixed(0)} · 0 paid` : "—")
      : `$${studioCac.toFixed(0)}`;
    const cacColor = studioCac == null ? "#94A3B8"
      : studioCac > 100 ? "#DC2626"
      : studioCac > 60  ? "#D97706"
      : "#15803D";
    return `<tr>
      <td style="padding:10px 6px;border-bottom:1px solid #F1F5F9;font-weight:600">${studioLabel(slug)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #F1F5F9;text-align:right;font-weight:700">${paid}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #F1F5F9;text-align:right">$${sp.spend.toFixed(2)}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #F1F5F9;text-align:right;color:${cacColor};font-weight:700">${cacText}</td>
      <td style="padding:10px 6px;border-bottom:1px solid #F1F5F9;text-align:right;color:#64748B;font-size:13px">${sp.impressions.toLocaleString()} · ${sp.clicks}</td>
    </tr>`;
  }).join("");

  // CAPI summary line
  const capiBad = s.capi.filter((r) => r.status === "red" || r.status === "never");
  const capiOk  = s.capi.filter((r) => r.status === "ok");
  const capiLine = s.capi.length === 0
    ? `<span style="color:#94A3B8">CAPI status unknown — get_capi_status() not deployed yet.</span>`
    : capiBad.length === 0
      ? `<span style="color:#15803D;font-weight:600">✓ All ${capiOk.length} studios firing Meta CAPI events.</span>`
      : `<span style="color:#DC2626;font-weight:700">🔴 ${capiBad.length} studio(s) silent on Meta CAPI:</span> ${capiBad.map((r) => studioLabel(String(r.studio_slug))).join(", ")} — check /ops`;

  const metaSyncAge = s.metaSync.last_ok
    ? Math.round((Date.now() - new Date(s.metaSync.last_ok).getTime()) / 3600000)
    : null;
  const metaSyncLine = metaSyncAge == null
    ? `<span style="color:#DC2626;font-weight:700">🔴 meta-insights-sync hasn't succeeded recently — cron may be broken.</span>`
    : metaSyncAge > 12
      ? `<span style="color:#D97706;font-weight:600">⚠ meta-insights-sync last succeeded ${metaSyncAge}h ago.</span>`
      : `<span style="color:#15803D">✓ meta-insights-sync running (${metaSyncAge}h ago).</span>`;

  // Duplicate-charge alert: if any studio collapsed raw rows into fewer unique
  // customers, surface it so a Bridget-Walsh-x3 situation hits Justin's inbox
  // instead of getting silently absorbed into the headline number.
  const totalDupes = Object.values(s.dupesByStudio).reduce((a, b) => a + b, 0);
  const dupeLine = totalDupes === 0 ? "" :
    `<div style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#92400E">
      <strong>⚠ ${totalDupes} duplicate charge${totalDupes === 1 ? "" : "s"} collapsed.</strong>
      ${Object.entries(s.dupesByStudio).map(([slug, n]) => `${studioLabel(slug)}: +${n}`).join(" · ")}.
      Same customer billed multiple times — check Stripe and refund the extras.
    </div>`;

  // Reconcile health line — surfaces the autonomous safety net so Justin
  // sees at a glance whether stripe-reconcile + dup-detector are doing their
  // job. Green = silent (nothing needed fixing). Yellow = caught misses last
  // 24h. Red = silent past its 30-min window (cron may be dead).
  const rh = s.reconcileHealth;
  const rec = s.reconcile;
  let reconcileLine = "";
  let reconcileBlock = "";
  if (rh && rec) {
    const status = (rh.status || "unknown") as string;
    const minSince = Number(rh.minutes_since_run || 0);
    const totalActions =
      Number(rec.created_trial_rows || 0) +
      Number(rec.welcomes_sent || 0) +
      Number(rec.mb_accounts_linked || 0) +
      Number(rec.capi_events_fired || 0);
    const statusColor = status === "healthy" ? "#15803D"
      : status === "lagging" ? "#D97706" : "#DC2626";
    const statusIcon = status === "healthy" ? "✓"
      : status === "lagging" ? "⚠" : "🔴";
    reconcileLine = `<span style="color:${statusColor};font-weight:600">${statusIcon} stripe-reconcile ${status}</span> · last run ${Math.round(minSince)}m ago · ${rh.runs_24h || 0} runs / ${rh.errors_24h || 0} errors in 24h`;

    if (totalActions > 0 || Number(rec.active_dup_groups || 0) > 0) {
      const actionItems: string[] = [];
      if (Number(rec.created_trial_rows || 0) > 0)
        actionItems.push(`${rec.created_trial_rows} trial row${rec.created_trial_rows === 1 ? "" : "s"} created`);
      if (Number(rec.welcomes_sent || 0) > 0)
        actionItems.push(`${rec.welcomes_sent} welcome${rec.welcomes_sent === 1 ? "" : "s"} fired`);
      if (Number(rec.mb_accounts_linked || 0) > 0)
        actionItems.push(`${rec.mb_accounts_linked} MB account${rec.mb_accounts_linked === 1 ? "" : "s"} linked`);
      if (Number(rec.capi_events_fired || 0) > 0)
        actionItems.push(`${rec.capi_events_fired} CAPI Purchase event${rec.capi_events_fired === 1 ? "" : "s"} backfilled`);

      const dupItems: string[] = [];
      if (Number(rec.active_dup_groups || 0) > 0) {
        const dupTone = "#92400E";
        dupItems.push(`<span style="color:${dupTone};font-weight:700">${rec.active_dup_groups} duplicate (location,email) group${rec.active_dup_groups === 1 ? "" : "s"} active</span>`);
        if (rec.newest_dup?.email) dupItems.push(`newest: ${rec.newest_dup.email}`);
      }
      const itemsHtml = [...actionItems, ...dupItems].map((it) => `<li style="margin:4px 0">${it}</li>`).join("");
      const tone = totalActions > 0 ? "#FFFBEB" : "#FEF3C7";
      const border = totalActions > 0 ? "#FCD34D" : "#F59E0B";
      reconcileBlock = `<div style="background:${tone};border:1px solid ${border};border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#92400E">
        <strong>🔧 Safety net activity in last 24h:</strong>
        <ul style="margin:6px 0 0;padding-left:20px">${itemsHtml}</ul>
      </div>`;
    }
  } else {
    reconcileLine = `<span style="color:#94A3B8">stripe-reconcile RPC not yet deployed.</span>`;
  }

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">
  <div style="background:#0F172A;color:#fff;padding:24px;border-radius:10px 10px 0 0">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;opacity:0.7">BBB Daily Ops · ${s.day.label}</div>
    <h1 style="margin:8px 0 0;font-size:24px;font-weight:800;letter-spacing:-0.02em">
      ${paidTotal} paid trial${paidTotal === 1 ? "" : "s"} yesterday${cac == null ? "" : ` · $${cac.toFixed(0)} blended CAC`}
    </h1>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #E2E8F0;border-top:0">
    <thead>
      <tr style="background:#F8FAFC;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.05em">
        <th style="padding:10px 6px;text-align:left">Studio</th>
        <th style="padding:10px 6px;text-align:right">Paid</th>
        <th style="padding:10px 6px;text-align:right">Spend</th>
        <th style="padding:10px 6px;text-align:right">CAC</th>
        <th style="padding:10px 6px;text-align:right">Imp · Clicks</th>
      </tr>
    </thead>
    <tbody>${studioRows}</tbody>
    <tfoot>
      <tr style="background:#F8FAFC;font-weight:800">
        <td style="padding:12px 6px">Total</td>
        <td style="padding:12px 6px;text-align:right">${paidTotal}</td>
        <td style="padding:12px 6px;text-align:right">$${spendTotal.toFixed(2)}</td>
        <td style="padding:12px 6px;text-align:right">${cac == null ? "—" : `$${cac.toFixed(0)}`}</td>
        <td style="padding:12px 6px"></td>
      </tr>
    </tfoot>
  </table>

  <div style="background:#fff;border:1px solid #E2E8F0;border-top:0;padding:16px 20px;font-size:13px;line-height:1.6">
    ${dupeLine}
    ${reconcileBlock}
    <div style="margin-bottom:6px"><strong style="color:#475569">Safety net:</strong> ${reconcileLine}</div>
    <div style="margin-bottom:6px"><strong style="color:#475569">Meta CAPI:</strong> ${capiLine}</div>
    <div><strong style="color:#475569">Background sync:</strong> ${metaSyncLine}</div>
  </div>

  <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 10px 10px;padding:16px 20px;font-size:12px;color:#64748B">
    Full picture: <a href="https://bbbmarketing.netlify.app/ops" style="color:#dc2626;text-decoration:none;font-weight:600">/ops</a> · Owner-facing dashboard: <a href="https://bbbmarketing.netlify.app" style="color:#dc2626;text-decoration:none">bbbmarketing.netlify.app</a><br>
    To stop these: remove <code>justin_daily_digest</code> from BBB_SEND_PATHS_ENABLED.
  </div>
</div>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const body = req.method === "POST"
    ? (await req.json().catch(() => ({}))) as { dry_run?: boolean; for_date?: string }
    : {};

  if (!isSendPathEnabled() && !body.dry_run) {
    return json({
      ok: false,
      skipped: true,
      reason: `send path "${SEND_PATH}" not in BBB_SEND_PATHS_ENABLED — add it to enable.`,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const stats = await gatherStats(supabase, body.for_date);
    const html = renderHtml(stats);
    const text = `BBB Daily Ops · ${stats.day.label}\n` +
                 Object.entries(stats.paidByStudio).map(([s, n]) => `${studioLabel(s)}: ${n} paid`).join("\n") +
                 `\n\nFull dashboard: https://bbbmarketing.netlify.app/ops`;

    if (body.dry_run) {
      return json({ ok: true, dry_run: true, stats, preview_html: html });
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) return json({ ok: false, error: "RESEND_API_KEY not set" }, 500);

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: DIGEST_FROM,
        to: [DIGEST_TO],
        subject: `BBB Ops · ${stats.day.label} · ${Object.values(stats.paidByStudio).reduce((a, b) => a + b, 0)} paid`,
        html,
        text,
        headers: { "X-Entity-Ref-ID": `digest-${stats.day.label}` }, // Resend idempotency
      }),
    });
    const respText = await r.text();
    if (!r.ok) return json({ ok: false, status: r.status, error: respText.slice(0, 400) }, 500);
    return json({ ok: true, sent_to: DIGEST_TO, day: stats.day.label, resend: respText.slice(0, 200) });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
