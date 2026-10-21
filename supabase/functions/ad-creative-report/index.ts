/**
 * ad-creative-report — the per-ad numbers a creative partner actually needs.
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing, sends nothing, changes no ad.
 *
 * Built 2026-10-21 for Christian's request, verbatim:
 *   1. Impressions, reach and CTR
 *   2. 3-second video plays and ThruPlay  (does the hook work)
 *   3. Age and gender breakdown
 *   4. Daily $49 trial sign-ups from Mariana Tek, plus daily spend per ad,
 *      "since Meta didn't credit purchases until Oct 14"
 *
 * He is right about point 4 and it is the reason this function exists. Meta's
 * own purchase column is wrong for this window: our CAPI sent purchases with
 * action_source=physical_store until 2026-10-14, so Meta never credited them
 * to an ad set. Any ROAS or cost-per-purchase in Ads Manager for this period
 * understates reality. So trials here come from Mariana Tek, not from Meta,
 * and they are reported DAILY alongside daily spend so the two can be lined up
 * by eye without pretending we can attribute a specific trial to a specific ad.
 *
 * WHAT CANNOT BE DONE, stated plainly rather than fudged: trials are per
 * STUDIO per day, not per ad. Every Bayside click for the last 90 days carried
 * the same utm_content=bayside, so no trial can be tied to one creative. The
 * daily columns let you see a spike the day after a creative changed; they are
 * not attribution.
 *
 * REACH is deduplicated people and is NOT additive — summing reach across ads
 * or across days double-counts anyone who saw two ads. It is reported per ad
 * for the whole window only, never totalled.
 *
 * Body: { "studios": ["bayside","fresh-meadows"],   // default these two
 *         "days": 90,
 *         "include_paused": true,
 *         "demographics": true }                    // age+gender costs 1 extra call per ad
 *
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn ad-creative-report
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const FB = "v19.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIOS: Record<string, { name: string; adAccount: string; tokenEnv: string; uuid: string }> = {
  "astoria":       { name: "Astoria",       adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA",       uuid: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45" },
  "bayside":       { name: "Bayside",       adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE",       uuid: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" },
  "fresh-meadows": { name: "Fresh Meadows", adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS", uuid: "6bbbe077-bcc6-4d9d-a10b-7605c1484752" },
  "williamsburg":  { name: "Williamsburg",  adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG",  uuid: "80536b45-df0e-42d1-880c-e9301372e1cf" },
};

// Straight memberships and desk/legacy rows are not $49 trials.
const NON_TRIAL = new Set(["direct_membership","mb_direct","walk_in","in_person",
  "walk-in","mt_direct_member","legacy_archived"]);

async function fbGet(path: string, token: string, params: Record<string,string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body?.error ?? body).slice(0,220)}`);
  return body;
}
/** Meta returns these as [{action_type, value}] — pull one out. */
const act = (arr: any[] | undefined, type: string) =>
  (arr ?? []).reduce((n,a) => a.action_type === type ? n + (Number(a.value)||0) : n, 0);
const num = (v: unknown) => Number(v) || 0;

/** Day in America/New_York (UTC-4 during EDT) as YYYY-MM-DD. */
const etDay = (iso: string) =>
  new Date(new Date(iso).getTime() - 4*3600*1000).toISOString().slice(0,10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok:false, error:"POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok:false, error:"unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const slugs: string[] = Array.isArray(body.studios) && body.studios.length
    ? body.studios.filter((s: string) => STUDIOS[s]) : ["bayside","fresh-meadows"];
  const days = Math.min(Math.max(Number(body.days ?? 90), 1), 365);
  const includePaused = body.include_paused !== false;
  const wantDemo = body.demographics !== false;

  const until = new Date(Date.now() - 4*3600*1000).toISOString().slice(0,10);
  const since = new Date(Date.now() - 4*3600*1000 - (days-1)*86400000).toISOString().slice(0,10);
  const timeRange = JSON.stringify({ since, until });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── Mariana Tek trials per studio per ET day (NOT from Meta) ─────────────
  const trialsByStudioDay: Record<string, Record<string, number>> = {};
  {
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("trial_signups")
        .select("location_id,payment_date,source_category,deleted_at")
        .gte("payment_date", `${since}T04:00:00Z`)
        .order("payment_date", { ascending: true })
        .range(from, from + 999);
      if (error) return json({ ok:false, error:`trial_signups: ${error.message}` }, 502);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const uuidToSlug: Record<string,string> = {};
    for (const [slug,s] of Object.entries(STUDIOS)) uuidToSlug[s.uuid] = slug;
    for (const r of rows) {
      if (r.deleted_at) continue;
      if (NON_TRIAL.has(String(r.source_category || ""))) continue;
      const slug = uuidToSlug[r.location_id]; if (!slug || !r.payment_date) continue;
      const d = etDay(r.payment_date);
      (trialsByStudioDay[slug] ||= {})[d] = (trialsByStudioDay[slug]?.[d] ?? 0) + 1;
    }
  }

  const out: any[] = [];
  for (const slug of slugs) {
    const s = STUDIOS[slug];
    const token = Deno.env.get(s.tokenEnv);
    if (!token) { out.push({ studio: slug, error: `missing ${s.tokenEnv}` }); continue; }

    try {
      // every ad in the account, with window totals incl. video + reach
      const adsRes = await fbGet(`${s.adAccount}/ads`, token, {
        limit: "200",
        fields: [
          "id,name,effective_status,created_time",
          `insights.time_range(${timeRange}){spend,impressions,reach,frequency,clicks,ctr,cpm,`+
          `actions,video_play_actions,video_thruplay_watched_actions,`+
          `video_p25_watched_actions,video_p50_watched_actions,video_p100_watched_actions}`,
        ].join(","),
      });

      const ads: any[] = [];
      for (const a of (adsRes.data ?? []) as any[]) {
        const ins = a.insights?.data?.[0];
        if (!ins) continue;                                   // never served in window
        const status = a.effective_status || "UNKNOWN";
        if (!includePaused && status !== "ACTIVE") continue;

        const impressions = num(ins.impressions);
        // 2026-10-21 CORRECTION. The first version of this function read
        // video_play_actions and called it "3-second plays". It is not. It
        // counts video STARTS, and on an autoplay placement that fires on
        // nearly every impression — Bayside Video 4 returned 140,968 starts
        // against 162,898 impressions, an 86% "hook rate" that would have told
        // Christian the opening was extraordinary when it only meant autoplay.
        // The real 3-second metric is action_type video_view inside `actions`.
        const plays    = act(ins.video_play_actions, "video_view");   // starts
        const views3s  = act(ins.actions,            "video_view");   // true 3-second views
        const thruplay = act(ins.video_thruplay_watched_actions, "video_view");
        const p25      = act(ins.video_p25_watched_actions,  "video_view");
        const p50      = act(ins.video_p50_watched_actions,  "video_view");
        const p100     = act(ins.video_p100_watched_actions, "video_view");

        const ad: any = {
          ad_id: a.id, ad_name: a.name, status, created: a.created_time?.slice(0,10) ?? null,
          spend: +num(ins.spend).toFixed(2),
          impressions,
          reach: num(ins.reach),
          frequency: +num(ins.frequency).toFixed(2),
          clicks: num(ins.clicks),
          ctr_pct: +num(ins.ctr).toFixed(2),
          cpm: +num(ins.cpm).toFixed(2),
          cost_per_click: num(ins.clicks) ? +(num(ins.spend)/num(ins.clicks)).toFixed(2) : null,
          video_plays_started: plays,
          video_3s_views: views3s,
          thruplay,
          video_25pct: p25, video_50pct: p50, video_100pct: p100,
          // The hook question, which is what he actually asked for: of the
          // people who SAW it, how many stayed 3 seconds, and of those, how
          // many reached ThruPlay. Measured off 3-second views, never off
          // autoplay starts.
          hook_rate_pct: impressions ? +(views3s/impressions*100).toFixed(2) : null,
          hold_rate_pct: views3s ? +(thruplay/views3s*100).toFixed(2) : null,
          completion_pct: views3s ? +(p100/views3s*100).toFixed(2) : null,
        };

        if (wantDemo) {
          try {
            const d = await fbGet(`${a.id}/insights`, token, {
              time_range: timeRange, breakdowns: "age,gender",
              fields: "impressions,reach,clicks,ctr,spend", limit: "100",
            });
            ad.demographics = ((d.data ?? []) as any[])
              .map((r) => ({ age: r.age, gender: r.gender, impressions: num(r.impressions),
                             reach: num(r.reach), clicks: num(r.clicks),
                             ctr_pct: +num(r.ctr).toFixed(2), spend: +num(r.spend).toFixed(2) }))
              .filter((r) => r.impressions > 0)
              .sort((x,y) => y.impressions - x.impressions);
          } catch (e) { ad.demographics_error = String((e as Error).message).slice(0,160); }
        }

        // daily spend for this ad, to sit beside the daily trial count
        try {
          const dd = await fbGet(`${a.id}/insights`, token, {
            time_range: timeRange, time_increment: "1",
            fields: "spend,impressions,clicks", limit: "400",
          });
          ad.daily = ((dd.data ?? []) as any[]).map((r) => ({
            date: r.date_start, spend: +num(r.spend).toFixed(2),
            impressions: num(r.impressions), clicks: num(r.clicks),
          })).filter((r) => r.spend > 0 || r.impressions > 0);
        } catch (e) { ad.daily_error = String((e as Error).message).slice(0,160); }

        ads.push(ad);
      }
      ads.sort((x,y) => y.spend - x.spend);

      const td = trialsByStudioDay[slug] ?? {};
      out.push({
        studio: slug, name: s.name, window: { since, until, days },
        ads_returned: ads.length,
        trials_total_mariana_tek: Object.values(td).reduce((a,b)=>a+b,0),
        trials_by_day: Object.fromEntries(Object.entries(td).sort()),
        ads,
      });
    } catch (e) {
      out.push({ studio: slug, error: String((e as Error).message).slice(0,300) });
    }
  }

  return json({
    ok: true, read_only: true, window: { since, until, days },
    how_to_read: {
      trials: "Trials come from Mariana Tek, not Meta. Meta's purchase column is wrong for this " +
              "window: CAPI sent purchases as action_source=physical_store until 2026-10-14, so Meta " +
              "never credited them. Do not use Ads Manager purchases for this period.",
      attribution: "trials_by_day is per STUDIO per day, not per ad. Every Bayside click in this " +
                   "window carried the same utm_content=bayside, so no trial can be tied to one " +
                   "creative. Use the daily columns to spot a change after a creative swap, not as attribution.",
      reach: "Reach is deduplicated people and is NOT additive. Do not sum it across ads or days.",
      video: "video_plays_started counts STARTS and is near-useless on autoplay placements — it fires " +
             "on most impressions. The honest hook metric is video_3s_views. " +
             "hook_rate = 3-second views / impressions (did the opening stop them). " +
             "hold_rate = ThruPlay / 3-second views (did they stay). " +
             "completion_pct = 100% watched / 3-second views.",
    },
    studios: out,
  });
});
