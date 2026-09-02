import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// winback-blast — the 2026-08-21 two-offer winback send (Justin).
//
//   bts299 -> expired trials  -> "$299 Back to School (2 months)"  -> /bts/<studio>
//   free3  -> abandoned carts -> "3 Free Classes"                  -> /trial/<studio>
//
// Audience: campaigns/winback-batch-2026-08-21.json (private bucket) — the
// verified 504 from BBB-Winback-List.xlsx (members / active trials / buyers /
// dupes / test accounts already excluded). TEXT first, EMAIL fallback rows
// are pre-decided in the batch file.
//
// SAFETY (all three required to send a single message):
//   1. BBB_SEND_PATHS_ENABLED must contain 'winback_blast'  (NOT added yet)
//   2. Request body must include {"live": true, "confirm": "SEND-IT"}
//   3. Per-person kill-checks re-run AT SEND TIME: bought membership since,
//      trial now active, Homebase member, opted out -> row skipped.
// Anything else = dry run: returns the full would-send report, sends nothing.
//
// Idempotent: each send is logged (sms_messages / email_log) with
// send_path winback_free3 / winback_bts299; on re-run, already-logged
// recipients are skipped. Default 25 sends per invocation (call repeatedly,
// or pass {"limit": N}); 350ms between sends. Filters: {"offer":"free3"},
// {"studio":"bayside"} to send in slices.
//
// Deploy: bbb deploy-fn winback-blast
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "bbb-test-2026-05-27";
const BATCH_PATH = "winback-batch-2026-08-21.json";
const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SR_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const STUDIO_TITLE: Record<string, string> = {
  "astoria": "Astoria", "bayside": "Bayside",
  "fresh-meadows": "Fresh Meadows", "williamsburg": "Williamsburg",
};
const PAIR: Record<string, "bfm" | "aw"> = {
  "bayside": "bfm", "fresh-meadows": "bfm", "astoria": "aw", "williamsburg": "aw",
};
const HERO: Record<string, string> = {
  bfm: `${SUPA_URL}/storage/v1/object/public/logos/emails/free3-bfm-hero.jpg`,
  aw:  `${SUPA_URL}/storage/v1/object/public/logos/emails/free3-aw-hero.jpg`,
};
const ADDR: Record<string, string> = {
  bfm: "Bayside &middot; 34-47 Bell Blvd, Bayside, NY 11361<br>Fresh Meadows &middot; 76-46 164th St, Fresh Meadows, NY 11366",
  aw:  "Williamsburg &middot; 487 Driggs Ave, Brooklyn, NY 11211<br>Astoria &middot; 31-18 Steinway St, Astoria, NY 11103",
};
const LOGO = `${SUPA_URL}/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png`;

function sb() { return createClient(SUPA_URL, SR_KEY); }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }
function firstName(name: string): string { return (name || "").trim().split(/\s+/)[0] || "there"; }

// ── copy ────────────────────────────────────────────────────────────────────
function smsBody(offer: string, first: string, slug: string): string {
  const studio = STUDIO_TITLE[slug] || "BBB";
  if (offer === "bts299") {
    // 2026-08-30: direct /backtoschool link with honest sms/winback UTMs —
    // the /bts/* redirects stamp instagram/social attribution (bio links).
    // 2026-08-31 (Justin): lead with NEW OWNERSHIP — this list left under the
    // old management; that's the hook.
    return `Hi ${first}, it's Better Body Bootcamp ${studio}. It's a different gym than the one you left: new ownership this past year, new coaches, rebuilt programming. Come see for yourself: 2 months of unlimited classes for $299, one payment, no auto-renewal. https://betterbodybootcamp.com/backtoschool?studio=${slug}&utm_source=sms&utm_medium=winback&utm_campaign=back-to-school-299 Reply STOP to opt out.`;
  }
  // 2026-08-22 rewrite after Justin's test landed in spam: no "$49 trial"
  // mention, no guilt-trip phrasing, shorter. Goes out as MMS with the
  // 3-free-classes card attached (see MMS_CARD below).
  return `Hi ${first}, it's Better Body Bootcamp ${studio}. Come see for yourself: 3 classes on us, good through Sep 21. Claim yours here: https://betterbodybootcamp.com/free3/${slug} Reply STOP to opt out.`;
}

// Image attached to free3 texts (MMS): the FULL email design per studio pair
// (Justin 2026-08-22 — whole design, not a crop). bfm = original mockup;
// aw = same design with the W+A group photo + W+A addresses swapped in.
// 2026-08-28: Back to School flyers (Justin's print designs) — attached to
// bts299 texts as MMS and used as the email hero. Per-studio, Bayside + FM.
const BTS_CARD: Record<string, string> = {
  "astoria":       `${SUPA_URL}/storage/v1/object/public/logos/emails/bts299-astoria.jpg`,
  "bayside":       `${SUPA_URL}/storage/v1/object/public/logos/emails/bts299-bayside.jpg`,
  "fresh-meadows": `${SUPA_URL}/storage/v1/object/public/logos/emails/bts299-fresh-meadows.jpg`,
  "williamsburg":  `${SUPA_URL}/storage/v1/object/public/logos/emails/bts299-williamsburg.jpg`,
};

const MMS_CARD: Record<string, string> = {
  bfm: `${SUPA_URL}/storage/v1/object/public/logos/emails/free3-mms-bfm.jpg`,
  aw:  `${SUPA_URL}/storage/v1/object/public/logos/emails/free3-mms-aw.jpg`,
};

function free3Html(slug: string): string {
  const pair = PAIR[slug] || "aw";
  const cta = `https://betterbodybootcamp.com/free3/${slug}`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#0D0D0D;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0D0D0D;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background-color:#0D0D0D;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="padding:28px 32px 20px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td align="left" valign="middle"><img src="${LOGO}" alt="bbb" width="74" style="display:block;border:0;"></td>
<td align="right" valign="middle" style="font-size:13px;line-height:19px;font-weight:bold;letter-spacing:3px;color:#C8F31E;text-align:right;">STILL&nbsp;THINKING<br>ABOUT&nbsp;IT?</td>
</tr></table></td></tr>
<tr><td><img src="${HERO[pair]}" alt="Better Body Bootcamp" width="640" style="display:block;width:100%;height:auto;border:0;"></td></tr>
<tr><td align="center" style="padding:44px 24px 10px 24px;"><div style="font-family:'Arial Black',Arial,sans-serif;font-size:44px;line-height:46px;font-weight:900;color:#F2EFE6;letter-spacing:-1px;">COME&nbsp;SEE&nbsp;FOR&nbsp;YOURSELF</div></td></tr>
<tr><td align="center" style="padding:8px 24px 6px 24px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" align="right" style="font-family:'Arial Black',Arial,sans-serif;font-size:150px;line-height:150px;font-weight:900;color:#C8F31E;padding-right:14px;">3</td>
<td valign="middle" style="background-color:#C8F31E;padding:22px 26px;">
<div style="font-family:'Arial Black',Arial,sans-serif;font-size:52px;line-height:50px;font-weight:900;color:#0D0D0D;">FREE<br>CLASSES</div>
<div style="font-family:'Arial Black',Arial,sans-serif;font-size:17px;line-height:22px;font-weight:900;color:#0D0D0D;padding-top:8px;">ALL&nbsp;BETTER&nbsp;BODY&nbsp;LOCATIONS</div>
</td></tr></table></td></tr>
<tr><td style="padding:28px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #4A4A4A;"><tr>
<td style="padding:16px 20px;font-size:13px;letter-spacing:3px;color:#9A9A9A;">LIMITED&nbsp;TIME&nbsp;OFFER</td>
<td align="right" style="padding:16px 20px;font-size:18px;letter-spacing:2px;font-weight:bold;color:#FFFFFF;">EXPIRES&nbsp;SEP&nbsp;21</td>
</tr></table></td></tr>
<tr><td style="padding:22px 32px 0 32px;"><a href="${cta}" style="display:block;background-color:#C8F31E;color:#0D0D0D;font-family:'Arial Black',Arial,sans-serif;font-size:26px;font-weight:900;letter-spacing:8px;text-align:center;text-decoration:none;padding:24px 10px;">CLAIM&nbsp;MY&nbsp;3&nbsp;CLASSES</a></td></tr>
<tr><td align="center" style="padding:16px 24px 0 24px;font-size:15px;color:#BDBDBD;">No commitment. Just come see for yourself.</td></tr>
<tr><td style="padding:44px 32px 0 32px;">
<div style="font-size:20px;font-weight:bold;color:#FFFFFF;">Better Than Yesterday.</div>
<div style="padding-top:14px;font-size:14px;line-height:24px;color:#CFCFCF;">${ADDR[pair]}</div>
<div style="padding-top:16px;font-size:13px;letter-spacing:2px;font-weight:bold;">
<a href="https://instagram.com/betterbodybootcamp" style="color:#C8F31E;text-decoration:none;">INSTAGRAM</a><span style="color:#666666;">&nbsp;&middot;&nbsp;</span>
<a href="https://www.tiktok.com/@betterbodybootcamp" style="color:#C8F31E;text-decoration:none;">TIKTOK</a><span style="color:#666666;">&nbsp;&middot;&nbsp;</span>
<a href="https://betterbodybootcamp.com" style="color:#C8F31E;text-decoration:none;">WEBSITE</a></div>
<div style="padding:22px 0 34px 0;font-size:12px;line-height:19px;color:#8A8A8A;">You are receiving this because you asked us about classes.<br>Don't want these? Just reply "unsubscribe" and we'll take you off the list. &middot; Better Body Bootcamp, NYC</div>
</td></tr></table></td></tr></table></body></html>`;
}

function bts299Html(slug: string, first: string): string {
  const studio = STUDIO_TITLE[slug] || "BBB";
  // 2026-08-30: direct link with honest email/winback UTMs (was /bts/* which
  // stamps instagram attribution).
  const cta = `https://betterbodybootcamp.com/backtoschool?studio=${slug}&utm_source=email&utm_medium=winback&utm_campaign=back-to-school-299`;
  return `<!DOCTYPE html><html><head>
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>:root{color-scheme:light;supported-color-schemes:light;} .bbb-green{background-color:#C8FF2D !important;} .bbb-green-txt{color:#C8FF2D !important;}</style>
</head><body style="margin:0;padding:0;background-color:#0D0D0D;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0D0D0D;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background-color:#0D0D0D;font-family:Arial,Helvetica,sans-serif;">
<tr><td style="padding:28px 32px 8px 32px;"><img src="${LOGO}" alt="bbb" width="74" style="display:block;border:0;"></td></tr>
${BTS_CARD[slug] ? `<tr><td style="padding:18px 32px 0 32px;"><a href="${cta}"><img src="${BTS_CARD[slug]}" alt="Back to School: 2 months unlimited classes, $299, ends Sep 21" width="576" style="display:block;width:100%;height:auto;border:0;"></a></td></tr>` : ""}
<tr><td align="center" style="padding:30px 24px 0 24px;">
<div class="bbb-green-txt" style="font-size:13px;font-weight:bold;letter-spacing:4px;color:#C8FF2D !important;">BACK&nbsp;TO&nbsp;SCHOOL&nbsp;SPECIAL</div>
<div style="font-family:'Arial Black',Arial,sans-serif;font-size:38px;line-height:44px;font-weight:900;color:#F2EFE6;padding-top:14px;white-space:nowrap;">2&nbsp;MONTHS&nbsp;UNLIMITED</div>
<div class="bbb-green-txt" style="font-family:'Arial Black',Arial,sans-serif;font-size:74px;line-height:76px;font-weight:900;color:#C8FF2D !important;">$299</div>
<div style="padding-top:14px;font-size:16px;line-height:25px;color:#CFCFCF;">Hi ${first}, this is a different gym than the one you left. <span style="color:#F2EFE6;font-weight:bold;">A year of new ownership, new coaches, rebuilt&nbsp;programming.</span> Come back for the fall push: one&nbsp;payment, no&nbsp;auto-renewal, and your 2&nbsp;months start at your first&nbsp;class.</div>
</td></tr>
<tr><td style="padding:26px 32px 0 32px;"><a href="${cta}" class="bbb-green" style="display:block;background-color:#C8FF2D !important;color:#0D0D0D !important;font-family:'Arial Black',Arial,sans-serif;font-size:24px;font-weight:900;letter-spacing:6px;text-align:center;text-decoration:none;padding:22px 10px;">CLAIM&nbsp;THE&nbsp;OFFER</a></td></tr>
<tr><td align="center" style="padding:14px 24px 0 24px;font-size:14px;color:#9A9A9A;">Better Body Bootcamp ${studio} &middot; small group classes &middot; coach-led every set</td></tr>
<tr><td style="padding:38px 32px 34px 32px;font-size:12px;line-height:19px;color:#8A8A8A;">You are receiving this because you trained with us.<br>Don't want these? Just reply "unsubscribe" and we'll take you off the list. &middot; Better Body Bootcamp, NYC</td></tr>
</table></td></tr></table></body></html>`;
}

// ── kill-checks at send time ────────────────────────────────────────────────
async function killCheck(client: ReturnType<typeof sb>, email: string): Promise<string | null> {
  const { data: sales } = await client.from("mariana_tek_sales")
    .select("item_names").eq("customer_email", email).limit(20);
  for (const s of (sales ?? [])) {
    const it = (s.item_names || "").toLowerCase();
    if (/contract|pif|month to month|membership|back to school/.test(it)) return "bought membership";
  }
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data: trials } = await client.from("trial_signups")
    .select("front_desk_stage, payment_date, payment_status, opted_out_at, deleted_at").eq("email", email).limit(10);
  for (const t of (trials ?? [])) {
    if (t.opted_out_at) return "opted out";
    if (t.front_desk_stage === "member" && !t.deleted_at) return "member";
    if (t.payment_status === "completed" && (t.payment_date || "") >= cutoff) return "trial active";
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* dry run */ }

  const paths = (Deno.env.get("BBB_SEND_PATHS_ENABLED") ?? "").split(",").map((s) => s.trim());
  const pathOn = paths.includes("winback_blast");
  const live = body.live === true && body.confirm === "SEND-IT" && pathOn;

  // 2026-08-27: TEST MODE — send ONE email + ONE text of the given offer to a
  // specified address/phone (Justin previewing before a real send). Touches no
  // batch rows, no sent-registry, no gating beyond the admin secret.
  //   { test_to: { email?: "justin@...", phone?: "+1631...", studio: "bayside", offer: "bts299", first?: "Justin" } }
  if (body.test_to && typeof body.test_to === "object") {
    const t = body.test_to as { email?: string; phone?: string; studio?: string; offer?: string; first?: string };
    const slug = t.studio || "bayside";
    const offer = t.offer || "bts299";
    const first = t.first || "Justin";
    const out: Record<string, unknown> = { ok: true, test: true, offer, studio: slug };
    if (t.phone) {
      const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
      const twToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
      const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
        method: "POST",
        headers: { "Authorization": "Basic " + btoa(`${twSid}:${twToken}`), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          From: twFrom, To: t.phone, Body: smsBody(offer, first, slug),
          ...(offer === "free3" ? { MediaUrl: MMS_CARD[PAIR[slug] || "aw"] } : {}),
          ...(offer === "bts299" && BTS_CARD[slug] ? { MediaUrl: BTS_CARD[slug] } : {}),
        }),
      });
      out.sms = resp.ok ? "sent" : `failed ${resp.status}`;
    }
    if (t.email) {
      const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
      const subject = offer === "bts299"
        ? `[TEST] ${first}, 2 months for $299: Back to School at BBB ${STUDIO_TITLE[slug]}`
        : `[TEST] ${first}, 3 free classes at Better Body ${STUDIO_TITLE[slug]}`;
      const html = offer === "bts299" ? bts299Html(slug, first) : free3Html(slug);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>",
          to: [t.email], subject, html,
        }),
      });
      out.email = resp.ok ? "sent" : `failed ${resp.status}`;
    }
    return json(out);
  }
  const limit = typeof body.limit === "number" ? Math.min(body.limit, 100) : 25;
  const offerFilter = typeof body.offer === "string" ? body.offer : null;
  const studioFilter = typeof body.studio === "string" ? body.studio : null;

  const client = sb();
  const dl = await client.storage.from("campaigns").download(BATCH_PATH);
  if (dl.error) return json({ ok: false, error: "batch file: " + dl.error.message }, 500);
  const batch = JSON.parse(await dl.data.text());
  let rows: Array<{ studio: string; name: string; email: string; phone: string; offer: string; channel: string }> = batch.rows || [];
  if (offerFilter) rows = rows.filter((r) => r.offer === offerFilter);
  if (studioFilter) rows = rows.filter((r) => r.studio === studioFilter);

  // Already-sent registry (idempotency)
  const { data: sentSms } = await client.from("sms_messages")
    .select("to_phone").in("send_path", ["winback_free3", "winback_bts299"]);
  const sentPhones = new Set((sentSms ?? []).map((r) => r.to_phone));
  const { data: sentEm } = await client.from("email_log")
    .select("to_addrs").in("send_path", ["winback_free3", "winback_bts299"]);
  const sentEmails = new Set<string>();
  for (const r of (sentEm ?? [])) for (const a of (r.to_addrs || [])) sentEmails.add(String(a).toLowerCase());

  const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const twToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const fromEmail = Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>";

  const report = { ok: true, live, path_enabled: pathOn, total_in_batch: rows.length, sent: 0, skipped_already_sent: 0, skipped_killcheck: [] as string[], would_send: 0, errors: [] as string[] };

  for (const r of rows) {
    if (report.sent >= limit && live) break;
    const sendPath = r.offer === "bts299" ? "winback_bts299" : "winback_free3";
    if (r.channel === "text" && r.phone && sentPhones.has(r.phone)) { report.skipped_already_sent++; continue; }
    if (r.channel === "email" && sentEmails.has(r.email)) { report.skipped_already_sent++; continue; }

    if (!live) { report.would_send++; continue; }

    const kill = await killCheck(client, r.email);
    if (kill) { report.skipped_killcheck.push(`${r.email}: ${kill}`); continue; }

    const first = firstName(r.name);
    try {
      if (r.channel === "text" && r.phone) {
        const bodyTxt = smsBody(r.offer, first, r.studio);
        const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
          method: "POST",
          headers: { "Authorization": "Basic " + btoa(`${twSid}:${twToken}`), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            From: twFrom, To: r.phone, Body: bodyTxt,
            // free3 goes out as MMS with the full offer design; bts299 stays SMS.
            ...(r.offer === "free3" ? { MediaUrl: MMS_CARD[PAIR[r.studio] || "aw"] } : {}),
            ...(r.offer === "bts299" && BTS_CARD[r.studio] ? { MediaUrl: BTS_CARD[r.studio] } : {}),
          }),
        });
        const j = await resp.json().catch(() => ({} as Record<string, unknown>));
        await client.from("sms_messages").insert({
          studio_slug: r.studio, direction: "outbound", from_phone: twFrom, to_phone: r.phone,
          body: bodyTxt, twilio_sid: (j as { sid?: string }).sid ?? null,
          status: resp.ok ? ((j as { status?: string }).status ?? "queued") : "failed",
          error_code: resp.ok ? null : String((j as { code?: unknown }).code ?? resp.status),
          error_message: resp.ok ? null : String((j as { message?: unknown }).message ?? "twilio error").slice(0, 200),
          sent_by: "winback-blast", sent_at: new Date().toISOString(), send_path: sendPath,
        });
        if (resp.ok) { report.sent++; sentPhones.add(r.phone); } else report.errors.push(`sms ${r.phone}: ${resp.status}`);
      } else {
        const subject = r.offer === "bts299"
          ? `${first}, 2 months for $299: Back to School at BBB ${STUDIO_TITLE[r.studio]}`
          : `${first}, 3 free classes at Better Body ${STUDIO_TITLE[r.studio]} — come see for yourself`;
        const html = r.offer === "bts299" ? bts299Html(r.studio, first) : free3Html(r.studio);
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: fromEmail, to: [r.email], subject, html }),
        });
        const j = await resp.json().catch(() => ({} as Record<string, unknown>));
        await client.from("email_log").insert({
          resend_id: (j as { id?: string }).id ?? null, event_type: resp.ok ? "email.sent" : "email.failed",
          from_addr: fromEmail, to_addrs: [r.email], subject, send_path: sendPath,
          raw: { offer: r.offer, studio: r.studio, status: resp.status },
        });
        if (resp.ok) { report.sent++; sentEmails.add(r.email); } else report.errors.push(`email ${r.email}: ${resp.status}`);
      }
      await new Promise((res) => setTimeout(res, 350));
    } catch (e) {
      report.errors.push(`${r.email}: ${(e as Error).message}`);
    }
  }

  if (!live) {
    (report as Record<string, unknown>).note = pathOn
      ? "DRY RUN - pass {live:true, confirm:'SEND-IT'} to send."
      : "DRY RUN - path 'winback_blast' is NOT in BBB_SEND_PATHS_ENABLED; nothing can send until it is added AND {live:true, confirm:'SEND-IT'} is passed.";
  }
  return json(report);
});
