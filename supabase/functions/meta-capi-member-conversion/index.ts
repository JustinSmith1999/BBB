/**
 * meta-capi-member-conversion — fires CAPI Subscribe/CustomEvent to Meta when
 * a paid-trial customer buys their first non-trial package (member conversion).
 *
 * Why: Meta Opportunity Score recommendation, "Connect CRM with Conversions
 * API → 24% lower cost per quality lead." The standard Purchase event from
 * the trial only tells Meta someone paid $49 — but Meta doesn't know which
 * trial customers turn into real members. Firing a downstream Subscribe
 * event for each member conversion lets Meta's algorithm distinguish
 * high-quality conversions from low-quality ones and find more like them.
 *
 * Trigger: idempotent cron, runs nightly.
 * Source of truth: public.get_converted_members() RPC.
 * Dedupe: capi_events.event_id LIKE 'member_<sha256email>_*' — if we've
 *   already fired for a given customer, skip. Stable across runs.
 *
 * Event details:
 *   event_name:    "Subscribe"
 *   custom_data.value:    total_member_rev_usd (LTV signal)
 *   custom_data.currency: USD
 *   custom_data.content_name: "Member · <package>" (the first non-trial pkg name)
 *   custom_data.predicted_ltv: same as value (Meta uses this for bidding)
 *
 * No browser-side pixel for this — it's a server-side data sync, not a
 * page event. Meta accepts CustomEvent fine for server-side.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Bbb-Secret",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPII(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  return await sha256Hex(v);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let dryRun = false;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      dryRun = body?.dry_run === true;
    }
  } catch { /* ignore */ }

  // 1) Pull converted members from the canonical RPC.
  const { data: members, error: membersErr } = await sb.rpc("get_converted_members");
  if (membersErr) {
    return json({ ok: false, error: "RPC failed: " + membersErr.message }, 500);
  }
  const memberList = (members || []) as Array<{
    studio_slug: string; customer_name: string; stripe_email: string;
    trial_paid_at: string; first_conversion_at: string;
    total_member_rev_usd: number; packages: string;
  }>;

  // 2) Pull all existing member CAPI event_ids so we can skip already-fired ones.
  const { data: existing } = await sb
    .from("capi_events")
    .select("event_id")
    .eq("event_name", "Subscribe");
  const seen = new Set((existing || []).map(r => r.event_id));

  // 3) For each unfired member, hash + POST to Meta CAPI.
  const results: Array<Record<string, unknown>> = [];
  let sent = 0, skipped = 0, failed = 0;

  for (const m of memberList) {
    const emailLower = (m.stripe_email || "").trim().toLowerCase();
    if (!emailLower) { skipped++; continue; }

    const emailHash = await sha256Hex(emailLower);
    const eventId = `member_${emailHash.slice(0, 16)}_${m.first_conversion_at.slice(0, 10)}`;
    if (seen.has(eventId)) {
      skipped++;
      results.push({ email: emailLower, studio: m.studio_slug, status: "already_fired", event_id: eventId });
      continue;
    }

    // Look up the studio's meta pixel + token.
    const { data: acct } = await sb
      .from("meta_accounts")
      .select("pixel_id, access_token, api_version")
      .eq("studio_slug", m.studio_slug)
      .maybeSingle();

    if (!acct?.pixel_id || !acct?.access_token) {
      failed++;
      results.push({ email: emailLower, studio: m.studio_slug, status: "no_meta_creds" });
      continue;
    }

    // Hash PII per CAPI spec.
    const parts = (m.customer_name || "").trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName  = parts.slice(1).join(" ");

    const userData: Record<string, string[]> = { em: [emailHash] };
    const fn = await hashPII(firstName); if (fn) userData.fn = [fn];
    const ln = await hashPII(lastName);  if (ln) userData.ln = [ln];

    const firstPkg = (m.packages || "").split(" | ")[0] || "Member package";
    const apiVersion = acct.api_version || "v19.0";
    const eventTime = Math.floor(new Date(m.first_conversion_at).getTime() / 1000);

    const requestBody = {
      data: [{
        event_name:       "Subscribe",
        event_time:       eventTime,
        event_id:         eventId,
        action_source:    "physical_store",  // Bought in-studio via MindBody, not online
        event_source_url: `https://betterbodybootcamp.com/locations/${m.studio_slug}`,
        user_data:        userData,
        custom_data: {
          currency:       "USD",
          value:          Number(m.total_member_rev_usd) || 0,
          predicted_ltv:  Number(m.total_member_rev_usd) || 0,
          content_name:   `Member · ${firstPkg.slice(0, 60)}`,
          content_category: "membership",
        },
      }],
      access_token: acct.access_token,
    };

    if (dryRun) {
      results.push({ email: emailLower, studio: m.studio_slug, status: "dry_run", event_id: eventId, value: m.total_member_rev_usd });
      continue;
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${acct.pixel_id}/events`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) },
      );
      const respText = await res.text();
      let respJson: Record<string, unknown> | null = null;
      try { respJson = JSON.parse(respText); } catch { /* not JSON */ }

      await sb.from("capi_events").insert({
        studio_slug:   m.studio_slug,
        pixel_id:      acct.pixel_id,
        event_name:    "Subscribe",
        event_id:      eventId,
        value_usd:     Number(m.total_member_rev_usd) || 0,
        ok:            res.ok,
        http_status:   res.status,
        meta_event_id: typeof respJson?.fbtrace_id === "string" ? respJson.fbtrace_id : null,
        error:         res.ok ? null : respText.slice(0, 500),
        raw:           respJson as Record<string, unknown>,
      });

      if (res.ok) {
        sent++;
        results.push({ email: emailLower, studio: m.studio_slug, status: "sent", event_id: eventId, http: res.status });
      } else {
        failed++;
        results.push({ email: emailLower, studio: m.studio_slug, status: "failed", http: res.status, error: respText.slice(0, 200) });
      }
    } catch (e) {
      failed++;
      results.push({ email: emailLower, studio: m.studio_slug, status: "exception", error: (e as Error).message });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    total_members: memberList.length,
    sent, skipped, failed,
    results,
  });
});
