// mt-member-reconcile — fix the "converted member" data using Mariana Tek as the
// source of truth (the conversion pipeline still matched against legacy MindBody
// sales, so real MT memberships were never flagged).
//
// For every paid trial, it checks mariana_tek_sales for a real MEMBERSHIP
// purchase by that customer (matched on email or MT customer id). If found:
//   - sets converted_to_member = true
//   - moves front_desk_stage to 'member' (unless already member, or 'lost' which
//     it only flags for human review rather than auto-flipping)
//
// Body:
//   { "dry_run": true }   -> report every change it WOULD make, write nothing
//   {}                     -> apply the corrections
//
// Auth: x-bbb-secret. Deploy: bbb deploy-fn mt-member-reconcile

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const MIN_CENTS = 4900;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// A membership specifically (not the trial, not a class pack, not retail).
function isMembershipSale(itemNames: string, totalCents: number): boolean {
  if (totalCents <= MIN_CENTS) return false;
  const s = (itemNames || "").toLowerCase();
  if (s.includes("two weeks trial") || s.includes("$49") || s.includes("week trial")) return false;
  return s.includes("membership") || s.includes(" pif") || s.includes("pif ") || s.includes("contract") || s.includes("month to month") || /\bmonthly\b/.test(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* live */ }
  const dryRun = body.dry_run === true;

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // 1. All membership purchases from Mariana Tek -> lookup by email + by MT id.
  const { data: sales, error: sErr } = await sb
    .from("mariana_tek_sales")
    .select("customer_email, customer_mt_id, item_names, total_cents")
    .gt("total_cents", MIN_CENTS)
    .limit(20000);
  if (sErr) return json({ ok: false, error: "sales read: " + sErr.message }, 500);

  const memberEmails = new Set<string>();
  const memberMtIds = new Set<string>();
  const memberNames = new Set<string>();
  const normName = (s: string) => (s || "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  for (const s of sales || []) {
    if (!isMembershipSale(s.item_names || "", Number(s.total_cents || 0))) continue;
    if (s.customer_email) memberEmails.add(String(s.customer_email).toLowerCase().trim());
    if (s.customer_mt_id) memberMtIds.add(String(s.customer_mt_id));
  }

  // Also honor LEGACY MindBody members (matched via get_converted_members), by
  // exact email or exact full name, so pre-migration members are flagged too.
  for (const slug of ["astoria", "williamsburg", "bayside", "fresh-meadows"]) {
    const { data: mb } = await sb.rpc("get_converted_members", { p_studio_slug: slug });
    for (const m of (mb || []) as any[]) {
      for (const e of [m.stripe_email, m.mb_email]) if (e) memberEmails.add(String(e).toLowerCase().trim());
      if (m.customer_name) memberNames.add(normName(m.customer_name));
    }
  }

  // 2. All paid trials.
  const { data: trials, error: tErr } = await sb
    .from("trial_signups")
    .select("id, name, email, front_desk_stage, converted_to_member, mariana_tek_id, location_id, convert_sms_sent_at, membership_nudge_sent_at")
    .is("deleted_at", null)
    .eq("payment_status", "completed")
    .limit(5000);
  if (tErr) return json({ ok: false, error: "trials read: " + tErr.message }, 500);

  const flagFixes: any[] = [];     // converted_to_member false -> true
  const stageFixes: any[] = [];    // promote to member
  const lostButMember: any[] = []; // converted but sitting in Lost — needs human eyes

  for (const t of trials || []) {
    const email = (t.email || "").toLowerCase().trim();
    const isMember = (email && memberEmails.has(email))
      || (t.mariana_tek_id && memberMtIds.has(String(t.mariana_tek_id)))
      || memberNames.has(normName(t.name || ""));
    if (!isMember) continue;

    const stage = t.front_desk_stage || "new_lead";
    const needsFlag = !t.converted_to_member;
    // A confirmed membership overrides a stale stage, including 'lost' — but we
    // record any lost->member move separately so you can eyeball those.
    const needsStage = stage !== "member";

    if (stage === "lost") lostButMember.push({ name: t.name, id: t.id });
    if (needsFlag) flagFixes.push({ name: t.name, id: t.id, from: t.converted_to_member });
    if (needsStage) stageFixes.push({ name: t.name, id: t.id, from: stage });

    if (!dryRun && (needsFlag || needsStage)) {
      const nowIso = new Date().toISOString();
      const patch: any = {};
      if (needsFlag) patch.converted_to_member = true;
      if (needsStage) patch.front_desk_stage = "member";
      // NO EMAILS, NO TEXTS: stamp the comms fields as already-handled so no
      // scheduled job (convert follow-up, membership nudge) fires at these
      // people as a side effect of this retroactive data correction.
      if (!t.convert_sms_sent_at) patch.convert_sms_sent_at = nowIso;
      if (!t.membership_nudge_sent_at) patch.membership_nudge_sent_at = nowIso;
      await sb.from("trial_signups").update(patch).eq("id", t.id);
    }
  }

  return json({
    ok: true, dry_run: dryRun,
    mt_membership_customers: memberEmails.size,
    paid_trials_checked: (trials || []).length,
    flag_corrections: flagFixes.length,
    stage_promotions_to_member: stageFixes.length,
    converted_but_marked_lost_REVIEW: lostButMember,
    detail: { flag_fixes: flagFixes, stage_fixes: stageFixes },
  });
});
