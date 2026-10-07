/**
 * ladder-send · the offer-ladder campaign sender (Bayside + Fresh Meadows)
 * ═══════════════════════════════════════════════════════════════════════════
 * DESCENDING LADDER. Justin, 2026-10-05: "start with highest to lowest pricing."
 *
 * We anchor at the most expensive offer and concede downward. Each rung is
 * shown two or three times before the next one appears, because a step down
 * only reads as a concession if they actually saw what they are being stepped
 * down FROM. Lead with $29 and every later number is an increase; lead with
 * $299 and every later number is a gift.
 *
 *   Rung 1  $299 · 2 months   looks 1-3   MT 14913  → /twomonths/<studio>
 *   Rung 2  $99  · 1 month    looks 1-3   MT 15109  → /month/<studio>
 *   Rung 3  $49  · 2 weeks    looks 1-3   MT 14944  → /trial/<studio>
 *   Rung 4  $29  · 1 week     looks 1-2   (Stripe)  → /comeback/<studio>
 *   menu    all four at once, after the floor
 *
 * ── THE DRIP ───────────────────────────────────────────────────────────────
 * Twelve sends over about five weeks. Three days inside a rung, four days
 * across a step-down so the new number lands on its own rather than reading as
 * more of the same email.
 *
 *   day  0   299 look 1       day 20   49  look 1
 *   day  3   299 look 2       day 23   49  look 2
 *   day  6   299 look 3       day 26   49  look 3
 *   day 10   99  look 1       day 30   29  look 1
 *   day 13   99  look 2       day 33   29  look 2
 *   day 16   99  look 3       day 38   menu
 *
 * Call {"plan": true} to get this calendar back as JSON with the exact
 * invocation for each day. There is NO cron attached: every send is a
 * deliberate human invocation, and that is on purpose.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * dry_run DEFAULTS TO TRUE. You must pass {"dry_run": false} to send anything.
 *
 * ── INVOKE (header: x-bbb-secret) ──────────────────────────────────────────
 *   { "plan": true }                                 -> the calendar, no send
 *   { "step": "299", "look": 1 }                     -> dry run, full cohort
 *   { "step": "299", "look": 1, "dry_run": false }   -> SENDS
 *   { "step": "99", "look": 2, "limit": 25 }         -> cap the batch
 *   { "step": "menu" }                               -> the everything email
 *   { "studio": "bayside" }                          -> one studio only
 *
 * ── GATES ──────────────────────────────────────────────────────────────────
 * A rung refuses to send unless the thing it sells can actually be bought.
 * These are REAL CHECKS where a real check is possible, not flags someone has
 * to remember to flip — see readiness() below. In particular step "99" reads
 * MT_CONTRACT_MONTH_99 from the environment, which is the same secret
 * mt-card-checkout resolves contract 15109 from. If that secret is missing the
 * checkout would 409, so this refuses to send people at it.
 *
 * ── WHY RESEND TAGS MATTER ─────────────────────────────────────────────────
 * Reporting (get_ladder_overview / get_ladder_detail) defines the campaign as
 * "everyone who received a ladder_% email", read from email_log. email_log is
 * populated by resend-webhook from the TAGS below. Drop the tags and the whole
 * owner-facing view silently reads zero. Note winback-blast writes to
 * email_log directly with no trial_signup_id — do NOT copy that pattern.
 *
 * ── THE NULL-LOCATION BUG THIS AVOIDS ──────────────────────────────────────
 * winback-49 builds locIds from candidate.location_id and calls
 * .in("id", locIds). One lead with a NULL location_id makes PostgREST throw
 * 22P02 (invalid input syntax for type uuid: "null"), the locations fetch
 * returns nothing, and EVERY candidate is skipped "no_location" — it sent zero
 * for days. Verified against the live API on 2026-10-05. Here we load the four
 * locations unconditionally and filter nulls out of the cohort instead.
 *
 * Deploy: bbb deploy-fn ladder-send
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const FROM_NAME = "Better Body Bootcamp";
const FROM_EMAIL = "hello@betterbodybootcamp.com";
const SITE = "https://betterbodybootcamp.com";

// Only these two studios are in this campaign.
const STUDIOS = new Set(["bayside", "fresh-meadows"]);

// Highest to lowest. This array is the single source of truth for ordering:
// the drip calendar, the "what comes next" line in the admin response, and the
// menu email all read it. Change the ladder here and nowhere else.
const STEP_ORDER = ["299", "99", "49", "29"] as const;
const LOOKS_PER_STEP: Record<string, number> = { "299": 3, "99": 3, "49": 3, "29": 2 };

const OFFERS: Record<string, { label: string; price: number; path: (s: string) => string }> = {
  "299": { label: "$299 · 2 months", price: 299, path: (s) => `${SITE}/twomonths/${s}` },
  "99":  { label: "$99 · 1 month",   price: 99,  path: (s) => `${SITE}/month/${s}` },
  "49":  { label: "$49 · 2 weeks",   price: 49,  path: (s) => `${SITE}/trial/${s}` },
  "29":  { label: "$29 · 1 week",    price: 29,  path: (s) => `${SITE}/comeback/${s}` },
};

const DRIP = [
  { day: 0,  step: "299", look: 1 }, { day: 3,  step: "299", look: 2 }, { day: 6,  step: "299", look: 3 },
  { day: 10, step: "99",  look: 1 }, { day: 13, step: "99",  look: 2 }, { day: 16, step: "99",  look: 3 },
  { day: 20, step: "49",  look: 1 }, { day: 23, step: "49",  look: 2 }, { day: 26, step: "49",  look: 3 },
  { day: 30, step: "29",  look: 1 }, { day: 33, step: "29",  look: 2 },
  { day: 38, step: "menu", look: 1 },
];

/**
 * Can this rung actually be bought right now? Real checks where possible.
 * Returning a reason string (rather than a bare false) means the 409 tells
 * whoever called it exactly what to go fix.
 */
function readiness(step: string): { ok: true } | { ok: false; why: string; fix: string[] } {
  switch (step) {
    case "299":
      // MT contract 14913, live at all four studios, sellable today — it is
      // still on the Bayside and Fresh Meadows public buy pages (verified in
      // MT admin 2026-10-05). /twomonths/<studio> mounts the BackToSchool
      // component, which posts kind "bts299" to mt-card-checkout.
      return { ok: true };
    case "99":
      // The contract id lives in a secret, not a literal. If it is unset,
      // mt-card-checkout returns 409 and the customer sees an error — so do
      // not send them there. This is the check, not a hand-flipped flag.
      return (Deno.env.get("MT_CONTRACT_MONTH_99") ?? "").trim()
        ? { ok: true }
        : {
            ok: false,
            why: "MT_CONTRACT_MONTH_99 is not set, so mt-card-checkout cannot sell the $99 month",
            fix: [
              "supabase secrets set MT_CONTRACT_MONTH_99=15109 --project-ref uracuwugpxqjfgtuobal",
              "bbb deploy-fn mt-card-checkout && bbb deploy-fn mt-provision",
              "bbb deploy-fn ladder-send   (so this function sees the secret too)",
            ],
          };
    case "49":
      return { ok: true };   // contract 14944 (web) / 14721 (desk), all four studios
    case "29":
      // NOTE: /comeback posts to create-trial-checkout (our Stripe). There is
      // no MT contract behind it, so a $29 buyer does NOT become an MT member,
      // cannot book, and the `paid` exit check below cannot see them in
      // mariana_tek_sales — only in stripe_paid_mirror. The ladder now ENDS
      // here, so this is the last thing a lead touches. Tracked as task #160.
      return { ok: true };
    case "menu":
      return { ok: true };
    default:
      return { ok: false, why: `unknown step "${step}"`, fix: ["see STEP_ORDER"] };
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const lc = (v: unknown) => String(v ?? "").toLowerCase().trim();
const slugOf = (name: string) => name.toLowerCase().replace(/\s+/g, "-");
const firstNameOf = (n: unknown) => (String(n ?? "").trim().split(/\s+/)[0] || "there");

// ─────────────────────────────────────────────────────────────────────────────
// COPY. Within a rung the OFFER never changes between looks — only the way in
// and the subject line. Look 1 is the offer, look 2 is the arithmetic, look 3
// is the objection. Across rungs the price drops and we say so plainly,
// because an unacknowledged discount reads as a mistake.
// ─────────────────────────────────────────────────────────────────────────────
type Ctx = { first: string; studio: string; slug: string; url: string };

function subjectFor(step: string, look: number, c: Ctx): string {
  const map: Record<string, string> = {
    "299_1": `${c.first}, the version of this that actually works`,
    "299_2": `$149 a month instead of $239`,
    "299_3": `Month two is where it happens`,
    "99_1":  `Smaller: one month, $99`,
    "99_2":  `The math on $99`,
    "99_3":  `What a month changes that two weeks can't`,
    "49_1":  `Smaller again: two weeks, $49`,
    "49_2":  `Two weeks is six classes`,
    "49_3":  `The part nobody tells you about starting`,
    "29_1":  `One week. $29. That's the floor.`,
    "29_2":  `Last one from me, ${c.first}`,
    "menu_1": `Everything we've got, ${c.first}`,
  };
  return map[`${step}_${look}`] ?? `${c.first}, from ${c.studio}`;
}

function bodyFor(step: string, look: number, c: Ctx): string[] {
  const P: Record<string, string[]> = {
    // ── Rung 1 · $299 two months ───────────────────────────────────────────
    "299_1": [
      `Hey ${c.first},`,
      `You started signing up at BBB ${c.studio} and never finished. I'm not going to guess why.`,
      `But I'll skip the trial pitch, because I think trials are part of the problem. Two weeks ends right before anything good happens.`,
      `<b>Two months, $299.</b> One payment, nothing recurring. That's $149 a month against the $239 our members pay.`,
      `__CTA__Take two months — $299__`,
      `Everything is included: every class, every time slot, both of those months.`,
    ],
    "299_2": [
      `${c.first} — just the arithmetic.`,
      `Month-to-month membership at BBB ${c.studio} is $239. Two months of it is $478.`,
      `<b>Two months for $299 saves you $179</b>, and you pay it once rather than signing up for something that renews until you remember to cancel it.`,
      `__CTA__Take two months — $299__`,
    ],
    "299_3": [
      `${c.first} — here's the honest reason I'm pushing two months rather than two weeks.`,
      `Week one you're sore and counting. Week two you're still counting. Somewhere in week three it stops being a thing you make yourself do.`,
      `Month two is where people stop deciding every morning. Almost nobody gets there on a trial, which is why so many trials end in nothing.`,
      `Two months, $299, paid once.`,
      `__CTA__Take two months — $299__`,
    ],

    // ── Rung 2 · $99 one month ─────────────────────────────────────────────
    "99_1": [
      `${c.first} — fair enough. Two months is a lot to ask from someone who hasn't set foot in the place.`,
      `So let's make it smaller.`,
      `<b>One month, $99.</b> One payment, nothing recurring. Membership here is $239, so this is a bit under half, for the same classes and the same coaches.`,
      `__CTA__Start my month — $99__`,
    ],
    "99_2": [
      `${c.first} — the numbers on the month.`,
      `$99 for a month. If you come three or four times a week that's twelve to sixteen classes, so six or seven dollars each — coached, with equipment, in a room full of people doing it with you.`,
      `A single drop-in class most places in Queens costs more than that.`,
      `__CTA__Start my month — $99__`,
    ],
    "99_3": [
      `${c.first} — one more go at this and then I'll stop talking about the month.`,
      `A month is the shortest run I've seen actually change how someone feels about training. Two weeks is enough to be sore. Four is enough to notice you're less sore.`,
      `$99, paid once, nothing after it.`,
      `__CTA__Start my month — $99__`,
    ],

    // ── Rung 3 · $49 two weeks ─────────────────────────────────────────────
    "49_1": [
      `${c.first} — smaller still, then.`,
      `<b>Two weeks, $49.</b> Every class, every time slot, one payment. It's the thing you were originally signing up for.`,
      `I'd rather you do two weeks than keep meaning to do something.`,
      `__CTA__Start my two weeks — $49__`,
    ],
    "49_2": [
      `${c.first} — the short version.`,
      `Two weeks is about six classes. $49 works out to roughly eight dollars a class.`,
      `__CTA__Take the two weeks — $49__`,
    ],
    "49_3": [
      `${c.first} — most people who stall on the signup page aren't stuck on the money.`,
      `They're wondering whether they'll be the least fit person in the room.`,
      `You won't be, and not because I'm being nice about it. Every class has someone on their first week and someone on their third year doing the same workout at different weights. The coach tells you what to pick up. That's the whole system.`,
      `Forty-five minutes. Two weeks, $49.`,
      `__CTA__Start my two weeks — $49__`,
    ],

    // ── Rung 4 · $29 one week · the floor ──────────────────────────────────
    "29_1": [
      `${c.first} — this is as small as it gets.`,
      `<b>One week. $29.</b> Unlimited classes for seven days, one payment.`,
      `About the price of two coffees and a sandwich, and the least I can think of to risk on finding out whether you like it here.`,
      `__CTA__Take one week — $29__`,
    ],
    "29_2": [
      `${c.first} — last one from me.`,
      `One week, $29, unlimited classes. It's the cheapest thing we sell and I've got nothing below it.`,
      `If it's not for you that's completely fine — no hard feelings and I'll leave you alone.`,
      `__CTA__Take one week — $29__`,
    ],
  };
  return P[`${step}_${look}`] ?? [];
}

function menuBody(c: Ctx): string[] {
  const li = (k: string, blurb: string) =>
    `<li><b>${OFFERS[k].label.replace(" · ", " — ")}</b> ${blurb} &nbsp;<a href="${OFFERS[k].path(c.slug)}">take it</a></li>`;
  return [
    `${c.first} — I've sent you a few of these, so here's everything at once and then I'll stop.`,
    `<ul style="margin:18px 0;padding-left:20px;line-height:2">
       ${li("299", "the best price per month we do, paid once")}
       ${li("99",  "enough time to see something change")}
       ${li("49",  "the standard starting point")}
       ${li("29",  "just see if you like it")}
     </ul>`,
    `Pick whichever one you'd actually use. If that's none of them, no hard feelings.`,
  ];
}

function render(paras: string[], c: Ctx): { html: string; text: string } {
  const btn = (label: string) =>
    `<table cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="background:#E11D2A;border-radius:8px">
     <a href="${c.url}" style="display:inline-block;padding:14px 26px;color:#fff;text-decoration:none;font:700 15px/1 Helvetica,Arial,sans-serif">${label}</a>
     </td></tr></table>`;
  const htmlParas = paras.map((p) =>
    p.startsWith("__CTA__") ? btn(p.replace(/^__CTA__/, "").replace(/__$/, ""))
      : `<p style="margin:0 0 16px">${p}</p>`).join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#fff;
       font:400 16px/1.6 Helvetica,Arial,sans-serif;color:#1a1a1a">
    ${htmlParas}
    <p style="margin:26px 0 0;color:#555">— ${c.studio} front desk</p>
    <p style="margin:22px 0 0;font-size:12px;color:#8a8a8a">
      Better Body Bootcamp ${c.studio}. Reply STOP and we'll leave you alone.</p>
  </div></body></html>`;
  const text = paras.map((p) =>
    p.startsWith("__CTA__") ? `${p.replace(/^__CTA__/, "").replace(/__$/, "")}: ${c.url}`
      : p.replace(/<[^>]+>/g, "")).join("\n\n") + `\n\n— ${c.studio} front desk`;
  return { html, text };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));

  // ── {"plan": true} — the calendar, with readiness checked per rung ───────
  if (body?.plan === true) {
    return json({
      ok: true,
      ladder: STEP_ORDER.map((s) => ({ step: s, offer: OFFERS[s].label, looks: LOOKS_PER_STEP[s], url: OFFERS[s].path("<studio>") })),
      drip: DRIP.map((d) => ({
        day: d.day,
        invoke: { step: d.step, look: d.look, dry_run: false },
        offer: d.step === "menu" ? "all four" : OFFERS[d.step].label,
      })),
      readiness: Object.fromEntries([...STEP_ORDER, "menu"].map((s) => {
        const r = readiness(s);
        return [s, r.ok ? "ready" : `BLOCKED: ${r.why}`];
      })),
      note: "No cron is attached. Each line above is a deliberate invocation. dry_run defaults to true.",
    });
  }

  const step = String(body?.step ?? STEP_ORDER[0]);
  const maxLook = step === "menu" ? 1 : (LOOKS_PER_STEP[step] ?? 3);
  const look = Math.max(1, Math.min(maxLook, Number(body?.look) || 1));
  const dryRun = body?.dry_run !== false;          // DEFAULT TRUE
  const limit = Math.max(1, Math.min(500, Number(body?.limit) || 500));
  const onlyStudio = body?.studio ? lc(body.studio) : null;

  if (!OFFERS[step] && step !== "menu") return json({ ok: false, error: `unknown step "${step}"` }, 400);

  const ready = readiness(step);
  if (!ready.ok) {
    return json({
      ok: false, blocked: true, step,
      error: `step "${step}" is not sellable right now — refusing to send people to a checkout that will fail`,
      why: ready.why, fix: ready.fix,
    }, 409);
  }

  const sendPath = step === "menu" ? "ladder_menu" : `ladder_${step}_l${look}`;
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  const RESEND_KEY = Deno.env.get("RESEND_API_KEY");

  // ── locations: loaded unconditionally. Never .in() on candidate-derived ids,
  //    which is the bug that made winback-49 send zero. ──────────────────────
  const { data: locs, error: locErr } = await sb.from("locations").select("id, name");
  if (locErr) return json({ ok: false, error: `locations: ${locErr.message}` }, 500);
  const locById = new Map<string, { name: string; slug: string }>();
  for (const l of (locs ?? []) as any[]) locById.set(l.id, { name: l.name, slug: slugOf(l.name || "") });
  const wantedLocIds = [...locById.entries()]
    .filter(([, v]) => STUDIOS.has(v.slug) && (!onlyStudio || v.slug === onlyStudio))
    .map(([id]) => id);
  if (!wantedLocIds.length) return json({ ok: false, error: "no matching studios" }, 400);

  // ── cohort ────────────────────────────────────────────────────────────────
  const { data: cands, error: cErr } = await sb
    .from("trial_signups")
    .select("id, name, email, phone, location_id, created_at, payment_status, front_desk_stage, converted_to_member, opted_out_at, deleted_at")
    .in("location_id", wantedLocIds)          // safe: ids come from locations, never null
    .is("deleted_at", null)
    .is("opted_out_at", null)
    .not("email", "is", null)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (cErr) return json({ ok: false, error: `candidates: ${cErr.message}` }, 500);

  const skips: Record<string, number> = {
    already_paid: 0, stage_member: 0, already_sent_this_look: 0,
    clicked_earlier_look: 0, no_location: 0, bad_status: 0,
  };

  // Everyone we must not touch, by email.
  const emails = (cands ?? []).map((c: any) => lc(c.email)).filter(Boolean);
  const paid = new Set<string>();
  // (a) a completed trial_signup under the same email, any studio
  const { data: paidTs } = await sb.from("trial_signups").select("email").eq("payment_status", "completed").in("email", emails.slice(0, 1000));
  (paidTs ?? []).forEach((r: any) => paid.add(lc(r.email)));
  // (b) Stripe mirror — the ONLY place a $29 /comeback buyer shows up, since
  //     that path never creates an MT membership (task #160).
  const { data: paidStripe } = await sb.from("stripe_paid_mirror").select("customer_email").in("customer_email", emails.slice(0, 1000));
  (paidStripe ?? []).forEach((r: any) => paid.add(lc(r.customer_email)));
  // (c) Mariana Tek — the real source of truth, and where $299/$99/$49 land
  const { data: paidMt } = await sb.from("mariana_tek_sales").select("customer_email, total_cents").gt("total_cents", 0).in("customer_email", emails.slice(0, 1000));
  (paidMt ?? []).forEach((r: any) => paid.add(lc(r.customer_email)));

  // Anyone already sent THIS look (idempotency), and anyone who clicked an
  // earlier look OF THIS SAME RUNG. Scoped to the same rung deliberately:
  // clicking the $299 and not buying is exactly the person the $99 is for, so
  // a click on a PREVIOUS rung must NOT hold them back from the next one.
  const earlier = look > 1 && step !== "menu"
    ? Array.from({ length: look - 1 }, (_, i) => `ladder_${step}_l${i + 1}`) : [];
  const { data: logRows } = await sb
    .from("email_log")
    .select("trial_signup_id, send_path, event_type")
    .like("send_path", "ladder\\_%")
    .not("trial_signup_id", "is", null)
    .limit(20000);
  const sentThis = new Set<string>(), clickedEarlier = new Set<string>();
  for (const r of (logRows ?? []) as any[]) {
    if (r.send_path === sendPath && ["email.sent", "sent"].includes(r.event_type)) sentThis.add(r.trial_signup_id);
    if (earlier.includes(r.send_path) && ["email.clicked", "clicked"].includes(r.event_type)) clickedEarlier.add(r.trial_signup_id);
  }

  const queue: any[] = [];
  for (const c of (cands ?? []) as any[]) {
    if (["completed", "attribution_only"].includes(String(c.payment_status ?? ""))) { skips.bad_status++; continue; }
    if (paid.has(lc(c.email))) { skips.already_paid++; continue; }
    // Justin 2026-10-05: hold out anyone the front desk already treats as a
    // member. Either they paid somewhere this check cannot see, or the board is
    // wrong — neither is a person to send a "come try us" offer to.
    if (lc(c.front_desk_stage) === "member" || c.converted_to_member === true) { skips.stage_member++; continue; }
    if (sentThis.has(c.id)) { skips.already_sent_this_look++; continue; }
    if (clickedEarlier.has(c.id)) { skips.clicked_earlier_look++; continue; }
    const loc = locById.get(c.location_id);
    if (!loc) { skips.no_location++; continue; }
    // The $99 month is sold at Bayside and Fresh Meadows only — which is the
    // whole cohort, but assert it rather than assume it, so widening STUDIOS
    // later cannot quietly start mailing a dead link.
    if (step === "99" && !["bayside", "fresh-meadows"].includes(loc.slug)) { skips.no_location++; continue; }
    queue.push({ ...c, loc });
  }

  // ── send ──────────────────────────────────────────────────────────────────
  let sent = 0, failed = 0;
  const sample: any[] = [];
  for (const c of queue) {
    if (sent >= limit) break;
    const ctx: Ctx = {
      first: firstNameOf(c.name), studio: c.loc.name, slug: c.loc.slug,
      url: (OFFERS[step] ?? OFFERS["49"]).path(c.loc.slug),
    };
    const subject = subjectFor(step, look, ctx);
    const paras = step === "menu" ? menuBody(ctx) : bodyFor(step, look, ctx);
    if (!paras.length) return json({ ok: false, error: `no copy for ${sendPath}` }, 500);

    if (dryRun) {
      sent++;
      if (sample.length < 5) sample.push({ to: c.email, name: c.name, studio: c.loc.name, subject, url: ctx.url });
      continue;
    }
    if (!RESEND_KEY) { failed++; continue; }
    if (sent > 0) await new Promise((r) => setTimeout(r, 150)); // Resend: 10 req/s

    const { html, text } = render(paras, ctx);
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`, to: [c.email], subject, html, text,
          // These three tags are what resend-webhook turns into email_log rows.
          // Without them the owner dashboard and /ladder read zero. Do not drop.
          tags: [
            { name: "send_path", value: sendPath },
            { name: "trial_signup_id", value: c.id },
            { name: "studio", value: c.loc.slug },
          ],
        }),
      });
      if (!r.ok) { failed++; continue; }
      sent++;
    } catch { failed++; }
  }

  // What the operator should run next, so the calendar does not have to be
  // remembered or looked up.
  const idx = DRIP.findIndex((d) => d.step === step && d.look === look);
  const next = idx >= 0 && idx + 1 < DRIP.length ? DRIP[idx + 1] : null;

  return json({
    ok: true, dry_run: dryRun, step, look, send_path: sendPath,
    offer: step === "menu" ? "all four" : OFFERS[step].label,
    cohort_considered: (cands ?? []).length,
    queued: queue.length,
    would_send: dryRun ? sent : undefined,
    sent: dryRun ? undefined : sent,
    failed, limit, skipped: skips,
    sample: dryRun ? sample : undefined,
    next_in_drip: next
      ? { in_days: next.day - (DRIP[idx]?.day ?? 0), invoke: { step: next.step, look: next.look, dry_run: false } }
      : "end of ladder",
  });
});
