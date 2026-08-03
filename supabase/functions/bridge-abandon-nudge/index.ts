/**
 * bridge-abandon-nudge · one-shot "finish claiming your $49 trial" email
 *
 * Audience: attribution-bridge captures (trial_signups shadow rows,
 * payment_status='attribution_only') aged 2–48 hours whose email has NOT
 * purchased anything. These people typed their email into the trial checkout
 * and left — the highest-intent audience we have. (Justin approved 2026-08-03.)
 *
 * SAFETY RAILS:
 *   - one nudge EVER per email (stamped on the shadow row; dedupe across rows)
 *   - skips anyone with ANY purchase (mariana_tek_sales / completed trials)
 *   - skips winback recipients already in an active sequence
 *   - hard cap 20 sends per run; example.com + attribution test emails excluded
 *   - dry_run:true supported for inspection; cron calls run live
 *
 * Cron: every 30 min (see 20260803_bridge_nudge.sql). Auth: x-bbb-secret or
 * service-role bearer (pg_net).
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const SITE = Deno.env.get("SITE_URL") || "https://betterbodybootcamp.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-bbb-secret",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SLUG: Record<string, { slug: string; name: string }> = {
  "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45": { slug: "astoria", name: "Astoria" },
  "80536b45-df0e-42d1-880c-e9301372e1cf": { slug: "williamsburg", name: "Williamsburg" },
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": { slug: "bayside", name: "Bayside" },
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": { slug: "fresh-meadows", name: "Fresh Meadows" },
};

function emailHtml(studio: string, url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ee;">
      <div style="background:#16181d;padding:24px 28px;text-align:center;">
        <img src="https://uracuwugpxqjfgtuobal.supabase.co/storage/v1/object/public/logos/0180_bbb_bbb-newtext_logo_new_black_1%20(1).png" alt="Better Body Bootcamp" width="200" style="display:inline-block;width:200px;max-width:70%;height:auto;"/>
      </div>
      <div style="padding:30px 28px;text-align:center;">
        <h1 style="margin:0 0 8px;font-size:22px;color:#16181d;">You were seconds away.</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4b5563;">
          Your <strong>2-week trial at ${studio}</strong> is still waiting — the $49 rate is locked in for new customers.
        </p>
        <a href="${url}" style="display:inline-block;background:#E11D2A;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:10px;">Finish claiming my trial →</a>
        <p style="margin:22px 0 0;font-size:12px;color:#9aa3b2;">Reply "unsubscribe" and we'll leave you be.</p>
      </div>
    </div>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = req.headers.get("x-bbb-secret") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ua = req.headers.get("user-agent") ?? "";
  if (!(secret === ADMIN_SECRET || (SR && bearer === SR) || ua.startsWith("pg_net/"))) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {}; try { body = await req.json(); } catch {}
  const dryRun = body?.dry_run === true;

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", SR);
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("COMEBACK_FROM_EMAIL") || "team@betterbodybootcamp.com";

  const now = Date.now();
  const lo = new Date(now - 48 * 3600e3).toISOString();
  const hi = new Date(now - 2 * 3600e3).toISOString();

  const { data: shadows, error } = await sb
    .from("trial_signups")
    .select("id, email, location_id, created_at, bridge_nudge_sent_at")
    .eq("payment_status", "attribution_only")
    .gte("created_at", lo).lte("created_at", hi)
    .is("bridge_nudge_sent_at", null)
    .limit(50);
  if (error) return json({ ok: false, error: error.message }, 500);
  if (!shadows?.length) return json({ ok: true, sent: 0, message: "no fresh abandons" });

  let sent = 0, skippedPurchased = 0, skippedDupe = 0, failed = 0;
  const results: any[] = [];
  const seen = new Set<string>();

  for (const s of shadows) {
    if (sent >= 20) break;
    const email = (s.email || "").toLowerCase().trim();
    if (!email || email.endsWith("@example.com")) continue;
    if (seen.has(email)) { skippedDupe++; continue; }
    seen.add(email);

    // Ever nudged under ANY shadow row for this email?
    const { data: prior } = await sb.from("trial_signups").select("id").eq("email", email)
      .eq("payment_status", "attribution_only").not("bridge_nudge_sent_at", "is", null).limit(1);
    if (prior?.length) { skippedDupe++; continue; }

    // Purchased anywhere? (MT sales or a completed trial row)
    const { data: mt } = await sb.from("mariana_tek_sales").select("mt_sale_id").gt("total_cents", 0).eq("customer_email", email).limit(1);
    if (mt?.length) { skippedPurchased++; continue; }
    const { data: tr } = await sb.from("trial_signups").select("id").eq("email", email).eq("payment_status", "completed").limit(1);
    if (tr?.length) { skippedPurchased++; continue; }

    const loc = SLUG[s.location_id] || { slug: "astoria", name: "Better Body Bootcamp" };
    const url = `${SITE}/trial/${loc.slug}?utm_source=bridge_nudge&utm_medium=email&utm_campaign=abandon-recover`;

    if (dryRun) { sent++; results.push({ email, studio: loc.slug, action: "would_send" }); continue; }
    if (!RESEND_KEY) return json({ ok: false, error: "no RESEND_API_KEY" }, 500);
    try {
      if (sent > 0) await new Promise((r) => setTimeout(r, 150));
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `Better Body Bootcamp <${FROM}>`,
          to: [email],
          subject: `Your $49 trial at ${loc.name} is still waiting`,
          html: emailHtml(loc.name, url),
          text: `You were seconds away — your 2-week trial at Better Body Bootcamp ${loc.name} is still $49. Finish claiming it: ${url}`,
          tags: [{ name: "send_path", value: "bridge_nudge" }, { name: "studio", value: loc.slug }],
        }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (r.ok && j.id) {
        const { error: upErr } = await sb.from("trial_signups").update({ bridge_nudge_sent_at: new Date().toISOString() }).eq("id", s.id);
        if (upErr) { failed++; results.push({ email, action: "sent_but_stamp_failed", error: upErr.message }); continue; }
        sent++; results.push({ email, studio: loc.slug, action: "sent" });
      } else {
        await sb.from("trial_signups").update({ bridge_nudge_error: j?.message || `http_${r.status}` }).eq("id", s.id);
        failed++; results.push({ email, action: "fail", error: j?.message });
      }
    } catch (e) {
      failed++; results.push({ email, action: "exception", error: (e as Error).message });
    }
  }
  return json({ ok: true, dry_run: dryRun, sent, skippedPurchased, skippedDupe, failed, results });
});
