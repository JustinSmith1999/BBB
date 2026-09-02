import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// mt-webhook — receiver for Mariana Tek webhook events (2026-08-21).
//
// Xplor/MT (Joe M, Partnerships) is configuring webhooks for tenant 10025 to
// point here. Events requested: order.completed, order.refunded,
// membership.purchased, membership.activated, membership.deactivated,
// reservation.checkedin.
//
// DESIGN: this function does NOT duplicate the order-processing business
// logic. It (1) logs the raw event to mt_webhook_events, then (2) kicks the
// existing mt-orders-sync incremental run, which already handles the sales
// mirror, trial_signups, welcome flows, and owner SMS — now in real time
// instead of on the cron. reservation.* events are logged only for now
// (future: review-ask trigger on checkin).
//
// SECURITY: MT signs webhook payloads — once Joe sends the signing details,
// set MT_WEBHOOK_SIGNING_SECRET and fill in verifySignature(). Until the
// secret is set, we accept but mark rows unverified (header snapshot is kept
// on each row so we can see exactly which signature header MT sends).
//
// Deploy: bbb deploy-fn mt-webhook   (public endpoint, --no-verify-jwt)
// Requires table (run supabase/migrations/20260821_mt_webhook_events.sql):
//   mt_webhook_events(id, action, tenant, event_datetime, payload, headers,
//                     verified, sync_kicked, received_at)
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "bbb-test-2026-05-27";

function sb() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Placeholder until MT provides signing details. Return values:
//   true  -> signature checked and valid
//   false -> signature checked and INVALID (reject)
//   null  -> no secret configured yet, cannot check (accept, mark unverified)
async function verifySignature(req: Request, rawBody: string): Promise<boolean | null> {
  const secret = Deno.env.get("MT_WEBHOOK_SIGNING_SECRET");
  if (!secret || !secret.trim()) return null;
  // Most MT-style webhooks use an HMAC-SHA256 hex digest of the raw body in a
  // signature header. Try the common header names; tighten this up to the
  // exact spec once Joe's docs arrive.
  const candidates = ["x-mariana-signature", "x-mt-signature", "x-hub-signature-256", "x-signature"];
  let provided: string | null = null;
  for (const h of candidates) {
    const v = req.headers.get(h);
    if (v) { provided = v.replace(/^sha256=/, "").trim(); break; }
  }
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret.trim()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === provided.toLowerCase();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const rawBody = await req.text();
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(rawBody); } catch { /* keep raw in log below */ }

  const verified = await verifySignature(req, rawBody);
  if (verified === false) {
    return json({ ok: false, error: "invalid signature" }, 401);
  }

  const action = String(payload["action"] ?? "unknown");
  const tenant = String(payload["tenant"] ?? "");
  const eventDatetime = typeof payload["event_datetime"] === "string"
    ? payload["event_datetime"] as string
    : null;

  // Snapshot headers (minus auth-ish ones) so we can identify MT's signature
  // header from real traffic before the docs arrive.
  const headerSnapshot: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!/authorization|cookie/i.test(k)) headerSnapshot[k] = k.toLowerCase().includes("signature") ? v.slice(0, 12) + "..." : v;
  });

  // Orders + memberships kick the sync; reservations/profiles just log.
  const kickActions = /^(order|membership)\./.test(action);
  let syncKicked = false;

  const client = sb();
  try {
    await client.from("mt_webhook_events").insert({
      action,
      tenant,
      event_datetime: eventDatetime,
      payload: payload && Object.keys(payload).length ? payload : { raw: rawBody.slice(0, 4000) },
      headers: headerSnapshot,
      verified: verified === true,
    });
  } catch (e) {
    console.error("mt_webhook_events insert failed:", (e as Error).message);
  }

  if (kickActions) {
    try {
      // Fire-and-forget incremental sync — it is cursor-based and idempotent,
      // so a burst of events collapsing into one run is fine.
      const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/mt-orders-sync`;
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bbb-secret": ADMIN_SECRET },
        body: JSON.stringify({}),
      }).catch((e) => console.error("sync kick failed:", (e as Error).message));
      syncKicked = true;
    } catch (e) {
      console.error("sync kick failed:", (e as Error).message);
    }
  }

  // ── 2026-08-28: CHURN RADAR — membership deactivated/suspended → text the
  //    studio owners the same day, not in a month-end report. Gated on
  //    BBB_SEND_PATHS_ENABLED containing 'churn_alert'. Payload parsing is
  //    defensive (MT's exact webhook shape is still being observed); when we
  //    can't extract the member, we log-and-skip — the raw event is stored
  //    above either way, nothing is lost.
  if (/^membership\.(deactivated|suspended)$/.test(action)) {
    try {
      const paths = (Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "").split(",").map((s) => s.trim());
      if (paths.includes("churn_alert")) {
        const d = (payload["data"] ?? {}) as Record<string, unknown>;
        const dig = (o: unknown, ...keys: string[]): unknown => {
          let cur: unknown = o;
          for (const k of keys) { if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k]; else return undefined; }
          return cur;
        };
        const memberName = String(
          dig(d, "user", "first_name") ?? dig(d, "attributes", "user_name") ?? dig(d, "customer", "first_name") ?? "",
        ) + " " + String(dig(d, "user", "last_name") ?? dig(d, "customer", "last_name") ?? "");
        const memberEmail = String(dig(d, "user", "email") ?? dig(d, "customer", "email") ?? dig(d, "attributes", "email") ?? "");
        const locId = String(dig(d, "location", "id") ?? dig(d, "attributes", "location_id") ?? "");
        const SLUG_BY_MT_LOC: Record<string, string> = { "48717": "astoria", "48718": "bayside", "48719": "fresh-meadows", "48720": "williamsburg" };
        const slug = SLUG_BY_MT_LOC[locId] ?? null;
        const who = (memberName.trim() || memberEmail || "a member").trim();
        const kind = action.endsWith("suspended") ? "FROZE their membership" : "CANCELED their membership";
        if (who !== "a member" || slug) {
          // owners for the studio (or all owners if studio unknown)
          let q = client.from("location_owners").select("phone, location_id");
          const { data: owners } = await q;
          const { data: locs } = await client.from("locations").select("id, name");
          const slugOf = (id: string) => (locs ?? []).find((l) => l.id === id)?.name?.toLowerCase().replace(/\s+/g, "-") ?? null;
          const targets = (owners ?? []).filter((o) => !slug || slugOf(o.location_id) === slug);
          const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
          const twTok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
          const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
          const smsBody = `BBB churn alert${slug ? " " + slug.replace("-", " ") : ""}: ${who} ${kind} today. A same-day call saves more members than any winback text.`;
          const seen = new Set<string>();
          for (const o of targets) {
            if (!o.phone || seen.has(o.phone)) continue;
            seen.add(o.phone);
            fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
              method: "POST",
              headers: { Authorization: "Basic " + btoa(`${twSid}:${twTok}`), "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ From: twFrom, To: o.phone, Body: smsBody }),
            }).then((r) => {
              client.from("sms_messages").insert({
                studio_slug: slug, direction: "outbound", from_phone: twFrom, to_phone: o.phone,
                body: smsBody, status: r.ok ? "queued" : "failed",
                sent_by: "mt-webhook", sent_at: new Date().toISOString(), send_path: "churn_alert",
              }).then(() => {});
            }).catch((e) => console.error("churn alert sms failed:", (e as Error).message));
          }
        }
      }
    } catch (e) {
      console.error("churn radar failed:", (e as Error).message);
    }
  }

  // ── 2026-08-28: CHECK-IN REVIEW TRIGGER — on a member's 3rd check-in, kick
  //    trial-review-request in targeted mode for that person. The engine
  //    itself enforces once-ever, opt-outs, and the send-path gate, so this
  //    is safe to fire liberally. Defensive payload parsing, log-and-skip.
  if (action === "reservation.checkedin") {
    try {
      const d = (payload["data"] ?? {}) as Record<string, unknown>;
      const dig = (o: unknown, ...keys: string[]): unknown => {
        let cur: unknown = o;
        for (const k of keys) { if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k]; else return undefined; }
        return cur;
      };
      const email = String(dig(d, "user", "email") ?? dig(d, "customer", "email") ?? dig(d, "attributes", "email") ?? "").toLowerCase();
      if (email && email.includes("@")) {
        const url = `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/trial-review-request`;
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-bbb-secret": ADMIN_SECRET },
          body: JSON.stringify({ live: true, target_email: email, trigger: "checkin" }),
        }).catch((e) => console.error("review trigger failed:", (e as Error).message));
      }
    } catch (e) {
      console.error("checkin review trigger failed:", (e as Error).message);
    }
  }

  return json({ ok: true, action, verified: verified === true, sync_kicked: syncKicked });
});
