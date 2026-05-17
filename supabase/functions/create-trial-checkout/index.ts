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

    if (!locationId) {
      throw new Error("Location ID is required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_publishable_key, stripe_price_id, name")
      .eq("id", locationId)
      .single();

    if (locationError || !location) {
      throw new Error("Location not found");
    }

    if (!location.stripe_secret_key || !location.stripe_price_id) {
      throw new Error("Stripe credentials not configured for this location");
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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: location.stripe_price_id,
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.headers.get("origin")}/trial-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.get("origin")}/locations/${locationName.toLowerCase().replace(/\s+/g, '-')}`,
      customer: customer.id,
      metadata: {
        locationId,
        locationName,
        customerName,
        customerPhone,
        address,
        city,
        zipCode,
        country,
        newsletter: newsletter ? "true" : "false",
        trialType: "2-week-unlimited",
      },
    });

    // ─── Save pending trial_signups row so we can match on the webhook ───
    // The stripe-webhook function will UPDATE this row to payment_status='completed'
    // when the customer finishes paying. Gives us a record of every abandoned
    // checkout, not just successful payments. Non-blocking — if insert fails,
    // we still return the checkout URL so the customer can pay.
    try {
      const { error: signupErr } = await supabase.from("trial_signups").insert({
        name: customerName ?? null,
        email: customerEmail ?? null,
        phone: customerPhone ?? null,
        address: address,
        city: city,
        zip_code: zipCode,
        country: country,
        newsletter_opted_in: !!newsletter,
        location_id: locationId,
        stripe_session_id: session.id,
        payment_status: "pending",
      });
      if (signupErr) console.error("pending trial_signups insert failed:", signupErr.message);
      else console.log("pending trial_signups row saved for session", session.id);
    } catch (e) {
      console.error("pending trial_signups insert exception:", e);
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
