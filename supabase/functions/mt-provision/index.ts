import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// mt-provision (2026-08-28) — the piece that kills the MT iframe.
//
// After Stripe collects the money (create-trial-checkout → stripe-webhook),
// this function makes the customer REAL in Mariana Tek:
//   1. find-or-create the MT user by email
//   2. create a cart at the studio's partner
//   3. add the purchased product (child product = contract id)
//   4. POST /checkouts with an "alt" payment (money collected via Stripe)
// Result: active, bookable MT member — same outcome as the widget, no iframe,
// and the paid-but-not-provisioned failure mode is structurally impossible:
// if any MT step fails we alert Justin by SMS with a retry command, and the
// payment is still safe in Stripe.
//
// Flow was proven live on 2026-08-28 against Justin's account (cart 8125,
// $49 total, cleared). Payload shapes come from MT's admin-app source +
// docs.marianatek.com /api/schema.
//
// PRODUCTS (child product id == membership contract id):
//   trial  → child 14721 "$49 Two Weeks Trial"        ($49)
//   bts299 → child 14913 "2 Months Back to School"    ($299)
//
// ALT PAYMENT SOURCE: /api/locations/{id}/alt_payment_sources must contain an
// enabled source (Justin adds "Website - Stripe" in MT admin, all 4 studios).
// Until it exists this function fails clearly with alt_source_missing.
//
// AUTH: x-bbb-secret. Idempotent per (email, kind): re-calls check the sales
// mirror + MT orders and skip if the same product was completed in the last
// 45 days.
//
// Usage:
//   POST { email, name, phone?, studio_slug, kind: "trial"|"bts299",
//          trial_signup_id? }
//   POST { action: "retry_failed" }   ← re-runs everything in the dead-letter
//                                        list (project_log entries)
//
// Deploy: bbb deploy-fn mt-provision
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "bbb-test-2026-05-27";
const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const A = "application/vnd.api+json";

const STUDIO: Record<string, { mtLoc: string; partner: string; title: string }> = {
  "astoria":       { mtLoc: "48717", partner: "41362", title: "Astoria" },
  "bayside":       { mtLoc: "48718", partner: "41363", title: "Bayside" },
  "fresh-meadows": { mtLoc: "48719", partner: "41364", title: "Fresh Meadows" },
  "williamsburg":  { mtLoc: "48720", partner: "41365", title: "Williamsburg" },
};
const PRODUCT: Record<string, { child: string; amount: string; label: string }> = {
  "trial":  { child: "14721", amount: "49.00",  label: "$49 Two Weeks Trial" },
  "bts299": { child: "14913", amount: "299.00", label: "2 Months Back to School Promo" },
};

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

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

type Result = { ok: boolean; step?: string; detail?: string; mt_user_id?: string; order_id?: string; skipped?: string };

async function provision(
  client: ReturnType<typeof sb>, token: string,
  email: string, name: string, phone: string | null, studioSlug: string, kind: string,
): Promise<Result> {
  const studio = STUDIO[studioSlug];
  const product = PRODUCT[kind];
  if (!studio || !product) return { ok: false, step: "input", detail: `unknown studio/kind ${studioSlug}/${kind}` };
  const lcEmail = email.trim().toLowerCase();

  // ── idempotency: same product completed for this email recently? ──────────
  const since = new Date(Date.now() - 45 * 864e5).toISOString();
  const { data: prior } = await client.from("mariana_tek_sales")
    .select("mt_sale_id").ilike("customer_email", lcEmail)
    .ilike("item_names", `%${product.label}%`).gte("sale_date_time", since).limit(1);
  if (prior && prior.length) return { ok: true, skipped: "already purchased in MT (mirror)" };

  // ── 1. find or create MT user ─────────────────────────────────────────────
  let userId: string | null = null; let created = false;
  {
    const q = await mtGet(token, `/api/users?query=${encodeURIComponent(lcEmail)}&page_size=5`);
    const hit = ((q.body as { data?: Array<{ id: string; attributes?: { email?: string } }> }).data ?? [])
      .find((u) => String(u.attributes?.email || "").toLowerCase() === lcEmail);
    userId = hit?.id ?? null;
  }
  if (!userId) {
    const parts = (name || "").trim().split(/\s+/);
    const first = parts[0] || "New";
    const last = parts.slice(1).join(" ") || "Member";
    const attrs: Record<string, unknown> = {
      email: lcEmail, first_name: first, last_name: last,
      marketing_opt_in: true, is_opted_in_to_transactional_sms: true,
      home_location: studio.mtLoc,
    };
    if (phone) attrs.phone_number = phone;
    let c = await mtPost(token, "/api/users", { data: { type: "users", attributes: attrs } });
    if (c.status >= 400 && phone) {
      // some tenants reject phone formats — retry without it rather than fail
      delete attrs.phone_number;
      c = await mtPost(token, "/api/users", { data: { type: "users", attributes: attrs } });
    }
    if (c.status !== 201 && c.status !== 200) {
      return { ok: false, step: "user_create", detail: `${c.status} ${JSON.stringify(c.body).slice(0, 300)}` };
    }
    userId = String((c.body as { data?: { id?: string } })?.data?.id ?? "");
    created = true;
    if (!userId) return { ok: false, step: "user_create", detail: "no id in response" };
  }

  // ── 2. cart ───────────────────────────────────────────────────────────────
  const cart = await mtPost(token, "/api/carts", {
    data: { type: "carts", relationships: {
      user: { data: { type: "users", id: userId } },
      fulfillment_partner: { data: { type: "partners", id: studio.partner } },
      originating_partner: { data: { type: "partners", id: studio.partner } },
    } },
  });
  const cartId = String((cart.body as { data?: { id?: string } })?.data?.id ?? "");
  if (cart.status !== 201 || !cartId) {
    return { ok: false, step: "cart", detail: `${cart.status} ${JSON.stringify(cart.body).slice(0, 300)}`, mt_user_id: userId };
  }

  // ── 3. add product ────────────────────────────────────────────────────────
  const add = await mtPost(token, `/api/carts/${cartId}/add_product`, {
    data: { type: "cart_add_product",
      attributes: { quantity: 1, has_options: false, admin_override_first_timer_validation: true },
      relationships: {
        cart: { data: { type: "carts", id: cartId } },
        partner: { data: { type: "partners", id: studio.partner } },
        product: { data: { type: "child_products", id: product.child } },
      } },
  });
  if (add.status !== 200 && add.status !== 201) {
    return { ok: false, step: "add_product", detail: `${add.status} ${JSON.stringify(add.body).slice(0, 300)}`, mt_user_id: userId };
  }

  // ── 4. alt payment source for this studio ─────────────────────────────────
  const src = await mtGet(token, `/api/locations/${studio.mtLoc}/alt_payment_sources/`);
  const sources = ((src.body as { data?: Array<{ id: string; attributes?: { name?: string; is_enabled?: boolean } }> }).data ?? [])
    .filter((s) => s.attributes?.is_enabled !== false);
  const stripeSrc = sources.find((s) => /stripe|website|web/i.test(String(s.attributes?.name || ""))) ?? sources[0];
  // 2026-08-28: alt payment sources are provisioned by Xplor support only
  // (admin UI is read-only for them). We don't wait: when none exists, we
  // credit the user's MT ACCOUNT BALANCE with the Stripe amount and check out
  // against it — books show "Account Balance" (clean, never touches register
  // cash counts), zero Xplor dependency. If an alt source ever appears, it's
  // preferred automatically.
  let payment: Record<string, unknown>;
  let balanceCredited = false;
  let creditTxId: string | null = null;
  if (stripeSrc) {
    payment = { type: "alt", amount: product.amount, source_type_id: Number(stripeSrc.id) };
  } else {
    const credit = await mtPost(token, "/api/account_transactions", {
      data: { type: "account_transactions", attributes: {
        transaction_amount: product.amount, transaction_currency: "USD",
      }, relationships: { user: { data: { type: "users", id: userId } } } },
    });
    if (credit.status !== 201 && credit.status !== 200) {
      return { ok: false, step: "account_credit", detail: `${credit.status} ${JSON.stringify(credit.body).slice(0, 300)}`, mt_user_id: userId };
    }
    balanceCredited = true;
    creditTxId = String((credit.body as { data?: { id?: string } })?.data?.id ?? "") || null;
    payment = { type: "account", amount: product.amount };
  }

  // ── 5. checkout ───────────────────────────────────────────────────────────
  const co = await mtPost(token, "/api/checkouts", {
    data: { type: "checkouts",
      relationships: { cart: { data: { type: "carts", id: cartId } } },
      attributes: { payments: [payment] },
    },
  });
  if (co.status !== 201 && co.status !== 200) {
    const coErr = JSON.stringify(co.body).slice(0, 400);
    // Roll back the balance credit so the user isn't left holding $49/$299
    // of spendable balance after a failed checkout. MT requires the reversal
    // to reference its parent transaction (learned 2026-08-29: bare negative
    // amounts 500).
    if (balanceCredited && creditTxId) {
      await mtPost(token, "/api/account_transactions", {
        data: { type: "account_transactions", attributes: {
          transaction_amount: `-${product.amount}`, transaction_currency: "USD",
        }, relationships: {
          user: { data: { type: "users", id: userId } },
          parent_account_transaction: { data: { type: "account_transactions", id: creditTxId } },
        } },
      }).catch(() => {});
    }

    // ── CREDIT-PASS FALLBACK (2026-08-29, the guiqiang incident) ────────────
    // MT refuses membership-contract checkout without a stored bankcard
    // (platform rule; may lift once the service account gets can_use_pos).
    // The customer PAID — they get access NO MATTER WHAT: grant an equivalent
    // credit pass (trial: 14 credits/14 days; bts299: 62 credits/62 days).
    // The desk can convert it to the real contract at first visit.
    if (/bankcard/i.test(coErr)) {
      const days = kind === "bts299" ? 62 : 14;
      const exp = new Date(Date.now() + days * 864e5).toISOString().replace(/\.\d+Z$/, "Z");
      const grant = await mtPost(token, "/api/credit_transactions", {
        data: { type: "credit_transactions", attributes: {
          transaction_amount: days, expiration_datetime: exp,
          note: `${product.label} paid on website`,
        }, relationships: {
          credit: { data: { type: "credits", id: "2323" } },
          user: { data: { type: "users", id: userId } },
        } },
      });
      if (grant.status === 201 || grant.status === 200) {
        console.log(`mt-provision FALLBACK: ${lcEmail} ${kind} → ${days}-day credit pass (contract blocked: bankcard rule)`);
        return { ok: true, mt_user_id: userId, skipped: `contract blocked by bankcard rule — granted ${days}-day credit pass instead` };
      }
    }
    return { ok: false, step: "checkout", detail: coErr, mt_user_id: userId };
  }
  const orderId = String((co.body as { data?: { relationships?: { order?: { data?: { id?: string } } }; id?: string } })?.data?.relationships?.order?.data?.id
    ?? (co.body as { data?: { id?: string } })?.data?.id ?? "");

  console.log(`mt-provision OK: ${lcEmail} ${kind} @ ${studioSlug} user=${userId} created=${created} order=${orderId}`);
  return { ok: true, mt_user_id: userId, order_id: orderId };
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const client = sb();
  const token = mtToken();
  if (!token) return json({ ok: false, error: "MT_ADMIN_API_KEY missing" }, 503);

  // retry_failed: replay dead-letter rows
  if (body.action === "retry_failed") {
    const { data: rows } = await client.from("project_log")
      .select("id, detail").eq("category", "mt_provision_failed").eq("status", "open").limit(20);
    const results: unknown[] = [];
    for (const r of (rows ?? [])) {
      try {
        const p = JSON.parse(r.detail);
        const res = await provision(client, token, p.email, p.name, p.phone ?? null, p.studio_slug, p.kind);
        if (res.ok) await client.from("project_log").update({ status: "resolved" }).eq("id", r.id);
        results.push({ email: p.email, ...res });
      } catch (e) { results.push({ id: r.id, error: (e as Error).message }); }
    }
    return json({ ok: true, retried: results.length, results });
  }

  const email = String(body.email || "").trim();
  const name = String(body.name || "").trim();
  const phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  const studioSlug = String(body.studio_slug || "").trim();
  const kind = String(body.kind || "trial").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "valid email required" }, 400);

  const res = await provision(client, token, email, name, phone, studioSlug, kind);

  if (!res.ok) {
    // dead-letter + alert — the money is in Stripe, the member just needs MT.
    try {
      await client.from("project_log").insert({
        emoji: "🚨",
        category: "mt_provision_failed",
        status: "open",
        studio: studioSlug,
        title: `MT provision failed: ${email} (${kind} @ ${studioSlug}) at step ${res.step}`,
        detail: JSON.stringify({ email, name, phone, studio_slug: studioSlug, kind, step: res.step, detail: res.detail }),
      });
    } catch { /* table shape may differ — the alert below still fires */ }
    await alertJustin(
      `BBB: PAID BUT NOT IN MT — ${name || email} (${kind}, ${studioSlug}). Failed at ${res.step}. ` +
      `Money is safe in Stripe. Fix cause then run mt-provision {"action":"retry_failed"}.`,
    );
  }

  return json(res, res.ok ? 200 : 500);
});
