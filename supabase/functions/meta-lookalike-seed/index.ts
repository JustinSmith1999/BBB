/**
 * meta-lookalike-seed — full pipeline to seed Meta Lookalike audiences from
 * BBB converted members and attach them to each studio's $49 trial adset.
 *
 * Steps per studio (×4):
 *   1. Find-or-create Custom Audience "BBB Converted Members (hashed)"
 *   2. Upload hashed PII (email + first name + last name) — idempotent on Meta's side
 *   3. Find-or-create Lookalike Audience "BBB LAL 1% from Converted Members"
 *      from that CA — 1% United States, similarity type
 *   4. Attach the lookalike to the studio's active $49 trial adset (if not already)
 *
 * Seed source:
 *   - Default: get_converted_members() RPC (paid trial → bought member package).
 *     Currently 8 people. Meta's lookalike minimum is ~100, so this may fail
 *     at step 3 with error_subcode about audience size.
 *   - Fallback: pass {"seed":"paid_trials"} in POST body to use all paid-trial
 *     customers (~65 people). Lower signal but clears the minimum.
 *
 * Auth: requires x-bbb-secret header matching BBB_ADMIN_SECRET env var.
 *
 * Idempotent: re-running won't create duplicate CAs or LALs (matched by name),
 *   won't duplicate-upload users (Meta dedupes by hash), won't re-attach LALs.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CA_NAME  = "BBB Converted Members (hashed)";
const LAL_NAME = "BBB LAL 1% from Converted Members";

// Active $49 trial adsets confirmed live as of 2026-06-05 04:30 ET.
const ADSET_BY_STUDIO: Record<string, string> = {
  "williamsburg":  "6921905366977",
  "astoria":       "120248447137650195",
  "bayside":       "120243065873680436",
  "fresh-meadows": "120240952162140358",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bbb-Secret",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hash(raw: string | null | undefined): Promise<string> {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "";
  return await sha256Hex(v);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
  const presented = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (presented !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const seedSource: "converted_members" | "paid_trials" = body.seed === "paid_trials" ? "paid_trials" : "converted_members";
  const dryRun = body.dry_run === true;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // 1. Pull seed audience
  let seedRows: Array<{ email: string; name: string }> = [];
  if (seedSource === "converted_members") {
    const { data, error } = await sb.rpc("get_converted_members");
    if (error) return json({ ok: false, error: "RPC failed: " + error.message }, 500);
    seedRows = (data || []).map((m: any) => ({
      email: (m.stripe_email || "").trim().toLowerCase(),
      name:  (m.customer_name || "").trim(),
    })).filter((r: any) => r.email);
  } else {
    // Paid trials: every customer with payment_status='completed' since launch
    const { data, error } = await sb
      .from("trial_signups")
      .select("email, name")
      .eq("payment_status", "completed")
      .is("deleted_at", null)
      .gte("payment_date", "2026-05-15");
    if (error) return json({ ok: false, error: "trial_signups query failed: " + error.message }, 500);
    seedRows = (data || []).map((r: any) => ({
      email: (r.email || "").trim().toLowerCase(),
      name:  (r.name  || "").trim(),
    })).filter((r: any) => r.email);
  }

  // Dedupe by email
  const seen = new Set<string>();
  seedRows = seedRows.filter(r => {
    if (seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });

  // 2. Hash payload (schema: EMAIL, FN, LN)
  const hashedData: string[][] = [];
  for (const r of seedRows) {
    const parts = r.name.split(/\s+/);
    const fn = parts[0] || "";
    const ln = parts.slice(1).join(" ");
    hashedData.push([
      await hash(r.email),
      await hash(fn),
      await hash(ln),
    ]);
  }

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      seed_source: seedSource,
      seed_count: hashedData.length,
      note: hashedData.length < 100
        ? "WARNING: Meta minimum for lookalikes is ~100. Try seed='paid_trials' if step 3 fails."
        : "Seed size clears Meta's typical lookalike minimum.",
    });
  }

  // 3. For each studio: find-or-create CA → upload → find-or-create LAL → attach
  const studios = Object.entries(ADSET_BY_STUDIO);
  const perStudio: Array<Record<string, unknown>> = [];

  for (const [slug, adsetId] of studios) {
    const { data: acct, error: acctErr } = await sb
      .from("meta_accounts")
      .select("ad_account_id, access_token, api_version")
      .eq("studio_slug", slug)
      .maybeSingle();

    if (acctErr || !acct?.ad_account_id || !acct?.access_token) {
      perStudio.push({ studio: slug, ok: false, step: "meta_accounts_lookup", error: acctErr?.message || "missing ad_account_id/access_token" });
      continue;
    }

    const v = acct.api_version || "v19.0";
    const token = acct.access_token;
    const adAcct = acct.ad_account_id;
    const studioResult: Record<string, unknown> = { studio: slug, ad_account_id: adAcct };

    try {
      // 3a. Find existing Custom Audience by name
      let caId: string | null = null;
      const listUrl = `https://graph.facebook.com/${v}/${adAcct}/customaudiences?fields=id,name,subtype,approximate_count_lower_bound&limit=200&access_token=${encodeURIComponent(token)}`;
      const listRes = await fetch(listUrl);
      const listJson = await listRes.json();
      if (!listRes.ok) {
        studioResult.ok = false; studioResult.step = "list_audiences"; studioResult.error = listJson.error || listJson;
        perStudio.push(studioResult); continue;
      }
      const existingCa = (listJson.data || []).find((a: any) => a.name === CA_NAME && a.subtype === "CUSTOM");
      if (existingCa) {
        caId = existingCa.id;
        studioResult.ca_existed = true;
      } else {
        // 3b. Create Custom Audience
        const createRes = await fetch(`https://graph.facebook.com/${v}/${adAcct}/customaudiences`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            name: CA_NAME,
            subtype: "CUSTOM",
            description: "BBB paid trial customers who converted to a paid member package (hashed PII).",
            customer_file_source: "USER_PROVIDED_ONLY",
            access_token: token,
          }),
        });
        const createJson = await createRes.json();
        if (!createRes.ok) {
          studioResult.ok = false; studioResult.step = "create_ca"; studioResult.error = createJson.error || createJson;
          perStudio.push(studioResult); continue;
        }
        caId = createJson.id;
        studioResult.ca_created = true;
      }
      studioResult.ca_id = caId;

      // 3c. Upload hashed users
      const uploadRes = await fetch(`https://graph.facebook.com/${v}/${caId}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: {
            schema: ["EMAIL", "FN", "LN"],
            data: hashedData,
          },
          access_token: token,
        }),
      });
      const uploadJson = await uploadRes.json();
      if (!uploadRes.ok) {
        studioResult.ok = false; studioResult.step = "upload_users"; studioResult.error = uploadJson.error || uploadJson;
        perStudio.push(studioResult); continue;
      }
      studioResult.users_uploaded = uploadJson.num_received ?? hashedData.length;
      studioResult.users_invalid  = uploadJson.num_invalid_entries ?? 0;

      // 3d. Find existing Lookalike by name
      let lalId: string | null = null;
      const existingLal = (listJson.data || []).find((a: any) => a.name === LAL_NAME && a.subtype === "LOOKALIKE");
      if (existingLal) {
        lalId = existingLal.id;
        studioResult.lal_existed = true;
      } else {
        // 3e. Create Lookalike
        const lalRes = await fetch(`https://graph.facebook.com/${v}/${adAcct}/customaudiences`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            name: LAL_NAME,
            subtype: "LOOKALIKE",
            origin_audience_id: caId!,
            lookalike_spec: JSON.stringify({
              country: "US",
              ratio: 0.01,
              type: "similarity",
            }),
            access_token: token,
          }),
        });
        const lalJson = await lalRes.json();
        if (!lalRes.ok) {
          studioResult.ok = false; studioResult.step = "create_lal";
          studioResult.error = lalJson.error || lalJson;
          studioResult.hint = "If 'audience size too small': re-run with body {\"seed\":\"paid_trials\"} to use the wider ~65-person seed.";
          perStudio.push(studioResult); continue;
        }
        lalId = lalJson.id;
        studioResult.lal_created = true;
      }
      studioResult.lal_id = lalId;

      // 3f. Attach LAL to active $49 trial adset
      const adsetRes = await fetch(`https://graph.facebook.com/${v}/${adsetId}?fields=targeting,name&access_token=${encodeURIComponent(token)}`);
      const adsetJson = await adsetRes.json();
      if (!adsetRes.ok) {
        studioResult.ok = false; studioResult.step = "fetch_adset"; studioResult.error = adsetJson.error || adsetJson;
        perStudio.push(studioResult); continue;
      }
      const targeting = JSON.parse(JSON.stringify(adsetJson.targeting || {}));
      const ca: Array<{ id: string; name?: string }> = Array.isArray(targeting.custom_audiences) ? targeting.custom_audiences : [];
      const alreadyAttached = ca.some(a => a.id === lalId);

      if (alreadyAttached) {
        studioResult.adset_attach = "already_attached";
      } else {
        ca.push({ id: lalId!, name: LAL_NAME });
        targeting.custom_audiences = ca;
        const updateRes = await fetch(`https://graph.facebook.com/${v}/${adsetId}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            targeting: JSON.stringify(targeting),
            access_token: token,
          }),
        });
        const updateJson = await updateRes.json();
        if (!updateRes.ok) {
          studioResult.ok = false; studioResult.step = "attach_adset"; studioResult.error = updateJson.error || updateJson;
          perStudio.push(studioResult); continue;
        }
        studioResult.adset_attach = "attached";
        studioResult.adset_id = adsetId;
        studioResult.adset_name = adsetJson.name;
      }

      studioResult.ok = true;
    } catch (e) {
      studioResult.ok = false;
      studioResult.error = (e as Error).message;
    }

    perStudio.push(studioResult);
  }

  return json({
    ok: true,
    seed_source: seedSource,
    seed_count: hashedData.length,
    studios: perStudio,
  });
});
