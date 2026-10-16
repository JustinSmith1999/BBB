/**
 * lead-source-report — WHERE DID EVERY LEAD AND TRIAL COME FROM. One call.
 * ═══════════════════════════════════════════════════════════════════════════
 * READ ONLY. Writes nothing, sends nothing, changes no budget or status.
 *
 * WHY THIS EXISTS (2026-10-15, Justin: "there is NO EXCUSE for you to not be
 * able to tell me where all leads are coming from at any time").
 *
 * The answer was always available. It just lived in three different places,
 * one of which was broken, and whoever asked got whichever one got picked:
 *
 *   A. META'S OWN NUMBERS   per-ad spend + attributed purchases from the Graph
 *      API. Worked the whole time. This is what finally showed that Reel 02
 *      Coach produced 2 purchases on $6.38 while Astoria v2 produced 0 on $277.
 *
 *   B. AD-TAGGED LANDINGS   capi_events.visitor_meta, captured at landing time
 *      on /trial/<studio>: utm_content (names the exact ad), fbc, ad_click_id.
 *      Worked the whole time. Upstream of every loss below.
 *
 *   C. THE TRIAL ROW        trial_signups.utm_* / fbc — the only source that
 *      names a PERSON and their ad together. Was returning nulls on every row
 *      until 2026-10-15 because of two silent bugs: getUtmParams() returned
 *      camelCase keys while capture-lead read snake_case, and fbc lived only
 *      in a cookie that in-app browsers drop. Both fixed; rows created before
 *      that fix are permanently bare.
 *
 * Each answers a different question and NONE of them is "the" source:
 *   A says which ad Meta credits, with its own view-through attribution.
 *   B says which ad the traffic came from, but the landings are anonymous.
 *   C says which ad a NAMED person came from — the only one that joins to a
 *     human — and is blank for everything before 2026-10-15.
 *
 * So this reports all three side by side and says plainly where they agree and
 * where they cannot. If they disagree, that is information, not a bug: B and C
 * are our own click data, A includes view-through conversions we never see.
 *
 * Body: { "days": 7, "studio": "astoria" }   // both optional; default all, 7d
 * Auth: x-bbb-secret.  Deploy: bbb deploy-fn lead-source-report
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const FB_VERSION = "v19.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIOS = [
  { slug: "astoria",       name: "Astoria",       adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA",       uuid: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45" },
  { slug: "bayside",       name: "Bayside",       adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE",       uuid: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" },
  { slug: "fresh-meadows", name: "Fresh Meadows", adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS", uuid: "6bbbe077-bcc6-4d9d-a10b-7605c1484752" },
  { slug: "williamsburg",  name: "Williamsburg",  adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG",  uuid: "80536b45-df0e-42d1-880c-e9301372e1cf" },
];

// Rows that are not trials at all — straight memberships, desk sales, imports.
// Counted separately rather than hidden, because "where did the leads come
// from" should not quietly include people who were never leads.
const NON_TRIAL = new Set([
  "direct_membership", "mb_direct", "walk_in", "in_person", "walk-in",
  "mt_direct_member", "legacy_archived",
]);

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const sumActions = (actions: any[] | undefined, types: string[]) =>
  (actions ?? []).reduce((n, a) => (types.includes(a.action_type) ? n + (Number(a.value) || 0) : n), 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Math.max(Number(body.days ?? 7), 1), 90);
  const only = body.studio ? String(body.studio).toLowerCase() : null;
  const studios = only ? STUDIOS.filter((s) => s.slug === only) : STUDIOS;
  if (!studios.length) return json({ ok: false, error: `unknown studio: ${only}` }, 400);

  const sinceMs = Date.now() - days * 86400000;
  const since = new Date(sinceMs).toISOString();
  const sinceDay = since.slice(0, 10);
  const untilDay = new Date().toISOString().slice(0, 10);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── C. the named rows ─────────────────────────────────────────────────────
  const { data: trials, error: tErr } = await sb
    .from("trial_signups")
    .select("id,name,email,location_id,payment_date,created_at,source_category,utm_source,utm_medium,utm_campaign,utm_content,fbc,fbp")
    .or(`payment_date.gte.${since},created_at.gte.${since}`)
    .limit(3000);
  if (tErr) return json({ ok: false, error: `trial_signups: ${tErr.message}` }, 502);

  // ── B. the ad-tagged landings ─────────────────────────────────────────────
  const { data: landings, error: lErr } = await sb
    .from("capi_events")
    .select("studio_slug,event_name,visitor_meta,attempted_at")
    .eq("event_name", "PageView")
    .gte("attempted_at", since)
    .limit(10000);
  if (lErr) return json({ ok: false, error: `capi_events: ${lErr.message}` }, 502);

  const out: any[] = [];

  for (const s of studios) {
    // ── A. Meta's own per-ad numbers ───────────────────────────────────────
    const token = Deno.env.get(s.tokenEnv);
    let metaAds: any[] = [];
    let metaError: string | null = null;
    if (!token) {
      metaError = `missing env var ${s.tokenEnv}`;
    } else {
      try {
        const tr = JSON.stringify({ since: sinceDay, until: untilDay });
        const res = await fbGet(`${s.adAccount}/ads`, token, {
          fields:
            `id,name,effective_status,campaign{name},` +
            `insights.time_range(${tr}){spend,impressions,clicks,actions}`,
          limit: "200",
        });
        metaAds = ((res.data || []) as any[])
          .map((a) => {
            const i = a.insights?.data?.[0];
            if (!i) return null;
            const spend = Number(i.spend) || 0;
            const purchases = sumActions(i.actions, ["purchase", "offsite_conversion.fb_pixel_purchase"]);
            const leads = sumActions(i.actions, ["lead", "offsite_conversion.fb_pixel_lead"]);
            if (!spend && !purchases && !leads) return null;
            return {
              ad: a.name,
              campaign: a.campaign?.name ?? null,
              status: a.effective_status,
              spend: +spend.toFixed(2),
              clicks: Number(i.clicks) || 0,
              purchases,
              leads,
              cost_per_purchase: purchases > 0 ? +(spend / purchases).toFixed(2) : null,
            };
          })
          .filter(Boolean)
          .sort((x: any, y: any) => y.purchases - x.purchases || y.spend - x.spend);
      } catch (e) {
        metaError = String((e as Error).message || e).slice(0, 300);
      }
    }

    // ── B. landings on this studio's trial page, by ad ─────────────────────
    const mine = (landings || []).filter((e: any) => e.studio_slug === s.slug && e.visitor_meta);
    const byAd: Record<string, number> = {};
    const byPaidAd: Record<string, number> = {};
    const byOrganicTagged: Record<string, number> = {};
    let taggedLandings = 0;
    let paidLandings = 0;
    let organicTagged = 0;

    // 2026-10-15 — PAID IS NOT THE SAME AS TAGGED, and the first version of
    // this report conflated them. Bayside read "21 from ads" today when 3 of
    // those were the Instagram bio link: utm_source=instagram&utm_medium=social,
    // which is organic social we tagged ourselves, not something we paid for.
    // That inflates paid traffic at every studio and makes a trial look
    // ad-driven when it may have come from a free link in the bio.
    //
    // Paid = utm_medium 'cpc'/'paid'/'ppc', or an actual ad click id (fbc /
    // ad_click_id only exist on a real ad click). Everything else that carries
    // a tag is organic-tagged and gets counted on its own line.
    // 2026-10-15, second pass — the first version of this said "any visit
    // carrying an fbc is paid". Wrong, and the deploy proved it within minutes:
    // Bayside showed 2 'bio' landings under by_paid_ad. _fbc is a 90-DAY
    // COOKIE. Someone who clicked an ad last week and comes back today through
    // the Instagram bio link still carries it, so fbc says "this person clicked
    // an ad at some point", never "this visit was paid".
    //
    // utm_medium describes THIS visit and wins whenever it is present. The
    // click id is only a fallback for visits with no medium at all (a bare
    // fbclid link with no UTMs, which only an ad click produces).
    const PAID_MEDIA = new Set(["cpc", "paid", "ppc", "paidsocial", "paid_social"]);
    const isPaid = (m: any) => {
      const med = String(m.utm_medium || "").toLowerCase().trim();
      if (med) return PAID_MEDIA.has(med);     // medium present: it decides, full stop
      return !!(m.fbc || m.ad_click_id);       // no medium at all: fall back to the click id
    };

    for (const e of mine) {
      const m = (e as any).visitor_meta || {};
      const tagged = m.utm_content || m.fbc || m.ad_click_id;
      if (tagged) {
        const k = String(m.utm_content || "(tagged, no per-ad tag)");
        if (isPaid(m)) { paidLandings++; byPaidAd[k] = (byPaidAd[k] || 0) + 1; }
        else { organicTagged++; byOrganicTagged[k] = (byOrganicTagged[k] || 0) + 1; }
      }
      if (!tagged) continue;
      taggedLandings++;
      const k = String(m.utm_content || "(ad, no per-ad tag)");
      byAd[k] = (byAd[k] || 0) + 1;
    }

    // ── C. the people ──────────────────────────────────────────────────────
    const rows = (trials || []).filter((t: any) => t.location_id === s.uuid);
    const realTrials = rows.filter((t: any) => !NON_TRIAL.has(String(t.source_category || "")));
    const notTrials = rows.length - realTrials.length;
    const paid = realTrials.filter((t: any) => !!t.payment_date);

    const named = paid.filter((t: any) => t.utm_content || t.fbc);
    const byAdNamed: Record<string, number> = {};
    for (const t of named) {
      const k = String((t as any).utm_content || "(ad click id, no per-ad tag)");
      byAdNamed[k] = (byAdNamed[k] || 0) + 1;
    }
    const byEntryPoint: Record<string, number> = {};
    for (const t of realTrials) {
      const k = String((t as any).source_category || "(null)");
      byEntryPoint[k] = (byEntryPoint[k] || 0) + 1;
    }

    const metaPurchases = metaAds.reduce((n, a: any) => n + a.purchases, 0);
    const metaSpend = +metaAds.reduce((n, a: any) => n + a.spend, 0).toFixed(2);

    out.push({
      studio: s.name,
      slug: s.slug,

      // The three answers, labelled by what each can and cannot prove.
      a_meta_says: {
        what_this_is:
          "Meta's own attribution per ad, including view-through. Names the ad, " +
          "never the person. Independent of our site code, so it keeps working " +
          "when our tracking breaks.",
        spend: metaSpend,
        attributed_purchases: metaPurchases,
        cost_per_purchase: metaPurchases > 0 ? +(metaSpend / metaPurchases).toFixed(2) : null,
        error: metaError,
        ads: metaAds.slice(0, 15),
      },

      b_our_traffic_says: {
        what_this_is:
          "Tagged landings on this studio's trial page, read at landing time. Names " +
          "the ad, never the person. from_paid_ads counts only cpc/paid traffic or a " +
          "real ad click id; organic_tagged is tagged but free, e.g. the Instagram " +
          "bio link (utm_medium=social), which we must not bill to the ad budget.",
        trial_page_landings: mine.length,
        from_paid_ads: paidLandings,
        by_paid_ad: byPaidAd,
        organic_tagged: organicTagged,
        by_organic_tag: byOrganicTagged,
        // Paid + organic-tagged together. Kept only so older output lines up;
        // do NOT read this as paid traffic.
        tagged_total_paid_plus_organic: taggedLandings,
        by_any_tag: byAd,
      },

      c_the_people: {
        what_this_is:
          "Paid trials with the ad stamped on their own row. The only source " +
          "that joins a NAME to an ad. Blank for anything created before the " +
          "2026-10-15 fix — absence here is not evidence a trial wasn't from an ad.",
        paid_trials: paid.length,
        with_ad_on_row: named.length,
        by_ad: byAdNamed,
        entry_points: byEntryPoint,
        not_trials_excluded: notTrials,

        // 2026-10-16 — "do we have leads from all of these?" Paid trials are
        // the tail end of the funnel; this is EVERY lead row in the window,
        // paid or not, so ad traffic can be checked against people actually
        // captured. captured_vs_paid_ad_landings is the blunt version: how
        // many humans we hold against how many paid clicks we bought.
        all_leads: {
          total: realTrials.length,
          paid: paid.length,
          unpaid: realTrials.length - paid.length,
          with_ad_on_row: realTrials.filter((t: any) => t.utm_content || t.fbc).length,
          captured_vs_paid_ad_landings: `${realTrials.length} leads / ${paidLandings} paid landings`,
          rows: [...realTrials]
            .sort((a: any, b: any) =>
              String(b.payment_date || b.created_at).localeCompare(String(a.payment_date || a.created_at)))
            .slice(0, 60)
            .map((t: any) => ({
              name: t.name,
              email: t.email,
              created: t.created_at,
              paid_at: t.payment_date ?? null,
              status: t.payment_date ? "PAID" : "lead only",
              entry: t.source_category,
              ad: t.utm_content ?? null,
              utm_source: t.utm_source ?? null,
              has_click_id: !!t.fbc,
            })),
        },
        recent: paid
          .sort((x: any, y: any) => String(y.payment_date).localeCompare(String(x.payment_date)))
          .slice(0, 10)
          .map((t: any) => ({
            name: t.name,
            paid_at: t.payment_date,
            entry: t.source_category,
            ad: t.utm_content ?? null,
            campaign: t.utm_campaign ?? null,
            has_click_id: !!t.fbc,
            source: t.utm_content
              ? `ad: ${t.utm_content}`
              : t.fbc
              ? "from an ad (click id, no per-ad tag)"
              : t.utm_source
              ? `${t.utm_source}/${t.utm_medium ?? "?"}`
              : "no ad signal on the row",
          })),
      },

      reconciliation: (() => {
        const notes: string[] = [];
        if (metaError) notes.push(`Meta unavailable (${metaError}) — A is missing, B and C still stand.`);
        if (!metaError && metaPurchases > paid.length) {
          notes.push(
            `Meta credits ${metaPurchases} purchases, we recorded ${paid.length} paid trials. ` +
            `Meta counts view-throughs and a 7-day click window, so it will usually read higher.`,
          );
        }
        if (paid.length > 0 && named.length === 0) {
          notes.push(
            `No paid trial here carries an ad on its row. Before 2026-10-15 that was the ` +
            `camelCase/snake_case bug and proves nothing. After it, suspect the handoff again.`,
          );
        }
        if (taggedLandings > 0 && named.length === 0 && paid.length > 0) {
          notes.push(
            `${paidLandings} paid-ad landings (plus ${organicTagged} organic-tagged) but no ` +
            `trial row carries an ad — traffic is arriving tagged and losing the tag before checkout.`,
          );
        }
        if (!notes.length) notes.push("Sources agree within expected attribution differences.");
        return notes;
      })(),
    });
  }

  return json({
    ok: true,
    read_only: true,
    window_days: days,
    since,
    how_to_read:
      "A = Meta's attribution (ad, not person). B = our ad-tagged landings (ad, not person). " +
      "C = the ad stamped on a named person's row. Trust A for 'which ad is producing sales', " +
      "C for 'where did THIS customer come from', B when C is blank and you need corroboration.",
    studios: out,
  });
});
