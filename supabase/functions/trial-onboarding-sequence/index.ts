/**
 * trial-onboarding-sequence - Supabase Edge Function
 *
 * Runs hourly via Cron. For each paid trial signup, sends the right email at
 * the right age window. Tracking columns prevent double-sends.
 *
 * Touchpoints handled here (email only; SMS lives in trial-onboarding-sms):
 *   Day 1   welcome + what to expect
 *   Day 7   mid-trial check-in
 *   Day 14  final-day urgency
 *   Day 17  single winback ("one free class on us, no pressure")
 *
 * Copy rules enforced throughout this file:
 *   - NO em dashes anywhere.
 *   - Never reference a specific class day or time. If we mention a real
 *     visit, we look it up in mindbody_visits first.
 *   - Never claim "a real person answers the phone" (VAPI handles calls).
 *
 * Required env vars (set in Supabase Dashboard, Function Settings):
 *   RESEND_API_KEY
 *   FROM_EMAIL  (default below)
 *
 * Deploy:
 *   supabase functions deploy trial-onboarding-sequence --project-ref uracuwugpxqjfgtuobal
 *
 * Schedule (Supabase Dashboard, Edge Functions, Cron):
 *   0 * * * *   (every hour on the hour)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Studio config ────────────────────────────────────────────────────────
type Studio = {
  slug: string;
  name: string;
  shortName: string;
  phone: string;
  address: string;
  city: string;
  zip: string;
  bookingUrl: string;
  memberSignupUrl: string;
  studioEmail: string;
};

const LOCATION_TO_STUDIO: Record<string, Studio> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": {
    slug: "williamsburg",
    name: "Better Body Bootcamp Williamsburg",
    shortName: "Williamsburg",
    phone: "(718) 683-1864",
    address: "487 Driggs Ave",
    city: "Brooklyn",
    zip: "11211",
    bookingUrl: "https://betterbodybootcamp.com/classes/williamsburg",
    memberSignupUrl: "https://betterbodybootcamp.com/membership/williamsburg",
    studioEmail: "williamsburg@betterbodybootcamp.com",
  },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": {
    slug: "astoria",
    name: "Better Body Bootcamp Astoria",
    shortName: "Astoria",
    phone: "(718) 704-9954",
    address: "31-18 Steinway Street",
    city: "Astoria",
    zip: "11103",
    bookingUrl: "https://betterbodybootcamp.com/classes/astoria",
    memberSignupUrl: "https://betterbodybootcamp.com/membership/astoria",
    studioEmail: "astoria@betterbodybootcamp.com",
  },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": {
    slug: "bayside",
    name: "Better Body Bootcamp Bayside",
    shortName: "Bayside",
    phone: "(646) 566-8870",
    address: "3447 Bell Blvd",
    city: "Bayside",
    zip: "11361",
    bookingUrl: "https://betterbodybootcamp.com/classes/bayside",
    memberSignupUrl: "https://betterbodybootcamp.com/membership/bayside",
    studioEmail: "bayside@betterbodybootcamp.com",
  },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": {
    slug: "fresh-meadows",
    name: "Better Body Bootcamp Fresh Meadows",
    shortName: "Fresh Meadows",
    phone: "(646) 566-8207",
    address: "76-46 164th Street",
    city: "Fresh Meadows",
    zip: "11366",
    bookingUrl: "https://betterbodybootcamp.com/classes/fresh-meadows",
    memberSignupUrl: "https://betterbodybootcamp.com/membership/fresh-meadows",
    studioEmail: "freshmeadows@betterbodybootcamp.com",
  },
};

const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// ─── Helpers ──────────────────────────────────────────────────────────────
function firstNameOf(full: string | null | undefined): string {
  return (full || "").trim().split(/\s+/)[0] || "there";
}

// Build a friendly phrase from a real visit timestamp. Never invents a day.
function describeVisitDate(iso: string): string {
  const visit = new Date(iso);
  const now = new Date();
  const days = Math.floor((now.getTime() - visit.getTime()) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days <= 3) return "a couple days ago";
  if (days <= 7) return "earlier this week";
  return "recently";
}

async function sendResend(to: string, subject: string, html: string, text: string, replyTo: string) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      reply_to: replyTo,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err}`);
  }
  return await res.json();
}

const LOGO_URL = "https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png";
const BRAND_RED = "#dc2626";

function emailShell(opts: {
  headline: string;
  bodyHtml: string;
  ctaText: string;
  ctaUrl: string;
  studio: Studio;
}): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
        <tr><td style="background:#0a0a0a;padding:48px 40px 40px 40px">
          <div style="width:48px;height:3px;background:${BRAND_RED};margin-bottom:24px"></div>
          <div style="font-size:11px;font-weight:700;color:${BRAND_RED};letter-spacing:2px;text-transform:uppercase;margin-bottom:18px">${opts.studio.shortName.toUpperCase()}</div>
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.18;color:#ffffff;font-weight:700;letter-spacing:-0.5px">${opts.headline}</h1>
        </td></tr>
        <tr><td style="padding:40px">
          ${opts.bodyHtml}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
            <tr><td style="background:${BRAND_RED};border-radius:8px">
              <a href="${opts.ctaUrl}" style="display:inline-block;padding:16px 32px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.3px">${opts.ctaText}</a>
            </td></tr>
          </table>
          <p style="margin:32px 0 4px;font-size:14px;color:#555;line-height:1.5">Questions? Reply to this email or call <a href="tel:${opts.studio.phone}" style="color:#1a1a1a">${opts.studio.phone}</a>.</p>
          <p style="margin:4px 0 0;font-size:12px;color:#888">${opts.studio.address}, ${opts.studio.city}, NY ${opts.studio.zip}</p>
        </td></tr>
        <tr><td style="padding:24px 40px;background:#fafafa;border-top:1px solid #eee;text-align:center">
          <img src="${LOGO_URL}" alt="Better Body Bootcamp" width="140" style="display:inline-block;max-width:50%;height:auto;opacity:0.85">
          <div style="margin-top:10px;font-size:11px;color:#999;line-height:1.5">Better Body Bootcamp &middot; ${opts.studio.name} &middot; ${opts.studio.phone}<br><a href="mailto:${opts.studio.studioEmail}?subject=STOP" style="color:#999;text-decoration:underline">Unsubscribe</a></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ─── Templates ────────────────────────────────────────────────────────────
function day1(studio: Studio, name: string) {
  const first = firstNameOf(name);
  return {
    subject: `${first}, you're in. Here's what to do first.`,
    text: `Welcome to ${studio.shortName}, ${first}.

You bought the 14 day unlimited trial. Two things to know before your first class:

1. Show up 10 minutes early so we can show you the floor and your station.
2. Wear sneakers and bring water. We have everything else.

Book your first class: ${studio.bookingUrl}

Most people who book within 48 hours stay for months. The ones who wait two weeks usually never come in.

Questions? Call us at ${studio.phone}.

Team ${studio.shortName}`,
    html: emailShell({
      headline: "WELCOME IN",
      bodyHtml: `
        <h2 style="margin:0 0 16px;font-size:22px">Welcome in, ${first}.</h2>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">You bought the 14 day unlimited trial at ${studio.shortName}. Here's what to do next.</p>
        <ol style="margin:0 0 16px 20px;padding:0;line-height:1.7;font-size:16px">
          <li><strong>Book your first class</strong> in the next 48 hours. Trial members who book fast almost always finish.</li>
          <li><strong>Show up 10 minutes early.</strong> We'll show you the floor and your station.</li>
          <li><strong>Wear sneakers, bring water.</strong> We have the rest.</li>
        </ol>
        <p style="margin:0 0 8px;line-height:1.6;font-size:16px">Two weeks of unlimited classes is only useful if you actually book them. The next click is the one that matters.</p>
      `,
      ctaText: "BOOK YOUR FIRST CLASS",
      ctaUrl: studio.bookingUrl,
      studio,
    }),
  };
}

function day2(studio: Studio, name: string) {
  const first = firstNameOf(name);
  return {
    subject: `${first}, did you book your first class yet?`,
    text: `${first},

Two days into your trial. Quick check-in.

Honest truth from running this place: trial members who book their first class within 48 hours of paying finish the full two weeks about 85% of the time. People who wait usually never make it in.

Not pressure. Just want you to actually use what you paid for.

If you have already booked, ignore this and we will see you on the floor.

If you have not, here is the direct link: ${studio.bookingUrl}

Pick whatever class fits. They are all welcoming to new folks. Show up 10 minutes early so we can walk you through the floor and your station.

Questions? Call us at ${studio.phone}.

Team ${studio.shortName}`,
    html: emailShell({
      headline: "HAVE YOU BOOKED YET?",
      bodyHtml: `
        <h2 style="margin:0 0 16px;font-size:22px">${first}, quick check-in.</h2>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Two days into your trial. Wanted to make sure you got booked.</p>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Honest truth from running this place: trial members who book their first class within 48 hours of paying finish the full two weeks about 85% of the time. People who wait usually never make it in.</p>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Not pressure. Just want you to actually use what you paid for.</p>
        <p style="margin:0 0 8px;line-height:1.6;font-size:16px">If you have already booked, ignore this and we'll see you on the floor. If you have not, the link below takes you straight to the schedule.</p>
      `,
      ctaText: "BOOK YOUR FIRST CLASS",
      ctaUrl: studio.bookingUrl,
      studio,
    }),
  };
}

function day7(studio: Studio, name: string, recentVisit?: string | null) {
  const first = firstNameOf(name);
  const visitPhrase = recentVisit
    ? `Hope your last class ${describeVisitDate(recentVisit)} felt good.`
    : `Hope your first class felt good.`;
  return {
    subject: `${first}, you're halfway through your trial`,
    text: `${first},

You're 7 days into your trial. 7 to go.

${visitPhrase}

People who show up 4 or more times in their trial almost always continue as members. People who show up once or twice usually don't.

Book your next class: ${studio.bookingUrl}

Questions? Call us at ${studio.phone}.

Team ${studio.shortName}`,
    html: emailShell({
      headline: "HALFWAY THERE",
      bodyHtml: `
        <h2 style="margin:0 0 16px;font-size:22px">${first}, you're halfway in.</h2>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">${visitPhrase} You've got 7 days left on your unlimited trial.</p>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Here is the honest pattern we see: trial members who hit 4 or more classes almost always continue. Members who only hit one or two usually don't. The difference is just whether you book the next one.</p>
      `,
      ctaText: "BOOK YOUR NEXT CLASS",
      ctaUrl: studio.bookingUrl,
      studio,
    }),
  };
}

function day14(studio: Studio, name: string) {
  const first = firstNameOf(name);
  return {
    subject: `${first}, last day of your trial`,
    text: `${first},

Today is the last day of your 14 day trial.

Members start tomorrow. If you want to keep your spot at the trial pricing, lock it in today: ${studio.memberSignupUrl}

Questions? Call us at ${studio.phone}.

Team ${studio.shortName}`,
    html: emailShell({
      headline: "LAST DAY",
      bodyHtml: `
        <h2 style="margin:0 0 16px;font-size:22px">${first}, today's the last day.</h2>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Your 14 day trial ends today. Members start tomorrow.</p>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">If you want to keep going at the rate we discussed in studio, this is the day to lock it in. Tomorrow is regular pricing.</p>
      `,
      ctaText: "BECOME A MEMBER",
      ctaUrl: studio.memberSignupUrl,
      studio,
    }),
  };
}

// Single winback at Day 17 (about 3 days after trial ends). No follow-ups.
function winback(studio: Studio, name: string) {
  const first = firstNameOf(name);
  return {
    subject: `${first}, one free class on us`,
    text: `${first},

Your trial wrapped up a few days ago and we haven't seen you sign up. No pressure.

One offer: come back for a free class this week, no strings. If it still doesn't click, we won't email you again.

Book it: ${studio.bookingUrl}

Questions? Call us at ${studio.phone}.

Team ${studio.shortName}`,
    html: emailShell({
      headline: "ONE ON US",
      bodyHtml: `
        <h2 style="margin:0 0 16px;font-size:22px">${first}, we'd like another shot.</h2>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Your trial wrapped up a few days ago and we didn't see you finish out. Life happens.</p>
        <p style="margin:0 0 16px;line-height:1.6;font-size:16px">One offer: come back for a free class this week, on us. No pitch, no upsell at the door. If it still doesn't feel like the right fit, we won't email you again.</p>
      `,
      ctaText: "BOOK YOUR FREE CLASS",
      ctaUrl: studio.bookingUrl,
      studio,
    }),
  };
}

// ─── Touchpoint runners ───────────────────────────────────────────────────
type Row = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  location_id: string | null;
  payment_date: string | null;
  winback_email_count: number;
};

async function runDay1(supabase: any) {
  const startWindow = new Date(Date.now() - 36 * 3600_000).toISOString();
  const endWindow   = new Date(Date.now() - 18 * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_date,winback_email_count")
    .eq("payment_status", "completed")
    .is("day1_email_sent_at", null)
    .is("opted_out_at", null)
    .lt("payment_date", endWindow)
    .gt("payment_date", startWindow)
    .limit(50);
  if (error) throw error;

  const results: any[] = [];
  for (const row of (data ?? []) as Row[]) {
    const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];
    if (!studio || !row.email) {
      results.push({ id: row.id, step: "day1", ok: false, err: !studio ? "unknown location" : "no email" });
      continue;
    }
    try {
      const tmpl = day1(studio, row.name ?? "");
      await sendResend(row.email, tmpl.subject, tmpl.html, tmpl.text, studio.studioEmail);
      await supabase.from("trial_signups")
        .update({ day1_email_sent_at: new Date().toISOString() }).eq("id", row.id);
      results.push({ id: row.id, step: "day1", ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: row.id, step: "day1", ok: false, err: msg });
    }
  }
  return results;
}

async function runDay2(supabase: any) {
  // Fires 36-60h after payment. Sits in the window between Day 1 welcome (18-36h)
  // and Day 7 halfway. Catches anyone who hasn't booked their first class.
  const startWindow = new Date(Date.now() - 60 * 3600_000).toISOString();
  const endWindow   = new Date(Date.now() - 36 * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_date,winback_email_count")
    .eq("payment_status", "completed")
    .is("day2_email_sent_at", null)
    .is("opted_out_at", null)
    .lt("payment_date", endWindow)
    .gt("payment_date", startWindow)
    .limit(50);
  if (error) throw error;

  const results: any[] = [];
  for (const row of (data ?? []) as Row[]) {
    const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];
    if (!studio || !row.email) {
      results.push({ id: row.id, step: "day2", ok: false, err: !studio ? "unknown location" : "no email" });
      continue;
    }

    // Skip people who've already attended a class since paying. Sending them
    // a "have you booked?" email would be awkward and break trust.
    const attended = await hasAttendedDuringTrial(supabase, row.email, row.payment_date);
    if (attended) {
      await supabase.from("trial_signups")
        .update({ day2_email_sent_at: new Date().toISOString() }).eq("id", row.id);
      results.push({ id: row.id, step: "day2", ok: true, action: "skip-attended" });
      continue;
    }

    try {
      const tmpl = day2(studio, row.name ?? "");
      await sendResend(row.email, tmpl.subject, tmpl.html, tmpl.text, studio.studioEmail);
      await supabase.from("trial_signups")
        .update({ day2_email_sent_at: new Date().toISOString() }).eq("id", row.id);
      results.push({ id: row.id, step: "day2", ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: row.id, step: "day2", ok: false, err: msg });
    }
  }
  return results;
}

// Has this person attended at least one class since they paid for the trial?
// Used to skip the Day 2 "have you booked?" email for people who clearly already
// have. Returns false on any error so we send the email rather than miss them.
async function hasAttendedDuringTrial(
  supabase: any,
  email: string | null,
  paymentDate: string | null,
): Promise<boolean> {
  if (!email || !paymentDate) return false;
  try {
    const { data: client } = await supabase
      .from("mindbody_clients")
      .select("client_id")
      .eq("email", email)
      .maybeSingle();
    const clientId = client?.client_id;
    if (!clientId) return false;
    const { data: visit } = await supabase
      .from("mindbody_visits")
      .select("visit_date")
      .eq("client_id", clientId)
      .gte("visit_date", paymentDate)
      .limit(1)
      .maybeSingle();
    return !!visit;
  } catch {
    return false;
  }
}

async function lookupRecentVisit(supabase: any, email: string | null, locationId: string | null): Promise<string | null> {
  if (!email || !locationId) return null;
  try {
    const { data: clientData } = await supabase
      .from("mindbody_clients")
      .select("client_id")
      .eq("email", email)
      .maybeSingle();
    const clientId = clientData?.client_id;
    if (!clientId) return null;
    const { data: visit } = await supabase
      .from("mindbody_visits")
      .select("visit_date")
      .eq("client_id", clientId)
      .order("visit_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    return visit?.visit_date ?? null;
  } catch {
    return null;
  }
}

async function runDay7(supabase: any) {
  const startWindow = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const endWindow   = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_date,winback_email_count")
    .eq("payment_status", "completed")
    .is("day7_email_sent_at", null)
    .is("opted_out_at", null)
    .lt("payment_date", endWindow)
    .gt("payment_date", startWindow)
    .limit(50);
  if (error) throw error;

  const results: any[] = [];
  for (const row of (data ?? []) as Row[]) {
    const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];
    if (!studio || !row.email) {
      results.push({ id: row.id, step: "day7", ok: false, err: !studio ? "unknown location" : "no email" });
      continue;
    }
    try {
      const recent = await lookupRecentVisit(supabase, row.email, row.location_id);
      const tmpl = day7(studio, row.name ?? "", recent);
      await sendResend(row.email, tmpl.subject, tmpl.html, tmpl.text, studio.studioEmail);
      await supabase.from("trial_signups")
        .update({ day7_email_sent_at: new Date().toISOString() }).eq("id", row.id);
      results.push({ id: row.id, step: "day7", ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: row.id, step: "day7", ok: false, err: msg });
    }
  }
  return results;
}

async function runDay14(supabase: any) {
  const startWindow = new Date(Date.now() - 15 * 86_400_000).toISOString();
  const endWindow   = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_date,winback_email_count")
    .eq("payment_status", "completed")
    .is("day14_email_sent_at", null)
    .is("opted_out_at", null)
    .eq("converted_to_member", false)
    .lt("payment_date", endWindow)
    .gt("payment_date", startWindow)
    .limit(50);
  if (error) throw error;

  const results: any[] = [];
  for (const row of (data ?? []) as Row[]) {
    const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];
    if (!studio || !row.email) {
      results.push({ id: row.id, step: "day14", ok: false, err: !studio ? "unknown location" : "no email" });
      continue;
    }
    try {
      const tmpl = day14(studio, row.name ?? "");
      await sendResend(row.email, tmpl.subject, tmpl.html, tmpl.text, studio.studioEmail);
      await supabase.from("trial_signups")
        .update({ day14_email_sent_at: new Date().toISOString() }).eq("id", row.id);
      results.push({ id: row.id, step: "day14", ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: row.id, step: "day14", ok: false, err: msg });
    }
  }
  return results;
}

// Single winback at Day 17 (give them ~3 days after trial ends before nudging).
async function runWinback(supabase: any) {
  const startWindow = new Date(Date.now() - 18 * 86_400_000).toISOString();
  const endWindow   = new Date(Date.now() - 17 * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("trial_signups")
    .select("id,name,email,phone,location_id,payment_date,winback_email_count")
    .eq("payment_status", "completed")
    .eq("converted_to_member", false)
    .is("opted_out_at", null)
    .eq("winback_email_count", 0)
    .lt("payment_date", endWindow)
    .gt("payment_date", startWindow)
    .limit(50);
  if (error) throw error;

  const results: any[] = [];
  for (const row of (data ?? []) as Row[]) {
    const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];
    if (!studio || !row.email) {
      results.push({ id: row.id, step: "winback", ok: false, err: !studio ? "unknown location" : "no email" });
      continue;
    }
    try {
      const tmpl = winback(studio, row.name ?? "");
      await sendResend(row.email, tmpl.subject, tmpl.html, tmpl.text, studio.studioEmail);
      await supabase.from("trial_signups")
        .update({
          winback_email_count: 1,
          winback_last_sent_at: new Date().toISOString(),
        }).eq("id", row.id);
      results.push({ id: row.id, step: "winback", ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: row.id, step: "winback", ok: false, err: msg });
    }
  }
  return results;
}

// ─── HTTP entry ───────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Day 7 "halfway through" is paused per user request — runDay7 + day7
    // template still exist below for easy re-enable.
    const [d1, d2, d14, wb] = await Promise.all([
      runDay1(supabase).catch(e => [{ step: "day1", ok: false, err: String(e) }]),
      runDay2(supabase).catch(e => [{ step: "day2", ok: false, err: String(e) }]),
      runDay14(supabase).catch(e => [{ step: "day14", ok: false, err: String(e) }]),
      runWinback(supabase).catch(e => [{ step: "winback", ok: false, err: String(e) }]),
    ]);

    const all = [...d1, ...d2, ...d14, ...wb];

    return new Response(
      JSON.stringify({
        ok: true,
        processed: all.length,
        sent: all.filter((r: any) => r.ok).length,
        failed: all.filter((r: any) => !r.ok).length,
        details: all,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Function error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
