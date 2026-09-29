// quo-task-queue — build a per-gym CALL QUEUE in Quo as Tasks. Three cohorts:
//   • INQUIRY — filled out the website contact form (high intent, any pay status)
//   • TRIAL   — paid the $49 trial, not yet converted to member
//   • EXPIRED — former member who actually paid, now lapsed
//
// Each person becomes ONE Quo Task on their studio's line (so it shows under
// that gym): title = "Name · TRIAL/EXPIRED", description = phone, email, last
// visit, last payment. Staff open the task, see who/why, tap the number to
// call/text (the number resolves to a named contact we also create), then
// check the task off — which is the "we talked to them" tracking.
//
// Sorted NEWEST-FIRST and grouped by type (all trials, then all expired).
// Scoped to Bayside + Fresh Meadows (the only studios on Quo).
//
// ⚠ Quo caps OPEN tasks. This batches (limit) and is idempotent via
// public.quo_task_loaded. If Quo returns 402 (Open Tasks Limit Reached) it
// stops and reports how many landed, so we page as staff clear the queue.
//
// Invoke (header x-bbb-secret):
//   {}                                  -> dry-run: counts + sample, no writes
//   {"dry_run":false,"limit":100}       -> create up to 100 tasks (newest first)
//   {"dry_run":false,"studio":"bayside","type":"expired"}
//
// Needs QUO_API_KEY.  Deploy: bbb deploy-fn quo-task-queue

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIO = {
  "bayside":       { pn: "PN53tm8BYn", label: "Bayside",       uuid: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7" },
  "fresh-meadows": { pn: "PNrbRXue3z", label: "Fresh Meadows", uuid: "6bbbe077-bcc6-4d9d-a10b-7605c1484752" },
} as const;
type Slug = keyof typeof STUDIO;

// Cohort presentation: inquiries are hottest → group first, then paid trials,
// then expired members. TAG shows in the task title; COMPANY on the contact.
const TAG: Record<string, string>     = { inquiry: "INQUIRY", trial: "TRIAL", expired: "EXPIRED" };
const COMPANY: Record<string, string> = { inquiry: "Website Inquiry", trial: "Paid Trial", expired: "Expired Member" };
const RANK: Record<string, number>    = { inquiry: 0, trial: 1, expired: 2 };

function digits(p: string): string { return (p || "").replace(/\D/g, ""); }
function toE164(p: string): string | null {
  const d = digits(p);
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }); } catch { return null; }
}
async function quoPost(path: string, body: unknown, key: string): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
  const r = await fetch(`https://api.quo.com/v1/${path}`, { method: "POST", headers: { "Authorization": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, status: r.status, id: (j as any)?.data?.id || (j as any)?.data?.taskId };
  return { ok: false, status: r.status, error: (j as any)?.message || `HTTP ${r.status}` };
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface Cand { type: "inquiry" | "trial" | "expired"; slug: Slug; first: string; last: string; e164: string; dk: string; email: string | null; sortKey: string; ctx: string[]; }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);
  let body: any = {}; try { body = await req.json(); } catch { /* dry */ }
  const dryRun = body.dry_run !== false;
  const limit = Math.min(Math.max(Number(body.limit ?? 100), 1), 200);
  const slugs = (body.studio ? [String(body.studio)] : ["bayside", "fresh-meadows"]).filter((s) => s in STUDIO) as Slug[];
  const types = body.type ? [String(body.type)] : ["inquiry", "trial", "expired"];
  const key = Deno.env.get("QUO_API_KEY");
  if (!dryRun && !key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const uuidToSlug: Record<string, Slug> = {}; for (const s of slugs) uuidToSlug[STUDIO[s].uuid] = s;

  // Already-loaded ledger (idempotent by phone+type).
  const { data: done } = await sb.from("quo_task_loaded").select("phone_digits, type");
  const loaded = new Set((done ?? []).map((r: any) => `${r.phone_digits}|${r.type}`));

  const cands: Cand[] = [];

  // ── Cohort C: online inquiries (contact form) — high intent, any pay status ─
  if (types.includes("inquiry")) {
    // Website inquiries live in leads (source=contact-form) — the standalone
    // contact_form_submissions table was never created. studio_slug is already
    // the slug; the message is in notes ("Contact form: <msg> · Preferred ...").
    const { data: iq } = await sb.from("leads")
      .select("full_name, email, phone, notes, studio_slug, last_touch_at")
      .eq("source", "contact-form").in("studio_slug", slugs)
      .order("last_touch_at", { ascending: false }).limit(3000);
    for (const q of (iq ?? [])) {
      const e164 = toE164((q as any).phone || ""); if (!e164) continue;
      const slug = (q as any).studio_slug as Slug; if (!(slug in STUDIO)) continue;
      const nm = String((q as any).full_name || "").trim().split(/\s+/);
      const msg = String((q as any).notes || "").replace(/^Contact form:\s*/i, "").replace(/\s*·\s*Preferred location:.*$/i, "").trim().replace(/\s+/g, " ");
      cands.push({ type: "inquiry", slug, first: nm[0] || "Website", last: nm.slice(1).join(" ") || "Lead", e164, dk: digits((q as any).phone),
        email: (q as any).email || null, sortKey: String((q as any).last_touch_at || ""),
        ctx: [`Website inquiry${(q as any).last_touch_at ? ` · ${fmtDate((q as any).last_touch_at)}` : ""}`, msg ? `Asked: "${msg.slice(0, 180)}${msg.length > 180 ? "…" : ""}"` : `(no message left)`] });
    }
  }

  // ── Cohort A: paid, not-yet-converted $49 trials ──────────────────────────
  if (types.includes("trial")) {
    const { data: tr } = await sb.from("trial_signups")
      .select("name, phone, email, payment_date, created_at, location_id")
      .eq("payment_status", "completed").eq("converted_to_member", false).is("deleted_at", null)
      .in("location_id", slugs.map((s) => STUDIO[s].uuid)).order("payment_date", { ascending: false }).limit(3000);
    for (const t of (tr ?? [])) {
      const e164 = toE164((t as any).phone || ""); if (!e164) continue;
      const slug = uuidToSlug[(t as any).location_id]; if (!slug) continue;
      const nm = String((t as any).name || "").trim().split(/\s+/);
      const paid = fmtDate((t as any).payment_date || (t as any).created_at);
      cands.push({ type: "trial", slug, first: nm[0] || "Trial", last: nm.slice(1).join(" "), e164, dk: digits((t as any).phone),
        email: (t as any).email || null, sortKey: String((t as any).payment_date || (t as any).created_at || ""),
        ctx: [`Paid $49 trial${paid ? ` · ${paid}` : ""}`, `Not yet converted to member`] });
    }
  }

  // ── Cohort B: expired members who actually PAID (last payment on file) ─────
  if (types.includes("expired")) {
    const { data: mem } = await sb.from("mindbody_clients")
      .select("mindbody_id, first_name, last_name, email, phone, studio_slug, status")
      .in("studio_slug", slugs).in("status", ["Expired", "Terminated", "Cancelled", "Suspended"]).limit(20000);
    const ids = Array.from(new Set((mem ?? []).map((m: any) => m.mindbody_id).filter(Boolean)));
    const lastPaid: Record<string, string> = {}, lastVisit: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 1000) {
      const slice = ids.slice(i, i + 1000);
      const { data: sales } = await sb.from("mindbody_sales").select("customer_mindbody_id, sale_date_time, total_cents").in("customer_mindbody_id", slice).gt("total_cents", 0);
      for (const s of (sales ?? [])) { const id = (s as any).customer_mindbody_id, d = (s as any).sale_date_time; if (id && d && (!lastPaid[id] || d > lastPaid[id])) lastPaid[id] = d; }
      const { data: lc } = await sb.from("v_member_lifecycle").select("mindbody_id, last_attended_at").in("mindbody_id", slice);
      for (const r of (lc ?? [])) if ((r as any).last_attended_at) lastVisit[(r as any).mindbody_id] = (r as any).last_attended_at;
    }
    for (const m of (mem ?? [])) {
      // A former member IS paid history (they paid membership dues) — don't
      // gate on a synced sales row (mindbody_sales is only a partial mirror).
      const id = (m as any).mindbody_id; const paid = lastPaid[id];
      const e164 = toE164((m as any).phone || ""); if (!e164) continue;
      const slug = (m as any).studio_slug as Slug; if (!(slug in STUDIO)) continue;
      const lv = fmtDate(lastVisit[id] ?? null);
      cands.push({ type: "expired", slug, first: (m as any).first_name || "Former", last: (m as any).last_name || "Member",
        e164, dk: digits((m as any).phone), email: (m as any).email || null,
        sortKey: lastVisit[id] || paid || "", ctx: [`Expired member`, `Last visit: ${lv ?? "unknown"}`, `Last paid: ${paid ? fmtDate(paid) : "unknown"}`] });
    }
  }

  // ── Exclusion: current MEMBERS + PROMO buyers ─────────────────────────────
  // converted_to_member and the MindBody status are stale, so cross-check
  // against REAL purchases and drop anyone who already bought a membership or a
  // promo, or is flagged a member. (This is what let members slip into the queue.)
  const last10 = (p: string) => digits(p).slice(-10);
  const MP_MIN = 100;
  const isMembershipSale = (item: string, c: number) => {
    const s = (item || "").toLowerCase();
    if (c <= MP_MIN) return false;
    if (s.includes("two weeks trial") || s.includes("$49") || s.includes("week trial")) return false;
    return s.includes("membership") || s.includes("pif") || s.includes("contract") || s.includes("month to month") || /\bmonthly\b/.test(s);
  };
  const isPromoSale = (item: string, c: number) => {
    const s = (item || "").toLowerCase();
    return c > MP_MIN && (s.includes("299") || s.includes("back to school") || s.includes("comeback") || s.includes("bts"));
  };
  const exclude = new Set<string>();
  const memMtIds = new Set<string>(), memEmails = new Set<string>();
  const RECENT_CUTOFF = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("mariana_tek_sales").select("customer_mt_id, customer_email, item_names, total_cents, sale_date_time").gt("total_cents", MP_MIN).range(from, from + 999);
    for (const s of (data ?? [])) {
      const it = (s as any).item_names || "", c = Number((s as any).total_cents || 0), itl = it.toLowerCase();
      // membership OR promo (any date) OR ANY non-trial purchase in the last 90 days.
      const recentNonTrial = String((s as any).sale_date_time || "").slice(0, 10) >= RECENT_CUTOFF && !(itl.includes("trial") || itl.includes("$49"));
      if (isMembershipSale(it, c) || isPromoSale(it, c) || recentNonTrial) {
        if ((s as any).customer_mt_id) memMtIds.add(String((s as any).customer_mt_id));
        if ((s as any).customer_email) memEmails.add(String((s as any).customer_email).toLowerCase().trim());
      }
    }
    if (!data || data.length < 1000) break;
  }
  // Authoritative converted-members list (catches members with no synced sale row).
  for (const slug of ["bayside", "fresh-meadows"]) {
    const { data: cm } = await sb.rpc("get_converted_members", { p_studio_slug: slug });
    for (const m of ((cm ?? []) as any[])) for (const e of [m.stripe_email, m.mb_email]) if (e) memEmails.add(String(e).toLowerCase().trim());
  }
  const mtArr = Array.from(memMtIds);
  for (let i = 0; i < mtArr.length; i += 500) {
    const { data } = await sb.from("mariana_tek_clients").select("phone").in("mt_id", mtArr.slice(i, i + 500));
    for (const r of (data ?? [])) if ((r as any).phone) exclude.add(last10((r as any).phone));
  }
  const emArr = Array.from(memEmails);
  for (const tbl of ["mariana_tek_clients", "mindbody_clients", "trial_signups"]) {
    for (let i = 0; i < emArr.length; i += 150) {
      const { data } = await sb.from(tbl).select("phone").in("email", emArr.slice(i, i + 150));
      for (const r of (data ?? [])) if ((r as any).phone) exclude.add(last10((r as any).phone));
    }
  }
  { const { data } = await sb.from("trial_signups").select("phone").or("converted_to_member.eq.true,front_desk_stage.eq.member").limit(8000);
    for (const r of (data ?? [])) if ((r as any).phone) exclude.add(last10((r as any).phone)); }

  // Gate: not a member/buyer, not already loaded; de-dupe; GROUP + newest-first.
  const seen = new Set<string>();
  const queue = cands.filter((c) => {
    if (exclude.has(last10(c.dk))) return false;
    const k = `${c.dk}|${c.type}`;
    if (loaded.has(k) || seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => (a.type === b.type ? b.sortKey.localeCompare(a.sortKey) : RANK[a.type] - RANK[b.type]));

  const batch = queue.slice(0, limit);
  const titleOf = (c: Cand) => `${c.first} ${c.last}`.trim() + ` · ${TAG[c.type]}`;
  const descOf = (c: Cand) => [`📞 ${c.e164}`, c.email ? `✉️ ${c.email}` : "", `📍 ${STUDIO[c.slug].label}`, "", ...c.ctx, "", "Log the outcome + check off when contacted."].filter((l) => l !== undefined).join("\n");

  if (dryRun) {
    const by = (t: string, s: string) => queue.filter((c) => c.type === t && c.slug === s).length;
    return json({
      ok: true, dry_run: true, note: "Bayside + Fresh Meadows only (the studios on Quo).",
      remaining_total: queue.length,
      breakdown: {
        bayside: { inquiry: by("inquiry", "bayside"), trial: by("trial", "bayside"), expired: by("expired", "bayside") },
        "fresh-meadows": { inquiry: by("inquiry", "fresh-meadows"), trial: by("trial", "fresh-meadows"), expired: by("expired", "fresh-meadows") },
      },
      would_load_now: batch.length,
      sample: batch.slice(0, 6).map((c) => ({ studio: STUDIO[c.slug].label, title: titleOf(c), description: descOf(c) })),
    });
  }

  const results = { created: 0, errors: [] as any[] }; let hitLimit = false;
  for (const c of batch) {
    // Named contact so the number resolves to the person (one-tap call/text).
    await quoPost("contacts", { defaultFields: { firstName: c.first, lastName: c.last, company: `${COMPANY[c.type]} · ${STUDIO[c.slug].label}`, phoneNumbers: [{ name: "mobile", value: c.e164 }], ...(c.email ? { emails: [{ name: "email", value: c.email }] } : {}) }, source: `queue-${c.type}` }, key!);
    await sleep(110);
    const task = await quoPost("tasks", { title: titleOf(c), description: descOf(c), phoneNumberId: STUDIO[c.slug].pn }, key!);
    await sleep(110);
    if (task.ok) {
      await sb.from("quo_task_loaded").upsert({ phone_digits: c.dk, type: c.type, studio_slug: c.slug, full_name: `${c.first} ${c.last}`.trim(), quo_task_id: task.id ?? null, loaded_at: new Date().toISOString() }, { onConflict: "phone_digits,type" });
      results.created++;
    } else {
      results.errors.push({ name: `${c.first} ${c.last}`.trim(), error: task.error });
      if (task.status === 402) { hitLimit = true; break; }   // Open-task cap reached
    }
  }
  return json({ ok: true, dry_run: false, created: results.created, remaining_after: queue.length - results.created, hit_open_task_limit: hitLimit, error_count: results.errors.length, errors: results.errors.slice(0, 5) });
});
