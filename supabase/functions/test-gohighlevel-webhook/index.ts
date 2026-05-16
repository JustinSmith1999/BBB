import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    const { trialSignupId } = await req.json();

    if (!trialSignupId) {
      return new Response(
        JSON.stringify({ error: "trialSignupId is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: trialSignup, error: signupError } = await supabase
      .from("trial_signups")
      .select("*, locations(gohighlevel_webhook_url, gohighlevel_api_key)")
      .eq("id", trialSignupId)
      .maybeSingle();

    if (signupError || !trialSignup) {
      return new Response(
        JSON.stringify({ error: "Trial signup not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const location = trialSignup.locations;
    if (!location || !location.gohighlevel_webhook_url) {
      return new Response(
        JSON.stringify({ error: "GoHighLevel webhook URL not configured for this location" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const payload = {
      eventType: "trial_signup_test",
      customer: {
        name: trialSignup.name,
        email: trialSignup.email,
        phone: trialSignup.phone,
        address: trialSignup.address,
        city: trialSignup.city,
        zipCode: trialSignup.zip_code,
        country: trialSignup.country,
      },
      metadata: {
        locationId: trialSignup.location_id,
        stripeSessionId: trialSignup.stripe_session_id,
        paymentStatus: trialSignup.payment_status,
        paymentDate: trialSignup.payment_date,
        newsletterOptedIn: trialSignup.newsletter_opted_in,
        trialSignupId: trialSignup.id,
      },
      timestamp: new Date().toISOString(),
      testMode: true,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (location.gohighlevel_api_key) {
      headers["Authorization"] = `Bearer ${location.gohighlevel_api_key}`;
    }

    console.log("Sending test webhook to:", location.gohighlevel_webhook_url);

    const response = await fetch(location.gohighlevel_webhook_url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          status: response.status,
          statusText: response.statusText,
          response: responseText,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    await supabase
      .from("trial_signups")
      .update({
        gohighlevel_sent: true,
        gohighlevel_sent_at: new Date().toISOString(),
        gohighlevel_error: null,
      })
      .eq("id", trialSignupId);

    return new Response(
      JSON.stringify({
        success: true,
        status: response.status,
        response: responseText,
        message: "Test webhook sent successfully",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Test webhook error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
