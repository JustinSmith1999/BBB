/**
 * meta-set-budget — set the DAILY BUDGET for a studio (or all studios).
 *
 * Built 2026-07 for "reduce Meta spend to $25/day per location."
 *
 * Meta puts the budget in one of two places:
 *   - CBO (Campaign Budget Optimization): budget lives on the CAMPAIGN.
 *   - ABO (Ad set Budget Optimization):   budget lives on each AD SET.
 * This function detects which, per active campaign, and sets the budget on the
 * correct object so the LOCATION TOTAL lands on the requested amount.
 *
 * Body:
 *   {
 *     "studio":       "bayside" | "astoria" | "fresh-meadows" | "williamsburg" | "all",
 *     "daily_usd":    25,          // target dollars/day (default 25)
 *     "mode":         "total",     // "total" (default) = location sums to daily_usd,
 *                                  //   split evenly across active budget entities.
 *                                  // "each"  = every active budget entity set to daily_usd.
 *     "dry_run":      true,        // default TRUE — writes nothing, shows the plan
 *     "include_paused": false      // default false — only ACTIVE campaigns/adsets
 *   }
 *
 * Auth: x-bbb-secret header (same as meta-ad-update / meta-bulk-target).
 * Env:  META_TOKEN_<STUDIO> per studio.
 *
 * Deploy:  supabase functions deploy meta-set-budget --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
 *          (or: bbb deploy-fn meta-set-budget)
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB_VERSION = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const MIN_CENTS = 100; // Meta USD minimum daily budget floor ($1.00)

const STUDIO_CONFIG: Record<string, { adAccount: string; tokenEnv: string; name: string }> = {
  williamsburg:    { adAccount: "act_26739874695621849", tokenEnv: "META_TOKEN_WILLIAMSBURG",  name: "Williamsburg" },
  astoria:         { adAccount: "act_1367835402069398",  tokenEnv: "META_TOKEN_ASTORIA",       name: "Astoria" },
  bayside:         { adAccount: "act_4298533693762953",  tokenEnv: "META_TOKEN_BAYSIDE",       name: "Bayside" },
  "fresh-meadows": { adAccount: "act_1301162772160251",  tokenEnv: "META_TOKEN_FRESH_MEADOWS", name: "Fresh Meadows" },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

const dollars = (cents: any) => (Number(cents) || 0) / 100;

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB_VERSION}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${JSON.stringify(body.error || body)}`);
  return body;
}

// One budget-holding entity we may write to.
interface Entity {
  level: "campaign" | "adset";
  id: string;
  name: string;
  current_cents: number;      // current daily_budget in cents (0 if none/lifetime)
  is_lifetime: boolean;       // lifetime-budget entities are NOT touched
  campaign_id?: string;
}

async function planStudio(slug: string, daily_usd: number, mode: string, includePaused: boolean, campaignIds?: Set<string>) {
  const cfg = STUDIO_CONFIG[slug];
  const token = Deno.env.get(cfg.tokenEnv);
  if (!token) return { studio: slug, name: cfg.name, ok: false, error: `missing env var: ${cfg.tokenEnv}` };

  const statusFilter = includePaused ? `["ACTIVE","PAUSED"]` : `["ACTIVE"]`;
  const filtering = `[{"field":"effective_status","operator":"IN","value":${statusFilter}}]`;
  const scoped = campaignIds && campaignIds.size > 0; // 2026-07-22: restrict to specific campaigns

  // 1. Active campaigns — CBO if they carry a daily_budget (or lifetime_budget).
  const campData = await fbGet(`${cfg.adAccount}/campaigns`, token, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget",
    filtering, limit: "200",
  });
  let campaigns = (campData.data || []) as any[];

  // 2. Active adsets — ABO budget lives here (daily_budget), tagged to campaign.
  const adsetData = await fbGet(`${cfg.adAccount}/adsets`, token, {
    fields: "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id",
    filtering, limit: "200",
  });
  let adsets = (adsetData.data || []) as any[];

  // 2026-07-22: The Bayside ad account also houses Fresh Meadows campaigns, so
  // an account-wide sweep touches the wrong studio. When campaign_ids is
  // supplied, keep only those campaigns (and adsets whose campaign is in scope).
  if (scoped) {
    campaigns = campaigns.filter((c) => campaignIds!.has(c.id));
    adsets = adsets.filter((a) => campaignIds!.has(a.campaign_id));
  }

  // 3. Classify. A campaign with a daily/lifetime budget is CBO → the campaign
  //    is the budget entity and its adsets are skipped. Otherwise (ABO) each of
  //    its adsets that carries a daily_budget is a budget entity.
  const entities: Entity[] = [];
  const cboCampaignIds = new Set<string>();
  for (const c of campaigns) {
    const hasDaily = Number(c.daily_budget) > 0;
    const hasLife = Number(c.lifetime_budget) > 0;
    if (hasDaily || hasLife) {
      cboCampaignIds.add(c.id);
      entities.push({
        level: "campaign", id: c.id, name: c.name,
        current_cents: Number(c.daily_budget) || 0, is_lifetime: hasLife && !hasDaily,
      });
    }
  }
  for (const a of adsets) {
    if (cboCampaignIds.has(a.campaign_id)) continue; // budget is on the CBO campaign
    const hasDaily = Number(a.daily_budget) > 0;
    const hasLife = Number(a.lifetime_budget) > 0;
    if (hasDaily || hasLife) {
      entities.push({
        level: "adset", id: a.id, name: a.name, campaign_id: a.campaign_id,
        current_cents: Number(a.daily_budget) || 0, is_lifetime: hasLife && !hasDaily,
      });
    }
  }

  const writable = entities.filter((e) => !e.is_lifetime);
  const lifetimeSkipped = entities.filter((e) => e.is_lifetime);
  const currentTotalCents = entities.reduce((s, e) => s + e.current_cents, 0);
  const targetCents = Math.round(daily_usd * 100);

  // 4. Assign new budgets.
  let targets: Record<string, number> = {};
  let note = "";
  if (writable.length === 0) {
    note = "No writable daily-budget entities found (all lifetime or none active).";
  } else if (mode === "each") {
    for (const e of writable) targets[e.id] = Math.max(MIN_CENTS, targetCents);
    note = `mode=each: every active budget entity set to $${daily_usd}/day.`;
  } else {
    // mode=total — split the target evenly so the LOCATION sums to daily_usd.
    const n = writable.length;
    const base = Math.floor(targetCents / n);
    let remainder = targetCents - base * n;
    for (const e of writable) {
      let c = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      targets[e.id] = Math.max(MIN_CENTS, c);
    }
    note = n === 1
      ? `mode=total: single active budget entity set to $${daily_usd}/day.`
      : `mode=total: $${daily_usd}/day split evenly across ${n} active budget entities.`;
  }
  const newTotalCents = writable.reduce((s, e) => s + (targets[e.id] || e.current_cents), 0);

  return {
    studio: slug, name: cfg.name, ad_account: cfg.adAccount, ok: true, note,
    current_total_daily_usd: dollars(currentTotalCents),
    new_total_daily_usd: dollars(newTotalCents),
    budget_type: entities.length === 0 ? "none"
      : entities.every((e) => e.level === "campaign") ? "CBO (campaign-level)"
      : entities.every((e) => e.level === "adset") ? "ABO (adset-level)" : "mixed",
    entities: entities.map((e) => ({
      level: e.level, id: e.id, name: e.name,
      current_daily_usd: dollars(e.current_cents),
      new_daily_usd: e.is_lifetime ? "SKIP (lifetime budget)" : dollars(targets[e.id] ?? e.current_cents),
    })),
    lifetime_skipped: lifetimeSkipped.map((e) => ({ level: e.level, id: e.id, name: e.name })),
    _writable: writable,   // internal, stripped before response
    _targets: targets,     // internal
    _token: token,         // internal
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if ((req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret")) !== ADMIN_SECRET) {
    return json({ ok: false, error: "bad secret" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON body" }, 400); }

  const studioIn = String(body.studio || "").trim().toLowerCase();
  const daily_usd = Number(body.daily_usd ?? 25);
  const mode = String(body.mode || "total").toLowerCase() === "each" ? "each" : "total";
  const dryRun = body.dry_run !== false; // default TRUE
  const includePaused = body.include_paused === true;
  const pause = body.pause === true;      // 2026-07-15: hard-pause all active campaigns
  const activate = body.activate === true; // 2026-07-20: turn paused campaigns back ON
  // 2026-07-22: optional campaign_ids — restrict pause/activate/budget to just
  // these campaigns. Needed because the Bayside ad account also holds Fresh
  // Meadows campaigns, so account-wide actions hit the wrong studio.
  const rawCampIds = Array.isArray(body.campaign_ids) ? body.campaign_ids
    : Array.isArray(body.campaigns) ? body.campaigns : [];
  const campaignIds = new Set<string>(rawCampIds.map((x: any) => String(x).trim()).filter(Boolean));
  const scoped = campaignIds.size > 0;

  if (!(daily_usd > 0) || daily_usd > 10000) {
    return json({ ok: false, error: "daily_usd must be a sane positive number (1–10000)" }, 400);
  }
  const slugs = studioIn === "all" ? Object.keys(STUDIO_CONFIG) : [studioIn];
  if (studioIn !== "all" && !STUDIO_CONFIG[studioIn]) {
    return json({ ok: false, error: `unknown studio: ${studioIn}`, valid: [...Object.keys(STUDIO_CONFIG), "all"] }, 400);
  }

  // ─── AUDIT MODE (read-only) ────────────────────────────────────────────────
  // {"studio":"bayside","audit_ads":true}
  // Lists every ad in the account with its status and its real destination URL,
  // pulled from the creative. Use it to confirm each ad points at the right
  // studio's page (e.g. a Bayside ad must land on /trial/bayside, not a Fresh
  // Meadows page). GET only — changes nothing. Honors campaign_ids to scope.
  if (body.audit_ads === true) {
    const pickUrls = (cr: any): string[] => {
      const urls = new Set<string>();
      const add = (u: any) => { if (u && typeof u === "string") urls.add(u); };
      if (!cr) return [];
      add(cr.link_url); add(cr.template_url);
      const oss = cr.object_story_spec || {};
      add(oss.link_data?.link);
      add(oss.video_data?.call_to_action?.value?.link);
      add(oss.template_data?.link);
      const afs = cr.asset_feed_spec || {};
      for (const l of (afs.link_urls || [])) add(l.website_url || l.display_url);
      return [...urls];
    };
    const out: any[] = [];
    for (const slug of slugs) {
      const cfg = STUDIO_CONFIG[slug];
      const token = Deno.env.get(cfg.tokenEnv);
      if (!token) { out.push({ studio: slug, name: cfg.name, ok: false, error: `missing env var: ${cfg.tokenEnv}` }); continue; }
      try {
        const filter = scoped
          ? `[{"field":"campaign.id","operator":"IN","value":[${[...campaignIds].map((c) => `"${c}"`).join(",")}]}]`
          : undefined;
        const params: Record<string, string> = {
          fields: "id,name,effective_status,campaign{id,name},creative{id,link_url,template_url,object_story_spec,asset_feed_spec}",
          limit: "200",
        };
        if (filter) params.filtering = filter;
        const data = await fbGet(`${cfg.adAccount}/ads`, token, params);
        const ads = ((data.data || []) as any[]).map((a) => ({
          ad: a.name,
          status: a.effective_status,
          campaign: a.campaign?.name || null,
          destination_urls: pickUrls(a.creative),
        }));
        out.push({ studio: slug, name: cfg.name, ok: true, ad_account: cfg.adAccount, ads });
      } catch (e) {
        out.push({ studio: slug, name: cfg.name, ok: false, error: String((e as Error).message || e) });
      }
    }
    return json({ ok: true, action: "audit_ads", locations: out });
  }

  // ─── PAUSE / ACTIVATE MODE ─────────────────────────────────────────────────
  // {"studio":"bayside","pause":true,"dry_run":false}    → ACTIVE campaigns → PAUSED (stop spend)
  // {"studio":"bayside","activate":true,"dry_run":false} → PAUSED campaigns → ACTIVE (turn on)
  // dry_run (default TRUE) previews. Re-run with dry_run:false to apply.
  if (pause || activate) {
    const targetStatus = pause ? "PAUSED" : "ACTIVE"; // what we set each campaign TO
    const fromStatus   = pause ? "ACTIVE" : "PAUSED"; // which campaigns to flip
    const out: any[] = [];
    for (const slug of slugs) {
      const cfg = STUDIO_CONFIG[slug];
      const token = Deno.env.get(cfg.tokenEnv);
      if (!token) { out.push({ studio: slug, name: cfg.name, ok: false, error: `missing env var: ${cfg.tokenEnv}` }); continue; }
      try {
        const camp = await fbGet(`${cfg.adAccount}/campaigns`, token, {
          fields: "id,name,effective_status",
          filtering: `[{"field":"effective_status","operator":"IN","value":["${fromStatus}"]}]`,
          limit: "500",
        });
        let camps = (camp.data || []) as any[];
        if (scoped) camps = camps.filter((c) => campaignIds.has(c.id)); // 2026-07-22: only named campaigns
        if (dryRun) {
          out.push({ studio: slug, name: cfg.name, dry_run: true, set_to: targetStatus, matched: camps.length, would_change: camps.map((c) => c.name) });
          continue;
        }
        const results: any[] = [];
        for (const c of camps) {
          const r = await fetch(`https://graph.facebook.com/${FB_VERSION}/${c.id}`, {
            method: "POST",
            body: new URLSearchParams({ access_token: token, status: targetStatus }),
          });
          const jr = await r.json();
          results.push({ id: c.id, name: c.name, set_to: targetStatus, ok: r.ok, ...(r.ok ? {} : { error: jr.error?.error_user_msg || jr.error?.message || jr.error || jr }) });
        }
        out.push({ studio: slug, name: cfg.name, changed_count: results.filter((x) => x.ok).length, campaigns: results });
      } catch (e) {
        out.push({ studio: slug, name: cfg.name, ok: false, error: String((e as Error).message || e) });
      }
    }
    return json({ ok: true, action: pause ? "pause" : "activate", dry_run: dryRun, locations: out });
  }

  const plans: any[] = [];
  for (const slug of slugs) {
    try { plans.push(await planStudio(slug, daily_usd, mode, includePaused, campaignIds)); }
    catch (e) { plans.push({ studio: slug, ok: false, error: String((e as Error).message || e) }); }
  }

  // DRY RUN — strip internals, return the plan only.
  if (dryRun) {
    return json({
      ok: true, dry_run: true, mode, daily_usd,
      summary: "Review current_daily_usd vs new_daily_usd per location. Re-run with dry_run:false to apply.",
      locations: plans.map(({ _writable, _targets, _token, ...pub }) => pub),
    });
  }

  // LIVE — POST daily_budget to each writable entity.
  for (const p of plans) {
    if (!p.ok || !p._writable) { p.applied = []; continue; }
    const applied: any[] = [];
    for (const e of p._writable as Entity[]) {
      const cents = (p._targets as Record<string, number>)[e.id];
      if (!cents) continue;
      try {
        const r = await fetch(`https://graph.facebook.com/${FB_VERSION}/${e.id}`, {
          method: "POST",
          body: new URLSearchParams({ access_token: p._token, daily_budget: String(cents) }),
        });
        const jr = await r.json();
        applied.push({
          level: e.level, id: e.id, name: e.name,
          set_daily_usd: dollars(cents), ok: r.ok,
          ...(r.ok ? {} : { error: jr.error?.error_user_msg || jr.error?.message || jr.error || jr }),
        });
      } catch (err) {
        applied.push({ level: e.level, id: e.id, name: e.name, ok: false, error: String((err as Error).message || err) });
      }
    }
    p.applied = applied;
  }

  return json({
    ok: true, dry_run: false, mode, daily_usd,
    locations: plans.map(({ _writable, _targets, _token, ...pub }) => pub),
  });
});
