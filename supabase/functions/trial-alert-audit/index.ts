/**
 * trial-alert-audit — READ ONLY. Did the studio actually get an email for each
 * paid trial?
 *
 * Built 2026-10-13. Chris says he is not seeing trial emails for Astoria and
 * Williamsburg. The machinery exists (manual-welcome-batch sends a studio alert,
 * mt-orders-sync calls it with send_studio_email:true, and EXTRA_STUDIO_NOTIFY
 * has cc'd chris@ and steve@ since 2026-09-15), so the question is whether the
 * sends are happening at all or whether they are happening and not being seen.
 *
 * This takes every paid trial in the window and checks email_log for a matching
 * `manual_studio_alert` row. Writes nothing.
 *
 * KNOWN LOG GAP, stated so the output is not over-read: manual-welcome-batch
 * logs only `to_addrs: [studioMail]` on that insert, dropping the cc'd owner
 * addresses. So a logged row proves the email was SENT and names the studio
 * mailbox; it cannot prove chris@ was on it. The code path always includes him,
 * so sent means he was a recipient.
 *
 * Body: { "days": 14, "studios": ["astoria","williamsburg"] }  // both optional
 *
 * Auth: x-bbb-secret. Deploy: bbb deploy-fn trial-alert-audit
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

const NON_TRIAL = new Set([
  "direct_membership", "mb_direct", "walk_in", "in_person", "walk-in",
  "mt_direct_member", "legacy_archived",
]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Math.max(Number(body.days ?? 14), 1), 120);
  const want: string[] = Array.isArray(body.studios) && body.studios.length
    ? body.studios.map((s: any) => String(s).toLowerCase())
    : ["astoria", "williamsburg"];

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Locations, so we can map id -> slug
  const { data: locs } = await sb.from("locations").select("id,name,slug");
  const slugOf: Record<string, string> = {};
  const nameOf: Record<string, string> = {};
  for (const l of locs || []) {
    const slug = (l as any).slug || String((l as any).name || "").toLowerCase().replace(/\s+/g, "-");
    slugOf[(l as any).id] = slug;
    nameOf[(l as any).id] = (l as any).name;
  }

  // Paid trials in the window.
  // 2026-10-13: the first version filtered payment_status = 'completed' and got
  // zero rows back while email_log clearly held 184 studio alerts. Don't assume
  // the status vocabulary — pull the window and report what the values actually
  // are, so a wrong guess shows up as data instead of as an empty result.
  const { data: trials, error: tErr } = await sb
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_status,payment_date,source_category,created_at")
    .or(`payment_date.gte.${since},created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (tErr) return json({ ok: false, error: `trial_signups: ${tErr.message}` }, 502);

  const statusSeen: Record<string, number> = {};
  const sourceSeen: Record<string, number> = {};
  const slugSeen: Record<string, number> = {};
  for (const t of trials || []) {
    statusSeen[String((t as any).payment_status)] = (statusSeen[String((t as any).payment_status)] || 0) + 1;
    sourceSeen[String((t as any).source_category)] = (sourceSeen[String((t as any).source_category)] || 0) + 1;
    const sl = slugOf[(t as any).location_id] || `(unmapped:${(t as any).location_id})`;
    slugSeen[sl] = (slugSeen[sl] || 0) + 1;
  }

  const rows = (trials || []).filter((t: any) => {
    if (NON_TRIAL.has(String(t.source_category || ""))) return false;
    if (!t.payment_date) return false;
    const slug = slugOf[t.location_id] || "";
    return want.includes(slug);
  });

  // Every studio-alert email logged in the window
  const { data: logs, error: lErr } = await sb
    .from("email_log")
    .select("trial_signup_id,send_path,to_addrs,subject,created_at,resend_id,event_type")
    .gte("created_at", since)
    .limit(5000);
  if (lErr) return json({ ok: false, error: `email_log: ${lErr.message}` }, 502);

  const alertByTrial = new Map<string, any>();
  const pathCounts: Record<string, number> = {};
  for (const l of logs || []) {
    const p = String((l as any).send_path || "(none)");
    pathCounts[p] = (pathCounts[p] || 0) + 1;
    if (p === "manual_studio_alert" && (l as any).trial_signup_id) {
      alertByTrial.set(String((l as any).trial_signup_id), l);
    }
  }

  const detail = rows.map((t: any) => {
    const hit = alertByTrial.get(String(t.id));
    return {
      trial_id: t.id,
      name: t.name,
      studio: nameOf[t.location_id] || slugOf[t.location_id] || "(unknown)",
      paid_at: t.payment_date,
      alert_email_sent: !!hit,
      logged_to: hit ? (hit as any).to_addrs : null,
      logged_at: hit ? (hit as any).created_at : null,
      resend_id: hit ? (hit as any).resend_id : null,
    };
  });

  const byStudio: Record<string, { trials: number; emailed: number; missing: number }> = {};
  for (const d of detail) {
    const k = d.studio;
    byStudio[k] = byStudio[k] || { trials: 0, emailed: 0, missing: 0 };
    byStudio[k].trials++;
    if (d.alert_email_sent) byStudio[k].emailed++; else byStudio[k].missing++;
  }

  const emailed = detail.filter((d) => d.alert_email_sent).length;

  return json({
    ok: true,
    read_only: true,
    window_days: days,
    since,
    studios_checked: want,
    summary: {
      paid_trials: detail.length,
      alert_email_sent: emailed,
      no_alert_email: detail.length - emailed,
      by_studio: byStudio,
    },
    how_to_read:
      "alert_email_sent true means manual-welcome-batch sent the studio alert and logged it. " +
      "logged_to shows only the studio mailbox because that insert drops the cc'd owner addresses, " +
      "but the code path always cc's chris@ and steve@ for Astoria and Williamsburg, so sent means he was a recipient. " +
      "If alert_email_sent is false across the board, the alert is not firing and that is the bug. " +
      "If it is true across the board, the mail is being sent and the problem is delivery or nobody reading the inbox.",
    all_send_paths_seen_in_window: pathCounts,
    // What the data actually looks like, so a wrong filter shows up as data.
    diagnostics: {
      trial_signups_rows_in_window: (trials || []).length,
      payment_status_values: statusSeen,
      source_category_values: sourceSeen,
      location_slugs_seen: slugSeen,
    },
    // Straight from email_log: who did the studio alerts actually go to?
    //
    // 2026-10-13: the first version counted ROWS per recipient and reported them
    // as if they were emails. They are not. Two writers feed this table:
    //   manual-welcome-batch  one row at send time, to_addrs = [studio mailbox]
    //   resend-webhook        one row PER RECIPIENT PER EVENT (delivered,
    //                         bounced, opened, complained...)
    // So a raw row count mixes sends with delivery events and is meaningless.
    // Count DISTINCT resend_id per recipient instead, and split by event type,
    // which is what actually answers "did this person get the mail".
    studio_alert_recipients: (() => {
      const uniq: Record<string, Set<string>> = {};          // recipient -> distinct resend_id
      const byEvent: Record<string, Record<string, number>> = {}; // recipient -> event -> n
      const bad: any[] = [];
      for (const l of logs || []) {
        if (String((l as any).send_path) !== "manual_studio_alert") continue;
        const ev = String((l as any).event_type || "unknown");
        const rid = String((l as any).resend_id || `norid:${(l as any).created_at}`);
        for (const addr of ((l as any).to_addrs || [])) {
          const a = String(addr).toLowerCase();
          (uniq[a] ||= new Set()).add(rid);
          ((byEvent[a] ||= {})[ev] = (byEvent[a][ev] || 0) + 1);
          if (/bounce|complain|fail|reject|delivery_delay/i.test(ev)) {
            bad.push({ at: (l as any).created_at, to: a, event: ev, subject: (l as any).subject });
          }
        }
      }
      return {
        distinct_emails_per_recipient: Object.fromEntries(
          Object.entries(uniq).map(([k, v]) => [k, v.size]).sort((a: any, b: any) => b[1] - a[1]),
        ),
        events_per_recipient: byEvent,
        problem_events: bad,
      };
    })(),
    trials: detail,
  });
});
