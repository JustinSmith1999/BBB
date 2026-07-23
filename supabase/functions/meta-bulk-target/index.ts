/**
 * meta-bulk-target — discover every active adset in a studio's Meta ad
 * account, then PATCH each one with the same targeting changes.
 *
 * Built 2026-06-15 so Justin can roll a single targeting change (e.g. Women
 * 34-54) across an entire studio with one curl, instead of looking up adset
 * IDs by hand and calling meta-ad-update 5+ times.
 *
 * Body:
 *   {
 *     "studio":    "bayside",            // required, one of: williamsburg|astoria|bayside|fresh-meadows
 *     "dry_run":   true,                  // default TRUE — only lists what would change
 *     "changes": {                        // same shape as meta-ad-update
 *       "age_min":  34,
 *       "age_max":  54,
 *       "genders":  "women"               // "women"|"men"|"all"|[1]|[2]|[1,2]
 *     },
 *     "include_paused": false             // default false — only ACTIVE adsets
 *   }
 *
 * Auth: x-bbb-secret header (same as meta-ad-update).
 * Env:  META_TOKEN_<STUDIO> token per studio.
 *
 * Deploy:
 *   supabase functions deploy meta-bulk-target --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB_VERSION   = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const STUDIO_CONFIG: Record<string, { adAccount: string; tokenEnv: string }> = {
  williamsburg:    { adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG" },
  astoria:         { adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA" },
  bayside:         { adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE" },
  "fresh-meadows": { adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS" },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

function normalizeGenders(g: any): number[] | "clear" | null {
  if (g === undefined) return null;
  if (g === "women") return [2];
  if (g === "men")   return [1];
  if (g === "all")   return "clear";
  if (Array.isArray(g)) {
    const arr = g.map((v: any) => Number(v)).filter((n: number) => n === 1 || n === 2);
    if (arr.length === 0) return "clear";
    return arr;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) {
    return json({ ok: false, error: "bad secret" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }

  const studio  = String(body.studio || "").trim().toLowerCase();
  const dryRun  = body.dry_run !== false;  // default TRUE for safety
  const changes = body.changes || {};
  const includePaused = body.include_paused === true;

  const cfg = STUDIO_CONFIG[studio];
  if (!cfg) return json({ ok: false, error: `unknown studio: ${studio}`, valid: Object.keys(STUDIO_CONFIG) }, 400);

  const token = Deno.env.get(cfg.tokenEnv);
  if (!token) return json({ ok: false, error: `missing env var: ${cfg.tokenEnv}` }, 500);

  // 1. Discover adsets — only ACTIVE by default (effective_status filters out paused, archived, ended)
  const statusFilter = includePaused
    ? `[\"ACTIVE\",\"PAUSED\"]`
    : `[\"ACTIVE\"]`;
  const adsetUrl = new URL(`https://graph.facebook.com/${FB_VERSION}/${cfg.adAccount}/adsets`);
  // 2026-06-16 added geo_locations to surface targeting overlap (the cause of
  // Bayside-locals seeing WB+Astoria ads but not Bayside ads — WB/Astoria geo
  // was bleeding into Bayside ZIPs and outbidding the lower-budget studio).
  // 2026-06-17 added targeting_automation to surface Advantage+ audience expansion
  // state. When advantage_audience=1, Meta auto-expands geo beyond declared 5mi
  // radius — that's how Astoria/WB ads end up bleeding into Bayside even though
  // those studios are 7-10mi away.
  adsetUrl.searchParams.set("fields", "id,name,status,effective_status,targeting{age_min,age_max,genders,geo_locations,targeting_automation}");
  adsetUrl.searchParams.set("filtering", `[{\"field\":\"effective_status\",\"operator\":\"IN\",\"value\":${statusFilter}}]`);
  adsetUrl.searchParams.set("limit", "100");
  adsetUrl.searchParams.set("access_token", token);
  const listRes = await fetch(adsetUrl);
  const listJson = await listRes.json();
  if (!listRes.ok) {
    return json({ ok: false, step: "discover_adsets", error: listJson.error || listJson }, 502);
  }
  const adsets = (listJson.data || []) as Array<{
    id: string; name: string; status: string; effective_status: string;
    targeting?: { age_min?: number; age_max?: number; genders?: number[] };
  }>;

  // 2. DRY RUN — just show what would change
  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      studio,
      ad_account: cfg.adAccount,
      adsets_found: adsets.length,
      changes_requested: changes,
      preview: adsets.map((a) => {
        const geo: any = (a.targeting as any)?.geo_locations || {};
        const customLocs = (geo.custom_locations || []).map((l: any) => ({
          lat: l.latitude, lng: l.longitude,
          radius_mi: l.distance_unit === "mile" ? l.radius : Math.round((l.radius || 0) * 0.621),
          address_string: l.address_string || l.name || null,
        }));
        const ta: any = (a.targeting as any)?.targeting_automation || {};
        return {
          adset_id: a.id, name: a.name, effective_status: a.effective_status,
          current_age:     [a.targeting?.age_min, a.targeting?.age_max],
          current_genders: a.targeting?.genders ?? "all",
          advantage_audience: ta.advantage_audience ?? null,  // 1=ON, 0=OFF, null=not set
          targeting_automation: ta,
          geo_custom_locations: customLocs,
          geo_cities:           geo.cities  || [],
          geo_zips:             geo.zips    || [],
          geo_regions:          geo.regions || [],
          geo_countries:        geo.countries || [],
        };
      }),
    });
  }

  // 3. LIVE — for each adset, fetch full targeting, apply delta, POST update
  const gPatch = normalizeGenders(changes.genders);
  const results: any[] = [];
  for (const a of adsets) {
    try {
      // Fetch full targeting (the list call returns only sub-fields we asked for)
      const cu = new URL(`https://graph.facebook.com/${FB_VERSION}/${a.id}`);
      cu.searchParams.set("fields", "name,targeting");
      cu.searchParams.set("access_token", token);
      const curRes = await fetch(cu);
      const cur = await curRes.json();
      if (!curRes.ok) {
        results.push({ adset_id: a.id, name: a.name, ok: false, step: "fetch_current", error: cur.error || cur });
        continue;
      }

      const targeting: any = JSON.parse(JSON.stringify(cur.targeting || {}));
      const applied: string[] = [];

      if (typeof changes.age_min === "number") { targeting.age_min = changes.age_min; applied.push(`age_min=${changes.age_min}`); }
      if (typeof changes.age_max === "number") { targeting.age_max = changes.age_max; applied.push(`age_max=${changes.age_max}`); }
      if (gPatch === "clear") { delete targeting.genders; applied.push("genders=all"); }
      else if (Array.isArray(gPatch)) { targeting.genders = gPatch; applied.push(`genders=[${gPatch.join(",")}]`); }

      // Any age change → also disable Advantage+ Audience automation (same
      // belt-and-suspenders as meta-ad-update, since Meta rejects age caps
      // <65 when Advantage+ is on).
      if (typeof changes.age_min === "number" || typeof changes.age_max === "number") {
        targeting.targeting_automation = targeting.targeting_automation || {};
        targeting.targeting_automation.advantage_audience = 0;
        applied.push("advantage_audience=off");
      }

      // 2026-06-17: Explicit clearAdvantage flag — turns OFF Advantage+
      // audience expansion AND removes any individual_setting overrides
      // (e.g. geo:1) that auto-expand the declared geo. WB had
      // individual_setting.geo = 1 which was auto-expanding the 5mi radius
      // and pushing WB ads into Bayside (10.5mi away).
      //
      // 2026-06-17 v2: Meta rejects sending an explicit individual_setting
      // object with zero values ("Invalid Targeting Automation Type"). Instead
      // we DELETE the individual_setting key entirely — Meta treats absence
      // as "all expansion features off."
      if ((changes as any).clearAdvantage === true) {
        targeting.targeting_automation = targeting.targeting_automation || {};
        targeting.targeting_automation.advantage_audience = 0;
        if (targeting.targeting_automation.individual_setting) {
          delete targeting.targeting_automation.individual_setting;
          applied.push("individual_setting=removed");
        }
        applied.push("advantage_audience=off");
      }

      if (applied.length === 0) {
        results.push({ adset_id: a.id, name: a.name, ok: false, skip: "no_changes_recognized" });
        continue;
      }

      const updateRes = await fetch(`https://graph.facebook.com/${FB_VERSION}/${a.id}`, {
        method: "POST",
        body: new URLSearchParams({ access_token: token, targeting: JSON.stringify(targeting) }),
      });
      const updateJson = await updateRes.json();
      if (!updateRes.ok) {
        results.push({ adset_id: a.id, name: a.name, ok: false, step: "update", applied, error: updateJson.error || updateJson });
        continue;
      }

      // Verify
      const v = await fetch(cu);
      const verify = await v.json();
      results.push({
        adset_id: a.id, name: a.name, ok: true, applied,
        before: {
          age:     [cur.targeting?.age_min,    cur.targeting?.age_max],
          genders: cur.targeting?.genders ?? "all",
        },
        after: {
          age:     [verify.targeting?.age_min, verify.targeting?.age_max],
          genders: verify.targeting?.genders ?? "all",
        },
      });
    } catch (e) {
      results.push({ adset_id: a.id, name: a.name, ok: false, step: "exception", error: (e as Error).message });
    }
  }

  return json({
    ok: results.every((r) => r.ok || r.skip),
    dry_run: false,
    studio,
    ad_account: cfg.adAccount,
    adsets_processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed:    results.filter((r) => !r.ok && !r.skip).length,
    results,
  });
});
