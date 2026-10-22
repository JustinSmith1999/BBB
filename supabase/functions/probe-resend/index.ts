/**
 * probe-resend — minimal verification endpoint.
 *
 * Confirms two things in one round-trip:
 *   1. RESEND_API_KEY is set on this function's env (proves Supabase secret
 *      propagated to edge functions).
 *   2. The key is valid by pinging Resend's /domains endpoint (a read-only
 *      call that never sends mail).
 *
 * Optional: pass {"send_test": true, "to": "justin@..."} to fire ONE actual
 * email to confirm end-to-end. Off by default to avoid accidental sends.
 *
 * Deploy: supabase functions deploy probe-resend --no-verify-jwt
 *
 * Use:
 *   curl -s https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/probe-resend | jq
 *   curl -s -X POST https://uracuwugpxqjfgtuobal.supabase.co/functions/v1/probe-resend \
 *        -H 'content-type: application/json' \
 *        -d '{"send_test": true, "to": "justin@j20solutions.com"}' | jq
 *
 * Disposable. After verification you can remove this function entirely:
 *   supabase functions delete probe-resend --project-ref uracuwugpxqjfgtuobal
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const key = Deno.env.get("RESEND_API_KEY");
  const out: Record<string, unknown> = {
    resend_api_key_present: !!key,
    key_prefix: key ? key.slice(0, 7) : null,
    key_length: key ? key.length : 0,
    function_name: "probe-resend",
    as_of: new Date().toISOString(),
  };

  if (!key) {
    return new Response(JSON.stringify({ ...out, ok: false, error: "RESEND_API_KEY not set on this function" }, null, 2),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // 1. Validate the key against Resend /domains (cheap, read-only)
  try {
    const r = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    out.resend_domains_status = r.status;
    if (r.ok) {
      const body = await r.json() as { data?: { name?: string; status?: string }[] };
      out.resend_domains = (body?.data || []).map((d) => ({ name: d.name, status: d.status }));
    } else {
      out.resend_domains_body = (await r.text()).slice(0, 400);
    }
  } catch (e) {
    out.resend_domains_error = (e as Error).message;
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  // 1b. Optionally return the FULL DNS records for one domain (exact values —
  // used to re-add DKIM/SPF/MX in the registrar when a domain shows "failed").
  // {"records": true, "domain_id": "<uuid>"}  (domain_id defaults to the BBB domain)
  if (body?.records === true) {
    const domainId = String(body?.domain_id || "5b65595f-75fe-4224-b5ea-4307677f1a47");
    try {
      const r = await fetch(`https://api.resend.com/domains/${domainId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const d = await r.json();
      out.domain_records = {
        status: d?.status,
        name: d?.name,
        records: (d?.records || []).map((rec: any) => ({
          record: rec.record, type: rec.type, name: rec.name,
          value: rec.value, ttl: rec.ttl, priority: rec.priority, status: rec.status,
        })),
      };
    } catch (e) {
      out.domain_records_error = (e as Error).message;
    }
  }

  // 1c. OPEN + CLICK TRACKING — read, and optionally turn on.
  // ───────────────────────────────────────────────────────────────────────────
  // 2026-10-21 (Justin: "I need literally every interaction tracked").
  // tracking-audit showed 0 opens and 0 clicks across all 3,767 email_log rows:
  // delivered events arrive, engagement events never do. The cause is that
  // open/click tracking is a per-DOMAIN setting in Resend and it is off. No
  // amount of sender-side code produces an `email.opened` webhook while it is.
  //
  // Resend exposes it on the domain object, so this does not need the dashboard:
  //   GET   /domains/<id>  → { open_tracking, click_tracking }
  //   PATCH /domains/<id>  → set them
  //
  // Read is the default. Flipping it needs an explicit enable:true, because it
  // changes how every future email is rendered — click tracking rewrites every
  // link in the body to route through Resend, which is how clicks get counted
  // but also means the raw URL is no longer what the recipient sees.
  //
  //   {"tracking": true}                 → report current state
  //   {"tracking": true, "enable": true} → turn both on, then verify
  if (body?.tracking === true) {
    const domainId = String(body?.domain_id || "5b65595f-75fe-4224-b5ea-4307677f1a47");
    const read = async () => {
      const r = await fetch(`https://api.resend.com/domains/${domainId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const d = await r.json();
      return { status: r.status, name: d?.name, open_tracking: d?.open_tracking, click_tracking: d?.click_tracking };
    };
    try {
      out.tracking_before = await read();
      if (body?.enable === true) {
        const r = await fetch(`https://api.resend.com/domains/${domainId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ open_tracking: true, click_tracking: true }),
        });
        out.tracking_patch_status = r.status;
        out.tracking_patch_body = (await r.text()).slice(0, 300);
        // Never trust the write — read it back, same rule as meta-set-url-tags.
        await new Promise((res) => setTimeout(res, 600));
        out.tracking_after = await read();
      }
    } catch (e) {
      out.tracking_error = (e as Error).message;
    }
  }

  // 2. Optionally fire a real test email
  if (body?.send_test === true) {
    const to = String(body?.to || "").trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      out.send_test = { ok: false, error: "send_test requires 'to' as a valid email" };
    } else {
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "BBB Probe <trials@betterbodybootcamp.com>",
            to: [to],
            subject: "probe-resend — verification",
            text: `If you see this, RESEND_API_KEY is wired up correctly on the BBB Supabase project.\n\nSent at ${new Date().toISOString()} from probe-resend.`,
          }),
        });
        const respBody = r.ok ? await r.json() : { error: await r.text() };
        out.send_test = { ok: r.ok, status: r.status, body: respBody };
      } catch (e) {
        out.send_test = { ok: false, error: (e as Error).message };
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, ...out }, null, 2),
    { headers: { ...cors, "Content-Type": "application/json" } });
});
