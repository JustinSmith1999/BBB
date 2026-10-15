/**
 * quo-call-audit — READ ONLY. Answers "are these Quo calls actually real?"
 *
 * Built 2026-10-12. On 9 Oct I told Justin the spam calls were invisible to us
 * because quo-inbound-webhook only subscribes to message.received /
 * message.delivered. That was true of the WEBHOOK but wrong about the API:
 * Quo's /calls endpoint (API version 2026-03-30) returns full call history,
 * retroactively. So we can measure this without waiting for new events.
 *
 * WHAT IT DOES
 * Pulls every INCOMING call on the Bayside + Fresh Meadows Quo lines over a
 * window, then classifies each one. Writes nothing, blocks nobody, changes no
 * settings.
 *
 * HOW A CALL IS CLASSIFIED
 *   known_customer  caller's number matches a phone in trial_signups — a lead,
 *                   trial buyer or member. These are unambiguously real, and
 *                   they are the number that matters: if staff stop answering,
 *                   these are what gets missed.
 *   left_voicemail  recorded a voicemail. Dialers essentially never do.
 *   real_conversation  answered AND lasted >= 20s.
 *   likely_spam     unanswered or answered-then-dead in under 10s, no
 *                   voicemail, no customer match. Robocalls hang up when a
 *                   human or a menu answers.
 *   withheld        caller id was anonymous / blocked / restricted.
 *   unclear         everything else — reported honestly rather than guessed at.
 *
 * It also returns repeat_callers (same number 2+ times) because those are the
 * ones worth blocking by hand, and an hour-of-day histogram, since a dialer
 * runs on a schedule and humans do not.
 *
 * 2026-10-12 (second pass): added keyword hunting over call SUMMARIES and
 * TRANSCRIPTS. Justin identified "SimplySearch" as the outfit behind most of the
 * Google-Business-Profile spam. Caller IDs are spoofed fresh every time, so the
 * number tells us nothing — but what they SAY is constant. Searching the
 * transcripts is the only way to count them, and it produces the named,
 * quotable evidence a complaint to Google/FTC actually needs.
 *
 * Summaries and transcripts are Quo business/scale plan features. If the plan
 * does not include them the API reports them absent and this says so plainly
 * rather than returning a confident zero.
 *
 * Body:
 *   { "hours": 72,          // lookback, default 72
 *     "max_pages": 40,      // safety cap, 50 calls per page
 *     "samples": 15,        // how many example rows to return per studio
 *     "keywords": ["simplysearch","google business","listing"],
 *                           // case-insensitive; searched in summary + transcript
 *     "fetch_transcripts": true }  // default true; one extra call per call row
 *
 * Auth: x-bbb-secret. Env: QUO_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 * Deploy: bbb deploy-fn quo-call-audit
 */

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const QUO_BASE = "https://api.quo.com";
const QUO_VERSION = "2026-03-30";

const LINES: Record<string, { pn: string; label: string; number: string }> = {
  bayside:         { pn: "PN53tm8BYn", label: "Bayside",       number: "+19178770759" },
  "fresh-meadows": { pn: "PNrbRXue3z", label: "Fresh Meadows", number: "+16468876483" },
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const WITHHELD = /^(anonymous|blocked|restricted)$/i;
const digits10 = (p: string) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
};

async function listCalls(key: string, pn: string, sinceIso: string, maxPages: number) {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL(`${QUO_BASE}/calls`);
    u.searchParams.set("phoneNumberId", pn);
    u.searchParams.set("direction", "incoming");
    u.searchParams.set("createdAt[gte]", sinceIso);
    u.searchParams.set("limit", "50");
    u.searchParams.set("include", "summary,voicemail");
    if (cursor) u.searchParams.set("after", cursor);
    const r = await fetch(u.toString(), {
      headers: { Authorization: key, "Quo-Api-Version": QUO_VERSION },
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`GET /calls HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    out.push(...(body.data || []));
    cursor = body.nextCursor || null;
    if (!cursor) break;
  }
  return out;
}

// Transcripts are a separate endpoint, one call per call id. Returns "" when the
// plan does not include transcription, which is reported rather than hidden.
async function getTranscript(key: string, callId: string) {
  try {
    const u = new URL(`${QUO_BASE}/calls/${callId}/transcripts`);
    u.searchParams.set("limit", "10");
    const r = await fetch(u.toString(), {
      headers: { Authorization: key, "Quo-Api-Version": QUO_VERSION },
    });
    if (!r.ok) return { text: "", available: false, note: `HTTP ${r.status}` };
    const b = await r.json();
    const rows = b.data || [];
    const text = rows
      .flatMap((t: any) => (t.dialogue || t.segments || []).map((s: any) => s.text || s.content || ""))
      .join(" ")
      .trim();
    return { text, available: rows.length > 0 };
  } catch (e) {
    return { text: "", available: false, note: String(e).slice(0, 120) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults below */ }
  const hours = Math.min(Math.max(Number(body.hours ?? 72), 1), 24 * 30);
  const maxPages = Math.min(Math.max(Number(body.max_pages ?? 40), 1), 200);
  const nSamples = Math.min(Math.max(Number(body.samples ?? 15), 0), 100);
  const keywords: string[] = (Array.isArray(body.keywords) && body.keywords.length
    ? body.keywords
    : ["simplysearch", "simply search", "google business", "google listing", "your listing", "verify your"]
  ).map((k: any) => String(k).toLowerCase());
  const fetchTx = body.fetch_transcripts !== false;

  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  // Every phone we know belongs to a real person in our funnel.
  const known = new Set<string>();
  {
    let from = 0;
    for (;;) {
      const { data, error } = await sb
        .from("trial_signups")
        .select("phone")
        .not("phone", "is", null)
        .range(from, from + 999);
      if (error) break;
      for (const r of data || []) { const d = digits10(r.phone); if (d.length === 10) known.add(d); }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
  }

  const studios: any[] = [];
  const grandHours: Record<string, number> = {};

  for (const [slug, cfg] of Object.entries(LINES)) {
    let calls: any[] = [];
    try {
      calls = await listCalls(key, cfg.pn, since, maxPages);
    } catch (e) {
      studios.push({ studio: slug, label: cfg.label, ok: false, error: String(e) });
      continue;
    }

    const tally: Record<string, number> = {
      known_customer: 0, left_voicemail: 0, real_conversation: 0,
      likely_spam: 0, withheld: 0, unclear: 0,
    };
    const byCaller: Record<string, { n: number; answered: number; totalDur: number; vm: number; cls: string[] }> = {};
    const hourHist: Record<string, number> = {};
    const samples: any[] = [];
    let answered = 0, totalDur = 0;
    const kwHits: any[] = [];
    let txAvailable = 0, summAvailable = 0;

    for (const c of calls) {
      const other = (c.participants || [])
        .filter((p: any) => p.phoneNumber && p.phoneNumber !== cfg.number)
        .map((p: any) => p.phoneNumber)[0] || "";
      const d10 = digits10(other);
      const dur = Number(c.duration || 0);
      const wasAnswered = !!c.answeredAt;
      const vm = !!(c.voicemail && (c.voicemail.duration || c.voicemail.transcript));
      if (wasAnswered) answered++;
      totalDur += dur;

      const hr = new Date(c.createdAt).toISOString().slice(11, 13);
      hourHist[hr] = (hourHist[hr] || 0) + 1;
      grandHours[hr] = (grandHours[hr] || 0) + 1;

      // ── what did they actually SAY ──────────────────────────────────────────
      const summText = [
        ...(c.summary?.summary || []),
        ...(c.summary?.nextSteps || []),
        c.summary?.title || "",
      ].join(" ");
      if (c.summary?.status === "completed") summAvailable++;
      let txText = "";
      if (fetchTx && (c.answeredAt || vm)) {
        const tx = await getTranscript(key, c.id);
        txText = tx.text;
        if (tx.available) txAvailable++;
      }
      const haystack = `${summText} ${txText} ${c.voicemail?.transcript || ""}`.toLowerCase();
      const matched = keywords.filter((k) => haystack.includes(k));
      if (matched.length) {
        kwHits.push({
          at: c.createdAt, from: other, duration_s: dur, answered: wasAnswered,
          matched_keywords: matched,
          quote: (txText || summText || c.voicemail?.transcript || "").slice(0, 400),
        });
      }

      let cls: string;
      if (WITHHELD.test(other)) cls = "withheld";
      else if (d10.length === 10 && known.has(d10)) cls = "known_customer";
      else if (vm) cls = "left_voicemail";
      else if (wasAnswered && dur >= 20) cls = "real_conversation";
      else if (!wasAnswered || dur < 10) cls = "likely_spam";
      else cls = "unclear";
      tally[cls]++;

      const kk = other || "(unknown)";
      byCaller[kk] = byCaller[kk] || { n: 0, answered: 0, totalDur: 0, vm: 0, cls: [] };
      byCaller[kk].n++;
      if (wasAnswered) byCaller[kk].answered++;
      byCaller[kk].totalDur += dur;
      if (vm) byCaller[kk].vm++;
      if (!byCaller[kk].cls.includes(cls)) byCaller[kk].cls.push(cls);

      if (samples.length < nSamples) {
        samples.push({
          at: c.createdAt, from: other, status: c.status, answered: wasAnswered,
          duration_s: dur, voicemail: vm, route: c.callRoute, classified: cls,
          voicemail_transcript: vm ? String(c.voicemail?.transcript || "").slice(0, 160) : null,
        });
      }
    }

    const repeats = Object.entries(byCaller)
      .filter(([, v]) => v.n >= 2)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 25)
      .map(([num, v]) => ({
        number: num, calls: v.n, answered: v.answered,
        avg_duration_s: v.n ? Math.round(v.totalDur / v.n) : 0,
        voicemails: v.vm, classified: v.cls,
        block_candidate: v.n >= 2 && v.vm === 0 && !v.cls.includes("known_customer") && (v.totalDur / v.n) < 15,
      }));

    const total = calls.length;
    const pct = (x: number) => (total ? Math.round((x / total) * 100) : 0);
    studios.push({
      studio: slug, label: cfg.label, ok: true,
      window_hours: hours, total_incoming: total,
      answered, answer_rate_pct: pct(answered),
      avg_duration_s: total ? Math.round(totalDur / total) : 0,
      breakdown: tally,
      breakdown_pct: Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, pct(v)])),
      legit_total: tally.known_customer + tally.left_voicemail + tally.real_conversation,
      legit_pct: pct(tally.known_customer + tally.left_voicemail + tally.real_conversation),
      unique_callers: Object.keys(byCaller).length,
      transcripts_available: txAvailable,
      summaries_available: summAvailable,
      transcript_coverage_note:
        txAvailable === 0 && summAvailable === 0
          ? "No transcripts OR summaries came back. These are Quo business/scale plan features — on a lower plan the keyword hunt cannot work and keyword_hits:0 means 'unknown', not 'none'."
          : `${txAvailable} transcripts, ${summAvailable} summaries available for keyword matching.`,
      keyword_hits: kwHits,
      keyword_hit_count: kwHits.length,
      repeat_callers: repeats,
      calls_per_hour_utc: hourHist,
      samples,
    });
  }

  const ok = studios.filter((s) => s.ok);
  return json({
    ok: true,
    read_only: true,
    generated_at: new Date().toISOString(),
    window_hours: hours,
    since,
    known_phones_in_funnel: known.size,
    how_to_read:
      "legit_pct is the share that matched a phone in our funnel, left a voicemail, or held a real conversation (>=20s answered). " +
      "likely_spam is unanswered or sub-10s with no voicemail and no customer match. " +
      "repeat_callers with block_candidate:true are the ones worth blocking by hand. " +
      "calls_per_hour_utc exposes a dialer schedule: a flat spread across business hours is human, a tight cluster is automated.",
    keywords_searched: keywords,
    network: {
      total_incoming: ok.reduce((a, s) => a + s.total_incoming, 0),
      legit_total: ok.reduce((a, s) => a + s.legit_total, 0),
      likely_spam: ok.reduce((a, s) => a + s.breakdown.likely_spam, 0),
      known_customer: ok.reduce((a, s) => a + s.breakdown.known_customer, 0),
      keyword_hits: ok.reduce((a, s) => a + s.keyword_hit_count, 0),
      transcripts_available: ok.reduce((a, s) => a + s.transcripts_available, 0),
      calls_per_hour_utc: grandHours,
    },
    studios,
  });
});
