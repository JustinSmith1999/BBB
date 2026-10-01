import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// 2026-09-23 (Justin): route Contact-form leads into the studio's Quo shared
// inbox instead of only emailing. Texting the studio's Quo number lands the
// lead in the shared inbox, so every staffer on that line gets pinged (and
// respects their own on/off availability). Only the studios live on Quo are
// mapped; Astoria/Williamsburg are unmapped and fall back to email only.
const QUO_STUDIO_NUMBER: Record<string, string> = {
  bayside: "+19178770759",
  freshmeadows: "+16468876483",
};
async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") || Deno.env.get("TWILIO_FROM");
  if (!sid || !token || !from) return { ok: false, error: "twilio env missing" };
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, sid: (j as any).sid } : { ok: false, error: (j as any).message || `HTTP ${r.status}` };
}

function toE164(p: string): string | null {
  const d = (p || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
// Create the lead as a NAMED contact in Quo so the number resolves to the person
// (one-tap call/text) instead of showing a raw number. No outbound message is
// sent — staff reach out themselves.
async function quoCreateContact(firstName: string, lastName: string, phone: string | null, email: string | null, location?: string, inquiry?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return { ok: false, error: "QUO_API_KEY missing" };
  const defaultFields: any = { firstName: firstName || "Website", lastName: lastName || "Lead" };
  const e164 = phone ? toE164(phone) : null;
  if (e164) defaultFields.phoneNumbers = [{ name: "mobile", value: e164 }];
  if (email) defaultFields.emails = [{ name: "email", value: email }];
  // Tag + surface what they asked, so staff see it in the conversation's
  // contact panel (the API can't post a real inbound message from the lead).
  if (location) defaultFields.company = `Website lead · ${location}`;
  const q = (inquiry || "").trim().replace(/\s+/g, " ");
  if (q) defaultFields.role = `Asked: "${q.slice(0, 180)}${q.length > 180 ? "…" : ""}"`;
  const r = await fetch("https://api.quo.com/v1/contacts", {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultFields, source: "website-contact-form" }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: (j as any)?.data?.id } : { ok: false, error: (j as any)?.message || `HTTP ${r.status}` };
}
// Send a text FROM the studio's Quo number TO the lead. This is what spins up
// each lead's own named conversation in the shared inbox (self-threading), so
// staff text/call the person straight from it. Blocked until 10DLC is approved
// (returns a2pBlocked) — caller falls back to the inbox alert until then.
async function quoSendMessage(fromE164: string, toE164: string, content: string): Promise<{ ok: boolean; a2pBlocked?: boolean; error?: string }> {
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return { ok: false, error: "QUO_API_KEY missing" };
  const r = await fetch("https://api.quo.com/v1/messages", {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromE164, to: [toE164], content }),
  });
  if (r.ok) return { ok: true };
  const j = await r.json().catch(() => ({}));
  const code = String((j as any)?.code || "");
  return { ok: false, a2pBlocked: code === "0206400" || r.status === 400, error: (j as any)?.message || `HTTP ${r.status}` };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const reqBody = await req.json().catch(() => ({}));

    // ─── Admin: count historical contact-form submissions ──────────────────
    // Read-only — queries Resend's /emails list and counts ones whose subject
    // starts with "New Contact Form Submission". Sends NO emails. Auth via the
    // FUNCTION_SHARED_SECRET header (same pattern as other admin endpoints).
    //   curl ... -d '{"count_contact_submissions": true}'
    if ((reqBody as any).count_contact_submissions) {
      const SHARED_SECRET = Deno.env.get("FUNCTION_SHARED_SECRET") ?? "";
      const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const presentedSecret = req.headers.get("x-bbb-secret") ?? "";
      const presentedBearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const authed =
        (SHARED_SECRET && presentedSecret === SHARED_SECRET) ||
        (SERVICE_ROLE && presentedBearer === SERVICE_ROLE);
      if (!authed) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized — x-bbb-secret or service-role bearer required" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const KEY = Deno.env.get("RESEND_API_KEY");
      if (!KEY) {
        return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not set" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const matches: any[] = [];
      let cursor: string | null = null;
      let pages = 0;
      // Paginate up to 20 pages × 100 = 2000 emails (more than enough)
      while (pages < 20) {
        const url = new URL("https://api.resend.com/emails");
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("after", cursor);
        const r = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${KEY}` },
        });
        if (!r.ok) {
          const txt = await r.text();
          return new Response(JSON.stringify({ ok: false, error: `Resend list ${r.status}: ${txt.slice(0, 300)}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const body = await r.json() as { data?: any[]; has_more?: boolean };
        const items = body?.data || [];
        for (const item of items) {
          const subj = String(item.subject || "");
          if (subj.startsWith("New Contact Form Submission")) {
            matches.push({
              id: item.id,
              date: item.created_at,
              to: Array.isArray(item.to) ? item.to.join(", ") : item.to,
              subject: subj,
              // Resend doesn't always return `from`/sender; capture if present
              from: item.from || null,
            });
          }
        }
        if (!body?.has_more || !items.length) break;
        cursor = items[items.length - 1]?.id ?? null;
        if (!cursor) break;
        pages++;
      }
      // Group by recipient mailbox so Justin can see which studio got how many
      const byMailbox: Record<string, number> = {};
      for (const m of matches) {
        const to = String(m.to || "").toLowerCase();
        byMailbox[to] = (byMailbox[to] || 0) + 1;
      }
      return new Response(JSON.stringify({
        ok: true,
        total_contact_submissions: matches.length,
        pages_scanned: pages + 1,
        by_mailbox: byMailbox,
        most_recent_10: matches.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10),
      }, null, 2),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { name, email, phone, location, locationEmail, message, utm_source, utm_medium, utm_campaign, utm_content } = reqBody;

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

    // Route the message to the selected studio's own mailbox — astoria@,
    // bayside@, freshmeadows@, williamsburg@ — derived from the studio name so
    // it never depends on the locations.contact_email column being set right.
    const studioMailbox = (studioName: string): string | null => {
      const key = (studioName || "").toLowerCase().replace(/[^a-z]/g, "");
      const known = ["astoria", "bayside", "freshmeadows", "williamsburg"];
      return known.includes(key) ? `${key}@betterbodybootcamp.com` : null;
    };
    // Studio mailbox first; locationEmail then info@ only as fallbacks
    // (e.g. when the visitor didn't pick a studio).
    const TO_EMAIL = studioMailbox(location) || locationEmail || "info@betterbodybootcamp.com";

    console.log("Sending email to:", TO_EMAIL);
    console.log("From:", name, email);
    console.log("Location requested:", location);

    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured");
    }

    const emailBody = `
      New Contact Form Submission

      Name: ${name}
      Email: ${email}
      Phone: ${phone || "Not provided"}
      Preferred Location: ${location || "Not specified"}

      Message:
      ${message}
    `;

    const emailPayload = {
      from: "Better Body Bootcamp <noreply@betterbodybootcamp.com>",
      to: [TO_EMAIL],
      reply_to: email,
      subject: `New Contact Form Submission from ${name}`,
      text: emailBody,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
        <p><strong>Preferred Location:</strong> ${location || "Not specified"}</p>
        <h3>Message:</h3>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `,
    };

    console.log("Sending email with payload:", JSON.stringify(emailPayload, null, 2));

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await res.text();
    console.log("Resend API response status:", res.status);
    console.log("Resend API response:", responseText);

    if (!res.ok) {
      console.error("Resend API error:", responseText);
      throw new Error(`Failed to send email (${res.status}): ${responseText}`);
    }

    // ─── Persist the submission so the owner dashboard can show it ─────────
    // We do this AFTER the email send so a DB error doesn't lose the email.
    // Classification (asked_about_monthly / trial / pricing) is computed via
    // the SQL function so the same logic can be re-used for backfill jobs.
    let resendEmailId: string | null = null;
    try { resendEmailId = JSON.parse(responseText)?.id ?? null; } catch {}
    try {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      );
      // Best-effort location_id lookup. The form sends a label like "Fresh
      // Meadows"; locations.name matches. Falls back to NULL if no match,
      // which still lets the dashboard show the row under its location_label.
      let locationId: string | null = null;
      if (location && typeof location === "string") {
        const { data: locRow } = await sb
          .from("locations")
          .select("id")
          .ilike("name", location.trim())
          .maybeSingle();
        locationId = (locRow as any)?.id ?? null;
      }
      // Pull classification from the SQL function so the regex lives in one
      // place. If the RPC fails for any reason, default to all-false rather
      // than block the insert.
      let cls = { asked_about_monthly: false, asked_about_trial: false, asked_about_pricing: false };
      try {
        const { data: c } = await sb.rpc("classify_contact_form_message", { p_message: message ?? "" });
        if (Array.isArray(c) && c[0]) cls = c[0];
        else if (c && typeof c === "object") cls = c as any;
      } catch (e) {
        console.warn("classify_contact_form_message RPC failed:", (e as Error).message);
      }
      const { error: insErr } = await sb.from("contact_form_submissions").insert({
        name:    name ?? "",
        email:   email ?? "",
        phone:   phone ?? null,
        message: message ?? "",
        location_id:    locationId,
        location_label: location ?? null,
        asked_about_monthly: !!cls.asked_about_monthly,
        asked_about_trial:   !!cls.asked_about_trial,
        asked_about_pricing: !!cls.asked_about_pricing,
        resend_email_id: resendEmailId,
        studio_mailbox:  TO_EMAIL,
        raw: { name, email, phone, location, message, locationEmail },
      });
      if (insErr) console.error("contact_form_submissions insert failed:", insErr.message);
    } catch (e) {
      console.error("contact_form_submissions insert exception:", (e as Error).message);
    }

    const data = JSON.parse(responseText);
    console.log("Email sent successfully via Resend:", data);

    // ─── Capture as a lead so the contact-form submission shows up in our
    // CRM (and the Homebase if we ever surface leads there). Without this,
    // every contact submission was being lost as a lead — only the email
    // notification fired.
    // Upsert-style: UPDATE existing lead with same email first, otherwise INSERT.
    // Never blocks the email response — log + swallow on failure.
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      );
      const studioSlug = (location || "")
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "") || null;
      const noteParts = [
        `Contact form: ${message || "(no message)"}`,
        location ? `Preferred location: ${location}` : null,
      ].filter(Boolean);
      const leadFields = {
        full_name: name || null,
        phone: phone || null,
        source: "contact-form",
        stage: "new_inquiry",
        studio_slug: studioSlug,
        last_touch_at: new Date().toISOString(),
        notes: noteParts.join(" · "),
        // 2026-07-23: carry the ad/source tag through so contact-form leads are
        // attributable (previously always landed untagged).
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        utm_content: utm_content || null,
      };
      if (email) {
        const normEmail = String(email).trim().toLowerCase();
        const { data: updated, error: updErr } = await supabase
          .from("leads")
          .update(leadFields)
          .eq("email", normEmail)
          .select("id");
        if (updErr) {
          console.error("contact-form lead update failed:", updErr.message);
        } else if (!updated || updated.length === 0) {
          const { error: insErr } = await supabase
            .from("leads")
            .insert({ ...leadFields, email: normEmail });
          if (insErr) console.error("contact-form lead insert failed:", insErr.message);
          else console.log("contact-form: new lead inserted for", normEmail);
        } else {
          console.log(`contact-form: ${updated.length} existing lead row(s) updated for`, normEmail);
        }
      }
    } catch (leadErr) {
      console.error("contact-form lead capture exception:", leadErr);
    }

    // ─── Route the lead into the studio's OWN Quo thread (contact + task) ───
    // via quo-lead-router — NOT the shared 877 relay inbox, which produced the
    // "Could not tell who this reply is for" bounces when staff replied there.
    // The router creates a named Quo contact + a Quo Task on the studio line;
    // staff tap the contact to call/text the person directly in their own
    // thread. NO auto-text to the customer. Astoria / Williamsburg aren't on
    // Quo → the router returns {skipped} and the studio email above still went
    // out. Best-effort: never blocks or fails the response.
    try {
      const slug = (location || "").toLowerCase().replace(/[^a-z]/g, "");
      // Source label from what the form captured (utm first, else in-app UA, else Direct)
      // — same vocabulary as request-schedule-sms so tasks read consistently.
      const us = String(utm_source || "").toLowerCase();
      const ua = req.headers.get("user-agent") || "";
      const source =
        us === "instagram" || us === "ig" ? (String(utm_content || "").toLowerCase() === "bio" ? "Instagram bio" : "Instagram")
        : us === "facebook" || us === "fb" ? (String(utm_medium || "").toLowerCase() === "cpc" ? "Facebook ad" : "Facebook")
        : us.startsWith("gbp") || us === "gmb" ? "Google Business Profile"
        : us === "google" ? "Google"
        : us ? String(utm_source).slice(0, 30)
        : /Instagram/i.test(ua) ? "Instagram"
        : /FBAN|FBAV/i.test(ua) ? "Facebook"
        : "No referrer (typed / texted link / QR)";
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/quo-lead-router`, {
        method: "POST",
        headers: {
          "x-bbb-secret": Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, phone, email, studio_slug: slug, kind: "inquiry", source, note: message }),
      });
      if (!r.ok) console.error("quo-lead-router (lead) failed:", r.status);
    } catch (e) {
      console.error("quo lead routing exception:", (e as Error).message);
    }

    return new Response(
      JSON.stringify({ success: true, data }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
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