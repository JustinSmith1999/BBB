/**
 * winback-followup &mdash; Day 3 + Day 7 follow-up emails for the $129 winback campaign.
 *
 * Runs daily via pg_cron. Each invocation:
 *   1. Finds rows where original email_sent_at >= 3 days ago AND followup_day3 not yet sent
 *      AND replied_at/converted_at/opted_out_at are all null → sends Day 3 "Just checking" email.
 *   2. Finds rows where email_sent_at >= 7 days ago AND followup_day7 not yet sent AND same skip
 *      conditions → sends Day 7 "Last call" email.
 *
 * Skips anyone who replied, converted, or opted out (table columns track this).
 * Marks followup_dayN_sent_at on success.
 *
 * Cadence chosen by user: Option B (two-touch).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LOGO_URL = "https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png";
const BRAND_RED = "#dc2626";

const STUDIO: Record<string, {
  name: string; slug: string; locationId: string;
  phone: string; replyTo: string; senderName: string;
  paymentLink: string;
}> = {
  "williamsburg": {
    name: "Williamsburg", slug: "williamsburg",
    locationId: "80536b45-df0e-42d1-880c-e9301372e1cf",
    phone: "(718) 683-1864",
    replyTo: "williamsburg@betterbodybootcamp.com",
    senderName: "BBB Williamsburg",
    paymentLink: "https://buy.stripe.com/eVq28s3LBg4w3C6ac7fbq04",
  },
  "astoria": {
    name: "Astoria", slug: "astoria",
    locationId: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45",
    phone: "(718) 704-9954",
    replyTo: "astoria@betterbodybootcamp.com",
    senderName: "BBB Astoria",
    paymentLink: "https://buy.stripe.com/00w5kCdC20iYbue0jq24002",
  },
  "bayside": {
    name: "Bayside", slug: "bayside",
    locationId: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7",
    phone: "(646) 566-8870",
    replyTo: "bayside@betterbodybootcamp.com",
    senderName: "BBB Bayside",
    paymentLink: "https://buy.stripe.com/14A4gy33kcS3foi9oEfbq02",
  },
  "fresh-meadows": {
    name: "Fresh Meadows", slug: "fresh-meadows",
    locationId: "6bbbe077-bcc6-4d9d-a10b-7605c1484752",
    phone: "(646) 566-8207",
    replyTo: "freshmeadows@betterbodybootcamp.com",
    senderName: "BBB Fresh Meadows",
    paymentLink: "https://buy.stripe.com/cNifZhbDN4iJ5wU72j7EQ04",
  },
};

function firstName(full: string | null): string {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

function emailShell(opts: {
  headline: string;
  subhead: string;
  bodyLines: string[];
  ctaText: string;
  ctaUrl: string;
  signature: string;
  studioPhone: string;
  studioReplyTo: string;
}): string {
  const lines = opts.bodyLines.map(l => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#1a1a1a">${l}</p>`).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
        <tr><td style="padding:32px 32px 0;text-align:center">
          <img src="${LOGO_URL}" alt="Better Body Bootcamp" width="200" style="display:inline-block;max-width:60%;height:auto">
        </td></tr>
        <tr><td style="padding:32px">
          <h1 style="margin:0 0 8px;font-size:24px;letter-spacing:-0.5px;line-height:1.25">${opts.headline}</h1>
          <p style="margin:0 0 24px;font-size:14px;color:#666">${opts.subhead}</p>
          ${lines}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px">
            <tr><td style="background:${BRAND_RED};border-radius:8px">
              <a href="${opts.ctaUrl}" style="display:inline-block;padding:16px 32px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.3px">${opts.ctaText}</a>
            </td></tr>
          </table>
          <p style="margin:32px 0 0;font-size:14px;color:#555;line-height:1.5">${opts.signature}</p>
          <p style="margin:8px 0 0;font-size:13px;color:#888">Questions? Reply to this email or call <a href="tel:${opts.studioPhone}" style="color:#1a1a1a">${opts.studioPhone}</a>.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;text-align:center;font-size:12px;color:#999">
          Better Body Bootcamp · 4 NYC Locations · Since 2011<br>
          <a href="mailto:${opts.studioReplyTo}?subject=STOP" style="color:#999;text-decoration:underline">Unsubscribe</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function day3Html(s: any, first: string): string {
  return emailShell({
    headline: `${first}, still thinking it over?`,
    subhead: `${s.name} · Quick check-in`,
    bodyLines: [
      `I reached out a few days ago about coming back to ${s.name}, and wanted to make sure my note didn't get buried.`,
      `The $129 first month is still here for you. Same studio, same coaches, same community you trained with before.`,
      `No pressure at all. If now isn't the right moment, just reply NO and I'll take you off the list.`,
    ],
    ctaText: "Claim my $129 month",
    ctaUrl: s.paymentLink,
    signature: `The team at ${s.senderName}`,
    studioPhone: s.phone,
    studioReplyTo: s.replyTo,
  });
}

function day7Html(s: any, first: string): string {
  return emailShell({
    headline: `${first}, last call on $129`,
    subhead: `${s.name} · Final notice`,
    bodyLines: [
      `This is the last email I'll send about this. Promise.`,
      `The $129 first-month rate is going away soon. Once it's gone, it's back to standard pricing.`,
      `If you've been on the fence, now is the moment to grab it. If you're not coming back, no hard feelings, and I wish you well.`,
    ],
    ctaText: "Lock in my $129 month",
    ctaUrl: s.paymentLink,
    signature: `The team at ${s.senderName}`,
    studioPhone: s.phone,
    studioReplyTo: s.replyTo,
  });
}

async function resendSend(payload: any) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 86400 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();

    // ─── DAY 3 batch ──────────────────────────────────────────────────
    const { data: day3Rows } = await supabase
      .from("winback_sends")
      .select("id,studio_slug,name,email,trial_age_days")
      .lte("email_sent_at", threeDaysAgo)
      .is("followup_day3_sent_at", null)
      .is("replied_at", null)
      .is("converted_at", null)
      .is("opted_out_at", null)
      .not("email_sent_at", "is", null)
      .limit(500);

    // ─── DAY 7 batch ──────────────────────────────────────────────────
    const { data: day7Rows } = await supabase
      .from("winback_sends")
      .select("id,studio_slug,name,email")
      .lte("email_sent_at", sevenDaysAgo)
      .is("followup_day7_sent_at", null)
      .is("replied_at", null)
      .is("converted_at", null)
      .is("opted_out_at", null)
      .not("email_sent_at", "is", null)
      .limit(500);

    const results = { day3: { sent: 0, failed: 0, details: [] as any[] }, day7: { sent: 0, failed: 0, details: [] as any[] } };

    // Send Day 3 batch
    for (const r of (day3Rows ?? [])) {
      const s = STUDIO[r.studio_slug];
      if (!s) { results.day3.details.push({ id: r.id, error: "unknown_studio" }); continue; }
      const first = firstName(r.name);
      try {
        const res = await resendSend({
          from: `${s.senderName} <hello@betterbodybootcamp.com>`,
          to: [r.email],
          reply_to: s.replyTo,
          subject: `${first}, still thinking it over?`,
          html: day3Html(s, first),
        });
        await supabase.from("winback_sends").update({
          followup_day3_sent_at: new Date().toISOString(),
          followup_day3_resend_id: res.id,
          followup_day3_error: null,
        }).eq("id", r.id);
        results.day3.sent++;
        results.day3.details.push({ id: r.id, studio: s.slug, email: r.email, resend_id: res.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("winback_sends").update({ followup_day3_error: msg.slice(0, 500) }).eq("id", r.id);
        results.day3.failed++;
        results.day3.details.push({ id: r.id, studio: s.slug, email: r.email, error: msg });
      }
      // Pacing for Resend's 5 req/sec limit
      await new Promise(r => setTimeout(r, 250));
    }

    // Send Day 7 batch
    for (const r of (day7Rows ?? [])) {
      const s = STUDIO[r.studio_slug];
      if (!s) { results.day7.details.push({ id: r.id, error: "unknown_studio" }); continue; }
      const first = firstName(r.name);
      try {
        const res = await resendSend({
          from: `${s.senderName} <hello@betterbodybootcamp.com>`,
          to: [r.email],
          reply_to: s.replyTo,
          subject: `${first}, last call on $129`,
          html: day7Html(s, first),
        });
        await supabase.from("winback_sends").update({
          followup_day7_sent_at: new Date().toISOString(),
          followup_day7_resend_id: res.id,
          followup_day7_error: null,
        }).eq("id", r.id);
        results.day7.sent++;
        results.day7.details.push({ id: r.id, studio: s.slug, email: r.email, resend_id: res.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase.from("winback_sends").update({ followup_day7_error: msg.slice(0, 500) }).eq("id", r.id);
        results.day7.failed++;
        results.day7.details.push({ id: r.id, studio: s.slug, email: r.email, error: msg });
      }
      await new Promise(r => setTimeout(r, 250));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        ran_at: now.toISOString(),
        day3: { eligible: day3Rows?.length ?? 0, sent: results.day3.sent, failed: results.day3.failed },
        day7: { eligible: day7Rows?.length ?? 0, sent: results.day7.sent, failed: results.day7.failed },
        details: results,
      }, null, 2),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
