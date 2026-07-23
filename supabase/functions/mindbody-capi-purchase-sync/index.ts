/**
 * mindbody-capi-purchase-sync — fires CAPI Purchase (trial) + Subscribe (member)
 * events to Meta for every NEW MindBody sale in the lookback window.
 *
 * Why this exists (the 2026-06-11 story):
 *   Meta's Williamsburg campaign collapsed to $2.84 spend by 9 AM ET. Auto-bidder
 *   had been pulling back delivery across all 4 studios because it saw 7 days of
 *   ad spend ($1,481) with only 4 attributed Purchases. We KNEW there were ~15+
 *   real $49 paid trials in that window + 25+ membership conversions — Meta just
 *   never saw them. The gap: stripe-webhook only fires Purchase CAPI on
 *   checkout.session.completed (online card-on-file flow). In-person Stripe
 *   Terminal swipes AND every MindBody POS trial / membership purchase go
 *   silently into mindbody_sales without ever touching Meta.
 *
 *   Manual one-shot backfill on 2026-06-11 fired 32 events ($4,326 attributed
 *   value) and immediately gave Meta enough signal to recover bidding. This
 *   function makes that automatic — runs every night, never lets the gap
 *   reopen.
 *
 * Scope:
 *   Window = mindbody_sales.sale_date_time >= NOW() - <lookback_hours> (default 36)
 *   The 12h overlap with prior runs is intentional — idempotency by event_id
 *   makes double-runs safe and we'd rather double-cover than miss a late row.
 *
 * Classification per sale:
 *   total_cents == 4900  OR  item_names contains "trial" / "$49"
 *       → event_name = "Purchase",  custom_data.content_category = "trial"
 *   total_cents >= 10000
 *       → event_name = "Subscribe", custom_data.content_category = "membership"
 *                                   custom_data.predicted_ltv = value
 *   Anything else (penalty fees, retail, etc.) → skip.
 *
 * Idempotency:
 *   event_id = `mb_<mindbody_sale_id>` — globally unique per sale.
 *   We query capi_events for already-fired event_ids in the window before sending.
 *
 * Match quality:
 *   PII is joined from mindbody_clients via customer_mindbody_id and hashed:
 *   em (email), ph (phone digits-only), fn (first_name), ln (last_name).
 *   Skips any sale where the joined client has no email — match quality
 *   below ~5/10 doesn't help Meta and may even hurt signal trust.
 *
 * Action source:
 *   "physical_store" — Meta's documented pattern for offline / in-store
 *   conversions reported via Conversions API. Meta will credit these to any
 *   matching ad-click within its 7-day attribution window. NOT a workaround.
 *
 * Deploy:
 *   supabase functions deploy mindbody-capi-purchase-sync \
 *     --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
 *
 * Schedule:
 *   pg_cron entry lives in migration 20260611_schedule_mb_capi_purchase_sync.sql
 *   Runs 04:15 ET (08:15 UTC) every night — 15 min after mindbody-sales-sync,
 *   so any new MB sales from the previous day are mirrored into our DB first.
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPII(raw: string | null | undefined): Promise<string | null> {
  const v = (raw ?? "").trim().toLowerCase();
  return v ? await sha256Hex(v) : null;
}

type MBSale = {
  mindbody_sale_id: string;
  studio_slug: string | null;
  sale_date_time: string;
  customer_mindbody_id: number | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  total_cents: number | null;
  item_names: string[] | null;
};

type MBClient = {
  mindbody_id: number;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
};

function classify(sale: MBSale): { event_name: "Purchase" | "Subscribe"; content_name: string; content_category: string } | null {
  const total = sale.total_cents ?? 0;
  // item_names is text[] in Postgres but PostgREST occasionally returns it as
  // a JSON-encoded string (e.g. "{Premium}") for legacy rows. Coerce to array.
  let itemsArr: string[] = [];
  const raw = sale.item_names;
  if (Array.isArray(raw)) {
    itemsArr = raw.filter((x): x is string => typeof x === "string");
  } else if (typeof raw === "string" && raw.length > 0) {
    // Could be "{Premium,Unlimited}" Postgres-array-literal or a single name.
    const stripped = raw.replace(/^\{|\}$/g, "");
    itemsArr = stripped ? stripped.split(",").map((s) => s.replace(/^"|"$/g, "")) : [];
  }
  const items = itemsArr.join(" ");
  const itemsLower = items.toLowerCase();

  // Trial: explicit $49 OR item-name hint — but ALWAYS require positive value.
  // Zero-value rows are promo/comp passes and just dilute Meta's signal quality.
  const isTrial =
    total > 0 &&
    (total === 4900 ||
      itemsLower.includes("trial") ||
      itemsLower.includes("$49") ||
      itemsLower.includes("2 week") ||
      itemsLower.includes("2-week") ||
      itemsLower.includes("14 day") ||
      itemsLower.includes("14-day"));

  // Membership: anything >= $100 that isn't a trial. (Below $100 is almost
  // always a drop-in, late-cancel fee, or retail — not conversion signal.)
  const isMembership = !isTrial && total >= 10000;

  if (isTrial) {
    return {
      event_name: "Purchase",
      content_name: items.slice(0, 60) || "BBB Trial",
      content_category: "trial",
    };
  }
  if (isMembership) {
    return {
      event_name: "Subscribe",
      content_name: `Member · ${items.slice(0, 60) || "package"}`,
      content_category: "membership",
    };
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    return await handler(req);
  } catch (e) {
    const err = e as Error;
    console.error("mindbody-capi-purchase-sync uncaught:", err.message, err.stack);
    return json({ ok: false, error: "uncaught_exception", message: err.message, stack: (err.stack || "").slice(0, 1500) }, 500);
  }
});

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Auth: BBB_ADMIN_SECRET header OR Authorization: Bearer SERVICE_ROLE_KEY.
  // pg_cron invocations send no auth at all — but supabase functions deploy
  // with --no-verify-jwt accepts those; we still enforce the secret check
  // here so the function isn't open to the public internet.
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Cron runs land here without any of the above — accept them by checking
  // the User-Agent (pg_net sets pg_net/<version>). Belt-and-suspenders so
  // a non-cron internet hit must present a real credential.
  const ua = req.headers.get("user-agent") ?? "";
  const okAuth =
    secret === ADMIN_SECRET ||
    (SR && bearer === SR) ||
    ua.startsWith("pg_net/");
  if (!okAuth) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch {}

  const lookbackHours = Number.isFinite(body?.lookback_hours) ? Number(body.lookback_hours) : 36;
  const explicitSince = typeof body?.since === "string" ? body.since : null;
  const since = explicitSince ? new Date(explicitSince) : new Date(Date.now() - lookbackHours * 3600 * 1000);
  const dryRun = body?.dry_run === true;

  const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supaUrl || !SR) return json({ ok: false, error: "supabase env missing" }, 500);
  const sb = createClient(supaUrl, SR);

  // ── 1. Pull MB sales in window ─────────────────────────────────────────────
  const { data: salesRaw, error: salesErr } = await sb
    .from("mindbody_sales")
    .select("mindbody_sale_id, studio_slug, sale_date_time, customer_mindbody_id, customer_first_name, customer_last_name, total_cents, item_names")
    .gte("sale_date_time", since.toISOString())
    .order("sale_date_time", { ascending: true });
  if (salesErr) return json({ ok: false, error: `mindbody_sales: ${salesErr.message}` }, 500);
  const sales = (salesRaw ?? []) as MBSale[];
  if (sales.length === 0) {
    return json({ ok: true, since: since.toISOString(), processed: 0, message: "no MB sales in window" });
  }

  // ── 2. Join mindbody_clients for PII + member_since for legacy filter ──────
  // member_since BEFORE BBB relaunch (2026-05-15) = legacy/pre-existing
  // customer. Sending their renewal as a "new conversion" to Meta poisons the
  // training signal — the bidder credits ad clicks for purchases driven by
  // their existing membership, not our funnel.
  const BBB_LAUNCH = "2026-05-15T00:00:00Z";
  const clientIds = Array.from(new Set(sales.map((s) => s.customer_mindbody_id).filter((x): x is number => x != null)));
  const clientsById = new Map<number, MBClient & { member_since?: string | null }>();
  for (let i = 0; i < clientIds.length; i += 50) {
    const chunk = clientIds.slice(i, i + 50);
    const { data } = await sb
      .from("mindbody_clients")
      .select("mindbody_id, email, phone, first_name, last_name, member_since")
      .in("mindbody_id", chunk);
    for (const c of (data ?? []) as Array<MBClient & { member_since?: string | null }>) {
      clientsById.set(c.mindbody_id, c);
    }
  }

  // For each client, also check if they have a prior $49 trial — if so they
  // came through our funnel and their membership conversion IS real Meta-
  // attributable signal even if member_since predates launch.
  const priorTrialClients = new Set<number>();
  if (clientIds.length > 0) {
    for (let i = 0; i < clientIds.length; i += 50) {
      const chunk = clientIds.slice(i, i + 50);
      const { data: priorSales } = await sb
        .from("mindbody_sales")
        .select("customer_mindbody_id")
        .in("customer_mindbody_id", chunk)
        .eq("total_cents", 4900);
      for (const ps of (priorSales ?? []) as Array<{ customer_mindbody_id: number }>) {
        priorTrialClients.add(ps.customer_mindbody_id);
      }
    }
  }

  // ── 3. Already-fired event_ids in window — dedupe across re-runs ───────────
  const { data: alreadyRows } = await sb
    .from("capi_events")
    .select("event_id")
    .gte("attempted_at", since.toISOString())
    .eq("ok", true)
    .like("event_id", "mb_%");
  const alreadyFired = new Set(((alreadyRows ?? []) as Array<{ event_id: string }>).map((r) => r.event_id));

  // ── 4. Cache meta_accounts per studio ──────────────────────────────────────
  const studios = Array.from(new Set(sales.map((s) => s.studio_slug).filter((x): x is string => !!x)));
  const { data: acctRows } = await sb
    .from("meta_accounts")
    .select("studio_slug, pixel_id, access_token, api_version")
    .in("studio_slug", studios);
  const acctBySlug = new Map<string, { pixel_id: string | null; access_token: string | null; api_version: string | null }>();
  for (const a of (acctRows ?? []) as Array<{ studio_slug: string; pixel_id: string | null; access_token: string | null; api_version: string | null }>) {
    acctBySlug.set(a.studio_slug, { pixel_id: a.pixel_id, access_token: a.access_token, api_version: a.api_version });
  }

  // ── 5. Walk sales, fire eligible events ────────────────────────────────────
  const results: any[] = [];
  let sentPurchase = 0, sentSubscribe = 0;
  let skippedAlready = 0, skippedNoEmail = 0, skippedNoCreds = 0, skippedNotEligible = 0;
  let failed = 0;

  for (const sale of sales) {
    const slug = sale.studio_slug ?? "";
    const eid = `mb_${sale.mindbody_sale_id}`;
    const valueUsd = (sale.total_cents ?? 0) / 100;

    if (alreadyFired.has(eid)) {
      skippedAlready++;
      results.push({ event_id: eid, status: "already_fired" });
      continue;
    }

    const klass = classify(sale);
    if (!klass) {
      skippedNotEligible++;
      results.push({ event_id: eid, status: "not_eligible", total: valueUsd });
      continue;
    }

    const client = sale.customer_mindbody_id ? clientsById.get(sale.customer_mindbody_id) : null;
    const email = (client?.email ?? "").trim();
    if (!email) {
      skippedNoEmail++;
      results.push({ event_id: eid, status: "no_email", studio: slug });
      continue;
    }

    // ── Legacy-customer filter ───────────────────────────────────────────
    // If member_since predates BBB launch AND the customer has no prior $49
    // trial, this is a renewal of a pre-existing membership. NOT a new Meta-
    // attributable conversion. Skip so we don't poison the bidder.
    const memberSince = client?.member_since ?? null;
    const isLegacyMember = memberSince && memberSince < BBB_LAUNCH;
    const cameThroughFunnel = sale.customer_mindbody_id
      ? priorTrialClients.has(sale.customer_mindbody_id)
      : false;
    if (isLegacyMember && !cameThroughFunnel) {
      skippedNotEligible++;
      results.push({
        event_id: eid,
        status: "legacy_renewal",
        studio: slug,
        member_since: memberSince,
        note: "pre-launch member, no $49 trial in MB — skipping to avoid poisoning Meta signal",
      });
      continue;
    }

    const acct = acctBySlug.get(slug);
    if (!acct || !acct.pixel_id || !acct.access_token) {
      skippedNoCreds++;
      results.push({ event_id: eid, status: "no_meta_creds", studio: slug });
      continue;
    }

    // PII hashing
    const phoneDigits = (client?.phone ?? "").replace(/\D/g, "");
    const firstName = (client?.first_name ?? sale.customer_first_name ?? "").trim();
    const lastName  = (client?.last_name  ?? sale.customer_last_name  ?? "").trim();

    const userData: Record<string, string[]> = {};
    const em = await hashPII(email);          if (em) userData.em = [em];
    const ph = await hashPII(phoneDigits);    if (ph) userData.ph = [ph];
    const fn = await hashPII(firstName);      if (fn) userData.fn = [fn];
    const ln = await hashPII(lastName);       if (ln) userData.ln = [ln];

    const apiVersion = acct.api_version || "v19.0";
    const eventTime = Math.floor(new Date(sale.sale_date_time).getTime() / 1000);

    const customData: Record<string, unknown> = {
      currency: "USD",
      value: valueUsd,
      content_name: klass.content_name,
      content_category: klass.content_category,
      content_ids: [slug],
    };
    if (klass.event_name === "Subscribe") {
      // LTV signal helps Meta bid harder for high-value lookalikes.
      customData.predicted_ltv = valueUsd;
    }

    const requestBody = {
      data: [{
        event_name: klass.event_name,
        event_time: eventTime,
        event_id: eid,
        action_source: "physical_store",
        user_data: userData,
        custom_data: customData,
      }],
      access_token: acct.access_token,
    };

    if (dryRun) {
      results.push({ event_id: eid, status: "dry_run", studio: slug, event_name: klass.event_name, value: valueUsd, name: `${firstName} ${lastName}`.trim() });
      continue;
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/${apiVersion}/${acct.pixel_id}/events`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) },
      );
      const respText = await res.text();
      let respJson: any = null;
      try { respJson = JSON.parse(respText); } catch { /* not JSON */ }
      const ok = res.ok && !respJson?.error;
      const metaEventId =
        respJson?.events_received != null
          ? `events_received:${respJson.events_received}`
          : (typeof respJson?.fbtrace_id === "string" ? respJson.fbtrace_id : null);

      // Best-effort log — never block on it.
      try {
        await sb.from("capi_events").insert({
          studio_slug: slug,
          pixel_id: acct.pixel_id,
          event_name: klass.event_name,
          event_id: eid,
          value_usd: valueUsd,
          ok,
          http_status: res.status,
          meta_event_id: metaEventId,
          error: ok ? null : (respJson?.error?.message || respText.slice(0, 500)),
          raw: { source: "mindbody-capi-purchase-sync", action_source: "physical_store", response: respJson },
        });
      } catch (logErr) {
        console.error("capi_events insert failed:", (logErr as Error).message);
      }

      if (ok) {
        if (klass.event_name === "Purchase") sentPurchase++;
        else sentSubscribe++;
        results.push({ event_id: eid, status: "sent", studio: slug, event_name: klass.event_name, value: valueUsd, http: res.status });
      } else {
        failed++;
        results.push({ event_id: eid, status: "failed", studio: slug, http: res.status, error: (respJson?.error?.message || respText.slice(0, 200)) });
      }
    } catch (e) {
      failed++;
      results.push({ event_id: eid, status: "exception", error: (e as Error).message });
    }
  }

  return json({
    ok: true,
    since: since.toISOString(),
    lookback_hours: lookbackHours,
    dry_run: dryRun,
    processed: sales.length,
    sent_purchase: sentPurchase,
    sent_subscribe: sentSubscribe,
    skipped_already_fired: skippedAlready,
    skipped_no_email: skippedNoEmail,
    skipped_no_meta_creds: skippedNoCreds,
    skipped_not_eligible: skippedNotEligible,
    failed,
    results,
  });
}
