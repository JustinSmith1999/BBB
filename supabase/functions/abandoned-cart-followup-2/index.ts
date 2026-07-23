/**
 * abandoned-cart-followup-2 — Supabase Edge Function (TOUCH #2)
 *
 * Sister function to abandoned-cart-followup. Sends a SECOND nudge to people
 * who got the first cart-recovery email at least 24h ago and still haven't
 * paid. One touch-2 per cart, ever. Different copy from touch-1 (owner
 * "checking in" voice, no discount, ask-them-to-reply CTA).
 *
 * Eligibility (all must be true):
 *   - trial_signups.abandoned_email_sent_at IS NOT NULL
 *   - trial_signups.abandoned_email_sent_at <= now() - 24h
 *   - trial_signups.abandoned_email2_sent_at IS NULL
 *   - trial_signups.payment_status NOT IN ('completed', 'paid')
 *   - trial_signups.deleted_at IS NULL
 *   - email/phone not present in stripe_paid_mirror (belt + suspenders)
 *   - touch-1 isn't more than 14 days stale (cold-cart cap)
 *
 * Calling:
 *   POST /functions/v1/abandoned-cart-followup-2          → live send
 *   POST /functions/v1/abandoned-cart-followup-2?dry_run=1 → preview, no send
 *
 * Required env vars (inherits from touch-1 function settings):
 *   SUPABASE_URL                 (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY    (auto-injected)
 *   RESEND_API_KEY               (must be set on this function)
 *   FROM_EMAIL                   (defaults if unset)
 *
 * Deploy:
 *   supabase functions deploy abandoned-cart-followup-2 --project-ref uracuwugpxqjfgtuobal
 *
 * Cron: schedule every 30 minutes in Supabase Dashboard → Edge Functions → Cron.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Canonical studio mapping. MUST match abandoned-cart-followup/index.ts.
const LOCATION_TO_STUDIO: Record<string, {
  slug: string;
  name: string;
  shortName: string;
  phone: string;
  bookingUrl: string;
  studioEmail: string;
}> = {
  "80536b45-df0e-42d1-880c-e9301372e1cf": {
    slug: "williamsburg",
    name: "Better Body Bootcamp Williamsburg",
    shortName: "Williamsburg",
    phone: "(718) 683-1864",
    bookingUrl: "https://betterbodybootcamp.com/trial/williamsburg",
    studioEmail: "williamsburg@betterbodybootcamp.com",
  },
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": {
    slug: "astoria",
    name: "Better Body Bootcamp Astoria",
    shortName: "Astoria",
    phone: "(718) 704-9954",
    bookingUrl: "https://betterbodybootcamp.com/trial/astoria",
    studioEmail: "astoria@betterbodybootcamp.com",
  },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": {
    slug: "bayside",
    name: "Better Body Bootcamp Bayside",
    shortName: "Bayside",
    phone: "(646) 566-8870",
    bookingUrl: "https://betterbodybootcamp.com/trial/bayside",
    studioEmail: "bayside@betterbodybootcamp.com",
  },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": {
    slug: "fresh-meadows",
    name: "Better Body Bootcamp Fresh Meadows",
    shortName: "Fresh Meadows",
    phone: "(646) 566-8207",
    bookingUrl: "https://betterbodybootcamp.com/trial/fresh-meadows",
    studioEmail: "freshmeadows@betterbodybootcamp.com",
  },
};

const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Touch-2 copy: approved by Justin 2026-06-06. No owner name, no em dashes,
// no discount. Different angle from touch-1: ask-and-listen voice with the
// reply CTA equally weighted to the finish-checkout CTA.
function buildEmail(customerName: string, studio: typeof LOCATION_TO_STUDIO[string]) {
  const firstName = (customerName || "").split(" ")[0] || "there";

  return {
    subject: `Quick question about your trial`,
    html: `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;overflow:hidden">
        <tr><td style="background:#d63838;padding:24px 32px">
          <p style="margin:0;color:#fff;font-size:13px;letter-spacing:1.5px;opacity:0.9">${studio.name.toUpperCase()}</p>
        </td></tr>
        <tr><td style="padding:32px">
          <p style="margin:0 0 16px;line-height:1.6;font-size:16px">Hey ${firstName},</p>
          <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
            We saw you started signing up for the 2-week trial at Better Body Bootcamp ${studio.shortName} a few days ago and didn't finish. Totally get it, life happens.
          </p>
          <p style="margin:0 0 16px;line-height:1.6;font-size:16px">
            If something stopped you (class times, the intro, schedule, money), hit reply and tell us. We read every one.
          </p>
          <p style="margin:0 0 24px;line-height:1.6;font-size:16px">
            If you just got busy, here's the link to pick back up where you left off. Same $49, same 2 weeks:
          </p>

          <table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#d63838;border-radius:6px">
            <a href="${studio.bookingUrl}" style="display:inline-block;padding:16px 32px;color:#fff;text-decoration:none;font-weight:700;font-size:16px;letter-spacing:0.5px">FINISH YOUR TRIAL</a>
          </td></tr></table>

          <p style="margin:32px 0 0;line-height:1.6;font-size:15px">
            Either way, no pressure. Just wanted to make sure the door was open.
          </p>

          <p style="margin:24px 0 0;line-height:1.6;font-size:14px;color:#666">
            Better Body Bootcamp ${studio.shortName}<br>
            ${studio.phone}
          </p>
        </td></tr>
        <tr><td style="background:#fafafa;padding:16px;text-align:center;font-size:11px;color:#888;border-top:1px solid #eee">
          You're receiving this because you started a trial signup at ${studio.shortName}.
          Don't want these emails? Just reply STOP.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>
`,
    text: `Hey ${firstName},

We saw you started signing up for the 2-week trial at Better Body Bootcamp ${studio.shortName} a few days ago and didn't finish. Totally get it, life happens.

If something stopped you (class times, the intro, schedule, money), hit reply and tell us. We read every one.

If you just got busy, here's the link to pick back up where you left off. Same $49, same 2 weeks:

${studio.bookingUrl}

Either way, no pressure. Just wanted to make sure the door was open.

Better Body Bootcamp ${studio.shortName}
${studio.phone}`,
  };
}

async function sendEmail(
  supabase: ReturnType<typeof createClient>,
  trialId: string,
  studioSlug: string,
  to: string,
  name: string,
  studio: typeof LOCATION_TO_STUDIO[string],
) {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY not set");
  }
  const tmpl = buildEmail(name, studio);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      reply_to: studio.studioEmail,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      tags: [
        // NEW send_path so dashboard / Funnel Health can count touch-2 sends
        // separately from touch-1. Attribution RPCs need to be extended to
        // count abandoned_cart_email_2 in addition to abandoned_cart_email.
        { name: "send_path",       value: "abandoned_cart_email_2" },
        { name: "trial_signup_id", value: trialId },
        { name: "studio_slug",     value: studioSlug },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }
  const body = await res.json();
  try {
    await supabase.from("email_log").insert({
      trial_signup_id: trialId,
      send_path:       "abandoned_cart_email_2",
      resend_id:       body?.id ?? null,
      from_addr:       FROM_EMAIL,
      to_addrs:        [to],
      subject:         tmpl.subject,
      event_type:      "sent_inline",
      raw:             { source: "abandoned-cart-followup-2", studio_slug: studioSlug, resend_id: body?.id ?? null },
    });
  } catch (logErr) {
    console.warn("email_log insert failed (continuing):", (logErr as Error).message);
  }
  return body;
}

const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
const normPhone = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "");

// Sweep every pending row for this person and stamp the touch-2 flag, so
// duplicate signups can't trigger a second touch-2 on a later cron run.
async function markPersonHandled(
  supabase: ReturnType<typeof createClient>,
  row: { email: string | null; phone: string | null },
) {
  const ts = new Date().toISOString();
  if (row.phone) {
    await supabase.from("trial_signups")
      .update({ abandoned_email2_sent_at: ts })
      .is("abandoned_email2_sent_at", null)
      .eq("phone", row.phone);
  }
  if (row.email) {
    await supabase.from("trial_signups")
      .update({ abandoned_email2_sent_at: ts })
      .is("abandoned_email2_sent_at", null)
      .eq("email", row.email);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "1";

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Eligibility window: touch-1 went out ≥24h ago but ≤14d ago. The 14d cap
    // matches touch-1's cold-cart cutoff so we don't re-poke ancient carts.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo    = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from("trial_signups")
      .select("id, name, email, phone, location_id, abandoned_email_sent_at")
      .not("abandoned_email_sent_at", "is", null)
      .lt("abandoned_email_sent_at", twentyFourHoursAgo)
      .gt("abandoned_email_sent_at", fourteenDaysAgo)
      .is("abandoned_email2_sent_at", null)
      .neq("payment_status", "completed")
      .neq("payment_status", "paid")
      .is("deleted_at", null)
      .order("abandoned_email_sent_at", { ascending: true })
      .limit(100);

    if (queryErr) {
      console.error("Query error:", queryErr);
      return new Response(
        JSON.stringify({ ok: false, error: queryErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Same belt-and-suspenders paid-customer guard as touch-1. Catches anyone
    // who paid AFTER the abandoned-cart flag was set but BEFORE the touch-2
    // window opens. Without this, a customer who pays within the 24h gap
    // would still get touch-2 (annoying and embarrassing).
    const [paidRowsResult, mirrorResult] = await Promise.all([
      supabase.from("trial_signups").select("email, phone")
        .or("payment_status.eq.completed,payment_status.eq.paid"),
      supabase.from("stripe_paid_mirror").select("customer_email, customer_phone"),
    ]);

    if (paidRowsResult.error) {
      console.error("Paid-lookup error:", paidRowsResult.error);
      return new Response(
        JSON.stringify({ ok: false, error: paidRowsResult.error.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (mirrorResult.error) {
      console.error("Mirror-lookup error (continuing):", mirrorResult.error.message);
    }

    const paidEmails = new Set<string>();
    const paidPhones = new Set<string>();
    for (const r of paidRowsResult.data ?? []) {
      const e = normEmail(r.email);  if (e) paidEmails.add(e);
      const p = normPhone(r.phone); if (p) paidPhones.add(p);
    }
    for (const m of mirrorResult.data ?? []) {
      const e = normEmail(m.customer_email);  if (e) paidEmails.add(e);
      const p = normPhone(m.customer_phone); if (p) paidPhones.add(p);
    }

    const sentEmails = new Set<string>();
    const sentPhones = new Set<string>();
    const results: Array<{
      id: string; name: string; email: string; studio?: string;
      ok: boolean; err?: string; dry_run?: boolean;
    }> = [];

    for (const row of candidates ?? []) {
      const email = normEmail(row.email);
      const phone = normPhone(row.phone);
      const studio = LOCATION_TO_STUDIO[row.location_id ?? ""];

      if ((email && paidEmails.has(email)) || (phone && paidPhones.has(phone))) {
        results.push({ id: row.id, name: row.name ?? "", email: row.email ?? "", studio: studio?.slug, ok: false, err: "skipped: already paid" });
        continue;
      }
      if ((email && sentEmails.has(email)) || (phone && sentPhones.has(phone))) {
        if (!dryRun) await markPersonHandled(supabase, row);
        results.push({ id: row.id, name: row.name ?? "", email: row.email ?? "", studio: studio?.slug, ok: false, err: "skipped: duplicate signup" });
        continue;
      }
      if (!studio || !row.email) {
        results.push({
          id: row.id, name: row.name ?? "", email: row.email ?? "", studio: studio?.slug,
          ok: false, err: !studio ? "unknown location" : "no email",
        });
        continue;
      }

      if (dryRun) {
        results.push({ id: row.id, name: row.name ?? "", email: row.email, studio: studio.slug, ok: true, dry_run: true });
        continue;
      }

      try {
        await sendEmail(supabase, row.id, studio.slug, row.email, row.name ?? "", studio);
        if (email) sentEmails.add(email);
        if (phone) sentPhones.add(phone);
        await markPersonHandled(supabase, row);
        results.push({ id: row.id, name: row.name ?? "", email: row.email, studio: studio.slug, ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Send failed for ${row.email}:`, msg);
        results.push({ id: row.id, name: row.name ?? "", email: row.email, studio: studio.slug, ok: false, err: msg });
      }
      // Resend's free tier caps at 5 req/sec. The first run on 2026-06-06
      // burst-fired 14 in <2s and the last 4 came back HTTP 429. 250ms
      // between sends keeps us safely under the cap even when a cron run
      // back-to-backs with another path that also uses Resend.
      await new Promise((r) => setTimeout(r, 250));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: dryRun,
        processed: results.length,
        sent: results.filter(r => r.ok && !r.dry_run).length,
        would_send: results.filter(r => r.ok && r.dry_run).length,
        skipped: results.filter(r => !r.ok && (r.err ?? "").startsWith("skipped")).length,
        failed: results.filter(r => !r.ok && !(r.err ?? "").startsWith("skipped")).length,
        details: results,
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
