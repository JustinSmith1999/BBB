/**
 * stripe-trial-export — READ ONLY. 2026-10-02.
 *
 * Lists every succeeded Stripe charge for Bayside / Fresh Meadows in a date
 * range and returns date, amount, email and name. Nothing is written, nothing
 * is sent, no other function is called. Built because the cached charge file
 * only kept an email on 84 of 154 trial payments, which made it impossible to
 * tell whether those people later became members.
 *
 * Pages through the full range (the hourly audit only ever reads the latest
 * 100 PaymentIntents, which is why this exists separately).
 *
 * POST  { "from": "2025-10-01", "to": "2026-06-26" }
 * AUTH  x-bbb-secret
 * Deploy: bbb deploy-fn stripe-trial-export
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.4.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const STUDIOS: Record<string, string> = {
  "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7": "Bayside",
  "6bbbe077-bcc6-4d9d-a10b-7605c1484752": "Fresh Meadows",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({} as Record<string, string>));
  const from = Math.floor(new Date(String(body.from ?? "2025-10-01")).getTime() / 1000);
  const to = Math.floor(new Date(String(body.to ?? "2026-06-26")).getTime() / 1000);

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const { data: locs } = await sb.from("locations").select("id, stripe_secret_key");

  const out: Array<Record<string, unknown>> = [];
  const counts: Record<string, number> = {};
  for (const l of locs ?? []) {
    const studio = STUDIOS[(l as { id: string }).id];
    const key = (l as { stripe_secret_key?: string }).stripe_secret_key;
    if (!studio || !key) continue;
    const stripe = new Stripe(key, { apiVersion: "2024-12-18.acacia" });

    let starting_after: string | undefined;
    let n = 0;
    while (true) {
      const page = await stripe.charges.list({
        limit: 100,
        created: { gte: from, lt: to },
        ...(starting_after ? { starting_after } : {}),
      });
      for (const c of page.data) {
        if (c.status !== "succeeded") continue;
        out.push({
          studio,
          date: new Date((c.created || 0) * 1000).toISOString().slice(0, 10),
          amount: (c.amount ?? 0) / 100,
          refunded: (c.amount_refunded ?? 0) / 100,
          email: (c.billing_details?.email || c.receipt_email || "").toLowerCase() || null,
          name: c.billing_details?.name || null,
        });
        n++;
      }
      if (!page.has_more) break;
      starting_after = page.data[page.data.length - 1]?.id;
      if (!starting_after) break;
    }
    counts[studio] = n;
  }
  const withEmail = out.filter((r) => r.email).length;
  return json({ ok: true, read_only: true, counts, total: out.length, with_email: withEmail, charges: out });
});
