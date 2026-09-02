/**
 * meta-ad-from-ig-reel — run an EXISTING Instagram reel (a post on the studio's
 * connected IG account) as an ad: resolve the reel media, create the ad in an
 * existing adset, set the adset daily budget, and switch the campaign + adset on.
 * Built 2026-07-29 for the Astoria + Williamsburg $50/day reel ads.
 *
 * Auth: x-bbb-secret header. Deploy with --no-verify-jwt.
 * Env: META_TOKEN_<STUDIO>.
 *
 * POST body:
 *   {
 *     "dry_run": true,
 *     "jobs": [
 *       { "studio":"astoria",      "shortcode":"DTBLynHEbx7", "adset_id":"120248447137650195",
 *         "daily_budget_cents":5000, "ad_name":"Astoria - IG Reel DTBLynHEbx7", "activate":true },
 *       { "studio":"williamsburg", "shortcode":"DV9DS-5ATRQ", "adset_id":"6921905366977",
 *         "daily_budget_cents":5000, "ad_name":"WB - IG Reel DV9DS-5ATRQ", "activate":true }
 *     ]
 *   }
 * dry_run: resolves the IG account + reel media and returns the plan, WRITES NOTHING.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const TOKENS: Record<string, string> = {
  williamsburg: "META_TOKEN_WILLIAMSBURG", astoria: "META_TOKEN_ASTORIA",
  bayside: "META_TOKEN_BAYSIDE", "fresh-meadows": "META_TOKEN_FRESH_MEADOWS",
};
const ACCOUNTS: Record<string, string> = {
  williamsburg: "act_26739874695621849", astoria: "act_1367835402069398",
  bayside: "act_4298533693762953", "fresh-meadows": "act_1301162772160251",
};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString()); const b = await r.json();
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${JSON.stringify(b)}`);
  return b;
}
async function fbPost(path: string, token: string, fields: Record<string, string>) {
  const form = new URLSearchParams(); form.set("access_token", token);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const r = await fetch(`https://graph.facebook.com/${FB}/${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const b = await r.json();
  if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${JSON.stringify(b)}`);
  return b;
}

// Find the IG business account(s) connected to the ad account.
async function resolveIgAccounts(account: string, token: string) {
  const out: any[] = [];
  try { const r = await fbGet(`${account}/instagram_accounts`, token, { fields: "id,username" }); (r.data || []).forEach((x: any) => out.push({ id: x.id, username: x.username, via: "instagram_accounts" })); } catch (_) {}
  // Also via connected pages → instagram_business_account (the modern link)
  try {
    const pr = await fbGet(`${account}/promote_pages`, token, { fields: "id,name,instagram_business_account{id,username}" });
    (pr.data || []).forEach((p: any) => { if (p.instagram_business_account) out.push({ id: p.instagram_business_account.id, username: p.instagram_business_account.username, via: `page:${p.name}` }); });
  } catch (_) {}
  return out;
}

// Find the media on an IG account whose permalink matches the reel shortcode.
async function findReelMedia(igId: string, token: string, shortcode: string) {
  const start = new URL(`https://graph.facebook.com/${FB}/${igId}/media`);
  start.searchParams.set("access_token", token);
  start.searchParams.set("fields", "id,permalink,media_type,timestamp");
  start.searchParams.set("limit", "50");
  let next: string | null = start.toString();
  for (let page = 0; page < 8 && next; page++) {
    const r = await fetch(next); const b: any = await r.json();
    if (!r.ok) throw new Error(`media lookup ${r.status}: ${JSON.stringify(b)}`);
    for (const m of (b.data || [])) {
      if (typeof m.permalink === "string" && m.permalink.includes(`/${shortcode}`)) {
        return { id: m.id, permalink: m.permalink, media_type: m.media_type, timestamp: m.timestamp };
      }
    }
    next = b.paging?.next || null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if ((req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret")) !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }
  const dryRun = body.dry_run === true;
  const jobs: any[] = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return json({ ok: false, error: "jobs[] required" }, 400);

  const results: any[] = [];
  for (const j of jobs) {
    const studio = String(j.studio || "").toLowerCase();
    const token = Deno.env.get(TOKENS[studio] || "");
    const account = ACCOUNTS[studio];
    const res: any = { studio, shortcode: j.shortcode, adset_id: j.adset_id, daily_budget_cents: j.daily_budget_cents, activate: j.activate !== false };
    try {
      if (!token || !account) throw new Error(`unknown/unconfigured studio: ${studio}`);
      // 1. Resolve IG account + reel media
      const igs = await resolveIgAccounts(account, token);
      res.ig_accounts = igs;
      let media: any = null, igUsed: any = null;
      // 2026-08-31: media_id override. Bayside's token lacks instagram_basic,
      // so listing /{ig}/media 400s (#10). IG shortcodes are base64url-encoded
      // media ids, so the caller can pass media_id directly and we skip the
      // listing entirely. instagram_actor_id = first resolved IG account.
      if (j.media_id) {
        media = { id: String(j.media_id), permalink: `https://www.instagram.com/reel/${j.shortcode}/`, media_type: "VIDEO", via: "media_id override" };
        igUsed = igs[0] || null;
      } else {
        for (const ig of igs) { const m = await findReelMedia(ig.id, token, j.shortcode); if (m) { media = m; igUsed = ig; break; } }
      }
      res.resolved_media = media; res.ig_used = igUsed;
      // adset → campaign for activation
      const aset = await fbGet(String(j.adset_id), token, { fields: "id,name,campaign_id,daily_budget,effective_status" });
      res.adset = { id: aset.id, name: aset.name, campaign_id: aset.campaign_id, current_daily_budget: aset.daily_budget, status: aset.effective_status };

      if (!media) { res.ok = false; res.error = "Could not find that reel on the connected IG account(s). Check the shortcode / that it's posted on the linked account."; results.push(res); continue; }

      if (dryRun) { res.ok = true; res.plan = `Create ad from IG media ${media.id} into adset ${j.adset_id}, set daily_budget=$${(j.daily_budget_cents/100).toFixed(0)}, ${res.activate?"ACTIVATE":"leave paused"} campaign+adset.`; results.push(res); continue; }

      // 2. Create creative from existing IG post
      // 2026-08-31: Meta v19+ rejects instagram_actor_id for some accounts
      // ((#100) must be a valid Instagram account id). Try the modern
      // instagram_user_id param first, fall back to instagram_actor_id.
      let cr: any;
      try {
        cr = await fbPost(`${account}/adcreatives`, token, {
          name: `${j.ad_name || studio + " IG reel"} — creative`,
          source_instagram_media_id: media.id,
          instagram_user_id: igUsed?.id,
        });
      } catch (e1) {
        res.first_attempt_error = String(e1).slice(0, 200);
        cr = await fbPost(`${account}/adcreatives`, token, {
          name: `${j.ad_name || studio + " IG reel"} — creative`,
          source_instagram_media_id: media.id,
          instagram_actor_id: igUsed?.id,
        });
      }
      res.creative_id = cr.id;
      // 3. Create the ad (active)
      const ad = await fbPost(`${account}/ads`, token, { name: j.ad_name || `${studio} IG reel ${j.shortcode}`, adset_id: String(j.adset_id), creative: JSON.stringify({ creative_id: cr.id }), status: "ACTIVE" });
      res.ad_id = ad.id;
      // 4. Set adset daily budget
      if (j.daily_budget_cents) { await fbPost(String(j.adset_id), token, { daily_budget: String(j.daily_budget_cents) }); res.budget_set = j.daily_budget_cents; }
      // 5. Activate adset + campaign
      if (res.activate) { await fbPost(String(j.adset_id), token, { status: "ACTIVE" }); if (aset.campaign_id) await fbPost(String(aset.campaign_id), token, { status: "ACTIVE" }); res.activated = true; }
      res.ok = true;
    } catch (e) { res.ok = false; res.error = String(e); }
    results.push(res);
  }
  return json({ ok: results.every((r) => r.ok), dry_run: dryRun, results });
});
