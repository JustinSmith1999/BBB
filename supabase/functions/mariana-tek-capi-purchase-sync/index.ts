/**
 * mariana-tek-capi-purchase-sync — fires CAPI Purchase (trial) + Subscribe
 * (member) events to Meta for every NEW Mariana Tek sale in the lookback
 * window. Mirrors `mindbody-capi-purchase-sync` exactly — same classify(),
 * same hashing, same dedupe, same eligibility filters — just swaps the
 * source table from `mindbody_sales` → `mariana_tek_sales` and the client
 * join from `mindbody_clients` → `mariana_tek_clients`.
 *
 * Idempotency: event_id = `mt_<mt_sale_id>` (globally unique per sale).
 * Distinct prefix from `mb_<…>` so MB + MT can run side-by-side during the
 * cutover without dedupe collisions.
 *
 * Schedule: pg_cron — 04:20 ET nightly (5 min after mariana-tek-sales-sync,
 * which itself runs after mindbody-* during the cutover overlap window).
 *
 * Deploy:
 *   supabase functions deploy mariana-tek-capi-purchase-sync \
 *     --no-verify-jwt --project-ref uracuwugpxqjfgtuobal
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

type MTSale = {
  mt_sale_id: string;
  studio_slug: string | null;
  sale_date_time: string;
  customer_mt_id: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  total_cents: number | null;
  item_names: string[] | string | null;
};

type MTClient = {
  mt_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at_mt?: string | null;
};

function classify(sale: MTSale): { event_name: "Purchase" | "Subscribe"; content_name: string; content_category: string } | null {
  const total = sale.total_cents ?? 0;
  let itemsArr: string[] = [];
  const raw = sale.item_names;
  if (Array.isArray(raw)) {
    itemsArr = raw.filter((x): x is string => typeof x === "string");
  } else if (typeof raw === "string" && raw.length > 0) {
    const stripped = raw.replace(/^\{|\}$/g, "");
    itemsArr = stripped ? stripped.split(/[,·]/).map((s) => s.replace(/^"|"$/g, "").trim()) : [];
  }
  const items = itemsArr.join(" ");
  const itemsLower = items.toLowerCase();

  const isTrial =
    total > 0 &&
    (total === 4900 ||
      itemsLower.includes("trial") ||
      itemsLower.includes("$49") ||
      itemsLower.includes("2 week") ||
      itemsLower.includes("2-week") ||
      itemsLower.includes("14 day") ||
      itemsLower.includes("14-day"));

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
    console.error("mariana-tek-capi-purchase-sync uncaught:", err.message, err.stack);
    return json({ ok: false, error: "uncaught_exception", message: err.message, stack: (err.stack || "").slice(0, 1500) }, 500);
  }
});

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
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

  // ── 1. Pull MT sales in window ────────────────────────────────────────────
  const { data: salesRaw, error: salesErr } = await sb
    .from("mariana_tek_sales")
    .select("mt_sale_id, studio_slug, sale_date_time, customer_mt_id, customer_first_name, customer_last_name, customer_email, total_cents, item_names")
    .gte("sale_date_time", since.toISOString())
    .order("sale_date_time", { ascending: true });
  if (salesErr) return json({ ok: false, error: `mariana_tek_sales: ${salesErr.message}` }, 500);
  const sales = (salesRaw ?? []) as MTSale[];
  if (sales.length === 0) {
    return json({ ok: true, since: since.toISOString(), processed: 0, message: "no MT sales in window" });
  }

  // ── 2. Join mariana_tek_clients for PII + created_at_mt for legacy filter ─
  const BBB_LAUNCH = "2026-05-15T00:00:00Z";
  const clientIds = Array.from(new Set(sales.map((s) => s.customer_mt_id).filter((x): x is string => !!x)));
  const clientsById = new Map<string, MTClient>();
  for (let i = 0; i < clientIds.length; i += 50) {
    const chunk = clientIds.slice(i, i + 50);
    const { data } = await sb
      .from("mariana_tek_clients")
      .select("mt_id, email, phone, first_name, last_name, created_at_mt")
      .in("mt_id", chunk);
    for (const c of (data ?? []) as MTClient[]) {
      clientsById.set(c.mt_id, c);
    }
  }

  // Customers who have a prior $49 trial in MT sales → came through the funnel.
  const priorTrialClients = new Set<string>();
  if (clientIds.length > 0) {
    for (let i = 0; i < clientIds.length; i += 50) {
      const chunk = clientIds.slice(i, i + 50);
      const { data: priorSales } = await sb
        .from("mariana_tek_sales")
        .select("customer_mt_id")
        .in("customer_mt_id", chunk)
        .eq("total_cents", 4900);
      for (const ps of (priorSales ?? []) as Array<{ customer_mt_id: string }>) {
        priorTrialClients.add(ps.customer_mt_id);
      }
    }
  }

  // ── 3. Already-fired event_ids in window ─────────────────────────────────
  const { data: alreadyRows } = await sb
    .from("capi_events")
    .select("event_id")
    .gte("attempted_at", since.toISOString())
    .eq("ok", true)
    .like("event_id", "mt_%");
  const alreadyFired = new Set(((alreadyRows ?? []) as Array<{ event_id: string }>).map((r) => r.event_id));

  // ── 4. Cache meta_accounts per studio ────────────────────────────────────
  const studios = Array.from(new Set(sales.map((s) => s.studio_slug).filter((x): x is string => !!x)));
  const { data: acctRows } = await sb
    .from("meta_accounts")
    .select("studio_slug, pixel_id, access_token, api_version")
    .in("studio_slug", studios);
  const acctBySlug = new Map<string, { pixel_id: string | null; access_token: string | null; api_version: string | null }>();
  for (const a of (acctRows ?? []) as Array<{ studio_slug: string; pixel_id: string | null; access_token: string | null; api_version: string | null }>) {
    acctBySlug.set(a.studio_slug, { pixel_id: a.pixel_id, access_token: a.access_token, api_version: a.api_version });
  }

  // ── 4b. Join trial_signups for the BROWSER match signals (fbp/fbc/IP/UA) ──
  // These are captured client-side on the trial page + create-trial-checkout.
  // They're what let Meta tie this server-side purchase back to the original
  // ad click. Without them the event has only hashed PII and lands as a weak
  // "physical_store" conversion Meta will NOT credit to the website ad sets —
  // which is exactly why Bayside showed spend with ~0 attributed purchases.
  type Match = { fbp: string | null; fbc: string | null; client_ip: string | null; client_user_agent: string | null };
  const matchByEmail = new Map<string, Match>();
  const emailSet = new Set<string>();
  for (const s of sales) {
    const e = ((s.customer_email || clientsById.get(s.customer_mt_id || "")?.email || "") as string).trim().toLowerCase();
    if (e) emailSet.add(e);
  }
  const emailList = Array.from(emailSet);
  const sig = (m: Partial<Match> | undefined) => (m?.fbc ? 2 : 0) + (m?.fbp ? 1 : 0) + (m?.client_ip ? 1 : 0);
  for (let i = 0; i < emailList.length; i += 50) {
    const chunk = emailList.slice(i, i + 50);
    const { data } = await sb
      .from("trial_signups")
      .select("email, fbp, fbc, client_ip, client_user_agent, created_at")
      .in("email", chunk)
      .order("created_at", { ascending: false });
    for (const r of (data ?? []) as any[]) {
      const key = ((r.email || "") as string).trim().toLowerCase();
      if (!key) continue;
      const cand: Match = { fbp: r.fbp ?? null, fbc: r.fbc ?? null, client_ip: r.client_ip ?? null, client_user_agent: r.client_user_agent ?? null };
      const cur = matchByEmail.get(key);
      if (!cur || sig(cand) > sig(cur)) matchByEmail.set(key, cand); // keep the row with the strongest signal
    }
  }

  // ── 5. Walk sales, fire eligible events ──────────────────────────────────
  const results: any[] = [];
  let sentPurchase = 0, sentSubscribe = 0;
  let skippedAlready = 0, skippedNoEmail = 0, skippedNoCreds = 0, skippedNotEligible = 0;
  let failed = 0;

  for (const sale of sales) {
    const slug = sale.studio_slug ?? "";
    const eid = `mt_${sale.mt_sale_id}`;
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

    const client = sale.customer_mt_id ? clientsById.get(sale.customer_mt_id) : null;
    // Fall back to email captured on the sale row when client lookup missed.
    const email = ((client?.email ?? sale.customer_email) ?? "").trim();
    if (!email) {
      skippedNoEmail++;
      results.push({ event_id: eid, status: "no_email", studio: slug });
      continue;
    }

    // Legacy-customer filter — created_at_mt before launch + no prior $49 trial.
    const memberSince = client?.created_at_mt ?? null;
    const isLegacyMember = memberSince && memberSince < BBB_LAUNCH;
    const cameThroughFunnel = sale.customer_mt_id
      ? priorTrialClients.has(sale.customer_mt_id)
      : false;
    if (isLegacyMember && !cameThroughFunnel) {
      skippedNotEligible++;
      results.push({
        event_id: eid,
        status: "legacy_renewal",
        studio: slug,
        member_since: memberSince,
        note: "pre-launch MT customer, no $49 trial — skipping to avoid poisoning Meta signal",
      });
      continue;
    }

    const acct = acctBySlug.get(slug);
    if (!acct || !acct.pixel_id || !acct.access_token) {
      skippedNoCreds++;
      results.push({ event_id: eid, status: "no_meta_creds", studio: slug });
      continue;
    }

    const phoneDigits = (client?.phone ?? "").replace(/\D/g, "");
    const firstName = (client?.first_name ?? sale.customer_first_name ?? "").trim();
    const lastName  = (client?.last_name  ?? sale.customer_last_name  ?? "").trim();

    const userData: Record<string, string | string[]> = {};
    const em = await hashPII(email);          if (em) userData.em = [em];
    const ph = await hashPII(phoneDigits);    if (ph) userData.ph = [ph];
    const fn = await hashPII(firstName);      if (fn) userData.fn = [fn];
    const ln = await hashPII(lastName);       if (ln) userData.ln = [ln];

    // Attach the browser match signals (fbp/fbc/IP/UA) from this customer's
    // trial_signups row. fbc/fbp/IP/UA are single strings (NOT arrays) per
    // Meta's user_data schema. When present, this becomes a real "website"
    // event Meta can attribute to the ad click; otherwise we leave it as a
    // low-match physical_store event so we don't claim web attribution we
    // can't back up.
    const m = matchByEmail.get(email.toLowerCase());
    let actionSource = "physical_store";
    let eventSourceUrl: string | undefined;
    if (m && (m.fbc || m.fbp || m.client_ip)) {
      if (m.fbp) userData.fbp = m.fbp;
      if (m.fbc) userData.fbc = m.fbc;
      if (m.client_ip) userData.client_ip_address = m.client_ip;
      if (m.client_user_agent) userData.client_user_agent = m.client_user_agent;
      actionSource = "website";
      eventSourceUrl = `https://betterbodybootcamp.com/trial/${slug}`;
    }

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
      customData.predicted_ltv = valueUsd;
    }

    const requestBody = {
      data: [{
        event_name: klass.event_name,
        event_time: eventTime,
        event_id: eid,
        action_source: actionSource,
        ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
        user_data: userData,
        custom_data: customData,
      }],
      access_token: acct.access_token,
    };

    if (dryRun) {
      results.push({
        event_id: eid, status: "dry_run", studio: slug, event_name: klass.event_name,
        value: valueUsd, name: `${firstName} ${lastName}`.trim(),
        action_source: actionSource, attributable: actionSource === "website",
        match_signals: m ? { fbc: !!m.fbc, fbp: !!m.fbp, ip: !!m.client_ip, ua: !!m.client_user_agent } : null,
      });
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
          raw: { source: "mariana-tek-capi-purchase-sync", action_source: actionSource, attributable: actionSource === "website", response: respJson },
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
