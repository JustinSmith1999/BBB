/**
 * meta-ad-status — set ACTIVE / PAUSED on specific Meta ADS by id.
 *
 * Built 2026-10-09. Why it exists: every other meta-* function works at the
 * campaign or adset level. On 2026-10-09 the 16 new video ads were created into
 * the SAME adsets that hold the old creative, so there was no way to stop just
 * the new ones — campaign-pause killed the old ads too, and adset-pause has the
 * same problem. This is the missing per-ad switch.
 *
 * It ONLY reads and writes the `status` field of ads you name explicitly.
 * It never touches budget, targeting, creative, schedule, or anything else, and
 * it never discovers ads on its own — if an ad id is not in the body, it is not
 * touched.
 *
 * Body:
 *   {
 *     "studio":  "astoria" | "bayside" | "fresh-meadows" | "williamsburg",
 *     "status":  "PAUSED" | "ACTIVE",
 *     "ad_ids":  ["120254160147020195", "..."],
 *     "dry_run": true            // DEFAULT TRUE — lists current vs intended, writes nothing
 *   }
 *
 * Always reads each ad back AFTER the write and reports `verified_status`, so a
 * silent no-op from Meta (which is exactly what url_tags does) cannot be
 * mistaken for success. `ok` is false if any ad failed to land on the target.
 *
 * Auth: x-bbb-secret header. Deploy with --no-verify-jwt.
 * Env:  META_TOKEN_<STUDIO>
 *
 * Deploy: bbb deploy-fn meta-ad-status
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FB = "v19.0";
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const TOKENS: Record<string, string> = {
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
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function fbGet(path: string, token: string, fields: string) {
  const url = new URL(`https://graph.facebook.com/${FB}/${path}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("fields", fields);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
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
  if (!r.ok) throw new Error(`POST ${path} HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine, validation below catches it */ }

  const studio = String(body.studio || "").trim().toLowerCase();
  const target = String(body.status || "").trim().toUpperCase();
  const adIds: string[] = Array.isArray(body.ad_ids) ? body.ad_ids.map(String).filter(Boolean) : [];
  const dryRun = body.dry_run !== false; // default TRUE

  if (!TOKENS[studio]) return json({ ok: false, error: `unknown studio: ${studio}`, valid: Object.keys(TOKENS) }, 400);
  if (target !== "ACTIVE" && target !== "PAUSED") return json({ ok: false, error: 'status must be "ACTIVE" or "PAUSED"' }, 400);
  if (!adIds.length) return json({ ok: false, error: "ad_ids[] required — this function never discovers ads on its own" }, 400);

  const tokenEnv = (body.token_env && String(body.token_env)) || TOKENS[studio];
  const token = Deno.env.get(tokenEnv);
  if (!token) return json({ ok: false, error: `missing ${tokenEnv}` }, 500);

  const results: any[] = [];
  let allGood = true;

  for (const id of adIds) {
    const row: any = { ad_id: id };
    try {
      const before = await fbGet(id, token, "name,status,effective_status");
      row.name = before.name;
      row.status_before = before.status;
      row.effective_status_before = before.effective_status;

      if (dryRun) {
        row.action = before.status === target ? "already_" + target.toLowerCase() : "would_set_" + target.toLowerCase();
        results.push(row);
        continue;
      }

      if (before.status === target) {
        row.action = "already_" + target.toLowerCase();
        row.verified_status = before.status;
        results.push(row);
        continue;
      }

      await fbPost(id, token, { status: target });

      // Read back. A 200 from Meta is not proof the field changed.
      const after = await fbGet(id, token, "name,status,effective_status");
      row.verified_status = after.status;
      row.effective_status_after = after.effective_status;
      row.action = after.status === target ? "set_" + target.toLowerCase() : "write_ignored_by_meta";
      if (after.status !== target) allGood = false;
    } catch (e) {
      row.action = "failed";
      row.error = String(e);
      allGood = false;
    }
    results.push(row);
  }

  return json({
    ok: dryRun ? true : allGood,
    dry_run: dryRun,
    studio,
    target_status: target,
    count: results.length,
    note: dryRun
      ? "Nothing was written. Re-run with dry_run:false to apply."
      : "verified_status is a fresh read AFTER the write. Trust that, not the absence of an error.",
    results,
  });
});
