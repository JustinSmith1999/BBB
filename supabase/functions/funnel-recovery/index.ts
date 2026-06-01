/**
 * funnel-recovery — fix the customers stuck after webhook outage.
 *
 * Action plan in this function (gated by query params):
 *
 *   ?action=promote_orphans   — for every paid Stripe PI since 2026-05-15
 *                                that has no completed trial_signups row,
 *                                call handle-paid-trial. That:
 *                                  - updates row to payment_status=completed
 *                                  - sends customer the Day 1 welcome email
 *                                  - sends the studio team the new-trial email
 *                                  - fires CAPI Purchase (if within 7d)
 *
 *   ?action=studio_digest      — for every "completed but not in Mindbody"
 *                                customer, group by studio and email the
 *                                studio team a clean list so the front desk
 *                                can add the missing clients manually.
 *
 *   ?action=all                — both
 *
 *   &dry_run=true              — show what would happen, don't actually do
 *
 * Auth: x-bbb-secret header (deploy --no-verify-jwt).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@^17.4.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bbb-Secret, X-Client-Info, Apikey",
};

const ADMIN_SECRET = "bbb-test-2026-05-27";
const LAUNCH_FLOOR_UNIX = Math.floor(new Date("2026-05-15T00:00:00Z").getTime() / 1000);
const AMOUNT_FILTER = 4900;

const STUDIOS = [
  { id: "80536b45-df0e-42d1-880c-e9301372e1cf", slug: "williamsburg",  name: "Williamsburg",
    teamRecipients: ["steve@betterbodybootcamp.com","chris@betterbodybootcamp.com","williamsburg@betterbodybootcamp.com"] },
  { id: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45", slug: "astoria",       name: "Astoria",
    teamRecipients: ["steve@betterbodybootcamp.com","chris@betterbodybootcamp.com","astoria@betterbodybootcamp.com"] },
  { id: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7", slug: "bayside",       name: "Bayside",
    teamRecipients: ["carlos@betterbodybootcamp.com"] },
  { id: "6bbbe077-bcc6-4d9d-a10b-7605c1484752", slug: "fresh-meadows", name: "Fresh Meadows",
    teamRecipients: ["carlos@betterbodybootcamp.com","freshmeadows@betterbodybootcamp.com"] },
];

async function callHandlePaidTrial(stripeId: string, slug: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/handle-paid-trial`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
    },
    body: JSON.stringify({ stripe_id: stripeId, studio_slug: slug }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function resend(payload: any) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,400)}`);
  return await r.json();
}

function digestEmailHtml(studioName: string, rows: any[]): string {
  const trs = rows.map((r) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${r.name || "(no name)"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee"><a href="mailto:${r.email}" style="color:#0066cc;text-decoration:none">${r.email}</a></td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${r.phone || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;white-space:nowrap">${(r.payment_date || "").slice(0,10)}</td>
    </tr>`).join("");
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px;border:1px solid #eee">
      <div style="font-size:11px;font-weight:700;color:#dc2626;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px">ACTION REQUIRED &middot; ${studioName}</div>
      <h1 style="margin:0 0 8px;font-size:24px">${rows.length} paid trial${rows.length === 1 ? "" : "s"} not in Mindbody</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.55">These customers paid for the $49 trial through the website but were never added to Mindbody. Please create a Mindbody client for each one so they can book and check in.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#fafafa">
          <th style="text-align:left;padding:10px 12px;font-weight:600;color:#666;border-bottom:1px solid #ddd">Name</th>
          <th style="text-align:left;padding:10px 12px;font-weight:600;color:#666;border-bottom:1px solid #ddd">Email</th>
          <th style="text-align:left;padding:10px 12px;font-weight:600;color:#666;border-bottom:1px solid #ddd">Phone</th>
          <th style="text-align:left;padding:10px 12px;font-weight:600;color:#666;border-bottom:1px solid #ddd">Paid</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
      <p style="margin:24px 0 0;font-size:13px;color:#999;line-height:1.5">Generated by funnel-recovery. Going forward, this will be sent daily until the auto-Mindbody-creation feature is live.</p>
    </div>
  </body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // 2026-06-01: HARD KILL after the 2026-05-31 owner-spam incident. This
  // function fires owner emails on every call (promote_orphans triggers the
  // welcome-email path per recovered orphan; studio_digest emails owners a
  // digest per studio). Requires an explicit env override to even run.
  // Set BBB_RECOVERY_ENABLED=true in Supabase function settings to allow.
  if ((Deno.env.get("BBB_RECOVERY_ENABLED") ?? "false") !== "true") {
    return new Response(JSON.stringify({
      ok: false,
      error: "funnel-recovery is disabled. Set BBB_RECOVERY_ENABLED=true to enable. See OPS_LEDGER.md.",
    }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "bad secret" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "all";
  // 2026-06-01: dry-run is now the default. Explicit `?dry_run=false` required
  // to actually fire emails. Prevents accidental re-spam.
  const dryRun = url.searchParams.get("dry_run") !== "false";
  const doPromote = action === "promote_orphans" || action === "all";
  const doDigest = action === "studio_digest" || action === "all";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const result: any = { ok: true, dry_run: dryRun, action, promote: null, digest: null };

  try {
    if (doPromote) {
      const { data: locs } = await supabase.from("locations").select("id,stripe_secret_key");
      const promoteResults: any[] = [];

      for (const L of STUDIOS) {
        const locRow = (locs || []).find((r: any) => r.id === L.id);
        if (!locRow?.stripe_secret_key) {
          promoteResults.push({ studio: L.slug, error: "no stripe key" });
          continue;
        }
        const stripe = new Stripe(locRow.stripe_secret_key, { apiVersion: "2024-12-18.acacia" });

        // List succeeded $49 PIs since launch
        const pis: Stripe.PaymentIntent[] = [];
        let startAfter: string | undefined;
        for (let page = 0; page < 10; page++) {
          const args: any = { limit: 100, created: { gte: LAUNCH_FLOOR_UNIX } };
          if (startAfter) args.starting_after = startAfter;
          const list = await stripe.paymentIntents.list(args);
          for (const p of list.data) {
            if (p.status === "succeeded" && p.amount === AMOUNT_FILTER) pis.push(p);
          }
          if (!list.has_more || list.data.length === 0) break;
          startAfter = list.data[list.data.length - 1].id;
        }

        // Find which are not completed in trial_signups
        const piIds = pis.map((p) => p.id);
        const { data: existingRows } = await supabase
          .from("trial_signups")
          .select("id,email,stripe_session_id,payment_status")
          .eq("location_id", L.id)
          .gte("created_at", "2026-05-15T00:00:00Z");
        const byPI = new Map<string, any>();
        const byEmail = new Map<string, any>();
        for (const r of (existingRows || [])) {
          if (r.stripe_session_id) byPI.set(r.stripe_session_id.toLowerCase(), r);
          if (r.email) byEmail.set(r.email.toLowerCase(), r);
        }

        const orphans: any[] = [];
        for (const p of pis) {
          const piMatch = byPI.get(p.id.toLowerCase());
          let emailMatch: any = null;
          if (!piMatch && p.latest_charge) {
            try {
              const ch = await stripe.charges.retrieve(typeof p.latest_charge === "string" ? p.latest_charge : p.latest_charge.id);
              const em = (ch.billing_details?.email || p.receipt_email || "").toLowerCase();
              if (em) emailMatch = byEmail.get(em);
            } catch { /* ignore */ }
          }
          const match = piMatch || emailMatch;
          if (!match || match.payment_status !== "completed") {
            orphans.push({ pi: p.id, paid_at_unix: p.created });
          }
        }

        if (dryRun) {
          promoteResults.push({ studio: L.slug, orphans_count: orphans.length, orphans: orphans.slice(0, 50) });
          continue;
        }

        // For each orphan, call handle-paid-trial
        const calls: any[] = [];
        for (const o of orphans) {
          try {
            const r = await callHandlePaidTrial(o.pi, L.slug);
            calls.push({ pi: o.pi, status: r.status, ok: r.body?.ok === true, body: r.body });
          } catch (e) {
            calls.push({ pi: o.pi, error: String(e) });
          }
        }
        promoteResults.push({
          studio: L.slug,
          attempted: orphans.length,
          succeeded: calls.filter((c) => c.ok).length,
          failed: calls.filter((c) => !c.ok).length,
          details: calls,
        });
      }
      result.promote = { per_studio: promoteResults };
    }

    if (doDigest) {
      const digestResults: any[] = [];
      for (const L of STUDIOS) {
        const { data: completed } = await supabase
          .from("trial_signups")
          .select("id,name,email,phone,payment_date")
          .eq("location_id", L.id)
          .eq("payment_status", "completed")
          .gte("payment_date", "2026-05-15T00:00:00Z")
          .order("payment_date", { ascending: false });

        const emails = (completed || []).map((r: any) => (r.email || "").toLowerCase()).filter(Boolean);
        const { data: mbRows } = await supabase
          .from("mindbody_clients")
          .select("email")
          .in("email", emails.length > 0 ? emails : ["__none__"]);
        const mbEmails = new Set((mbRows || []).map((r: any) => (r.email || "").toLowerCase()));

        const missing = (completed || [])
          .filter((r: any) => !mbEmails.has((r.email || "").toLowerCase()))
          .filter((r: any) => !(r.email || "").includes("no-email.bbb.local"));

        if (missing.length === 0) {
          digestResults.push({ studio: L.slug, missing_count: 0, emailed: false });
          continue;
        }

        if (dryRun) {
          digestResults.push({ studio: L.slug, missing_count: missing.length, sample: missing.slice(0, 3), emailed: false });
          continue;
        }

        try {
          const sendRes = await resend({
            from: "BBB Recovery <trials@betterbodybootcamp.com>",
            to: L.teamRecipients,
            subject: `${L.name} — ${missing.length} paid customers need a Mindbody profile`,
            html: digestEmailHtml(L.name, missing),
          });
          digestResults.push({ studio: L.slug, missing_count: missing.length, emailed: true, resend_id: sendRes.id });
        } catch (e) {
          digestResults.push({ studio: L.slug, missing_count: missing.length, emailed: false, error: String(e) });
        }
      }
      result.digest = { per_studio: digestResults };
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
