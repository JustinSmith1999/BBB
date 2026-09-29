// quo-outreach-load — push expired Bayside / Fresh Meadows members into Quo as
// NAMED CONTACTS (no tasks). Dead-simple workflow for staff:
//   Contacts → filter Company = "Expired Member — Bayside" (or Fresh Meadows)
//   → open a person → one tap to CALL or TEXT → jot a note → done.
//
// Each contact carries the history where staff can see it (Role field):
//   "Last visit: Mar 3, 2026 · Last paid: Feb 1, 2026"
// Loaded most-recently-active first (warmest win-backs first). Calls/texts to
// them auto-log on the contact — that's the tracking.
//
// ── Why batches ──
// Blasting a huge cold list from a fresh number risks spam flags, so this loads
// a LIMITED batch (default 50). Work it, then load the next.
//
// ── Invoke (header: x-bbb-secret) ──
//   { "dry_run": true }                              -> counts + sample, no writes
//   { "dry_run": false, "limit": 50 }                -> load next 50 (by recency)
//   { "dry_run": false, "limit": 50, "studio": "bayside" }
//
// Idempotent via public.quo_outreach_loaded.  Needs secret QUO_API_KEY.
// Deploy: bbb deploy-fn quo-outreach-load

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIO_LABEL: Record<string, string> = { "bayside": "Bayside", "fresh-meadows": "Fresh Meadows" };

function digits(p: string): string { return (p || "").replace(/\D/g, ""); }
function toE164(p: string): string | null {
  const d = digits(p);
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }); }
  catch { return null; }
}
async function quoCreateContact(body: unknown, key: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await fetch("https://api.quo.com/v1/contacts", {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: (j as any)?.data?.id };
  return { ok: false, error: (j as any)?.message || `HTTP ${r.status}` };
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty = dry run */ }
  const dryRun = body.dry_run !== false;
  const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 200);
  // Phase 1 (default): only proven former members (visit/payment on file).
  // Phase 2: include_no_history=true also loads the older no-history roster.
  const includeNoHistory = body.include_no_history === true;
  const studios = body.studio ? [String(body.studio)] : ["bayside", "fresh-meadows"];
  const key = Deno.env.get("QUO_API_KEY");
  if (!dryRun && !key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // Target = everyone at these studios who is NOT currently Active AND has a
  // real history with us (attended at least once OR paid at least once). That
  // captures former members even when MindBody relabeled them "Non-Member",
  // while skipping cold, never-engaged leads.

  // 1) Full non-Active roster — paginated past PostgREST's 1000-row cap.
  const clients: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("mindbody_clients")
      .select("mindbody_id, first_name, last_name, email, phone, studio_slug, status")
      .in("studio_slug", studios).neq("status", "Active").range(from, from + 999);
    if (error) return json({ ok: false, error: error.message }, 500);
    clients.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const allIds = Array.from(new Set(clients.map((m) => m.mindbody_id).filter(Boolean)));

  // 2) Last-visit (lifecycle view) + last-payment (sales) per member.
  const lastVisitById: Record<string, string> = {};
  const lastPaidById: Record<string, string> = {};
  for (let i = 0; i < allIds.length; i += 1000) {
    const slice = allIds.slice(i, i + 1000);
    const { data: lc } = await sb.from("v_member_lifecycle").select("mindbody_id, last_attended_at").in("mindbody_id", slice);
    for (const r of (lc ?? [])) if ((r as any).last_attended_at) lastVisitById[(r as any).mindbody_id] = (r as any).last_attended_at;
    const { data: sales } = await sb.from("mindbody_sales").select("customer_mindbody_id, sale_date_time, total_cents").in("customer_mindbody_id", slice).gt("total_cents", 0);
    for (const s of (sales ?? [])) {
      const id = (s as any).customer_mindbody_id, d = (s as any).sale_date_time;
      if (!id || !d) continue;
      if (!lastPaidById[id] || d > lastPaidById[id]) lastPaidById[id] = d;
    }
  }

  // 3) Gate (valid phone, real history, not already loaded), de-dupe by phone,
  //    then sort MOST-RECENTLY-ACTIVE FIRST (recent visit, else recent payment).
  const { data: done } = await sb.from("quo_outreach_loaded").select("phone_digits");
  const already = new Set((done ?? []).map((r: any) => r.phone_digits));
  const seen = new Set<string>();
  const candidates: any[] = [];
  for (const m of clients) {
    const raw = m.phone;
    const e164 = raw ? toE164(raw) : null;
    const dk = raw ? digits(raw) : "";
    if (!e164 || already.has(dk) || seen.has(dk)) continue;
    const lv = lastVisitById[m.mindbody_id] ?? null;
    const lp = lastPaidById[m.mindbody_id] ?? null;
    if (!includeNoHistory && !lv && !lp) continue;   // phase 1: proven history only
    seen.add(dk);
    candidates.push({ ...m, e164, dk, last_attended_at: lv });
  }
  // Strict sort by LAST VISIT (most recent first); never-visited sink to the
  // bottom, ordered among themselves by most recent payment.
  candidates.sort((a, b) => {
    const av = a.last_attended_at ?? "", bv = b.last_attended_at ?? "";
    if (av !== bv) return bv.localeCompare(av);
    return (lastPaidById[b.mindbody_id] ?? "").localeCompare(lastPaidById[a.mindbody_id] ?? "");
  });
  const batch = candidates.slice(0, limit);

  // Role line = the history, shown right on the contact card.
  const roleFor = (c: any) => {
    const lv = fmtDate(c.last_attended_at);
    const lp = fmtDate(lastPaidById[c.mindbody_id] ?? null);
    return `Last visit: ${lv ?? "never"} · Last paid: ${lp ?? "unknown"}`;
  };

  if (dryRun) {
    // Universe breakdown — from the paginated non-Active pull (uncapped).
    const { count: totalAll } = await sb.from("mindbody_clients")
      .select("*", { count: "exact", head: true }).in("studio_slug", studios);
    const byStatus: Record<string, number> = {};
    let withPhone = 0, withHistory = 0;
    for (const m of clients) {
      const st = m.status ?? "(null)";
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      if (toE164(m.phone ?? "")) withPhone++;
      if (lastVisitById[m.mindbody_id] || lastPaidById[m.mindbody_id]) withHistory++;
    }
    return json({
      ok: true, dry_run: true,
      _universe: {
        total_clients_all_statuses: totalAll,
        non_active_clients: clients.length,
        non_active_by_status: byStatus,
        non_active_with_valid_phone: withPhone,
        non_active_with_visit_or_payment: withHistory,
        qualifying_after_gate_and_dedupe: candidates.length,
      },
      remaining_total: candidates.length,
      remaining_by_studio: {
        bayside: candidates.filter((c) => c.studio_slug === "bayside").length,
        "fresh-meadows": candidates.filter((c) => c.studio_slug === "fresh-meadows").length,
      },
      would_load_now: batch.length,
      sample: batch.slice(0, 5).map((c) => ({
        name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
        phone: c.e164, company: `Expired Member — ${STUDIO_LABEL[c.studio_slug]}`, role: roleFor(c),
      })),
    });
  }

  const results: any[] = [];
  for (const c of batch) {
    const first = c.first_name || "Former";
    const last = c.last_name || "Member";
    const fullName = `${first} ${last}`.trim();

    const contact = await quoCreateContact({
      defaultFields: {
        firstName: first, lastName: last,                            // clean name
        company: `Expired Member — ${STUDIO_LABEL[c.studio_slug]}`,   // gym tag + filter/group
        role: roleFor(c),                                            // history under the name
        phoneNumbers: [{ name: "mobile", value: c.e164 }],
        ...(c.email ? { emails: [{ name: "email", value: c.email }] } : {}),
      },
      source: "expired-member",
    }, key!);
    await sleep(120);

    if (contact.ok) {
      await sb.from("quo_outreach_loaded").upsert({
        phone_digits: c.dk, studio_slug: c.studio_slug, full_name: fullName, quo_contact_id: contact.id ?? null,
      }, { onConflict: "phone_digits" });
    }
    results.push({ name: fullName, phone: c.e164, studio: c.studio_slug, ok: contact.ok, error: contact.error });
  }

  const loaded = results.filter((r) => r.ok).length;
  return json({ ok: true, dry_run: false, loaded, attempted: batch.length, remaining_after: candidates.length - loaded, results });
});
