/**
 * capi-health — READ ONLY. One answer to "is CAPI actually set up and working,
 * at all four studios?"
 *
 * Built 2026-10-14. Everything here is read from what Meta and our own logs
 * actually recorded, not from whether the code looks right.
 *
 * IT CHECKS, PER STUDIO:
 *   1. CREDENTIALS   meta_accounts has a pixel_id and an access_token.
 *                    Without both, mariana-tek-capi-purchase-sync skips the
 *                    studio silently (skipped_no_meta_creds) and nothing fires.
 *   2. DELIVERY      capi_events rows in the window: ok vs failed, with the
 *                    actual Meta error text on failures.
 *   3. ATTRIBUTION   raw.action_source per event. "website" is the only value
 *                    Meta will credit back to a website ad set. The old code
 *                    sent "physical_store", which is why Bayside showed spend
 *                    with ~0 attributed purchases. Any physical_store rows in
 *                    the window mean the fix is NOT live for that studio.
 *   4. MATCH QUALITY how many trial_signups rows in the window carry fbp /
 *                    fbc / client_ip / UA. These are the browser signals that
 *                    tie a server-side purchase to the original ad click.
 *                    Low fbc coverage caps match quality no matter what the
 *                    function sends.
 *   5. COVERAGE      paid trials in the window vs Purchase events fired, so a
 *                    silent gap shows up as a number instead of a vibe.
 *
 * Body: { "days": 14 }       (default 14, max 120)
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn capi-health
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

const STUDIOS = ["astoria", "bayside", "fresh-meadows", "williamsburg"];

// locations has no slug column (see owner-sms-trace) — map by id.
const LOC: Record<string, string> = {
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": "astoria",
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "fresh-meadows",
  "80536b45-df0e-42d1-880c-e9301372e1cf": "williamsburg",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Math.max(Number(body.days ?? 14), 1), 120);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── 1. credentials ────────────────────────────────────────────────────────
  const { data: accts, error: aErr } = await sb
    .from("meta_accounts")
    .select("studio_slug,pixel_id,access_token,api_version");
  if (aErr) return json({ ok: false, error: `meta_accounts: ${aErr.message}` }, 502);

  const credBySlug: Record<string, any> = {};
  for (const a of accts || []) {
    const s = String((a as any).studio_slug);
    credBySlug[s] = {
      pixel_id: (a as any).pixel_id || null,
      has_access_token: !!(a as any).access_token,
      api_version: (a as any).api_version || null,
    };
  }

  // ── 2 + 3. what actually got sent ─────────────────────────────────────────
  const { data: evs, error: eErr } = await sb
    .from("capi_events")
    .select("studio_slug,event_name,event_id,ok,http_status,error,raw,visitor_meta,attempted_at")
    .gte("attempted_at", since)
    .order("attempted_at", { ascending: false })
    .limit(5000);
  if (eErr) return json({ ok: false, error: `capi_events: ${eErr.message}` }, 502);

  // ── 4. match signals on the source rows ───────────────────────────────────
  const { data: trials, error: tErr } = await sb
    .from("trial_signups")
    .select("id,name,email,location_id,payment_status,payment_date,created_at,source_category,utm_source,utm_medium,utm_campaign,utm_content,fbp,fbc,client_ip,client_user_agent")
    .or(`payment_date.gte.${since},created_at.gte.${since}`)
    .limit(3000);
  if (tErr) return json({ ok: false, error: `trial_signups: ${tErr.message}` }, 502);

  // ── 4b. RECLASSIFICATION PREVIEW ──────────────────────────────────────────
  // 2026-10-14: the action_source fix cannot be proven with a dry run, because
  // every sale in the window has already fired and the function skips those
  // before it computes anything. So prove it here instead: pull sales_channel
  // off each sale, apply the NEW rule, and show what each already-sent event
  // WOULD have been. Nothing is sent and nothing is rewritten — Meta dedupes on
  // event_id, so past events keep whatever they were sent as. This only tells
  // you what the next trial will get.
  const { data: saleRows } = await sb
    .from("mariana_tek_sales")
    .select("mt_sale_id,sales_channel")
    .gte("sale_date_time", since)
    .limit(5000);
  const channelBySaleId = new Map<string, string>();
  for (const s of saleRows || []) {
    channelBySaleId.set(String((s as any).mt_sale_id), String((s as any).sales_channel || "unknown"));
  }
  // Must mirror mariana-tek-capi-purchase-sync exactly.
  const newRule = (channel: string, hadSignals: boolean) => {
    if (channel === "desk") return "physical_store";
    if (channel === "web" || channel === "app" || channel === "self") return "website";
    return hadSignals ? "website" : "physical_store";
  };

  const perStudio: Record<string, any> = {};
  for (const slug of STUDIOS) {
    const cred = credBySlug[slug] || null;

    const mine = (evs || []).filter((e: any) => String(e.studio_slug) === slug);
    const okN = mine.filter((e: any) => e.ok === true).length;
    const badN = mine.length - okN;

    const byEvent: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    // 2026-10-14: a raw count of physical_store cannot tell you whether the fix
    // is live or whether you are looking at pre-fix rows. Track the window per
    // action_source, and cross it with event_name + the function that sent it,
    // so "still happening" is a date instead of an opinion.
    const srcWindow: Record<string, { first: string; last: string }> = {};
    const srcByEvent: Record<string, Record<string, number>> = {};
    const srcBySender: Record<string, Record<string, number>> = {};
    const errs: any[] = [];
    for (const e of mine) {
      const n = String((e as any).event_name || "(none)");
      byEvent[n] = (byEvent[n] || 0) + 1;
      const src = String((e as any).raw?.action_source || "(not recorded)");
      bySource[src] = (bySource[src] || 0) + 1;
      const at = String((e as any).attempted_at);
      const w = srcWindow[src];
      if (!w) srcWindow[src] = { first: at, last: at };
      else { if (at < w.first) w.first = at; if (at > w.last) w.last = at; }
      ((srcByEvent[src] ||= {})[n] = (srcByEvent[src][n] || 0) + 1);
      const sender = String((e as any).raw?.source || "(not recorded)");
      ((srcBySender[src] ||= {})[sender] = (srcBySender[src][sender] || 0) + 1);
      if ((e as any).ok !== true) {
        errs.push({
          at: (e as any).attempted_at,
          event: n,
          http: (e as any).http_status,
          error: String((e as any).error || "").slice(0, 300),
        });
      }
    }

    const myTrials = (trials || []).filter((t: any) => LOC[t.location_id] === slug);
    const paid = myTrials.filter((t: any) => !!t.payment_date);
    const cov = (f: string) => paid.filter((t: any) => !!t[f]).length;

    const purchases = byEvent["Purchase"] || 0;
    const attributable = bySource["website"] || 0;

    perStudio[slug] = {
      credentials: cred
        ? { ...cred, ready: !!cred.pixel_id && cred.has_access_token }
        : { ready: false, note: "NO meta_accounts ROW — this studio fires nothing" },
      events: {
        total: mine.length,
        ok: okN,
        failed: badN,
        by_event_name: byEvent,
        last_event_at: mine.length ? (mine[0] as any).attempted_at : null,
      },
      attribution: {
        by_action_source: bySource,
        action_source_window: srcWindow,
        action_source_by_event: srcByEvent,
        action_source_by_sending_function: srcBySender,
        attributable_website: attributable,
        non_attributable: mine.length - attributable,
        verdict:
          mine.length === 0
            ? "no events in window — cannot confirm"
            : attributable === mine.length
            ? "GOOD — every event sent as action_source:website"
            : (bySource["physical_store"] || 0) > 0
            ? "BAD — physical_store events present, Meta will not credit these to the ad sets"
            : "MIXED — check by_action_source",
      },
      match_quality: {
        paid_trials_in_window: paid.length,
        with_fbc_ad_click: cov("fbc"),
        with_fbp_browser_id: cov("fbp"),
        with_client_ip: cov("client_ip"),
        with_user_agent: cov("client_user_agent"),
        // WHICH CHECKOUT PATH produced each paid trial, and how many of each
        // carried fbc. mt-card-checkout / create-trial-checkout are OUR pages
        // and do capture fbc. Rows created by mt-orders-sync from a Mariana Tek
        // widget or front-desk sale never had a browser attached, so they can
        // never carry fbc — no code change fixes those. This splits the two.
        by_source_category: (() => {
          const o: Record<string, { trials: number; with_fbc: number }> = {};
          for (const t of paid) {
            const k = String((t as any).source_category || "(null)");
            o[k] = o[k] || { trials: 0, with_fbc: 0 };
            o[k].trials++;
            if ((t as any).fbc) o[k].with_fbc++;
          }
          return o;
        })(),
        note:
          "fbc is the ad-click id and the strongest signal. A paid trial with no fbc can still " +
          "be matched on hashed email/phone, just more weakly. MT-widget purchases often have no " +
          "fbc because the click never passed through our own checkout.",
      },
      coverage: {
        paid_trials_in_window: paid.length,
        purchase_events_fired: purchases,
        gap: paid.length - purchases,
        note:
          "gap > 0 is not automatically a fault: a trial paid just before the window, or paid at " +
          "the desk, legitimately has no Purchase event inside it. A persistent large gap is.",
      },
      failures: errs.slice(0, 10),
      // SECOND SOURCE OF TRUTH for "did this come from an ad".
      // trial_signups.utm_* is only populated when the UTMs survive from the
      // landing page to checkout. They often don't: the Mariana Tek buy widget
      // runs in its own context, so the row comes back bare even for a real ad
      // click. capi_events PageView rows carry visitor_meta captured at LANDING
      // time (utm_content, fbc, ad_click_id, page_url), which is upstream of
      // that loss. So: list the ad-tagged landings in the 3h before the newest
      // paid trial. Tagged traffic landing right before the sale is corroboration,
      // not proof — we cannot tie an anonymous landing to a named buyer.
      ad_traffic_before_newest_trial: (() => {
        const newest = [...paid].sort((a: any, b: any) =>
          String(b.payment_date).localeCompare(String(a.payment_date)))[0];
        if (!newest?.payment_date) return null;
        const t1 = new Date(newest.payment_date).getTime();
        const t0 = t1 - 3 * 3600 * 1000;
        const landings = mine
          .filter((e: any) => e.event_name === "PageView" && e.visitor_meta)
          .filter((e: any) => {
            const t = new Date(e.attempted_at).getTime();
            return t >= t0 && t <= t1;
          })
          .map((e: any) => {
            const m = e.visitor_meta || {};
            return {
              at: e.attempted_at,
              utm_content: m.utm_content ?? null,
              utm_campaign: m.utm_campaign ?? null,
              utm_source: m.utm_source ?? null,
              has_fbc: !!m.fbc,
              has_ad_click_id: !!m.ad_click_id,
              page_url: m.page_url ?? null,
            };
          });
        const tagged = landings.filter((l) => l.utm_content || l.has_fbc || l.has_ad_click_id);
        const byAd: Record<string, number> = {};
        for (const l of tagged) {
          const k = String(l.utm_content || "(tagged, no per-ad content)");
          byAd[k] = (byAd[k] || 0) + 1;
        }
        return {
          newest_trial: newest.name,
          newest_trial_paid_at: newest.payment_date,
          window: `${new Date(t0).toISOString()} .. ${newest.payment_date}`,
          landings_total: landings.length,
          landings_from_ads: tagged.length,
          by_ad: byAd,
          sample: tagged.slice(0, 10),
        };
      })(),
      // "Did this trial come from the ads?" — the UTMs carried on the row,
      // newest first. utm_content is the per-ad tag baked into each creative's
      // destination link (AST-REEL-01-gym etc), so it names the exact ad.
      // Empty utm_source means the buyer did not arrive on a tagged ad link in
      // the session that produced the row: organic, direct, walk-in, or an ad
      // click whose session was lost before checkout.
      recent_paid_trials: [...paid]
        .sort((a: any, b: any) => String(b.payment_date).localeCompare(String(a.payment_date)))
        .slice(0, 8)
        .map((t: any) => ({
          name: t.name,
          paid_at: t.payment_date,
          source_category: t.source_category,
          utm_source: t.utm_source || null,
          utm_campaign: t.utm_campaign || null,
          utm_content: t.utm_content || null,
          has_fbc_ad_click: !!t.fbc,
          verdict: t.utm_content
            ? `ad: ${t.utm_content}`
            : t.utm_source
            ? `tagged ${t.utm_source}/${t.utm_medium || "?"} but no per-ad tag`
            : t.fbc
            ? "no UTMs, but carries an fbc ad-click id — came from an ad"
            : "no ad signal on the row",
        })),
      reclassification_preview: (() => {
        const chanCount: Record<string, number> = {};
        const flips: Record<string, number> = {};
        let wouldBeWebsite = 0;
        let unknownChannel = 0;
        for (const e of mine) {
          const eid = String((e as any).event_id || "");
          if (!eid.startsWith("mt_")) continue;
          const was = String((e as any).raw?.action_source || "(not recorded)");
          if (was === "(not recorded)") continue; // PageViews, different sender
          const ch = channelBySaleId.get(eid.slice(3)) || "unknown";
          chanCount[ch] = (chanCount[ch] || 0) + 1;
          if (ch === "unknown") unknownChannel++;
          const now = newRule(ch, was === "website");
          if (now === "website") wouldBeWebsite++;
          const k = `${was} -> ${now}`;
          flips[k] = (flips[k] || 0) + 1;
        }
        return {
          sales_channel_of_sent_events: chanCount,
          transitions: flips,
          attributable_now: (bySource["website"] || 0),
          attributable_under_new_rule: wouldBeWebsite,
          sales_with_unknown_channel: unknownChannel,
          note:
            "Past events are NOT resent — Meta dedupes on event_id, so these keep what they were " +
            "sent as. This is a preview of what the next trial at this studio will be tagged. " +
            "A large 'unknown' channel count would mean sales_channel is not being derived and the " +
            "new rule falls back to the old signal check.",
        };
      })(),
    };
  }

  const notReady = STUDIOS.filter((s) => !perStudio[s].credentials.ready);
  const anyPhysical = STUDIOS.filter(
    (s) => (perStudio[s].attribution.by_action_source?.physical_store || 0) > 0,
  );
  const anyFailed = STUDIOS.filter((s) => perStudio[s].events.failed > 0);

  return json({
    ok: true,
    read_only: true,
    window_days: days,
    since,
    headline: {
      all_four_have_credentials: notReady.length === 0,
      studios_missing_credentials: notReady,
      studios_still_sending_physical_store: anyPhysical,
      studios_with_failed_sends: anyFailed,
      verdict:
        notReady.length === 0 && anyPhysical.length === 0 && anyFailed.length === 0
          ? "CAPI is configured and delivering at all four studios, all events attributable."
          : "Needs attention — see the lists above.",
    },
    studios: perStudio,
  });
});
