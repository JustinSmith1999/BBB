import type { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

export const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-MindBody-Signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const signature = event.headers["x-mindbody-signature"] || "";
    const rawBody = event.body || "";

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: "invalid_json",
          message: "Invalid JSON payload",
        }),
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

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
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: "database_error",
          message: "Failed to store webhook event",
        }),
      };
    }

    console.log(`Webhook received: ${body.eventType || body.event_type}`, {
      eventId: data.id,
      signature: signature,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: "Webhook received successfully",
        eventId: data.id,
      }),
    };
  } catch (error: any) {
    console.error("Webhook error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: "internal_error",
        message: error.message || "Internal server error",
      }),
    };
  }
};
