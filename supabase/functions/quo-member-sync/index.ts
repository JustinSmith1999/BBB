// quo-member-sync — keep BBB members (Mariana Tek) mirrored into Quo as tagged
// contacts, so staff can text any member straight from the shared inbox.
//
// "Member" = a customer with a real membership purchase in mariana_tek_sales
// (same rule as mt-member-reconcile: excludes the $49 trial / class packs /
// retail). Their studio = the studio of their most recent membership sale.
// Scoped to Bayside + Fresh Meadows (the studios that have Quo lines). Phone
// comes from mariana_tek_clients (joined by MT id).
//
// Each contact carries Company = "Member · Bayside" / "Member · Fresh Meadows"
// so staff filter Contacts to a studio and text down the list.
//
// Designed to run every 5 minutes (pg_cron). Idempotent via
// public.quo_member_synced: new members get created, and if a member's phone
// changes in MT the Quo contact is PATCHed. Backfills in batches so a big first
// run never times out; steady-state runs are tiny.
//
// ── Invoke (header: x-bbb-secret) ──
//   {}  or  {"dry_run":true}                 -> counts + sample, no writes
//   {"dry_run":false, "limit":200}           -> create/refresh up to 200
//   {"dry_run":false, "studio":"bayside"}
//
// Needs secret QUO_API_KEY.  Deploy: bbb deploy-fn quo-member-sync

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
const MIN_CENTS = 100;

// Same membership test as mt-member-reconcile — keep them in sync.
function isMembershipSale(itemNames: string, totalCents: number): boolean {
  if (totalCents <= MIN_CENTS) return false;
  const s = (itemNames || "").toLowerCase();
  if (s.includes("two weeks trial") || s.includes("$49") || s.includes("week trial")) return false;
  return s.includes("membership") || s.includes(" pif") || s.includes("pif ") || s.includes("contract") || s.includes("month to month") || /\bmonthly\b/.test(s);
}

function digits(p: string): string { return (p || "").replace(/\D/g, ""); }
function toE164(p: string): string | null {
  const d = digits(p);
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
async function quoContact(method: "POST" | "PATCH", path: string, body: unknown, key: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const r = await fetch(`https://api.quo.com/v1/contacts${path}`, {
    method, headers: { "Authorization": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
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
  const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), 400);
  const studios = body.studio ? [String(body.studio)] : ["bayside", "fresh-meadows"];
  const key = Deno.env.get("QUO_API_KEY");
  if (!dryRun && !key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // 1) Membership sales -> one record per member (most recent sale wins for
  //    name + studio). Paginated past PostgREST's 1000-row cap.
  type Mem = { mt_id: string; studio_slug: string; first: string; last: string; email: string | null; when: string };
  const byMtId = new Map<string, Mem>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("mariana_tek_sales")
      .select("studio_slug, customer_mt_id, customer_first_name, customer_last_name, customer_email, item_names, total_cents, sale_date_time")
      .in("studio_slug", studios).gt("total_cents", MIN_CENTS).range(from, from + 999);
    if (error) return json({ ok: false, error: "sales read: " + error.message }, 500);
    for (const s of (data ?? [])) {
      if (!isMembershipSale((s as any).item_names || "", Number((s as any).total_cents || 0))) continue;
      const id = (s as any).customer_mt_id ? String((s as any).customer_mt_id) : "";
      if (!id) continue;
      const when = String((s as any).sale_date_time ?? "");
      const prev = byMtId.get(id);
      if (!prev || when > prev.when) {
        byMtId.set(id, {
          mt_id: id, studio_slug: (s as any).studio_slug,
          first: (s as any).customer_first_name || "", last: (s as any).customer_last_name || "",
          email: (s as any).customer_email ? String((s as any).customer_email).toLowerCase().trim() : null, when,
        });
      }
    }
    if (!data || data.length < 1000) break;
  }
  const memberIds = Array.from(byMtId.keys());

  // 2) Phone (+ name fallback) from mariana_tek_clients, joined by MT id.
  const clientById: Record<string, { phone: string | null; first: string; last: string; email: string | null }> = {};
  for (let i = 0; i < memberIds.length; i += 1000) {
    const { data: cl } = await sb.from("mariana_tek_clients")
      .select("mt_id, phone, first_name, last_name, email").in("mt_id", memberIds.slice(i, i + 1000));
    for (const c of (cl ?? [])) clientById[String((c as any).mt_id)] = {
      phone: (c as any).phone ?? null, first: (c as any).first_name || "", last: (c as any).last_name || "",
      email: (c as any).email ? String((c as any).email).toLowerCase().trim() : null,
    };
  }

  // 3) What's already synced (ledger), so we only create new + refresh changed.
  const { data: done } = await sb.from("quo_member_synced").select("mt_id, phone_digits, quo_contact_id");
  const ledger = new Map<string, { phone_digits: string; quo_contact_id: string | null }>();
  for (const r of (done ?? [])) ledger.set(String((r as any).mt_id), { phone_digits: (r as any).phone_digits, quo_contact_id: (r as any).quo_contact_id });

  // 4) Resolve each member to a loadable record; split into new vs phone-changed.
  const seenPhone = new Set<string>();
  const toCreate: any[] = [];
  const toUpdate: any[] = [];
  for (const m of byMtId.values()) {
    const cli = clientById[m.mt_id];
    const rawPhone = cli?.phone ?? null;
    const e164 = rawPhone ? toE164(rawPhone) : null;
    if (!e164) continue;                                  // no textable number -> skip
    const dk = digits(rawPhone!);
    const first = m.first || cli?.first || "Member";
    const last = m.last || cli?.last || "";
    const email = m.email || cli?.email || null;
    const rec = { mt_id: m.mt_id, studio_slug: m.studio_slug, e164, dk, first, last, email,
      fullName: `${first} ${last}`.trim() };
    const prev = ledger.get(m.mt_id);
    if (!prev) {
      if (seenPhone.has(dk)) continue;                    // de-dupe brand-new by phone
      seenPhone.add(dk);
      toCreate.push(rec);
    } else if (prev.phone_digits !== dk && prev.quo_contact_id) {
      toUpdate.push({ ...rec, quo_contact_id: prev.quo_contact_id });
    }
  }

  if (dryRun) {
    const withPhone = Array.from(byMtId.values()).filter((m) => toE164(clientById[m.mt_id]?.phone ?? "")).length;
    return json({
      ok: true, dry_run: true,
      _universe: {
        member_records: byMtId.size,
        members_with_textable_phone: withPhone,
        already_in_quo: ledger.size,
        new_to_create: toCreate.length,
        phone_changes_to_refresh: toUpdate.length,
      },
      by_studio: {
        bayside: toCreate.filter((c) => c.studio_slug === "bayside").length,
        "fresh-meadows": toCreate.filter((c) => c.studio_slug === "fresh-meadows").length,
      },
      would_process_now: Math.min(toCreate.length + toUpdate.length, limit),
      sample: toCreate.slice(0, 5).map((c) => ({ name: c.fullName, phone: c.e164, company: `Member · ${STUDIO_LABEL[c.studio_slug]}` })),
    });
  }

  const results = { created: 0, updated: 0, errors: [] as any[] };
  let budget = limit;

  // Refresh changed phones first (cheap, keeps existing contacts correct).
  for (const c of toUpdate) {
    if (budget-- <= 0) break;
    const u = await quoContact("PATCH", `/${c.quo_contact_id}`, {
      defaultFields: { phoneNumbers: [{ name: "mobile", value: c.e164 }], company: `Member · ${STUDIO_LABEL[c.studio_slug]}` },
    }, key!);
    await sleep(120);
    if (u.ok) {
      await sb.from("quo_member_synced").update({ phone_digits: c.dk, full_name: c.fullName, studio_slug: c.studio_slug, updated_at: new Date().toISOString() }).eq("mt_id", c.mt_id);
      results.updated++;
    } else results.errors.push({ mt_id: c.mt_id, op: "update", error: u.error });
  }

  // Create new members.
  for (const c of toCreate) {
    if (budget-- <= 0) break;
    const created = await quoContact("POST", "", {
      defaultFields: {
        firstName: c.first, lastName: c.last || "Member",
        company: `Member · ${STUDIO_LABEL[c.studio_slug]}`,
        phoneNumbers: [{ name: "mobile", value: c.e164 }],
        ...(c.email ? { emails: [{ name: "email", value: c.email }] } : {}),
      },
      source: "mt-member",
    }, key!);
    await sleep(120);
    if (created.ok) {
      await sb.from("quo_member_synced").upsert({
        mt_id: c.mt_id, phone_digits: c.dk, studio_slug: c.studio_slug, full_name: c.fullName,
        quo_contact_id: created.id ?? null, synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: "mt_id" });
      results.created++;
    } else results.errors.push({ mt_id: c.mt_id, op: "create", error: created.error });
  }

  return json({
    ok: true, dry_run: false, created: results.created, updated: results.updated,
    remaining_new: Math.max(0, toCreate.length - results.created),
    error_count: results.errors.length, errors: results.errors.slice(0, 10),
  });
});
