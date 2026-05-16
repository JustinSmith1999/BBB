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
    const {
      locationId,
      locationName,
      customerEmail,
      customerName,
      customerPhone,
      address,
      city,
      zipCode,
      country,
      newsletter
    } = await req.json();

    if (!locationId) {
      throw new Error("Location ID is required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_publishable_key, stripe_price_id")
      .eq("id", locationId)
      .single();

    if (locationError || !location) {
      throw new Error("Location not found");
    }

    if (!location.stripe_secret_key || !location.stripe_price_id) {
      throw new Error("Stripe credentials not configured for this location");
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
