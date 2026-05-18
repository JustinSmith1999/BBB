import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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
      customerEmail,
      customerName,
      customerPhone,
      newsletter,
    } = body;
    // Address fields no longer collected on the form; treat as optional.
    const address = body.address ?? null;
    const city = body.city ?? null;
    const zipCode = body.zipCode ?? null;
    const country = body.country ?? "US";
    // priceVariant: 'trial' (default, $49 / 2 weeks) | 'special' ($129 / 30-day
    // comeback offer). The /special/[slug] page sends 'special'; everything
    // else stays on the trial price for back-compat.
    const priceVariant: "trial" | "special" =
      body.priceVariant === "special" ? "special" : "trial";

    if (!locationId) {
      throw new Error("Location ID is required");
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
