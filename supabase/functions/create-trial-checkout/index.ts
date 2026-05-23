import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^17.4.0";
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
    // priceVariant: 'trial' (default, $49 / 2 weeks) | 'special' ($129 / 30-day
    // comeback offer) | 'resign' ($99 first month subscription win-back).
    const priceVariant: "trial" | "special" | "resign" =
      body.priceVariant === "special" ? "special"
      : body.priceVariant === "resign" ? "resign"
      : "trial";

    if (!locationId) {
      return badRequest("locationId", "Location ID is required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_publishable_key, stripe_price_id, stripe_special_price_id, name")
      .eq("id", locationId)
      .single();

    if (locationError || !location) {
      throw new Error("Location not found");
    }

    if (!location.stripe_secret_key) {
      throw new Error("Stripe credentials not configured for this location");
    }

    // Pick the right Stripe Price for this checkout. Same Stripe account either
    // way — the $129 win-back is a separate Price under the same gym LLC.
    const chosenPriceId =
      priceVariant === "special"
        ? location.stripe_special_price_id
        : location.stripe_price_id;

    if (!chosenPriceId) {
      throw new Error(
        priceVariant === "special"
          ? "Comeback ($129) Stripe price not configured for this location"
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

    // ─── Fix #9: Insert pending trial_signups row BEFORE the Stripe call ─
    // Earlier this happened AFTER Stripe — if the DB write failed the customer
    // could pay and we'd have no pending row for the webhook to match on. Now
    // we write first (without session_id), then PATCH with the session ID once
    // Stripe returns. If the Stripe call fails we leave a pending row tagged
    // for retry / cleanup.
    let pendingRowId: string | null = null;
    try {
      const { data: pending, error: signupErr } = await supabase
        .from("trial_signups")
        .insert({
          name: customerName ?? null,
          email: customerEmail ?? null,
          phone: customerPhone ?? null,
          address: address,
          city: city,
          zip_code: zipCode,
          country: country,
          newsletter_opted_in: !!newsletter,
          location_id: locationId,
          payment_status: "pending",
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
    } catch (e) {
      console.error("pre-Stripe trial_signups insert exception:", e);
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

    // Cancel back to the page they came from. /special funnels return to the
    // comeback page; /trial funnels return to the location page.
    const cancelPath =
      priceVariant === "special"
        ? `/special/${cancelSlug}`
        : `/locations/${cancelSlug}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: chosenPriceId,
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/trial-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}${cancelPath}`,
      customer: customer.id,
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
        trialType: priceVariant === "special" ? "30-day-comeback-129" : "2-week-unlimited",
        trialSignupId: pendingRowId ?? "",
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
