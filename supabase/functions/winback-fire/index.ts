/**
 * winback-fire - one-shot Edge Function that sends the winback campaign
 *
 * Reads recipients from winback_sends (pre-populated by Python script),
 * skips any already sent (email_sent_at IS NOT NULL), sends each via Resend
 * with per-studio templates and per-studio payment links.
 *
 * Schedule via pg_cron for one-time fire, then unschedule.
 *
 * Env vars (auto-injected by Supabase): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Env vars (must set in Function Settings): RESEND_API_KEY
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Studio = { name: string; phone: string; email: string; paymentLink: string };

const STUDIOS: Record<string, Studio> = {
  "williamsburg":  { name: "Williamsburg",  phone: "(718) 683-1864", email: "williamsburg@betterbodybootcamp.com",  paymentLink: "https://buy.stripe.com/eVq28s3LBg4w3C6ac7fbq04" },
  "astoria":       { name: "Astoria",       phone: "(718) 704-9954", email: "astoria@betterbodybootcamp.com",       paymentLink: "https://buy.stripe.com/00w5kCdC20iYbue0jq24002" },
  "bayside":       { name: "Bayside",       phone: "(646) 566-8870", email: "bayside@betterbodybootcamp.com",       paymentLink: "https://buy.stripe.com/14A4gy33kcS3foi9oEfbq02" },
  "fresh-meadows": { name: "Fresh Meadows", phone: "(646) 566-8207", email: "freshmeadows@betterbodybootcamp.com",  paymentLink: "https://buy.stripe.com/cNifZhbDN4iJ5wU72j7EQ04" },
};

function firstNameOf(full: string | null): string {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

function opener(cohort: string, studio: string): string {
  return ({
    warm: `You did your 2 week trial at ${studio} not long ago and didn't sign on as a member. Sometimes the timing is just off.`,
    mid:  `It's been a few months since you did your 2 week trial at ${studio}. If you've been thinking about coming back, here's a clean way in.`,
    cold: `It's been the better part of a year since you did your trial at ${studio}. We've added some new coaches and refreshed the schedule since then.`,
  } as Record<string, string>)[cohort] || "";
}

function subjectFor(first: string, cohort: string, studio: string): string {
  return ({
    warm: `${first}, skip the trial. Come back as a member.`,
    mid:  `${first}, $129 for your first month at ${studio}`,
    cold: `${first}, $129 first month if you want back in`,
  } as Record<string, string>)[cohort] || "";
}

function buildBody(first: string, cohort: string, studioCfg: Studio): string {
  const studio = studioCfg.name;
  const phone = studioCfg.phone;
  const link = studioCfg.paymentLink;
  return `Hey ${first},

${opener(cohort, studio)}

Different offer this round: $129 for your first month as a member. No second
trial, no $49 again. One month at a discount, no commitment past month one.

Claim it here: ${link}

Or reply to this email or call ${phone}.

Team ${studio}

---
You're getting this because you bought a $49 trial at ${studio}.
Reply STOP to opt out of future emails.
`;
}

async function sendResend(from: string, to: string, replyTo: string, subject: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err.slice(0, 400)}`);
  }
  return await res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: rows, error } = await supabase
      .from("winback_sends")
      .select("id,name,email,phone,studio_slug,cohort")
      .is("email_sent_at", null)
      .is("opted_out_at", null)
      .eq("campaign_name", "winback-2026-05")
      .limit(250);
    if (error) throw error;

    const results: Array<{ id: string; ok: boolean; err?: string }> = [];
    for (const r of rows ?? []) {
      const cfg = STUDIOS[r.studio_slug];
      if (!cfg) {
        results.push({ id: r.id, ok: false, err: `unknown studio ${r.studio_slug}` });
        continue;
      }
      const first = firstNameOf(r.name);
      const subject = subjectFor(first, r.cohort, cfg.name);
      const body = buildBody(first, r.cohort, cfg);
      const fromAddr = `Team ${cfg.name} <${cfg.email}>`;
      try {
        const resp = await sendResend(fromAddr, r.email, cfg.email, subject, body);
        await supabase
          .from("winback_sends")
          .update({
            email_sent_at: new Date().toISOString(),
            email_resend_id: (resp as any).id,
            email_subject: subject,
            email_error: null,
          })
          .eq("id", r.id);
        results.push({ id: r.id, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase
          .from("winback_sends")
          .update({ email_error: msg.slice(0, 500) })
          .eq("id", r.id);
        results.push({ id: r.id, ok: false, err: msg });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      processed: results.length,
      sent: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
