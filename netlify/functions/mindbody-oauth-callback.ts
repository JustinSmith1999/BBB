import type { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

export const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const code = params.code;
    const state = params.state;
    const error = params.error;

    if (error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: error,
          message: "MindBody authorization failed",
        }),
      };
    }

    if (!code) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: "missing_code",
          message: "Authorization code not provided",
        }),
      };
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error: dbError } = await supabase
      .from("mindbody_oauth_tokens")
      .insert({
        authorization_code: code,
        state: state,
        received_at: new Date().toISOString(),
        status: "pending",
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
          message: "Failed to store authorization code",
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: "Authorization code received successfully",
        tokenId: data.id,
      }),
    };
  } catch (error: any) {
    console.error("Callback error:", error);
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
