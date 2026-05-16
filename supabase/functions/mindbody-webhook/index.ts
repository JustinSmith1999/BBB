import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-MindBody-Signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const signature = req.headers.get("X-MindBody-Signature");
    const rawBody = await req.text();
    let body;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: "invalid_json",
          message: "Invalid JSON payload"
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data, error: dbError } = await supabase
      .from("mindbody_webhook_events")
      .insert({
        event_type: body.eventType || body.event_type || "unknown",
        payload: body,
        signature: signature,
        received_at: new Date().toISOString(),
        processed: false,
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError);
      return new Response(
        JSON.stringify({
          success: false,
          error: "database_error",
          message: "Failed to store webhook event"
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

    console.log(`Webhook received: ${body.eventType || body.event_type}`, {
      eventId: data.id,
      signature: signature
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Webhook received successfully",
        eventId: data.id
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "internal_error",
        message: error.message || "Internal server error"
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
