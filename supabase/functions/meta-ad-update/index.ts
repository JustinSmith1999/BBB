/**
 * meta-ad-update — apply targeting changes to a Meta adset.
 *
 * Built 2026-06-01 to apply the 3 Bayside fixes from the live diagnosis:
 *   1. Widen geo radius from 3mi to 5mi
 *   2. Cap upper age from 65 to 50
 *   3. Drop low-intent FB placements (Marketplace, In-Stream, Business Discovery)
 *
 * Usage:
 *   POST /functions/v1/meta-ad-update
 *   Header:  x-bbb-secret: <ADMIN_SECRET>
 *   Body:    { studio: "bayside", adsetId: "120243065873680436", changes: {...} }
 *
 *   changes accepts any of:
 *     { age_max: 50 }
 *     { age_min: 25 }
 *     { radius_miles: 5 }           // updates ALL custom_locations radii
 *     { facebook_positions: [...] } // exact replacement
 *     { instagram_positions: [...] }
 *     { publisher_platforms: [...] }
 *
 * Returns the updated targeting object as Meta sees it, so we can verify.
 *
 * Auth: x-bbb-secret header. Deploy with --no-verify-jwt.
 *
 * Env: META_TOKEN_<STUDIO_UPPER_SLUG> for the studio in question.
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB_VERSION = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const STUDIO_TOKENS: Record<string, string> = {
  williamsburg: "META_TOKEN_WILLIAMSBURG",
  astoria: "META_TOKEN_ASTORIA",
  bayside: "META_TOKEN_BAYSIDE",
  "fresh-meadows": "META_TOKEN_FRESH_MEADOWS",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }

  const studio = String(body.studio || "").trim().toLowerCase();
  const adsetId = String(body.adsetId || "").trim();
  const adId    = String(body.adId    || "").trim();
  const changes = body.changes || {};
  if (!STUDIO_TOKENS[studio]) return json({ ok: false, error: `unknown studio: ${studio}` }, 400);
  if (!adsetId && !adId) return json({ ok: false, error: "adsetId or adId required" }, 400);

  const token = Deno.env.get(STUDIO_TOKENS[studio]);
  if (!token) return json({ ok: false, error: `missing env var: ${STUDIO_TOKENS[studio]}` }, 500);

  // ── AD-LEVEL: only status changes (PAUSED|ACTIVE) ──────────────────────────
  // Meta accepts a top-level status field on the ad object. No targeting on ads.
  if (adId && !adsetId) {
    if (!["ACTIVE", "PAUSED"].includes(String(changes.status || "").toUpperCase())) {
      return json({ ok: false, error: "for adId, changes.status must be ACTIVE or PAUSED" }, 400);
    }
    const status = String(changes.status).toUpperCase();
    const updateRes = await fetch(`https://graph.facebook.com/${FB_VERSION}/${adId}`, {
      method: "POST",
      body: new URLSearchParams({ access_token: token, status }),
    });
    const updateJson = await updateRes.json();
    if (!updateRes.ok) {
      return json({ ok: false, step: "ad_status_update", error: updateJson.error || updateJson }, 502);
    }
    // Verify
    const v = await fetch(`https://graph.facebook.com/${FB_VERSION}/${adId}?fields=name,status,effective_status&access_token=${token}`);
    const verify = await v.json();
    return json({
      ok: true, studio, adId,
      applied: [`status=${status}`],
      after: { name: verify.name, status: verify.status, effective_status: verify.effective_status },
    });
  }

  // 1. Fetch current targeting so we can build a delta-style patch
  const fetchUrl = new URL(`https://graph.facebook.com/${FB_VERSION}/${adsetId}`);
  fetchUrl.searchParams.set("fields", "name,targeting");
  fetchUrl.searchParams.set("access_token", token);
  const curRes = await fetch(fetchUrl);
  const cur = await curRes.json();
  if (!curRes.ok) return json({ ok: false, step: "fetch_current", error: cur.error || cur }, 502);

  const targeting: any = JSON.parse(JSON.stringify(cur.targeting || {}));

  // 2. Apply changes
  const applied: string[] = [];
  if (typeof changes.age_min === "number") { targeting.age_min = changes.age_min; applied.push(`age_min=${changes.age_min}`); }
  if (typeof changes.age_max === "number") { targeting.age_max = changes.age_max; applied.push(`age_max=${changes.age_max}`); }
  // 2026-06-05: Meta rejects age caps below 65 when Advantage+ Audience is on
  // (error_subcode 1870189). Disable Advantage+ automatically whenever a
  // hard age cap is being set, since the caller explicitly wants control.
  // Also accept an explicit changes.disable_advantage_audience flag.
  //
  // 2026-06-08: Added explicit changes.enable_advantage_audience flag for
  // rollback after the 6/4 targeting changes tanked click rate 62%.
  // enable takes precedence over the auto-disable logic — if you're
  // restoring age to 25-65 AND want Advantage+ back on in one call, this
  // is the path. Meta will accept it because age 65 is the system default.
  if (changes.enable_advantage_audience === true) {
    targeting.targeting_automation = targeting.targeting_automation || {};
    targeting.targeting_automation.advantage_audience = 1;
    applied.push("advantage_audience=on");
  } else if (
    typeof changes.age_min === "number" ||
    typeof changes.age_max === "number" ||
    changes.disable_advantage_audience === true
  ) {
    targeting.targeting_automation = targeting.targeting_automation || {};
    targeting.targeting_automation.advantage_audience = 0;
    applied.push("advantage_audience=off");
  }
  if (typeof changes.radius_miles === "number") {
    const locs = targeting.geo_locations?.custom_locations || [];
    for (const loc of locs) { loc.radius = changes.radius_miles; loc.distance_unit = "mile"; }
    applied.push(`radius=${changes.radius_miles}mi (${locs.length} loc(s))`);
  }
  // 2026-06-15: gender targeting. Meta encoding:
  //   genders: [1]    → men only
  //   genders: [2]    → women only
  //   genders: [1, 2] or omit → all genders
  // Pass changes.genders as either an array of ints or the strings
  // "women" / "men" / "all" for convenience.
  if (changes.genders !== undefined) {
    let gArr: number[] | null = null;
    if (changes.genders === "women") gArr = [2];
    else if (changes.genders === "men") gArr = [1];
    else if (changes.genders === "all") gArr = [1, 2];
    else if (Array.isArray(changes.genders)) {
      gArr = changes.genders
        .map((v: any) => Number(v))
        .filter((n: number) => n === 1 || n === 2);
    }
    if (gArr && gArr.length > 0) {
      targeting.genders = gArr;
      applied.push(`genders=[${gArr.join(",")}]`);
    } else if (changes.genders === "all" || (Array.isArray(changes.genders) && changes.genders.length === 0)) {
      delete targeting.genders;
      applied.push("genders=all");
    }
  }
  if (Array.isArray(changes.facebook_positions)) {
    targeting.facebook_positions = changes.facebook_positions;
    applied.push(`facebook_positions=[${changes.facebook_positions.join(",")}]`);
  }
  if (Array.isArray(changes.instagram_positions)) {
    targeting.instagram_positions = changes.instagram_positions;
    applied.push(`instagram_positions=[${changes.instagram_positions.join(",")}]`);
  }
  if (Array.isArray(changes.publisher_platforms)) {
    targeting.publisher_platforms = changes.publisher_platforms;
    applied.push(`publisher_platforms=[${changes.publisher_platforms.join(",")}]`);
  }
  // Clear interest_groups / flexible_spec (Bayside fix — let Advantage+ algorithm
  // find the audience instead of constraining to fitness interest list).
  // Accepts: changes.interests = []  OR  changes.clear_interests = true
  if (
    (Array.isArray(changes.interests) && changes.interests.length === 0) ||
    changes.clear_interests === true
  ) {
    delete targeting.flexible_spec;
    delete targeting.interests;
    applied.push("interests=cleared");
  }
  // Adset-level status flip — separate POST below, not part of targeting blob.
  let adsetStatusChange: string | null = null;
  if (["ACTIVE", "PAUSED"].includes(String(changes.status || "").toUpperCase())) {
    adsetStatusChange = String(changes.status).toUpperCase();
    applied.push(`adset_status=${adsetStatusChange}`);
  }
  // 2026-06-23: daily_budget (in CENTS) — Meta accepts daily_budget on the adset
  // for ABO campaigns. For CBO campaigns Meta returns error_subcode 1885183 and
  // tells you to set the budget at campaign level. We surface the error if so.
  // Accepts: changes.daily_budget_cents = 2000  (= $20.00/day)
  //          OR  changes.daily_budget_dollars = 20  (same outcome)
  let dailyBudgetCents: number | null = null;
  if (typeof changes.daily_budget_cents === "number" && changes.daily_budget_cents > 0) {
    dailyBudgetCents = Math.round(changes.daily_budget_cents);
  } else if (typeof changes.daily_budget_dollars === "number" && changes.daily_budget_dollars > 0) {
    dailyBudgetCents = Math.round(changes.daily_budget_dollars * 100);
  }
  if (dailyBudgetCents !== null) {
    applied.push(`daily_budget=$${(dailyBudgetCents / 100).toFixed(2)}`);
  }
  if (applied.length === 0) return json({ ok: false, error: "no recognized changes" }, 400);

  // 3. POST update to Meta — targeting field as JSON string. Include status if set.
  const updateParams = new URLSearchParams({
    access_token: token,
    targeting: JSON.stringify(targeting),
  });
  if (adsetStatusChange) updateParams.set("status", adsetStatusChange);
  if (dailyBudgetCents !== null) updateParams.set("daily_budget", String(dailyBudgetCents));
  const updateRes = await fetch(`https://graph.facebook.com/${FB_VERSION}/${adsetId}`, {
    method: "POST",
    body: updateParams,
  });
  const updateJson = await updateRes.json();
  if (!updateRes.ok) {
    // 2026-06-23 CBO auto-fallback. Meta returns error_subcode 1885621
    // "Can't Set Ad Set and Campaign Budget" when the adset's parent campaign
    // is using Campaign Budget Optimization. In that case the daily_budget
    // belongs on the campaign object, not the adset. Auto-discover the
    // campaign and retry there. Only kicks in when the failure was budget-only;
    // targeting changes still need a successful adset POST.
    const subcode = updateJson?.error?.error_subcode;
    const isCboError = subcode === 1885621 || subcode === 1885183;
    const onlyBudget = dailyBudgetCents !== null && !adsetStatusChange &&
      applied.length === (applied.includes("advantage_audience=off") ? 2 : 1);
    if (isCboError && dailyBudgetCents !== null && onlyBudget) {
      // Get campaign_id from the adset
      const cFetch = await fetch(
        `https://graph.facebook.com/${FB_VERSION}/${adsetId}?fields=campaign_id&access_token=${token}`,
      );
      const cBody = await cFetch.json();
      const campaignId = cBody?.campaign_id;
      if (!campaignId) {
        return json({
          ok: false, step: "discover_campaign", applied,
          error: "could not get campaign_id from adset for CBO fallback",
          original_error: updateJson.error,
        }, 502);
      }
      // POST daily_budget to the campaign
      const cUpdate = await fetch(
        `https://graph.facebook.com/${FB_VERSION}/${campaignId}`,
        {
          method: "POST",
          body: new URLSearchParams({
            access_token: token,
            daily_budget: String(dailyBudgetCents),
          }),
        },
      );
      const cUpdateJson = await cUpdate.json();
      if (!cUpdate.ok) {
        return json({
          ok: false, step: "campaign_budget_update", applied,
          campaign_id: campaignId,
          error: cUpdateJson.error || cUpdateJson,
        }, 502);
      }
      // Verify
      const vC = await fetch(
        `https://graph.facebook.com/${FB_VERSION}/${campaignId}?fields=name,daily_budget,status&access_token=${token}`,
      );
      const vCBody = await vC.json();
      return json({
        ok: true, studio, adsetId,
        campaign_fallback: true, campaign_id: campaignId,
        applied: [`campaign.daily_budget=$${(dailyBudgetCents / 100).toFixed(2)}`],
        before_adset_error: updateJson.error,
        after_campaign: {
          name: vCBody.name,
          daily_budget_dollars: vCBody.daily_budget ? Number(vCBody.daily_budget) / 100 : null,
          status: vCBody.status,
        },
      });
    }
    return json({
      ok: false, step: "update", applied, error: updateJson.error || updateJson,
      targeting_attempted: targeting,
    }, 502);
  }

  // 4. Re-fetch and return so we can confirm
  const verifyRes = await fetch(fetchUrl);
  const verify = await verifyRes.json();

  return json({
    ok: true,
    studio, adsetId, name: cur.name, applied,
    before: {
      age: [cur.targeting?.age_min, cur.targeting?.age_max],
      genders: cur.targeting?.genders,
      radius: cur.targeting?.geo_locations?.custom_locations?.[0]?.radius,
      facebook_positions: cur.targeting?.facebook_positions,
      instagram_positions: cur.targeting?.instagram_positions,
      publisher_platforms: cur.targeting?.publisher_platforms,
    },
    after: {
      age: [verify.targeting?.age_min, verify.targeting?.age_max],
      genders: verify.targeting?.genders,
      radius: verify.targeting?.geo_locations?.custom_locations?.[0]?.radius,
      facebook_positions: verify.targeting?.facebook_positions,
      instagram_positions: verify.targeting?.instagram_positions,
      publisher_platforms: verify.targeting?.publisher_platforms,
    },
  });
});
