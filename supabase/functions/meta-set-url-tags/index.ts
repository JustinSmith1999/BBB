/**
 * meta-set-url-tags — put UTM parameters on every Meta ad, so a click can be
 * connected to the trial it produces.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. On 2026-10-05 get_unified_attribution reported that 512 of
 * 512 paid trials in 30 days were "Direct (untagged)" — zero attributed to any
 * channel — against 4,542 Meta ad clicks and $5,422 of spend. The whole
 * attribution chain downstream was already built and correct:
 *
 *   lib/utm.ts            captures utm_* on mount into sessionStorage
 *   LocationTrialSignup   sends them with the checkout POST
 *   mt-card-checkout      persists utm_source/medium/campaign on trial_signups
 *   get_unified_attribution  classifies utm_source='ads' as paid_meta_ads
 *
 * Nothing was entering it, because the ads link to /trial/<studio> with no
 * query string. get_meta_ad_creatives has carried a note about this since
 * 26 May: "requires Justin to set ad-level utm_content={{ad.id}} once in Ads
 * Manager". It was never done, and it is the reason the ad spend has looked
 * like it produces nothing.
 *
 * WHAT IT SETS. Meta's `url_tags` field on the Ad object — the "URL
 * parameters" box in Ads Manager. Meta appends it to the destination URL on
 * every click and substitutes its own macros:
 *
 *   utm_source=ads&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_content={{ad.id}}
 *
 *   utm_source=ads        → exactly what get_unified_attribution looks for
 *   utm_content={{ad.id}} → powers the trials_direct column, so you learn
 *                           which INDIVIDUAL ad produced paid trials rather
 *                           than the pro-rata estimate it falls back to today
 *
 * This changes tracking only. It does not touch budget, targeting, creative,
 * schedule or status. The destination URL itself is unchanged — Meta appends
 * the parameters at click time.
 *
 * SAFETY. dry_run defaults to TRUE. A dry run lists every ad it would change
 * with its current and proposed url_tags, and changes nothing. Ads that
 * already carry a utm_source are left alone unless you pass overwrite:true,
 * so this never clobbers tagging someone set up by hand.
 *
 * Invoke (header: x-bbb-secret):
 *   {}                                     -> dry run, all four studios
 *   { "studio": "bayside" }                -> dry run, one studio
 *   { "dry_run": false }                   -> APPLY to all active ads
 *   { "dry_run": false, "include_paused": true }
 *   { "overwrite": true }                  -> also replace existing utm tagging
 *
 * Deploy: bbb deploy-fn meta-set-url-tags
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB_VERSION = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

// utm_source=ads is the literal value get_unified_attribution classifies as
// paid_meta_ads. Changing it silently breaks the dashboard — see the CHANNEL
// CLASSIFICATION block in 20260601_unified_attribution.sql.
const URL_TAGS =
  "utm_source=ads&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_content={{ad.id}}";

const STUDIOS = [
  { slug: "williamsburg",  name: "Williamsburg",  adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG" },
  { slug: "astoria",       name: "Astoria",       adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA" },
  { slug: "bayside",       name: "Bayside",       adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE" },
  { slug: "fresh-meadows", name: "Fresh Meadows", adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS" },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function fbGet(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${FB_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function fbPost(path: string, token: string, fields: Record<string, string>) {
  const body = new URLSearchParams({ access_token: token, ...fields });
  const r = await fetch(`https://graph.facebook.com/${FB_VERSION}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run !== false;            // DEFAULT TRUE
  const overwrite = body?.overwrite === true;
  const includePaused = body?.include_paused === true;
  const only = body?.studio ? String(body.studio) : null;
  const tags = typeof body?.url_tags === "string" && body.url_tags ? String(body.url_tags) : URL_TAGS;

  const studios = STUDIOS.filter((s) => !only || s.slug === only);
  if (!studios.length) return json({ ok: false, error: `unknown studio "${only}"` }, 400);

  const out: any[] = [];
  let totalWould = 0, totalChanged = 0, totalSkipped = 0, totalFailed = 0;

  for (const st of studios) {
    const token = Deno.env.get(st.tokenEnv);
    if (!token) {
      out.push({ studio: st.slug, error: `missing secret ${st.tokenEnv}` });
      continue;
    }

    const listed = await fbGet(`${st.adAccount}/ads`, token, {
      // creative{id} matters: url_tags is stored on the AD CREATIVE, not the ad.
      // POSTing url_tags to /{ad_id} returns {"success":true} and silently
      // changes nothing — confirmed live on 2026-10-05, when a run reported
      // "set: 5, failed: 0" and a read-back showed all five still empty.
      fields: "id,name,status,effective_status,url_tags,creative{id,url_tags}",
      limit: "500",
      ...(includePaused ? {} : { effective_status: JSON.stringify(["ACTIVE"]) }),
    });
    if (listed.status !== 200) {
      out.push({ studio: st.slug, error: listed.body?.error?.message ?? `HTTP ${listed.status}` });
      continue;
    }

    const ads = (listed.body?.data ?? []) as any[];
    const changes: any[] = [];

    for (const ad of ads) {
      // Read the creative's value too — that is the one that actually governs.
      const current = String(ad.url_tags ?? ad?.creative?.url_tags ?? "");
      const creativeId = ad?.creative?.id ? String(ad.creative.id) : null;
      // Leave hand-made tagging alone unless explicitly told otherwise.
      if (!overwrite && /utm_source=/i.test(current)) {
        totalSkipped++;
        changes.push({ ad_id: ad.id, ad_name: ad.name, action: "skipped_already_tagged", current });
        continue;
      }
      if (current === tags) {
        totalSkipped++;
        changes.push({ ad_id: ad.id, ad_name: ad.name, action: "already_correct" });
        continue;
      }

      if (dryRun) {
        totalWould++;
        changes.push({ ad_id: ad.id, ad_name: ad.name, status: ad.effective_status, action: "would_set", from: current || "(empty)", to: tags });
        continue;
      }

      // Try the creative first (where the field really lives), then the ad as a
      // fallback. NEVER trust the response: Meta answers {"success":true} to a
      // write it ignored. Read the value back and report what is actually there.
      const attempts: any[] = [];
      if (creativeId) {
        const r = await fbPost(creativeId, token, { url_tags: tags });
        attempts.push({ target: `creative ${creativeId}`, status: r.status, error: r.body?.error?.message ?? null });
      }
      const rAd = await fbPost(ad.id, token, { url_tags: tags });
      attempts.push({ target: `ad ${ad.id}`, status: rAd.status, error: rAd.body?.error?.message ?? null });

      await new Promise((r) => setTimeout(r, 400)); // let the write settle
      const check = await fbGet(ad.id, token, { fields: "url_tags,creative{url_tags}" });
      const after = String(check.body?.url_tags ?? check.body?.creative?.url_tags ?? "");

      if (after === tags) {
        totalChanged++;
        changes.push({ ad_id: ad.id, ad_name: ad.name, action: "set_and_verified", from: current || "(empty)", to: after });
      } else {
        totalFailed++;
        changes.push({
          ad_id: ad.id, ad_name: ad.name,
          action: "write_ignored_by_meta",
          verified_value: after || "(still empty)",
          attempts,
          hint: "Meta accepted the call but did not persist url_tags. This ad's creative is likely immutable (common for ads created from a boosted post or an existing-post creative) — it has to be set in Ads Manager, or the ad rebuilt on a new creative.",
        });
      }
      await new Promise((r) => setTimeout(r, 120)); // be gentle with the graph API
    }

    out.push({ studio: st.slug, name: st.name, ads_found: ads.length, changes });
  }

  return json({
    ok: true,
    dry_run: dryRun,
    url_tags: tags,
    include_paused: includePaused,
    overwrite,
    would_set: dryRun ? totalWould : undefined,
    set: dryRun ? undefined : totalChanged,
    skipped: totalSkipped,
    failed: totalFailed,
    studios: out,
  });
});
