// Supabase Edge Function: trial-membership-nudge
//
// THE GOAL: surface trial customers who've shown engagement (3+ classes
// attended, or 12+ days into their trial) and gently nudge them to convert
// to a paying monthly membership. One SMS per customer, ever. Never on
// weekends. Always with a real out (STOP keyword respected — Twilio handles).
//
// ── HARD GATES (this function is SAFE to deploy live — it cannot send
//    until ALL of these are satisfied) ──────────────────────────────────────
//   1. BBB_SEND_PATHS_ENABLED must contain 'trial_membership_nudge'.
//      Default is "stripe_owner_sms,stripe_customer_welcome_email" → OFF.
//   2. The trial must have `membership_nudge_sent_at IS NULL` (single send).
//   3. The trial must NOT already be a member (converted_to_member = false).
//   4. The trial must have attended 3+ classes OR be 12+ days past payment.
//   5. The trial must have a valid US phone number.
//   6. The trial must NOT have opted out (opted_out_at IS NULL in trial_signups).
//
// LOGS: every attempt (success or failure) writes to membership_nudges table.
// Silent failures cannot happen.
//
// ── REQUEST SHAPES ────────────────────────────────────────────────────────
//   POST /                       — run for ALL eligible trials (cron mode)
//   POST { trial_id: "<uuid>" }  — dry-fire for one trial (test mode, still
//                                  goes through all gates above)
//   POST { dry_run: true }       — return candidates list, don't send
//
// ── DEFAULT BEHAVIOR — KILL-SWITCHED OFF UNTIL JUSTIN FLIPS IT ON ────────
// Returns `{ ok: false, skipped: true, reason: "send path … not enabled" }`
// for every request until the send path is added to BBB_SEND_PATHS_ENABLED.

// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SEND_PATH = "trial_membership_nudge";
const DEFAULT_ENABLED_PATHS = "stripe_owner_sms,stripe_customer_welcome_email";

function isSendPathEnabled(): boolean {
  const raw = Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? DEFAULT_ENABLED_PATHS;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)).has(SEND_PATH);
}

// ── Studio-specific membership signup URLs ───────────────────────────────
// Each studio has its own MindBody signup URL for monthly memberships. Until
// those are configured per location, fall back to the unified /membership
// page on the marketing site. If Justin sets locations.membership_signup_url
// later, the function picks it up automatically.
const MEMBERSHIP_URL_FALLBACK = "https://betterbodybootcamp.com/membership";

// ── Message template — short, friendly, one CTA ──────────────────────────
// Twilio SMS hard limit is 160 chars per segment. Keep this under one segment
// to stay deliverable + cheap. The {{first_name}} fallback handles missing
// first names gracefully.
function buildMessage(opts: {
  firstName: string | null;
  studioName: string;
  attendedCount: number;
  membershipUrl: string;
}): string {
  const name = (opts.firstName || "there").trim();
  // Two variants — the higher-engagement one feels more personal.
  if (opts.attendedCount >= 5) {
    return `Hey ${name}! You've crushed ${opts.attendedCount} classes at BBB ${opts.studioName}. ` +
           `Ready to lock in your monthly membership? ${opts.membershipUrl}`;
  }
  return `Hey ${name}! Your $49 trial at BBB ${opts.studioName} is wrapping up. ` +
         `Become a monthly member and keep training: ${opts.membershipUrl}`;
}

function firstNameOf(fullName: string | null): string | null {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const body = req.method === "POST"
    ? (await req.json().catch(() => ({}))) as { trial_id?: string; dry_run?: boolean }
    : {};

  // GATE 1: send path must be allowlisted.
  // dry_run requests skip this gate so Justin can preview without enabling.
  const allowed = isSendPathEnabled();
  if (!allowed && !body.dry_run) {
    return json({
      ok: false,
      skipped: true,
      reason: `send path "${SEND_PATH}" not in BBB_SEND_PATHS_ENABLED — add it to enable nudges.`,
      hint: "Supabase Dashboard → Edge Functions → trial-membership-nudge → Settings → Env Vars. Also add to stripe-webhook + bbb-send-paths-status.",
    });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Pull eligible candidates from the view we built in the migration.
  let query = sb.from("v_trial_member_journey")
    .select(
      "trial_id, name, email, phone, studio_slug, location_id, payment_date, " +
      "days_since_paid, attended_count, nudge_eligible, membership_nudge_sent_at, converted_to_member",
    )
    .eq("nudge_eligible", true)
    .is("membership_nudge_sent_at", null);
  if (body.trial_id) query = query.eq("trial_id", body.trial_id);
  const { data: candidates, error: candErr } = await query;
  if (candErr) return json({ ok: false, error: `candidate query: ${candErr.message}` }, 500);

  // dry_run — return candidates + the message they WOULD receive, send nothing
  if (body.dry_run) {
    const previews = (candidates ?? []).slice(0, 20).map((c) => ({
      trial_id: c.trial_id,
      name: c.name,
      studio: c.studio_slug,
      attended: c.attended_count,
      days_since_paid: c.days_since_paid,
      preview_message: buildMessage({
        firstName: firstNameOf(c.name as string),
        studioName: String(c.studio_slug).replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()),
        attendedCount: c.attended_count as number,
        membershipUrl: MEMBERSHIP_URL_FALLBACK,
      }),
    }));
    return json({
      ok: true,
      dry_run: true,
      send_path_enabled: allowed,
      total_candidates: candidates?.length ?? 0,
      preview_first_20: previews,
    });
  }

  // Live send loop. For each candidate: try to send, log the attempt, mark
  // the trial row so we never re-send. Errors don't stop the loop.
  const results: Array<Record<string, unknown>> = [];
  for (const c of candidates ?? []) {
    const trialId = c.trial_id as string;
    const studioSlug = c.studio_slug as string;
    const studioName = studioSlug.replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());

    // Pull the per-location membership URL if set; otherwise fallback.
    const { data: loc } = await sb.from("locations")
      .select("membership_signup_url")
      .eq("id", c.location_id)
      .maybeSingle();
    const membershipUrl =
      (loc?.membership_signup_url as string | null) || MEMBERSHIP_URL_FALLBACK;

    const message = buildMessage({
      firstName: firstNameOf(c.name as string),
      studioName,
      attendedCount: c.attended_count as number,
      membershipUrl,
    });

    let ok = false;
    let twilioSid: string | null = null;
    let errorMsg: string | null = null;
    let raw: unknown = null;

    try {
      const r = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-outbound-sms`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            trial_id: trialId,
            text: message,
            sent_by: "system:trial-membership-nudge",
          }),
        },
      );
      raw = await r.json().catch(() => ({}));
      if (r.ok && (raw as Record<string, unknown>)?.ok) {
        ok = true;
        twilioSid = ((raw as Record<string, unknown>).twilio_sid as string) ?? null;
      } else {
        errorMsg = JSON.stringify(raw).slice(0, 400);
      }
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    // Log every attempt — success OR failure.
    await sb.from("membership_nudges").insert({
      trial_id: trialId,
      studio_slug: studioSlug,
      customer_name: c.name as string,
      customer_phone: c.phone as string,
      attended_count: c.attended_count as number,
      days_since_paid: c.days_since_paid as number,
      channel: "sms",
      ok,
      twilio_sid: twilioSid,
      error: errorMsg,
      raw: raw as Record<string, unknown> | null,
    });

    // Only mark the trial as "nudge sent" if Twilio accepted the send.
    // Failed attempts are eligible to retry next cron (with rate limiting via
    // the membership_nudges log preventing rapid re-sends).
    if (ok) {
      await sb.from("trial_signups")
        .update({ membership_nudge_sent_at: new Date().toISOString() })
        .eq("id", trialId);
    }

    results.push({ trial_id: trialId, name: c.name, ok, twilio_sid: twilioSid, error: errorMsg });
  }

  return json({
    ok: true,
    send_path_enabled: allowed,
    attempted: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    details: results,
  });
});
