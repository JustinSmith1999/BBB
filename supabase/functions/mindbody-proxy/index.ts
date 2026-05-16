import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MINDBODY_API_BASE = "https://api.mindbodyonline.com/public/v6";

interface MindbodyRequest {
  endpoint: string;
  method?: string;
  body?: any;
  siteId: string;
  apiKey: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { endpoint, method = "GET", body, siteId, apiKey }: MindbodyRequest = await req.json();

    if (!endpoint || !siteId || !apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing required parameters: endpoint, siteId, or apiKey" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const mindbodyHeaders = {
      "Content-Type": "application/json",
      "Api-Key": apiKey,
      "SiteId": siteId,
    };

    const url = `${MINDBODY_API_BASE}${endpoint}`;

    const mindbodyResponse = await fetch(url, {
      method,
      headers: mindbodyHeaders,
      body: method !== "GET" ? JSON.stringify(body) : undefined,
    });

    const data = await mindbodyResponse.json();

    return new Response(
      JSON.stringify(data),
      {
        status: mindbodyResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
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
