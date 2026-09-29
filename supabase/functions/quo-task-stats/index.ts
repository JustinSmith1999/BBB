// quo-task-stats — dashboard tracking for the Quo CALL QUEUE (quo-task-queue).
// Answers the owner's question: "how many people did we call back, and how many
// did we win, from the task list?" — per studio and per cohort.
//
//   QUEUED      = live Quo tasks on the studio line (people still to work)
//   CALLED_BACK = those tasks marked completed in Quo (staff check off = "talked")
//   WON         = people we loaded into the queue who converted AFTER we queued
//                 them — a membership/promo/non-trial purchase dated after their
//                 loaded_at, OR moved to the "member" stage / marked converted in
//                 Homebase after loaded_at. The date gate matters: many people
//                 were removed from the queue for being members ALREADY — those
//                 are NOT wins. A win is "was on the call list, converted since."
//
// The queue is Bayside + Fresh Meadows only (the studios on Quo).
//
// Read-only. No writes, no Quo mutations. Safe to call from the dashboard.
// GET or POST, header x-bbb-secret. Deploy: bbb deploy-fn quo-task-stats
//
// Response shape:
//   { ok, generated_at,
//     totals:   { queued, called_back, won, called_back_rate, win_rate },
//     studios: { bayside:{...}, "fresh-meadows":{...} },   // same 5 fields
//     by_type: { inquiry:{...}, trial:{...}, expired:{...} } }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const STUDIO = {
  "bayside":       { pn: "PN53tm8BYn", label: "Bayside" },
  "fresh-meadows": { pn: "PNrbRXue3z", label: "Fresh Meadows" },
} as const;
type Slug = keyof typeof STUDIO;
const PN_TO_SLUG: Record<string, Slug> = { "PN53tm8BYn": "bayside", "PNrbRXue3z": "fresh-meadows" };
const TYPES = ["inquiry", "trial", "expired"] as const;
type Ctype = typeof TYPES[number];
// Task titles end with "· INQUIRY | TRIAL | EXPIRED"
const TAG_TO_TYPE: Record<string, Ctype> = { INQUIRY: "inquiry", TRIAL: "trial", EXPIRED: "expired" };

const digits = (p: string) => (p || "").replace(/\D/g, "");
const last10 = (p: string) => digits(p).slice(-10);
const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // one decimal %

// Pull every Quo task (paginate). Returns {queued, called_back} keyed by slug|type.
async function pullQuoTasks(key: string) {
  const cell = () => ({ queued: 0, called_back: 0 });
  const grid: Record<string, ReturnType<typeof cell>> = {};
  for (const s of Object.keys(STUDIO)) for (const t of TYPES) grid[`${s}|${t}`] = cell();
  let token: string | null = null, guard = 0;
  do {
    const url = `https://api.quo.com/v1/tasks?maxResults=50${token ? `&pageToken=${token}` : ""}`;
    const r = await fetch(url, { headers: { "Authorization": key, "User-Agent": "bbb-stats" } });
    if (!r.ok) throw new Error(`Quo /tasks HTTP ${r.status}`);
    const d = await r.json();
    for (const t of (d.data ?? [])) {
      const slug = PN_TO_SLUG[t.phoneNumberId]; if (!slug) continue;
      const title = String(t.title || "");
      const tag = title.includes("·") ? title.split("·").pop()!.trim().toUpperCase() : "";
      const type = TAG_TO_TYPE[tag]; if (!type) continue;
      const g = grid[`${slug}|${type}`];
      g.queued++;
      if (t.completed) g.called_back++;
    }
    token = d.nextPageToken ?? null;
  } while (token && ++guard < 60);
  return grid;
}

// Which qualifying purchase counts as a "conversion" — same membership/promo
// definition as the loader, plus any non-trial purchase (a real spend).
const MP_MIN = 100;
function isConversionSale(item: string, c: number): boolean {
  const s = (item || "").toLowerCase();
  if (c <= MP_MIN) return false;
  if (s.includes("two weeks trial") || s.includes("$49") || s.includes("week trial")) return false; // a new trial isn't a win
  return true; // any real (>$1) non-trial purchase after we queued them = won
}

// Given the ledger's phone→earliest-loaded_at map, return the set of phones that
// converted AFTER we queued them. Two dated signals, both gated on loaded_at:
//   1. an MT purchase (>$1, non-trial) with sale_date_time > loaded_at
//   2. Homebase: moved to "member" stage, or a dated convert flag, after loaded_at
async function buildWonPhones(sb: any, loadAt: Record<string, string>): Promise<Set<string>> {
  const won = new Set<string>();

  // Resolve MT customers → phone (mt_id and email both).
  const mt2ph: Record<string, string> = {}, em2ph: Record<string, string> = {};
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("mariana_tek_clients").select("mt_id, email, phone").range(from, from + 999);
    for (const r of (data ?? [])) {
      const ph = last10((r as any).phone || ""); if (!ph) continue;
      if ((r as any).mt_id) mt2ph[String((r as any).mt_id)] = ph;
      if ((r as any).email) em2ph[String((r as any).email).toLowerCase().trim()] = ph;
    }
    if (!data || data.length < 1000) break;
  }

  // Signal 1 — MT sales dated after loaded_at.
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("mariana_tek_sales").select("customer_mt_id, customer_email, item_names, total_cents, sale_date_time").gt("total_cents", MP_MIN).range(from, from + 999);
    for (const s of (data ?? [])) {
      if (!isConversionSale((s as any).item_names || "", Number((s as any).total_cents || 0))) continue;
      const dt = String((s as any).sale_date_time || ""); if (!dt) continue;
      let ph: string | undefined;
      if ((s as any).customer_mt_id && mt2ph[String((s as any).customer_mt_id)]) ph = mt2ph[String((s as any).customer_mt_id)];
      else if ((s as any).customer_email && em2ph[String((s as any).customer_email).toLowerCase().trim()]) ph = em2ph[String((s as any).customer_email).toLowerCase().trim()];
      if (ph && loadAt[ph] && dt > loadAt[ph]) won.add(ph);
    }
    if (!data || data.length < 1000) break;
  }

  // Signal 2 — Homebase conversions dated after loaded_at (trial_signups).
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("trial_signups")
      .select("phone, front_desk_stage, front_desk_updated_at, comeback_converted_at, winback49_converted_at")
      .range(from, from + 999);
    for (const r of (data ?? [])) {
      const ph = last10((r as any).phone || ""); if (!ph || !loadAt[ph]) continue;
      const la = loadAt[ph];
      const stageMember = (r as any).front_desk_stage === "member" && String((r as any).front_desk_updated_at || "") > la;
      const cb = String((r as any).comeback_converted_at || "") > la && !!(r as any).comeback_converted_at;
      const wb = String((r as any).winback49_converted_at || "") > la && !!(r as any).winback49_converted_at;
      if (stageMember || cb || wb) won.add(ph);
    }
    if (!data || data.length < 1000) break;
  }

  return won;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);

  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  // 1) Live Quo tasks → queued + called_back per studio|type.
  let grid;
  try { grid = await pullQuoTasks(key); }
  catch (e) { return json({ ok: false, error: String((e as any)?.message || e) }, 502); }

  // 2) Everyone we ever loaded into the queue (ledger). Keep the earliest
  //    loaded_at per phone, and remember which studio|type slots each phone sits in.
  const { data: ledger } = await sb.from("quo_task_loaded").select("phone_digits, type, studio_slug, loaded_at");
  const loadAt: Record<string, string> = {};
  const slotsByPhone: Record<string, Array<[string, string]>> = {};
  for (const r of (ledger ?? [])) {
    const ph = last10((r as any).phone_digits || ""); if (!ph) continue;
    const slug = String((r as any).studio_slug), type = String((r as any).type);
    if (!(slug in STUDIO) || !TYPES.includes(type as Ctype)) continue;
    const la = String((r as any).loaded_at || "");
    if (!(ph in loadAt) || la < loadAt[ph]) loadAt[ph] = la;
    (slotsByPhone[ph] ||= []).push([slug, type]);
  }

  // 3) Who converted AFTER we queued them (dated), then map to studio|type.
  const wonPhones = await buildWonPhones(sb, loadAt);
  const wonGrid: Record<string, number> = {};
  for (const s of Object.keys(STUDIO)) for (const t of TYPES) wonGrid[`${s}|${t}`] = 0;
  const countedSlot = new Set<string>();
  for (const ph of wonPhones) {
    for (const [slug, type] of (slotsByPhone[ph] || [])) {
      const k = `${slug}|${type}`;
      const dedupe = `${ph}|${k}`; if (countedSlot.has(dedupe)) continue; countedSlot.add(dedupe);
      wonGrid[k]++;
    }
  }

  // 4) Assemble output.
  const blank = () => ({ queued: 0, called_back: 0, won: 0 });
  const pack = (o: { queued: number; called_back: number; won: number }) => ({
    ...o,
    called_back_rate: rate(o.called_back, o.queued),   // % of queue contacted
    win_rate: rate(o.won, o.won + o.queued),           // % of the cohort won (won / everyone we tried)
  });

  const totals = blank();
  const studios: Record<string, any> = {};
  const byType: Record<string, any> = {};
  for (const t of TYPES) byType[t] = blank();

  for (const slug of Object.keys(STUDIO) as Slug[]) {
    const st = blank();
    for (const t of TYPES) {
      const g = grid[`${slug}|${t}`], won = wonGrid[`${slug}|${t}`] || 0;
      st.queued += g.queued; st.called_back += g.called_back; st.won += won;
      byType[t].queued += g.queued; byType[t].called_back += g.called_back; byType[t].won += won;
      totals.queued += g.queued; totals.called_back += g.called_back; totals.won += won;
    }
    studios[slug] = { label: STUDIO[slug].label, ...pack(st) };
  }

  return json({
    ok: true,
    generated_at: new Date().toISOString(),
    note: "Bayside + Fresh Meadows (the studios on Quo). called_back = tasks checked off in Quo; won = queued people who have since become a member/buyer.",
    totals: pack(totals),
    studios,
    by_type: Object.fromEntries(TYPES.map((t) => [t, pack(byType[t])])),
  });
});
