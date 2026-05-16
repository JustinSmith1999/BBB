import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, stripe-signature",
};

async function sendToGoHighLevel(
  webhookUrl: string,
  apiKey: string | null,
  trialData: any,
  trialSignupId: string,
  supabase: any,
  retryCount = 0
) {
  const maxRetries = 3;
  const payload = {
    eventType: "trial_signup_completed",
    customer: {
      name: trialData.name,
      email: trialData.email,
      phone: trialData.phone,
      address: trialData.address,
      city: trialData.city,
      zipCode: trialData.zip_code,
      country: trialData.country,
    },
    metadata: {
      locationId: trialData.location_id,
      stripeSessionId: trialData.stripe_session_id,
      paymentStatus: trialData.payment_status,
      paymentDate: trialData.payment_date,
      newsletterOptedIn: trialData.newsletter_opted_in,
      trialSignupId: trialSignupId,
    },
    timestamp: new Date().toISOString(),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    console.log(`Sending to GoHighLevel (attempt ${retryCount + 1}):`, webhookUrl);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`GoHighLevel webhook failed with status: ${response.status}`);
    }

    const responseText = await response.text();
    console.log("GoHighLevel webhook success:", responseText);

    await supabase
      .from("trial_signups")
      .update({
        gohighlevel_sent: true,
        gohighlevel_sent_at: new Date().toISOString(),
        gohighlevel_error: null,
      })
      .eq("id", trialSignupId);

    return true;
  } catch (error) {
    console.error(`GoHighLevel webhook error (attempt ${retryCount + 1}):`, error);

    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      console.log(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendToGoHighLevel(webhookUrl, apiKey, trialData, trialSignupId, supabase, retryCount + 1);
    }

    await supabase
      .from("trial_signups")
      .update({
        gohighlevel_sent: false,
        gohighlevel_error: error.message || "Unknown error",
        gohighlevel_retry_count: retryCount + 1,
      })
      .eq("id", trialSignupId);

    throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const signature = req.headers.get("stripe-signature");
    const body = await req.text();

    let event: Stripe.Event;
    let locationId: string | undefined;

    const parsedBody = JSON.parse(body);
    const sessionData = parsedBody?.data?.object;
    locationId = sessionData?.metadata?.locationId;

    if (!locationId) {
      console.log("No locationId in webhook payload - acknowledging event:", parsedBody.type);
      return new Response(
        JSON.stringify({ received: true, note: "No locationId found" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("stripe_secret_key, stripe_webhook_secret, gohighlevel_webhook_url, gohighlevel_api_key")
      .eq("id", locationId)
      .maybeSingle();

    if (locationError || !location) {
      console.log("Location not found:", locationId, "- acknowledging event");
      return new Response(
        JSON.stringify({ received: true, note: "Location not found" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!location.stripe_secret_key) {
      console.log("Stripe credentials not configured for location:", locationId, "- acknowledging event");
      return new Response(
        JSON.stringify({ received: true, note: "Stripe credentials not configured" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const stripe = new Stripe(location.stripe_secret_key, {
      apiVersion: "2024-12-18.acacia",
    });

    if (location.stripe_webhook_secret && signature) {
      try {
        event = stripe.webhooks.constructEvent(
          body,
          signature,
          location.stripe_webhook_secret
        );
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return new Response(
          JSON.stringify({ received: true, note: "Invalid signature" }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    } else {
      event = parsedBody;
    }

    console.log("Received Stripe event:", event.type, "for location:", locationId);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata || {};

      const trialData = {
        name: metadata.customerName || "",
        email: session.customer_email || metadata.email || "",
        phone: metadata.customerPhone || "",
        address: metadata.address || "",
        city: metadata.city || "",
        zip_code: metadata.zipCode || "",
        country: metadata.country || "US",
        newsletter_opted_in: metadata.newsletter === "true",
        location_id: metadata.locationId || null,
        stripe_session_id: session.id,
        payment_status: "completed",
        payment_date: new Date().toISOString(),
      };

      const { data, error: dbError } = await supabase
        .from("trial_signups")
        .insert([trialData])
        .select();

      if (dbError) {
        console.error("Database error:", dbError);
        return new Response(
          JSON.stringify({
            received: true,
            note: "Database error logged",
            error: dbError.message,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      console.log("Trial signup saved:", data);

      if (data && data[0] && location.gohighlevel_webhook_url) {
        const trialSignupId = data[0].id;

        (async () => {
          try {
            await sendToGoHighLevel(
              location.gohighlevel_webhook_url,
              location.gohighlevel_api_key,
              trialData,
              trialSignupId,
              supabase
            );
          } catch (ghlError) {
            console.error("GoHighLevel webhook error (non-blocking):", ghlError);
          }
        })();
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      JSON.stringify({
        received: true,
        note: "Error logged",
        error: error.message || "Internal server error",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
