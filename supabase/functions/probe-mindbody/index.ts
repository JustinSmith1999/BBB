// ─────────────────────────────────────────────────────────────────────────────
// probe-mindbody — heartbeat check for MindBody API credentials.
//
// MindBody-trial-sync + MindBody-visits-sync run hourly and silently fail if
// the API token expires or the staff password rotates. We learned today that
// silent failures eat weeks of data before anyone notices.
//
// This function:
//   1. Authenticates against MindBody Public API v6
//   2. Pulls one tiny test record (just to confirm the call succeeds)
//   3. Returns a JSON status block — easy to glance at, easy to alert on
//
// Called by a daily cron + can be hit manually from /ops.
//
// Deploy: supabase functions deploy probe-mindbody --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Studio site IDs — kept in sync with mindbody-trial-sync. These are MindBody's
// numeric studio IDs (not BBB's location slugs).
const STUDIO_SITES: Record<string, string> = {
  "williamsburg":  Deno.env.get("MB_SITE_WILLIAMSBURG")  || "",
  "astoria":       Deno.env.get("MB_SITE_ASTORIA")        || "",
  "bayside":       Deno.env.get("MB_SITE_BAYSIDE")        || "",
  "fresh-meadows": Deno.env.get("MB_SITE_FRESH_MEADOWS")  || "",
};

const MB_API_KEY    = Deno.env.get("MINDBODY_API_KEY")  || "";
const MB_STAFF_USER = Deno.env.get("MINDBODY_STAFF_USER") || "";
const MB_STAFF_PASS = Deno.env.get("MINDBODY_STAFF_PASS") || "";

interface StudioStatus {
  studio: string;
  site_id: string;
  ok: boolean;
  token_obtained: boolean;
  test_call_status: number | null;
  error: string | null;
  latency_ms: number;
}

async function probeStudio(studio: string, siteId: string): Promise<StudioStatus> {
  const t0 = Date.now();
  const result: StudioStatus = {
    studio, site_id: siteId, ok: false,
    token_obtained: false, test_call_status: null,
    error: null, latency_ms: 0,
  };
  if (!siteId) {
    result.error = "MB_SITE_* env var not set";
    return result;
  }
  if (!MB_API_KEY || !MB_STAFF_USER || !MB_STAFF_PASS) {
    result.error = "MINDBODY_API_KEY / MINDBODY_STAFF_USER / MINDBODY_STAFF_PASS missing";
    return result;
  }
  try {
    // Step 1 — get a staff token
    const tokenRes = await fetch("https://api.mindbodyonline.com/public/v6/usertoken/issue", {
      method: "POST",
      headers: {
        "Api-Key": MB_API_KEY,
        "SiteId": siteId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Username: MB_STAFF_USER, Password: MB_STAFF_PASS }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson?.AccessToken) {
      result.error = `token request failed (${tokenRes.status}): ${JSON.stringify(tokenJson).slice(0, 200)}`;
      result.latency_ms = Date.now() - t0;
      return result;
    }
    result.token_obtained = true;

    // Step 2 — lightweight test call: list 1 location
    const testRes = await fetch("https://api.mindbodyonline.com/public/v6/site/locations?limit=1", {
      headers: {
        "Api-Key": MB_API_KEY,
        "SiteId": siteId,
        "Authorization": tokenJson.AccessToken,
      },
    });
    result.test_call_status = testRes.status;
    if (testRes.ok) {
      result.ok = true;
    } else {
      const bodyText = await testRes.text();
      result.error = `test call failed (${testRes.status}): ${bodyText.slice(0, 200)}`;
    }
  } catch (e) {
    result.error = (e as Error).message;
  }
  result.latency_ms = Date.now() - t0;
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: cors });
  }
  const studios = await Promise.all(
    Object.entries(STUDIO_SITES).map(([slug, siteId]) => probeStudio(slug, siteId))
  );
  const allOk = studios.every(s => s.ok);
  const body = {
    ok: allOk,
    as_of: new Date().toISOString(),
    mb_api_key_present:  !!MB_API_KEY,
    mb_staff_user_present: !!MB_STAFF_USER,
    mb_staff_pass_present: !!MB_STAFF_PASS,
    studios,
    summary: allOk
      ? "All MindBody credentials healthy"
      : `${studios.filter(s => !s.ok).length} of ${studios.length} studios FAILING`,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: allOk ? 200 : 500,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
