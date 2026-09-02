import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Input validation helpers ────────────────────────────────────────────────
// All four fields (first/last name, email, phone) are required. Garbage in =
// garbage out for our front-desk follow-ups, so reject hard here.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;
const FAKE_EMAIL_DOMAINS = new Set([
  // common test / disposable / one-shot domains that flooded the lead table.
  "test.com","example.com","example.org","mailinator.com","tempmail.com",
  "10minutemail.com","guerrillamail.com","trashmail.com","fakeinbox.com",
  "dispostable.com","yopmail.com","getnada.com","mailnesia.com","sharklasers.com",
]);

function normalizeName(s: unknown): string {
  return typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";
}
function normalizeEmail(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}
function normalizePhone(s: unknown): string {
  // Strip everything but digits; keep a leading '+' if present.
  if (typeof s !== "string") return "";
  const cleaned = s.trim();
  const plus = cleaned.startsWith("+");
  const digits = cleaned.replace(/\D/g, "");
  return (plus ? "+" : "") + digits;
}

function toE164US(raw: string): string | null {
  // Accept US-format numbers in any common shape, return strict +1XXXXXXXXXX.
  // Reject anything else (we don't take international right now).
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

/**
 * Validate one phone number with Twilio Lookup v2. Returns:
 *   { ok: true, e164 }                    — number is real, deliverable
 *   { ok: false, reason: "..." }          — number is fake / invalid / wrong type
 *
 * Falls back to format-only (treated as ok) if TWILIO creds aren't set, so dev
 * environments and local supabase don't break.
 */
async function lookupPhone(e164: string): Promise<{ ok: true; e164: string } | { ok: false; reason: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!sid || !tok) {
    console.warn("Twilio creds not set — skipping Lookup validation");
    return { ok: true, e164 };
  }
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
  const res = await fetch(url, {
    headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`) },
  });
  if (res.status === 404) return { ok: false, reason: "Phone number not found on any carrier." };
  if (!res.ok) {
    // Don't punish the customer for a Twilio outage. Log + accept.
    console.error("Twilio Lookup non-200:", res.status, await res.text());
    return { ok: true, e164 };
  }
  const body = await res.json();
  if (body.valid === false) return { ok: false, reason: "That phone number isn't valid." };
  const type = body?.line_type_intelligence?.type as string | undefined;
  // Reject obviously-fake / undeliverable line types. We allow mobile, fixedVoip
  // (Google Voice etc.) and landline (Carlos's customer base skews older —
  // landline is real, just can't get SMS).
  const BAD_TYPES = new Set(["nonFixedVoip", "personal", "tollFree", "unknown"]);
  if (type && BAD_TYPES.has(type)) {
    return { ok: false, reason: "Please use a real mobile phone number." };
  }
  return { ok: true, e164: body.phone_number ?? e164 };
}

function badRequest(field: string, message: string) {
  return new Response(
    JSON.stringify({ success: false, field, error: message }),
    {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json();
    const {
      locationId,
      locationName,
      newsletter,
    } = body;

    // ─── Meta CAPI match-quality fingerprint (2026-06-05) ─────────────────
    // The CAPI Purchase event lives or dies by these two unhashed signals.
    // Without client_ip_address + client_user_agent, Meta receives our event
    // (HTTP 200, events_received:1) but its matching layer can't tie the
    // server event to the original ad click, so it declines to attribute.
    // Bayside showed this most visibly — $372 spend / 8 days / 0 attributed
    // purchases despite real paid trials. We pull IP from the standard
    // proxy chain (forwarded-for first) and the UA from its own header,
    // then persist on the row so stripe-webhook can include them in the
    // server-side Purchase event.
    const ipChain = (req.headers.get("x-forwarded-for") || "").split(",");
    const clientIp = (ipChain[0] || "").trim()
      || req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || null;
    const clientUserAgent = (req.headers.get("user-agent") || "").slice(0, 1024) || null;

    // ─── Validate identity fields (HARD — return 400 on any failure) ─────
    // The front-desk + win-back automation is useless if name/email/phone are
    // garbage, so we reject up-front instead of capturing junk into the DB.
    const firstName = normalizeName(body.customerFirstName);
    const lastName  = normalizeName(body.customerLastName);
    // Back-compat: if the form is still sending a single customerName, split it.
    let firstFinal = firstName;
    let lastFinal  = lastName;
    if (!firstFinal && !lastFinal && typeof body.customerName === "string") {
      const parts = body.customerName.trim().split(/\s+/);
      firstFinal = parts[0] ?? "";
      lastFinal  = parts.slice(1).join(" ");
    }
    if (firstFinal.length < 2) return badRequest("firstName", "Please enter your first name.");
    if (lastFinal.length  < 2) return badRequest("lastName",  "Please enter your last name.");

    const customerEmail = normalizeEmail(body.customerEmail);
    if (!EMAIL_RE.test(customerEmail)) return badRequest("email", "Please enter a valid email address.");
    const emailDomain = customerEmail.split("@")[1] ?? "";
    if (FAKE_EMAIL_DOMAINS.has(emailDomain)) return badRequest("email", "Please use a real email address.");

    const phoneRaw = normalizePhone(body.customerPhone);
    const e164 = toE164US(phoneRaw);
    if (!e164) return badRequest("phone", "Please enter a 10-digit US phone number.");
    const lookup = await lookupPhone(e164);
    if (!lookup.ok) return badRequest("phone", lookup.reason);

    const customerPhone = lookup.e164;
    const customerName  = `${firstFinal} ${lastFinal}`.trim();

    // Address fields no longer collected on the form; treat as optional.
    const address = body.address ?? null;
    const city = body.city ?? null;
    const zipCode = body.zipCode ?? null;
    const country = body.country ?? "US";

    // UTM tags from the landing URL (e.g. /ig/bayside → utm_source=instagram).
    // Stored on the trial_signups row so the dashboard can attribute signups
    // to the marketing link they came from.
    const utm = {
      utm_source:   (body.utmSource   ?? null) || null,
      utm_medium:   (body.utmMedium   ?? null) || null,
      utm_campaign: (body.utmCampaign ?? null) || null,
      utm_content:  (body.utmContent  ?? null) || null,
    };
    // Meta click identifiers captured in the browser. Threaded through to the
    // stripe-webhook so the server-side Purchase CAPI event can match this
    // conversion back to the ad. Sliced to stay under Stripe's 500-char
    // metadata value limit.
    const fbp = typeof body.fbp === "string" ? body.fbp.slice(0, 255) : "";
    const fbc = typeof body.fbc === "string" ? body.fbc.slice(0, 480) : "";
    // priceVariant:
    //   'trial'    (default, $49 / 2 weeks)
    //   'special'  ($129 / 30-day comeback offer)
    //   'resign'   ($99 first month subscription win-back)
    //   'comeback' ($29 / 1 week — sent to 7d+ abandoned leads, see comeback-offer-cron)
    const priceVariant: "trial" | "special" | "resign" | "comeback" =
      body.priceVariant === "special"  ? "special"
      : body.priceVariant === "resign" ? "resign"
      : body.priceVariant === "comeback" ? "comeback"
      : "trial";

    // 2026-08-28: native bts299 checkout (replaces the MT widget on
    // /backtoschool). Uses inline price_data ($299 one-time) so no per-studio
    // Stripe Price needs configuring; the webhook sees metadata.product and
    // mt-provision attaches MT contract 14913.
    const productKind: "trial" | "bts299" = body.product === "bts299" ? "bts299" : "trial";

    // For the $29 comeback flow we also carry the original_signup_id so the
    // webhook can credit comeback_converted_at on the right row.
    const comebackOriginalSignupId =
      typeof body.comebackOriginalSignupId === "string" && body.comebackOriginalSignupId.length === 36
        ? body.comebackOriginalSignupId
        : null;

    if (!locationId) {
      return badRequest("locationId", "Location ID is required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // ─── Same-person duplicate-trial guard (2026-06-01, hardened 2026-06-01,
    //     loosened 2026-06-17 to allow pending-row retries) ───────────────────
    // Block submissions where the SAME PERSON ALREADY PAID a trial at THIS
    // studio. Only completed payments count as a real duplicate — a stale
    // pending row is NOT a duplicate, it's a stuck checkout from a failed
    // earlier attempt and the customer needs to retry.
    //
    // 2026-06-17 update: the previous version blocked anyone with a pending
    // row at the same studio. After the 6/11-6/17 create-trial-checkout
    // outage, 24 recovery customers had stuck pending rows and were getting
    // told "you already started this trial" when they tried to re-submit
    // via the apology SMS. Now we only block when payment_status='completed'
    // — pending rows fall through to the smart dedupe below (lines ~340)
    // which UPDATES the existing pending row with the latest form data
    // and reuses it, preserving the original UTM attribution.
    //
    // Returns 409 with a clear field-targeted message the front-end shows.
    try {
      const phoneLast10 = customerPhone.replace(/\D+/g, "").slice(-10);
      const { data: dupes } = await supabase
        .from("trial_signups")
        .select("id, name, email, phone, payment_status, payment_date, created_at")
        .eq("location_id", locationId)
        .is("deleted_at", null)
        .eq("payment_status", "completed")
        .limit(50);
      if (Array.isArray(dupes)) {
        const isSamePerson = dupes.find((row) => {
          const rEmail = String(row.email ?? "").trim().toLowerCase();
          const rPhoneLast10 = String(row.phone ?? "").replace(/\D+/g, "").slice(-10);
          const emailMatch = rEmail && rEmail === customerEmail;
          const phoneMatch = rPhoneLast10.length === 10 && rPhoneLast10 === phoneLast10;
          return emailMatch || phoneMatch;
        });
        if (isSamePerson) {
          const msg = `${customerName} already signed up for the $49 trial at this studio. If you'd like to sign someone else up, change the name, email, and phone to theirs.`;
          console.log(`Duplicate guard: blocked completed-paid duplicate ${customerName} (${customerEmail}) at location ${locationId}; matched row ${isSamePerson.id}`);
          return new Response(
            JSON.stringify({ success: false, field: "firstName", error: msg, code: "already_signed_up" }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
    } catch (e) {
      console.warn("Duplicate guard skipped:", (e as Error).message);
    }

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_publishable_key, stripe_price_id, stripe_special_price_id, stripe_comeback_price_id, name")
      .eq("id", locationId)
      .single();

    if (locationError || !location) {
      throw new Error("Location not found");
    }

    if (!location.stripe_secret_key) {
      throw new Error("Stripe credentials not configured for this location");
    }

    // Pick the right Stripe Price for this checkout. Same Stripe account in
    // every case — the special / comeback prices are siblings under the same
    // gym LLC's Stripe account.
    const chosenPriceId =
      priceVariant === "special"  ? location.stripe_special_price_id
    : priceVariant === "comeback" ? location.stripe_comeback_price_id
    : location.stripe_price_id;

    if (!chosenPriceId && productKind !== "bts299") {
      throw new Error(
        priceVariant === "special"
          ? "Comeback ($129) Stripe price not configured for this location"
        : priceVariant === "comeback"
          ? "Comeback ($29) Stripe price not configured for this location"
        : "Trial ($49) Stripe price not configured for this location"
      );
    }

    // ─── Save lead to leads table BEFORE Stripe redirect ───────────────────
    // This captures every trial form submission into the BBB ERP, so abandoned
    // checkouts can be chased by win-back automation. Non-blocking — if the
    // insert fails for any reason, we still proceed to checkout.
    //
    // Note: leads.email has no unique constraint (Pancham imports allow dup
    // emails across studios), so we manually upsert: try UPDATE first, fall
    // back to INSERT if no row matched.
    try {
      const studioSlug = (location.name ?? "")
        .toLowerCase()
        .replace(/\s+/g, "-");
      const noteParts = [
        address ? `Address: ${address}` : null,
        city ? `City: ${city}` : null,
        zipCode ? `Zip: ${zipCode}` : null,
        country ? `Country: ${country}` : null,
        newsletter ? "Newsletter: yes" : null,
      ].filter(Boolean);
      const leadFields = {
        full_name: customerName ?? null,
        phone: customerPhone ?? null,
        source: `trial-form-${studioSlug}`,
        stage: "pending_checkout",
        studio_slug: studioSlug || null,
        last_touch_at: new Date().toISOString(),
        notes: noteParts.join(" · ") || null,
      };

      if (customerEmail) {
        // Try UPDATE first (handles re-submissions, Pancham contacts)
        const { data: updated, error: updErr } = await supabase
          .from("leads")
          .update(leadFields)
          .eq("email", customerEmail)
          .select("id");

        if (updErr) {
          console.error("lead update failed:", updErr.message);
        } else if (!updated || updated.length === 0) {
          // No existing lead with that email — insert a new one
          const { error: insErr } = await supabase
            .from("leads")
            .insert({ ...leadFields, email: customerEmail });
          if (insErr) console.error("lead insert failed:", insErr.message);
          else console.log("new lead inserted for trial form submission");
        } else {
          console.log(`lead updated (${updated.length} row) for trial form submission`);
        }
      }
    } catch (e) {
      console.error("lead upsert exception:", e);
    }

    // ─── Fix #9 + dedupe: pending trial_signups row before Stripe ─────────
    // Earlier this happened AFTER Stripe — if the DB write failed the customer
    // could pay and we'd have no pending row for the webhook to match on. Now
    // we write first, then PATCH with the session ID once Stripe returns.
    //
    // DEDUPE: if the same email+location already has a `pending` row created
    // within the last 60 minutes, UPDATE that one instead of inserting a new
    // one. Stops the "user fills form, doesn't complete checkout, comes back
    // and re-submits" pattern from creating ghost duplicates (e.g. Vanessa
    // Cruz × 4 across 3 sessions in May 2026 audit).
    let pendingRowId: string | null = null;
    const emailNorm = (customerEmail || '').toLowerCase().trim() || null;
    try {
      let existing: { id: string } | null = null;
      if (emailNorm) {
        // 2026-06-17: window expanded from 60 min → 30 days. After the
        // 6/11-6/17 checkout outage, 24 customers had pending rows from
        // multiple days ago. When they retry via the recovery SMS we want
        // to REUSE their original row (preserves UTM attribution + the
        // pending_signup_id metadata Stripe carries) instead of creating
        // a fresh duplicate. 30 days is the cleanup horizon for stale
        // abandoned-cart rows so reusing within that window is safe.
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { data: dupes } = await supabase
          .from("trial_signups")
          .select("id, created_at, payment_status")
          .eq("location_id", locationId)
          .eq("email", emailNorm)
          .eq("payment_status", "pending")
          .is("deleted_at", null)
          .gte("created_at", thirtyDaysAgo)
          .order("created_at", { ascending: false })
          .limit(1);
        if (dupes && dupes.length > 0) {
          existing = { id: dupes[0].id };
          console.log("dedupe: reusing existing pending row", existing.id, "for", emailNorm);
        }
      }

      if (existing) {
        // Refresh the existing pending row with the latest form data — they
        // may have corrected typos in a second pass. Don't overwrite UTMs
        // since the first capture wins on attribution.
        // Also refresh CAPI match-quality fields (IP, UA, fbp, fbc) — the
        // second submit may be from a different device / different cookie.
        const { error: updateErr } = await supabase
          .from("trial_signups")
          .update({
            name: customerName ?? null,
            phone: customerPhone ?? null,
            address: address,
            city: city,
            zip_code: zipCode,
            country: country,
            newsletter_opted_in: !!newsletter,
            client_ip: clientIp,
            client_user_agent: clientUserAgent,
            fbp: fbp || null,
            fbc: fbc || null,
          })
          .eq("id", existing.id);
        if (updateErr) console.error("pending row refresh failed:", updateErr.message);
        pendingRowId = existing.id;
      } else {
        const { data: pending, error: signupErr } = await supabase
          .from("trial_signups")
          .insert({
            name: customerName ?? null,
            email: emailNorm,
            phone: customerPhone ?? null,
            address: address,
            city: city,
            zip_code: zipCode,
            country: country,
            newsletter_opted_in: !!newsletter,
            location_id: locationId,
            payment_status: "pending",
            // NEVER leave source_category NULL. A downstream `.neq()` filter
            // in /homebase silently dropped every NULL-source row on 2026-06-01,
            // hiding 25 paid leads across all 4 studios. Tag at insert time
            // so the dashboard / homebase can trust this column as non-null.
            source_category: "trial_form",
            // Meta CAPI match-quality fingerprint — see comment block above.
            // stripe-webhook reads these off the row when firing the server-side
            // Purchase event so Meta can attribute it back to the ad click.
            client_ip: clientIp,
            client_user_agent: clientUserAgent,
            fbp: fbp || null,
            fbc: fbc || null,
            ...utm,
          })
          .select("id")
          .single();
        if (signupErr) {
          console.error("pre-Stripe trial_signups insert failed:", signupErr.message);
        } else if (pending) {
          pendingRowId = pending.id;
          console.log("pre-Stripe pending row saved:", pendingRowId);
        }
      }
    } catch (e) {
      console.error("pre-Stripe trial_signups insert exception:", e);
    }

    // ─── Server-side CAPI Lead (mirrors browser Pixel Lead) ────────────────
    // Why: browser fbq('track', 'Lead') gets eaten by Safari ITP / ad blockers /
    // iOS 17+ privacy on ~30-40% of NYC traffic. Most acute at Bayside, which
    // showed 6 reported leads vs 7 paid (paid > leads = impossible unless
    // leads silently dropped). Without Lead signal, Meta's algorithm can't
    // learn what a "good lead" looks like at Bayside → high CPL.
    //
    // The browser-side fbq is still wired (so dedupe works via shared
    // event_id when leadEventId is forwarded). When the browser Lead drops,
    // this server-side fire is the only signal Meta gets — and it always fires.
    //
    // Non-blocking: even if CAPI fails, checkout proceeds normally.
    try {
      const slug = (location.name ?? "")
        .toLowerCase()
        .replace(/\s+/g, "-");
      const leadEventId =
        (typeof body.leadEventId === "string" && body.leadEventId.trim()) ||
        `lead_${slug}_${pendingRowId || "anon"}_${Date.now()}`;
      const capiUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-capi-lead`;
      const capiAuth = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      EdgeRuntime.waitUntil(
        fetch(capiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${capiAuth}`,
            "apikey":        capiAuth,
          },
          body: JSON.stringify({
            studio_slug:       slug,
            email:             customerEmail,
            name:              customerName,
            phone:             customerPhone,
            fbp:               fbp || null,
            fbc:               fbc || null,
            client_ip:         clientIp,
            client_user_agent: clientUserAgent,
            page_url:          `https://betterbodybootcamp.com/trial/${slug}`,
            value:             49,
            currency:          "USD",
            content_name:      `${location.name ?? slug} 2-Week Trial`,
            content_category:  "trial",
            event_id:          leadEventId,
          }),
        }).catch((e) => console.error("meta-capi-lead invoke failed:", (e as Error).message))
      );
    } catch (e) {
      console.error("meta-capi-lead dispatch exception:", (e as Error).message);
    }

    const stripe = new Stripe(location.stripe_secret_key, {
      apiVersion: "2024-12-18.acacia",
    });

    const customer = await stripe.customers.create({
      email: customerEmail,
      name: customerName,
      phone: customerPhone,
      address: address && city && zipCode ? {
        line1: address,
        city: city,
        postal_code: zipCode,
        country: country || "US",
      } : undefined,
      metadata: {
        locationId,
        locationName,
        newsletter: newsletter ? "true" : "false",
        trialType: "2-week-unlimited",
      },
    });

    // Fix Justin batch 2 #3: defensive null guard so cancel_url never crashes
    // if locationName is missing from the request body.
    const cancelSlug = (locationName ?? location.name ?? "")
      .toLowerCase()
      .replace(/\s+/g, "-");

    // Cancel back to the page they came from. /special, /comeback, and /trial
    // each have their own funnel page.
    const cancelPath =
      productKind === "bts299"    ? `/backtoschool?studio=${cancelSlug}`
    : priceVariant === "special"  ? `/special/${cancelSlug}`
    : priceVariant === "comeback" ? `/comeback/${cancelSlug}`
    : `/locations/${cancelSlug}`;

    // 2026-06-15 ROLLBACK: the 6/11 switch to automatic_payment_methods
    // silently killed the entire trial funnel — 0 of 12 leads since 6/11
    // got a stripe_session_id, vs 79% before. Root cause: automatic_payment
    // _methods requires each studio's Stripe account to have those methods
    // configured in their Dashboard (Apple Pay domain verified, etc.) and
    // at least one isn't. When Stripe throws, the user just sees a generic
    // error. Reverting to card-only restores the funnel; we can re-enable
    // AMP later studio-by-studio after each account is verified.
    //
    // Original 6/10 comment kept for context:
    //   "Mobile users from Meta ads expect Apple Pay / Google Pay buttons;
    //    when they don't see them they bail rather than type a 16-digit
    //    card number on their phone." — true, but card-only is still
    //    converting 56% of Stripe-reachers, so not as catastrophic as
    //    100% session-creation failure.
    // 2026-06-18: Adding Stripe Link to payment methods. Unlike Apple Pay /
    // Google Pay (which require per-domain verification in each studio's
    // Stripe Dashboard — the trap that broke 6/11), Link works on every
    // Stripe account by default. It's Stripe's own one-tap login that
    // remembers payment + email across the Stripe network. Expected mobile
    // checkout conversion lift ~12-18%. Zero per-account config needed.
    // Apple/Google Pay can be added later studio-by-studio after each
    // account's Dashboard domain is verified.
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "link"],
      line_items: [
        productKind === "bts299"
          ? {
              price_data: {
                currency: "usd",
                unit_amount: 29900,
                product_data: {
                  name: "2 Months Unlimited — Back to School",
                  description: `One payment, no auto-renewal. ${locationName ?? location.name ?? ""}`,
                },
              },
              quantity: 1,
            }
          : {
              price: chosenPriceId,
              quantity: 1,
            },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/trial-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}${cancelPath}`,
      customer: customer.id,
      // 2026-06-24: Force Stripe to send an official receipt to the customer's
      // email after payment. Without receipt_email here, Stripe only sends a
      // receipt when the studio's Stripe Dashboard → Settings → Emails has
      // "Successful payments" enabled — that's per-account and inconsistent
      // across the 4 studios. Forcing it at the checkout level guarantees
      // every paid trial customer gets a Stripe-branded proof of purchase
      // with transaction ID, date, amount, and card last-4. Independent of
      // our own welcome email which fires from stripe-webhook.
      payment_intent_data: {
        receipt_email: customerEmail || undefined,
      },
      metadata: {
        locationId,
        locationName: locationName ?? location.name ?? "",
        customerName,
        customerPhone,
        // Fix #8: include email in metadata so the webhook can fall back to it
        // when session.customer_email is null (often the case).
        email: customerEmail ?? "",
        address,
        city,
        zipCode,
        country,
        newsletter: newsletter ? "true" : "false",
        priceVariant,
        product: productKind,
        trialType:
          priceVariant === "special"  ? "30-day-comeback-129"
        : priceVariant === "comeback" ? "1-week-comeback-29"
        : "2-week-unlimited",
        trialSignupId: pendingRowId ?? "",
        // For the $29 comeback flow, also carry which abandoned signup this
        // converts. The webhook will stamp comeback_converted_at on that row.
        comebackOriginalSignupId: comebackOriginalSignupId ?? "",
        // UTM tags passed through so the webhook's fallback insert can keep them.
        utm_source: utm.utm_source ?? "",
        utm_medium: utm.utm_medium ?? "",
        utm_campaign: utm.utm_campaign ?? "",
        utm_content: utm.utm_content ?? "",
        fbp,
        fbc,
      },
    });

    // ─── Patch the pending row with the Stripe session id so the webhook can
    // match on it. If the pre-insert failed above, fall back to a fresh insert
    // here so we never lose a paid trial.
    if (pendingRowId) {
      const { error: updErr } = await supabase
        .from("trial_signups")
        .update({ stripe_session_id: session.id })
        .eq("id", pendingRowId);
      if (updErr) console.error("trial_signups session_id patch failed:", updErr.message);
    } else {
      try {
        const { error: fallbackErr } = await supabase.from("trial_signups").insert({
          name: customerName ?? null,
          email: customerEmail ?? null,
          phone: customerPhone ?? null,
          address, city, zip_code: zipCode, country,
          newsletter_opted_in: !!newsletter,
          location_id: locationId,
          stripe_session_id: session.id,
          payment_status: "pending",
          // Match the primary insert above — never NULL source_category.
          source_category: "trial_form",
          ...utm,
        });
        if (fallbackErr) console.error("trial_signups fallback insert failed:", fallbackErr.message);
      } catch (e) {
        console.error("trial_signups fallback insert exception:", e);
      }
    }

    return new Response(
      JSON.stringify({
        sessionId: session.id,
        url: session.url
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
