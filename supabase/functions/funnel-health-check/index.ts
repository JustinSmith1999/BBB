/**
 * funnel-health-check — full Stripe → trial_signups → Mindbody funnel
 * diagnostic across all 4 studios. Returns where each paying customer
 * is stuck.
 *
 * Auth: x-bbb-secret header (deploy with --no-verify-jwt).
 *
 * For each studio it answers:
 *   - How many people actually paid in Stripe ($49 succeeded) since the
 *     anchor date
 *   - How many trial_signups rows exist for that window
 *   - Of those, how many are marked completed vs pending vs other
 *   - How many appear in mindbody_clients (by email)
 *   - List of "orphaned paid" customers: Stripe says paid, DB says not
 *     completed (the webhook outage casualties)
 *   - List of "completed but ghost" customers: DB says completed but
 *     they never made it into Mindbody (handle-paid-trial failed)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bbb-Secret, X-Client-Info, Apikey",
};

const ADMIN_SECRET = "bbb-test-2026-05-27";
const LAUNCH_FLOOR_ISO = "2026-05-15T00:00:00Z";
const LAUNCH_FLOOR_UNIX = Math.floor(new Date(LAUNCH_FLOOR_ISO).getTime() / 1000);
const AMOUNT_FILTER = 4900; // $49 trial

const LOCATIONS = [
  { id: "80536b45-df0e-42d1-880c-e9301372e1cf", slug: "williamsburg",  name: "Williamsburg" },
  { id: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45", slug: "astoria",       name: "Astoria" },
  { id: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7", slug: "bayside",       name: "Bayside" },
  { id: "6bbbe077-bcc6-4d9d-a10b-7605c1484752", slug: "fresh-meadows", name: "Fresh Meadows" },
];

async function listAllSucceededPIs(stripe: Stripe, sinceUnix: number) {
  const out: Stripe.PaymentIntent[] = [];
  let startAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const args: any = { limit: 100, created: { gte: sinceUnix } };
    if (startAfter) args.starting_after = startAfter;
    const pis = await stripe.paymentIntents.list(args);
    for (const p of pis.data) {
      if (p.status === "succeeded" && p.amount === AMOUNT_FILTER) out.push(p);
    }
    if (!pis.has_more || pis.data.length === 0) break;
    startAfter = pis.data[pis.data.length - 1].id;
  }
  return out;
}

async function getEmailForPI(stripe: Stripe, pi: Stripe.PaymentIntent): Promise<string | null> {
  let email = pi.receipt_email || null;
  if (!email && pi.latest_charge) {
    try {
      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
      const charge = await stripe.charges.retrieve(chargeId);
      email = charge.billing_details?.email || null;
    } catch { /* ignore */ }
  }
  return email ? email.toLowerCase() : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "bad secret" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Locations with their Stripe secret keys
    const { data: locs, error: locErr } = await supabase
      .from("locations")
      .select("id,name,stripe_secret_key");
    if (locErr) throw new Error(`locations query: ${locErr.message}`);

    const perStudio: Record<string, any> = {};

    for (const L of LOCATIONS) {
      const locRow = (locs || []).find((r: any) => r.id === L.id);
      const stripeKey = locRow?.stripe_secret_key;
      if (!stripeKey) {
        perStudio[L.slug] = { error: "no Stripe key on locations row" };
        continue;
      }
      const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });

      // 1) Pull all $49 succeeded PaymentIntents since launch
      const pis = await listAllSucceededPIs(stripe, LAUNCH_FLOOR_UNIX);
      const stripePaidCount = pis.length;

      // Collect email + PI id for each succeeded payment
      const stripePaymentsByEmail: Record<string, { pi: string; created: string }> = {};
      const stripePaymentsByPI: Record<string, { email: string | null; created: string }> = {};
      for (const p of pis) {
        const email = await getEmailForPI(stripe, p);
        const createdIso = new Date((p.created || 0) * 1000).toISOString();
        stripePaymentsByPI[p.id] = { email, created: createdIso };
        if (email) stripePaymentsByEmail[email] = { pi: p.id, created: createdIso };
      }

      // 2) Pull all trial_signups rows for this studio since launch
      const { data: signups, error: sErr } = await supabase
        .from("trial_signups")
        .select("id,name,email,phone,payment_status,payment_date,created_at,stripe_session_id")
        .eq("location_id", L.id)
        .gte("created_at", LAUNCH_FLOOR_ISO)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (sErr) throw new Error(`trial_signups query: ${sErr.message}`);

      const allRows = signups || [];
      const statusBreakdown: Record<string, number> = {};
      for (const r of allRows) {
        const s = r.payment_status || "(null)";
        statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
      }

      // 3) Cross-ref with mindbody_clients by email
      const emails = allRows.map((r: any) => (r.email || "").toLowerCase()).filter(Boolean);
      const { data: mbClients } = await supabase
        .from("mindbody_clients")
        .select("email,mindbody_id")
        .in("email", emails.length > 0 ? emails : ["__none__"]);
      const mbEmails = new Set((mbClients || []).map((c: any) => (c.email || "").toLowerCase()));

      // 4) Identify orphaned paid: Stripe says paid, DB row not completed
      // Match by stripe_session_id (PI) OR by email
      const dbByPI: Record<string, any> = {};
      const dbByEmail: Record<string, any> = {};
      for (const r of allRows) {
        if (r.stripe_session_id) dbByPI[r.stripe_session_id.toLowerCase()] = r;
        if (r.email) dbByEmail[r.email.toLowerCase()] = r;
      }

      const orphanedPaid: any[] = [];
      const stripeMatchedComplete: any[] = [];
      for (const [piId, info] of Object.entries(stripePaymentsByPI)) {
        const dbRow = dbByPI[piId.toLowerCase()]
          || (info.email ? dbByEmail[info.email] : null);
        if (!dbRow) {
          orphanedPaid.push({
            level: "no_row_at_all",
            stripe_pi: piId,
            email: info.email,
            paid_at: info.created,
          });
        } else if (dbRow.payment_status !== "completed") {
          orphanedPaid.push({
            level: "row_exists_not_completed",
            stripe_pi: piId,
            email: info.email,
            paid_at: info.created,
            db_row_id: dbRow.id,
            db_status: dbRow.payment_status,
            db_created_at: dbRow.created_at,
          });
        } else {
          stripeMatchedComplete.push({
            email: info.email,
            paid_at: info.created,
            in_mindbody: mbEmails.has((info.email || "").toLowerCase()),
          });
        }
      }

      // 5) Completed-but-ghost: DB completed, but never landed in Mindbody
      const completedNotInMB = allRows
        .filter((r: any) => r.payment_status === "completed")
        .filter((r: any) => !mbEmails.has((r.email || "").toLowerCase()))
        .map((r: any) => ({
          email: r.email,
          name: r.name,
          paid_at: r.payment_date,
          db_row_id: r.id,
        }));

      perStudio[L.slug] = {
        name: L.name,
        stripe_paid_49_since_may15: stripePaidCount,
        trial_signups_total_since_may15: allRows.length,
        status_breakdown: statusBreakdown,
        in_mindbody_count: allRows.filter((r: any) => mbEmails.has((r.email || "").toLowerCase())).length,
        orphaned_paid_count: orphanedPaid.length,
        completed_but_not_in_mindbody_count: completedNotInMB.length,
        orphaned_paid: orphanedPaid,
        completed_but_not_in_mindbody: completedNotInMB,
      };
    }

    // Roll-up totals
    const totals = {
      stripe_paid: 0,
      db_completed: 0,
      in_mindbody: 0,
      orphaned_paid: 0,
      completed_not_in_mindbody: 0,
    };
    for (const s of Object.values(perStudio) as any[]) {
      if (s.error) continue;
      totals.stripe_paid += s.stripe_paid_49_since_may15 || 0;
      totals.db_completed += (s.status_breakdown?.completed || 0);
      totals.in_mindbody += s.in_mindbody_count || 0;
      totals.orphaned_paid += s.orphaned_paid_count || 0;
      totals.completed_not_in_mindbody += s.completed_but_not_in_mindbody_count || 0;
    }

    return new Response(JSON.stringify({
      ok: true,
      anchor_date: LAUNCH_FLOOR_ISO,
      amount_filter_cents: AMOUNT_FILTER,
      totals,
      per_studio: perStudio,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
