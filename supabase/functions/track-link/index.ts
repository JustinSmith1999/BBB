import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// track-link — logs a click on a tracked marketing link, then 302-redirects to
// the trial page with UTM params. The /ig, /email, /flyer Netlify redirects
// point here (?l=<key>) so every click is counted, not just signups.
//
// Deploy with JWT verification OFF (public endpoint, no auth header possible):
//   supabase functions deploy track-link --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────

const SITE = "https://betterbodybootcamp.com";

// The 8 tracked links, keyed by the ?l= value the Netlify redirect passes in.
// Keep in sync with public/_redirects and the get_link_performance SQL function.
const LINKS: Record<
  string,
  { studio: string; source: string; medium: string; content?: string }
> = {
  "ig-astoria":         { studio: "astoria",       source: "instagram", medium: "social", content: "bio" },
  "ig-bayside":         { studio: "bayside",       source: "instagram", medium: "social", content: "bio" },
  "ig-fresh-meadows":   { studio: "fresh-meadows", source: "instagram", medium: "social", content: "bio" },
  "ig-williamsburg":    { studio: "williamsburg",  source: "instagram", medium: "social", content: "bio" },
  "email-bayside":        { studio: "bayside",       source: "email", medium: "email" },
  "email-fresh-meadows":  { studio: "fresh-meadows", source: "email", medium: "email" },
  "flyer-bayside":        { studio: "bayside",       source: "flyer", medium: "print" },
  "flyer-fresh-meadows":  { studio: "fresh-meadows", source: "flyer", medium: "print" },
};

// Link-preview crawlers (iMessage, Slack, WhatsApp, Facebook, etc.) hit the URL
// when it's pasted anywhere — don't count those as human clicks.
const BOT_RE =
  /bot|crawl|spider|facebookexternalhit|whatsapp|telegram|slackbot|discord|linkedinbot|twitterbot|preview|headless|lighthouse|pingdom|monitor/i;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("l") ?? "";
  const link = LINKS[key];

  // Unknown / missing key — fall back to the studio picker instead of erroring.
  if (!link) {
    return Response.redirect(`${SITE}/trial`, 302);
  }

  // Destination trial URL with UTM params.
  const dest = new URL(`${SITE}/trial/${link.studio}`);
  dest.searchParams.set("utm_source", link.source);
  dest.searchParams.set("utm_medium", link.medium);
  dest.searchParams.set("utm_campaign", "trial");
  if (link.content) dest.searchParams.set("utm_content", link.content);

  // Log the click — best effort. A logging failure must never block the redirect.
  const ua = req.headers.get("user-agent") ?? "";
  if (!BOT_RE.test(ua)) {
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      await supabase.from("link_clicks").insert({
        link_key: key,
        studio: link.studio,
        utm_source: link.source,
        utm_medium: link.medium,
        utm_campaign: "trial",
        utm_content: link.content ?? null,
        user_agent: ua || null,
        referrer: req.headers.get("referer"),
      });
    } catch (_e) {
      // swallow — the redirect always wins
    }
  }

  return Response.redirect(dest.toString(), 302);
});
