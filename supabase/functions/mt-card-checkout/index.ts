import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// mt-card-checkout (2026-09-03) — THE card-capture checkout Justin has asked
// for since June. The whole purchase runs on Mariana Tek's rails:
//
//   1. find-or-create the MT user
//   2. POST /api/bankcards with the card details — MT tokenizes into ITS OWN
//      Stripe account server-side (stripe_customer_id comes back read-only).
//      Card is now ON FILE for desk upsells, memberships, everything.
//   3. cart → add_product → POST /checkouts with payments:
//      [{ amount, type: "bankcard", id: <bankcard id> }]
//      (payment shape verified against MT's own admin app bundle
//       ember-mariana-admin.js: `"storedCard"===c&&p.push({amount:i,
//       type:"bankcard",id:l.id})`)
//   4. MT charges the customer on MT's Stripe. Our Stripe never touches the
//      money. The bankcard rule that killed contract checkouts is satisfied
//      because the card exists AND is the payment.
//   5. trial_signups row upserted with attribution (fbp/fbc/ip/ua) so
//      Homebase + CAPI keep working exactly as before.
//
// This is a PUBLIC function (the website calls it directly, no x-bbb-secret).
// Protections: strict validation, honeypot field, per-email dedupe (45d),
// per-IP throttle (5/hour), CORS locked to betterbodybootcamp.com.
//
// CARD DATA HANDLING: the PAN/CCV pass through this function over TLS and go
// straight to MT. They are NEVER logged, NEVER stored in Supabase, and are
// not included in any error detail. Do not add logging around `card`.
//
// FAILURE MODES (all money-safe — we never charge before checkout succeeds):
//   - bankcard store fails → 402 {error:"card_error"} → customer retries.
//   - checkout fails after card stored → card stays on file (harmless, no
//     charge), 402 returned, dead-letter + SMS to Justin.
//   NO credit-pass fallback here: nothing was paid, so nothing is owed.
//
// Deploy: bbb deploy-fn mt-card-checkout
// ─────────────────────────────────────────────────────────────────────────────

const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const A = "application/vnd.api+json";

// gateway = the studio's Stripe payment gateway in MT (/api/payment_gateways).
// 2026-09-03: bankcard creation REQUIRES a payment_gateway relationship —
// MT's admin app always sends it (createRecord("bankcard",{...paymentGateway}))
// and omitting it is why the first live test failed at the card-store step.
const STUDIO: Record<string, { mtLoc: string; partner: string; title: string; gateway: string }> = {
  "astoria":       { mtLoc: "48717", partner: "41362", title: "Astoria",       gateway: "53203" },
  "bayside":       { mtLoc: "48718", partner: "41363", title: "Bayside",       gateway: "53204" },
  "fresh-meadows": { mtLoc: "48719", partner: "41364", title: "Fresh Meadows", gateway: "53205" },
  "williamsburg":  { mtLoc: "48720", partner: "41365", title: "Williamsburg",  gateway: "53206" },
};
const PRODUCT: Record<string, { child: string; amount: string; label: string }> = {
  // 14944 "$49 Two Weeks Trial (Web)" — no intro-offer flag (see mt-provision).
  "trial":  { child: "14944", amount: "49.00",  label: "$49 Two Weeks Trial (Web)" },
  "bts299": { child: "14913", amount: "299.00", label: "2 Months Back to School Promo" },
  // $1 live-fire test (contract 14946, Active, hidden from the store). Used
  // only by the unlisted /checkout-test page. Remove after the test passes
  // and deactivate contract 14946 in MT admin.
  "webtest": { child: "14946", amount: "1.00", label: "Web Checkout Test $1 (do not sell)" },
  // 2026-10-05 · $99 one-month, Bayside + Fresh Meadows only. The contract id
  // comes from a SECRET rather than a literal so creating it in MT admin does
  // not require a code change or a redeploy — set MT_CONTRACT_MONTH_99 and it
  // goes live. Until that secret exists this entry resolves to an empty child
  // and the guard below rejects the kind outright, which is the behaviour we
  // want: refuse the sale rather than take money with nowhere to put it.
  "month": {
    child: Deno.env.get("MT_CONTRACT_MONTH_99") ?? "",
    amount: "99.00",
    label: "$99 One Month Unlimited (Web)",
  },
};
// Studios allowed to sell each product. Absent = all studios.
// The $99 month is deliberately Bayside + Fresh Meadows only.
const PRODUCT_STUDIOS: Record<string, string[]> = {
  "month": ["bayside", "fresh-meadows"],
};

const CORS = {
  "Access-Control-Allow-Origin": "https://betterbodybootcamp.com",
  // 2026-09-03 FIX: the site sends Authorization + apikey (standard Supabase
  // client headers). Without them here the preflight fails and the browser
  // reports "Failed to fetch".
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}
function mtToken(): string | null {
  const k = Deno.env.get("MT_ADMIN_API_KEY");
  return k && k.trim() ? k.trim() : null;
}
async function mtGet(token: string, path: string) {
  const r = await fetch(`${MT_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: A } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mtPost(token: string, path: string, payload: unknown) {
  const r = await fetch(`${MT_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: A, "Content-Type": A },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
// ── MT's Stripe bridge ───────────────────────────────────────────────────────
// 2026-09-03: MT will NOT tokenize raw PANs for Stripe gateways. Its own error:
// "the 'partner_reference' field must be set to the card's Payment Method ID
// from Stripe." So we do what MT's widget does: fetch the tenant's Stripe
// publishable key from /api/stripe/v1/configuration, create a PaymentMethod
// directly against MT's Stripe (publishable keys are allowed to create
// PaymentMethods — that is exactly what Stripe.js does client-side), then
// hand MT the pm_… id.
async function stripeConfig(token: string) {
  const r = await fetch(`${MT_BASE}/api/stripe/v1/configuration`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}
async function stripeCreatePaymentMethod(
  pk: string, stripeAccount: string | null,
  card: { number: string; expMonth: string; expYear: string; ccv: string; name: string; zip: string },
) {
  const form = new URLSearchParams({
    type: "card",
    "card[number]": card.number,
    "card[exp_month]": card.expMonth,
    "card[exp_year]": card.expYear,
    "card[cvc]": card.ccv,
    "billing_details[name]": card.name,
    "billing_details[address][postal_code]": card.zip,
  });
  const headers: Record<string, string> = {
    Authorization: "Basic " + btoa(`${pk}:`),
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
  const r = await fetch("https://api.stripe.com/v1/payment_methods", { method: "POST", headers, body: form });
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
}

async function alertJustin(msg: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
  const to = Deno.env.get("BBB_ALERT_PHONE") ?? "+16317086585";
  if (!sid || !tok || !from) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, To: to, Body: msg }),
  }).catch(() => {});
}

function luhnOk(num: string): boolean {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
function cardType(num: string): string {
  if (/^4/.test(num)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(num)) return "MasterCard";
  if (/^3[47]/.test(num)) return "American Express";
  if (/^6(011|5)/.test(num)) return "Discover";
  return "Visa";
}

// crude in-memory per-IP throttle (edge instances are ephemeral; good enough
// to stop dumb scripts, the honeypot + dedupe do the rest)
const hits = new Map<string, number[]>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 3600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 5;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  // debug: inspect MT's Stripe configuration (publishable key etc. — all
  // public-by-design values). Guarded by the admin secret since this fn is
  // otherwise a public endpoint.
  if (body.action === "stripe_config") {
    if (req.headers.get("x-bbb-secret") !== "bbb-test-2026-05-27") return json({ ok: false }, 401);
    const t = mtToken();
    if (!t) return json({ ok: false, error: "no token" }, 503);
    // optional: probe an arbitrary MT path with plain-JSON accept (debug only)
    const path = typeof body.path === "string" && body.path.startsWith("/api/") ? body.path : "/api/stripe/v1/configuration";
    const r = await fetch(`${MT_BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
    });
    const b = await r.json().catch(() => ({}));
    return json({ ok: true, status: r.status, config: b });
  }

  // debug POST passthrough (secret-guarded). Lets us iterate MT payload
  // shapes without redeploying. Remove after the card flow is proven.
  if (body.action === "mt_post") {
    if (req.headers.get("x-bbb-secret") !== "bbb-test-2026-05-27") return json({ ok: false }, 401);
    const t = mtToken();
    if (!t) return json({ ok: false, error: "no token" }, 503);
    const path = typeof body.path === "string" && body.path.startsWith("/api/") ? body.path : null;
    if (!path) return json({ ok: false, error: "path required" }, 400);
    const accept = body.accept === "json" ? "application/json" : A;
    const r = await fetch(`${MT_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, Accept: accept, "Content-Type": accept },
      body: JSON.stringify(body.payload ?? {}),
    });
    const b = await r.json().catch(() => ({}));
    return json({ ok: true, status: r.status, body: b });
  }

  // honeypot: real form never fills this
  if (typeof body.company === "string" && body.company.trim() !== "") return json({ ok: true });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  if (ip && throttled(ip)) return json({ ok: false, error: "Too many attempts. Please try again later." }, 429);

  const first = String(body.first_name ?? "").trim().slice(0, 60);
  const last = String(body.last_name ?? "").trim().slice(0, 60);
  const email = String(body.email ?? "").trim().toLowerCase();
  const phone = String(body.phone ?? "").trim().slice(0, 20);
  const studioSlug = String(body.studio_slug ?? "").trim();
  const kind = String(body.kind ?? "trial").trim();
  const card = (body.card ?? {}) as Record<string, unknown>;
  const number = String(card.number ?? "").replace(/[\s-]/g, "");
  const ccv = String(card.ccv ?? "").trim();
  const expMonth = String(card.exp_month ?? "").padStart(2, "0");
  const expYear = String(card.exp_year ?? "").trim();

  const studio = STUDIO[studioSlug];
  const product = PRODUCT[kind];
  if (!studio || !product) return json({ ok: false, error: "unknown studio or product" }, 400);

  // 2026-10-05 — a product whose contract id is blank is NOT sellable. This
  // catches the $99 month before MT_CONTRACT_MONTH_99 is set. Failing here is
  // the point: the alternative is charging a card and then having no contract
  // to attach, which is exactly the shape of the guiqiang incident.
  if (!product.child) {
    return json({
      ok: false,
      error: `"${kind}" is not available yet`,
      detail: kind === "month"
        ? "MT_CONTRACT_MONTH_99 is not set — create the $99 one-month contract in MT admin, then set that secret to its child-product id."
        : "this product has no Mariana Tek contract id configured",
    }, 409);
  }

  // Per-product studio restriction.
  const allowedStudios = PRODUCT_STUDIOS[kind];
  if (allowedStudios && !allowedStudios.includes(studioSlug)) {
    return json({
      ok: false,
      error: `"${kind}" is not sold at ${studio.title}`,
      available_at: allowedStudios,
    }, 400);
  }
  if (!first || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "name and valid email required" }, 400);
  if (!/^\d{12,19}$/.test(number) || !luhnOk(number)) return json({ ok: false, error: "That card number doesn't look right." }, 400);
  if (!/^\d{3,4}$/.test(ccv)) return json({ ok: false, error: "Security code should be 3 or 4 digits." }, 400);
  if (!/^(0[1-9]|1[0-2])$/.test(expMonth) || !/^\d{4}$/.test(expYear)) return json({ ok: false, error: "Check the card expiration date." }, 400);

  const token = mtToken();
  if (!token) return json({ ok: false, error: "temporarily unavailable" }, 503);
  const client = sb();
  const fullName = `${first} ${last}`.trim();

  // dedupe: same product completed for this email in the last 45 days
  const since = new Date(Date.now() - 45 * 864e5).toISOString();
  const { data: prior } = await client.from("mariana_tek_sales")
    .select("mt_sale_id").ilike("customer_email", email)
    .ilike("item_names", `%${product.label}%`).gte("sale_date_time", since).limit(1);
  if (prior && prior.length) {
    return json({ ok: false, error: "Looks like you already purchased this. Check your email, or contact the studio." }, 409);
  }

  // ── 1. find or create MT user ──────────────────────────────────────────────
  let userId: string | null = null;
  {
    const q = await mtGet(token, `/api/users?query=${encodeURIComponent(email)}&page_size=5`);
    const hit = ((q.body as { data?: Array<{ id: string; attributes?: { email?: string } }> }).data ?? [])
      .find((u) => String(u.attributes?.email || "").toLowerCase() === email);
    userId = hit?.id ?? null;
  }
  if (!userId) {
    const attrs: Record<string, unknown> = {
      email, first_name: first, last_name: last || "Member",
      marketing_opt_in: true, is_opted_in_to_transactional_sms: true,
      home_location: studio.mtLoc,
    };
    if (phone) attrs.phone_number = phone;
    let c = await mtPost(token, "/api/users", { data: { type: "users", attributes: attrs } });
    if (c.status >= 400 && phone) {
      delete attrs.phone_number;
      c = await mtPost(token, "/api/users", { data: { type: "users", attributes: attrs } });
    }
    userId = String((c.body as { data?: { id?: string } })?.data?.id ?? "") || null;
    if (!userId) return json({ ok: false, error: "Couldn't create your account. Please try again." }, 502);
  }

  // ── 2. store the card in MT (MT tokenizes into ITS Stripe) ────────────────
  // Reuse an existing stored card if one is already on file — don't stack dupes.
  let bankcardId: string | null = null;
  {
    const existing = await mtGet(token, `/api/bankcards?user=${userId}`);
    const rows = ((existing.body as { data?: Array<{ id: string; attributes?: { is_expired?: boolean } }> }).data ?? []);
    const live = rows.find((b) => !b.attributes?.is_expired);
    if (live) bankcardId = live.id;
  }
  if (!bankcardId) {
    // 2026-09-03: MT requires a billing address on stored cards
    // ("non_field_errors":["Billing address is required."]). Only postal_code
    // is mandatory per the schema; we send name + US too.
    const zip = String(card.postal_code ?? "").trim();
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return json({ ok: false, error: "Please enter the card's billing ZIP code." }, 400);
    const ba = await mtPost(token, "/api/billing_addresses", {
      data: { type: "billing_addresses", attributes: {
        first_name: first, last_name: last || "Member",
        postal_code: zip, country: "US",
      } },
    });
    const billingId = String((ba.body as { data?: { id?: string } })?.data?.id ?? "") || null;
    if (ba.status >= 400 || !billingId) {
      const detail = JSON.stringify((ba.body as { errors?: unknown })?.errors ?? {}).slice(0, 200);
      console.log(`mt-card-checkout: billing address failed for ${email}: ${ba.status} ${detail}`);
      return json({ ok: false, error: "card_error", message: `Billing address problem. (${detail.slice(0, 140)})` }, 402);
    }
    // Tokenize against MT's Stripe first (publishable key from MT's own
    // config endpoint), then reference the PaymentMethod id.
    const cfg = await stripeConfig(token);
    const pk = String(
      (cfg.body as Record<string, unknown>).stripePublishableApiKey ??
      (cfg.body as Record<string, unknown>).stripe_publishable_api_key ?? "",
    );
    const stripeAcct = String(
      (cfg.body as Record<string, unknown>).stripeAccountId ??
      (cfg.body as Record<string, unknown>).stripe_account_id ?? "",
    ) || null;
    if (!pk.startsWith("pk_")) {
      console.log(`mt-card-checkout: stripe config missing pk: ${cfg.status} ${JSON.stringify(cfg.body).slice(0, 200)}`);
      return json({ ok: false, error: "card_error", message: "Payment system unavailable. Please try again shortly." }, 502);
    }
    const pm = await stripeCreatePaymentMethod(pk, stripeAcct, {
      number, expMonth, expYear, ccv, name: fullName || email, zip,
    });
    const pmId = String((pm.body as { id?: string }).id ?? "");
    if (pm.status >= 400 || !pmId.startsWith("pm_")) {
      const stripeMsg = String(((pm.body as { error?: { message?: string } }).error?.message) ?? "card rejected");
      console.log(`mt-card-checkout: stripe pm failed for ${email}: ${pm.status} ${stripeMsg}`);
      return json({ ok: false, error: "card_error", message: `Your card couldn't be saved: ${stripeMsg.slice(0, 140)}` }, 402);
    }

    // NOTE: number + ccv MUST be present even with partner_reference — MT's
    // serializer 500s without them (verified 2026-09-03). With them present
    // it attaches the Stripe PaymentMethod correctly.
    const bc = await mtPost(token, "/api/bankcards", {
      data: { type: "bankcards", attributes: {
        name: fullName || email,
        number, ccv,
        expiration_month: expMonth, expiration_year: expYear,
        card_type: cardType(number),
        partner_reference: pmId,
      }, relationships: {
        user: { data: { type: "users", id: userId } },
        payment_gateway: { data: { type: "payment_gateways", id: studio.gateway } },
        billing_address: { data: { type: "billing_addresses", id: billingId } },
      } },
    });
    bankcardId = String((bc.body as { data?: { id?: string } })?.data?.id ?? "") || null;
    if (bc.status >= 400 || !bankcardId) {
      // Surface STATUS + FULL MT body (never contains the PAN) so failures
      // are debuggable without chasing function logs.
      const detail = `${bc.status} ${JSON.stringify(bc.body ?? {})}`.slice(0, 400);
      console.log(`mt-card-checkout: bankcard store failed for ${email}: ${detail}`);
      return json({ ok: false, error: "card_error", message: `Your card couldn't be saved. (${detail.slice(0, 220)})` }, 402);
    }
  }

  // ── 3. cart → product → checkout charged to the stored card ──────────────
  const cart = await mtPost(token, "/api/carts", {
    data: { type: "carts", relationships: {
      user: { data: { type: "users", id: userId } },
      fulfillment_partner: { data: { type: "partners", id: studio.partner } },
      originating_partner: { data: { type: "partners", id: studio.partner } },
    } },
  });
  const cartId = String((cart.body as { data?: { id?: string } })?.data?.id ?? "");
  if (cart.status !== 201 || !cartId) return json({ ok: false, error: "checkout_error", message: "Something went wrong. Please try again." }, 502);

  // 2026-09-03 (learned in the $1 live test): MT returns the user's EXISTING
  // open cart at this partner, stale items included — Justin's had $164 of
  // leftovers. Clear before adding, or the charge amount won't match.
  await mtPost(token, `/api/carts/${cartId}/clear`, {}).catch(() => {});

  const add = await mtPost(token, `/api/carts/${cartId}/add_product`, {
    data: { type: "cart_add_product",
      attributes: { quantity: 1, has_options: false, admin_override_first_timer_validation: true },
      relationships: {
        cart: { data: { type: "carts", id: cartId } },
        partner: { data: { type: "partners", id: studio.partner } },
        product: { data: { type: "child_products", id: product.child } },
      } },
  });
  if (add.status !== 200 && add.status !== 201) return json({ ok: false, error: "checkout_error", message: "Something went wrong. Please try again." }, 502);

  // Pay the cart's ACTUAL total (covers tax if ever enabled), but never accept
  // a total that drifted from the product price by more than $10 — that means
  // something unexpected is in the cart, and we stop rather than mischarge.
  const cartCheck = await mtGet(token, `/api/carts/${cartId}`);
  const cartTotal = Number((cartCheck.body as { data?: { attributes?: { total?: number } } })?.data?.attributes?.total ?? NaN);
  if (!Number.isFinite(cartTotal) || Math.abs(cartTotal - Number(product.amount)) > 10) {
    console.log(`mt-card-checkout: cart total sanity failed for ${email}: total=${cartTotal} expected=${product.amount}`);
    return json({ ok: false, error: "checkout_error", message: "Something went wrong. No charge was made. Please try again." }, 502);
  }

  const co = await mtPost(token, "/api/checkouts", {
    data: { type: "checkouts",
      relationships: { cart: { data: { type: "carts", id: cartId } } },
      attributes: { payments: [{ amount: cartTotal.toFixed(2), type: "bankcard", id: Number(bankcardId) }] },
    },
  });
  if (co.status !== 201 && co.status !== 200) {
    const coErr = JSON.stringify((co.body as { errors?: unknown })?.errors ?? {}).slice(0, 300);
    console.log(`mt-card-checkout: checkout failed for ${email}: ${co.status} ${coErr}`);
    try {
      await client.from("project_log").insert({
        emoji: "🚨", category: "mt_card_checkout_failed", status: "open", studio: studioSlug,
        title: `Card checkout failed: ${email} (${kind} @ ${studioSlug})`,
        detail: JSON.stringify({ email, name: fullName, phone, studio_slug: studioSlug, kind, mt_user_id: userId, error: coErr }),
      });
    } catch { /* non-fatal */ }
    await alertJustin(`BBB: web card checkout FAILED for ${fullName || email} (${kind}, ${studioSlug}). No charge went through. MT said: ${coErr.slice(0, 120)}`);
    return json({ ok: false, error: "card_declined", message: "Your card was declined. No charge was made. Try another card or contact the studio." }, 402);
  }
  const orderId = String((co.body as { data?: { relationships?: { order?: { data?: { id?: string } } }; id?: string } })?.data?.relationships?.order?.data?.id
    ?? (co.body as { data?: { id?: string } })?.data?.id ?? "");

  // ── 4. board row + attribution (mirrors create-trial-checkout fields) ─────
  try {
    const nowIso = new Date().toISOString();
    const fbp = typeof body.fbp === "string" ? body.fbp.slice(0, 255) : null;
    const fbc = typeof body.fbc === "string" ? body.fbc.slice(0, 480) : null;
    const ua = req.headers.get("user-agent")?.slice(0, 512) ?? null;
    const { data: locRow } = await client.from("locations").select("id").ilike("name", studio.title).limit(1).maybeSingle();
    const { data: existing } = await client.from("trial_signups")
      .select("id").ilike("email", email).is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(1);
    // ── 2026-10-05 FIX: UTMs were landing NULL on EVERY native card sale. ──
    // This block read body.utm_source (snake_case). But the pages that post
    // here — LocationTrialSignup (the $49 page) and BackToSchool (the $299
    // page) — both spread `...getUtmParams()`, and src/lib/utm.ts returns
    // CAMELCASE: { utmSource, utmMedium, utmCampaign, utmContent }. The keys
    // never matched, so every one of these four columns has been null since
    // card capture went live on 2026-09-03.
    //
    // It went unnoticed because create-trial-checkout — the OLD path, still
    // used by /comeback, /special and /resign — reads body.utmSource and so
    // works correctly. Only the native-checkout pages were affected, which is
    // to say: the two pages that take the most money.
    //
    // Fixed HERE rather than in the two React pages so it takes effect on a
    // function deploy with no site rebuild, and so any future caller is
    // covered whichever convention it picks. Snake_case wins when both are
    // sent. (This does not retroactively fix past sales; those rows stay null.)
    const pick = (snake: string, camel: string): string | null => {
      const v = (body as Record<string, unknown>)[snake] ?? (body as Record<string, unknown>)[camel];
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
    };
    const utms = {
      utm_source:   pick("utm_source", "utmSource"),
      utm_medium:   pick("utm_medium", "utmMedium"),
      utm_campaign: pick("utm_campaign", "utmCampaign"),
      utm_content:  pick("utm_content", "utmContent"),
    };

    // 2026-09-04 FIX (found via Maya Best, first organic sale): `source` and
    // `studio_slug` are NOT columns on trial_signups — the insert was failing
    // silently and the sync adopted buyers as attribution-less mt_app rows.
    // Correct column is lead_source.
    const fields = {
      name: fullName || email, email, phone: phone || null,
      location_id: locRow?.id ?? null, mariana_tek_id: userId,
      payment_status: "completed", payment_date: nowIso,
      lead_source: `mt-card-checkout-${studioSlug}`,
      fbp, fbc, client_ip: ip || null, client_user_agent: ua,
      ...utms,
    };
    let trialRowId: string | null = null;
    if (existing && existing.length) {
      await client.from("trial_signups").update(fields).eq("id", existing[0].id);
      trialRowId = existing[0].id;
    } else {
      const { data: ins } = await client.from("trial_signups").insert(fields).select("id").single();
      trialRowId = ins?.id ?? null;
    }
    // 2026-09-06: fire the standard day-0 welcome (text + email). Since this
    // fn now pre-creates the board row, mt-orders-sync no longer treats web
    // buyers as new and skipped their welcome (found via David/Shirley/Megan).
    // manual-welcome-batch sends the same welcome the sync would have.
    if (trialRowId && kind === "trial") {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/manual-welcome-batch`, {
        method: "POST",
        headers: { "x-bbb-secret": "bbb-test-2026-05-27", "Content-Type": "application/json" },
        body: JSON.stringify({ trial_ids: [trialRowId] }),
      }).catch((e) => console.log("welcome trigger failed (non-fatal):", (e as Error).message));
    }
  } catch (e) {
    console.log("mt-card-checkout: trial_signups upsert failed (sale is fine):", (e as Error).message);
  }

  console.log(`mt-card-checkout OK: ${email} ${kind} @ ${studioSlug} user=${userId} order=${orderId} (card on file, charged via MT Stripe)`);
  return json({ ok: true, order_id: orderId });
});
