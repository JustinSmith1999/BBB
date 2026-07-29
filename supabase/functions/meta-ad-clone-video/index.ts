/**
 * meta-ad-clone-video — clone a source ad's creative (page, copy, link, CTA,
 * targeting adset) and create NEW video ads from uploaded videos, then
 * optionally pause old ads. Built 2026-07-29 to swap Bayside creative.
 *
 * Auth: x-bbb-secret header. Deploy with --no-verify-jwt.
 * Env: META_TOKEN_<STUDIO> for the studio.
 *
 * POST body:
 *   {
 *     "studio": "bayside",
 *     "source_ad_id": "1202...",           // clone THIS ad's creative + adset
 *     "videos": [
 *       { "name": "BBB Bayside - Ad Video 5 (B&W)",  "url": "https://.../bayside-v1-bw.mp4",    "thumb_url": "https://.../bayside-v1-bw-thumb.jpg",  "video_id": "optional-if-already-uploaded" },
 *       { "name": "BBB Bayside - Ad Video 6 (Color)","url": "https://.../bayside-v1-color.mp4", "thumb_url": "https://.../bayside-v1-color-thumb.jpg" }
 *     ],
 *     "activate": true,                     // new ads start ACTIVE (default true)
 *     "pause_ad_ids": ["120...3","120...4"],// pause these after creating
 *     "dry_run": true                       // read-only: return source spec + plan, write nothing
 *   }
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const TOKENS: Record<string, string> = {
  williamsburg: "META_TOKEN_WILLIAMSBURG",
  astoria: "META_TOKEN_ASTORIA",
  bayside: "META_TOKEN_BAYSIDE",
  "fresh-meadows": "META_TOKEN_FRESH_MEADOWS",
};
const ACCOUNTS: Record<string, string> = {
  williamsburg: "act_26739874695621849",
  astoria: "act_1367835402069398",
  bayside: "act_4298533693762953",
  "fresh-meadows": "act_1301162772160251",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function fbGet(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`https://graph.facebook.com/${FB}/${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
}
async function fbPost(path: string, token: string, fields: Record<string, string>) {
  const form = new URLSearchParams();
  form.set("access_token", token);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const r = await fetch(`https://graph.facebook.com/${FB}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`POST ${path} HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitVideoReady(videoId: string, token: string, maxMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const s = await fbGet(videoId, token, { fields: "status" });
      const vs = s?.status?.video_status;
      if (vs === "ready") return "ready";
      if (vs === "error") return "error";
    } catch (_) { /* keep polling */ }
    await sleep(4000);
  }
  return "processing"; // proceed anyway; Meta finishes async
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if ((req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret")) !== ADMIN_SECRET)
    return json({ ok: false, error: "bad secret" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid JSON" }, 400); }

  const studio = String(body.studio || "").toLowerCase().trim();
  const sourceAdId = String(body.source_ad_id || "").trim();
  const videos: any[] = Array.isArray(body.videos) ? body.videos : [];
  const activate = body.activate !== false;
  const pauseIds: string[] = Array.isArray(body.pause_ad_ids) ? body.pause_ad_ids.map(String) : [];
  const dryRun = body.dry_run === true;

  if (!TOKENS[studio]) return json({ ok: false, error: `unknown studio: ${studio}` }, 400);
  if (!sourceAdId) return json({ ok: false, error: "source_ad_id required" }, 400);
  if (!videos.length) return json({ ok: false, error: "videos[] required" }, 400);

  const token = Deno.env.get(TOKENS[studio]);
  if (!token) return json({ ok: false, error: `missing ${TOKENS[studio]}` }, 500);
  const account = ACCOUNTS[studio];

  // 1. Read source ad → adset + creative spec (to clone)
  let src: any;
  try {
    src = await fbGet(sourceAdId, token, { fields: "name,adset_id,creative{id,object_story_spec,asset_feed_spec}" });
  } catch (e) { return json({ ok: false, error: `read source ad failed: ${String(e)}` }, 502); }

  const adsetId = src.adset_id;
  const oss = src?.creative?.object_story_spec || null;
  const hasVideoData = !!oss?.video_data;

  if (dryRun) {
    return json({
      ok: true, dry_run: true, studio, account,
      source: { ad_id: sourceAdId, name: src.name, adset_id: adsetId,
                object_story_spec: oss, asset_feed_spec: src?.creative?.asset_feed_spec || null,
                has_video_data: hasVideoData },
      plan: { create: videos.map((v) => ({ name: v.name, url: v.url, thumb_url: v.thumb_url })),
              activate, into_adset: adsetId, pause_after: pauseIds },
      note: hasVideoData
        ? "object_story_spec.video_data found — clean clone path. Will swap video_id + thumbnail."
        : "WARNING: source creative has no object_story_spec.video_data (may use asset_feed_spec). Review before live run.",
    });
  }

  if (!oss || !hasVideoData) {
    return json({ ok: false, error: "source creative is not a simple video creative (no object_story_spec.video_data). Aborting to avoid a malformed ad.", source_creative: { object_story_spec: oss, asset_feed_spec: src?.creative?.asset_feed_spec } }, 422);
  }

  const created: any[] = [];
  try {
    for (const v of videos) {
      // 2. Upload video (or reuse pre-uploaded id)
      let videoId = v.video_id ? String(v.video_id) : "";
      if (!videoId) {
        const up = await fbPost(`${account}/advideos`, token, { file_url: v.url, name: v.name });
        videoId = up.id;
      }
      const readyState = await waitVideoReady(videoId, token);

      // 3. Clone spec, swap video + thumbnail
      const newOss: any = JSON.parse(JSON.stringify(oss));
      newOss.video_data = { ...oss.video_data, video_id: videoId };
      if (v.thumb_url) { newOss.video_data.image_url = v.thumb_url; delete newOss.video_data.image_hash; }

      // 4. Create creative
      const cr = await fbPost(`${account}/adcreatives`, token, {
        name: `${v.name} — creative`,
        object_story_spec: JSON.stringify(newOss),
      });
      // 5. Create ad
      const ad = await fbPost(`${account}/ads`, token, {
        name: v.name,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: cr.id }),
        status: activate ? "ACTIVE" : "PAUSED",
      });
      created.push({ name: v.name, video_id: videoId, video_state: readyState, creative_id: cr.id, ad_id: ad.id, status: activate ? "ACTIVE" : "PAUSED" });
    }

    // 6. Pause old ads (only after new ones exist)
    const paused: any[] = [];
    for (const id of pauseIds) {
      try { await fbPost(id, token, { status: "PAUSED" }); paused.push({ ad_id: id, ok: true }); }
      catch (e) { paused.push({ ad_id: id, ok: false, error: String(e) }); }
    }

    return json({ ok: true, studio, account, adset_id: adsetId, created, paused });
  } catch (e) {
    return json({ ok: false, error: String(e), created_so_far: created, hint: "Re-run with video_id filled on any already-uploaded videos to avoid duplicate uploads." }, 502);
  }
});
