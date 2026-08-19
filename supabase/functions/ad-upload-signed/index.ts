/**
 * ad-upload-signed — hands the drag-and-drop page a secure, one-time upload slot
 * so the browser can push a large ad video straight to Supabase Storage
 * (bypassing edge-function size limits). Returns the public URL the video will
 * live at, which then feeds meta-ad-clone-video to run it as an ad.
 *
 * POST { filename }  ->  { signedUrl, token, path, publicUrl }
 * Auth: x-bbb-secret. Bucket "ad-uploads" (public) is created on first use.
 */
// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const BUCKET = "ad-uploads";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const sb = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // Ensure the public bucket exists — check first, create if missing, and
  // SURFACE a real failure instead of hiding it (the earlier version swallowed
  // the createBucket error, so a missing bucket showed up downstream as the
  // cryptic "related resource does not exist").
  const { data: existing } = await sb.storage.getBucket(BUCKET);
  if (!existing) {
    const { error: cerr } = await sb.storage.createBucket(BUCKET, { public: true });
    if (cerr && !/already exists/i.test(cerr.message)) {
      return json({ ok: false, error: `create bucket failed: ${cerr.message}` }, 500);
    }
  }

  let filename = "video.mp4";
  try { filename = (await req.json())?.filename || filename; } catch { /* default */ }
  const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const path = `${Date.now()}-${safe}`;

  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json({ ok: false, error: `signed url failed: ${error.message}` }, 500);

  const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}`;
  return json({ ok: true, signedUrl: data.signedUrl, token: data.token, path, publicUrl });
});
