/**
 * stripe-reconcile — autonomous reconciliation: Stripe IS the truth.
 *
 * Built 2026-06-24 after task #424: paid-trials-realtime-monitor missed 4
 * customers in 24h. Even with a 60-sec real-time monitor + 5-min mirror cron,
 * we *still* find paid trials in the morning that didn't get a welcome / no
 * MindBody account / no CAPI Purchase fire. Reasons vary (webhook signature
 * mismatch, monitor cron stalled, worker function 5xx) but the result is the
 * same: Justin acts as the alarm. Not anymore.
 *
 * Contract: for every paid charge in stripe_paid_mirror within the lookback
 * window, ensure these 4 downstream artifacts exist:
 *   1. trial_signups row with payment_status='completed' (not deleted)
 *   2. Welcome email + SMS fired   (rows in email_log + sms_messages)
 *   3. MindBody (or Mariana Tek) account linked (trial_signups.mindbody_id
 *      or mariana_tek_id IS NOT NULL)
 *   4. Meta CAPI Purchase event sent (row in capi_events with event_name
 *      'Purchase' and matching event_id 'trial_<session_id>')
 *
 * For each missing artifact, this function calls the right worker:
 *   - Missing trial_signups → upsert here (ON CONFLICT location_id,email)
 *   - Missing welcome       → POST /functions/v1/manual-welcome-batch
 *                             { trial_ids: [id], send_owner_sms: false }
 *                             (owner SMS OFF — reconcile fills gaps, owners
 *                              shouldn't get fake "new customer" pings hours
 *                              after the real event.)
 *   - Missing MB link       → POST /functions/v1/mindbody-create-trial-client
 *                             OR /functions/v1/mariana-tek-create-trial-client
 *                             based on locations.data_source
 *   - Missing CAPI          → POST /functions/v1/meta-capi-backfill
 *                             { trial_ids: [id], event: 'Purchase' }
 *                             (current backfill accepts since_hours; we pass
 *                              a tight window via since_hours derived from
 *                              the customer's paid_at — see callMetaBackfill)
 *
 * REQUEST:
 *   POST /functions/v1/stripe-reconcile
 *   {
 *     "lookback_days":   14,         // default 14, max 60
 *     "dry_run":         false,      // default false; if true: report only
 *     "customer_email":  "x@y.com"   // optional: just this one customer
 *   }
 *
 * AUTH: x-bbb-secret header. Same pattern as paid-trials-realtime-monitor.
 *
 * RESPONSE shape:
 *   { ok, dry_run, candidates_checked, fully_reconciled, actions_taken,
 *     customers: [{ email, studio, paid_at, trial_id,
 *                   before: { trial_row, welcome, mb, capi },
 *                   actions: [...], errors: [...] }] }
 *
 * SCHEDULE: every 15 min via cron. Heartbeat row written to ops_reconcile_runs
 * so silence-alarm cron can SMS Justin if no successful run in 30+ min.
 *
 * IDEMPOTENCY: every artifact check is a query. Re-running the function on
 * a fully-reconciled customer is a no-op (4 cheap selects, 0 writes).
 *
 * Deploy:
 *   supabase functions deploy stripe-reconcile --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_LOOKBACK_DAYS     = 60;
const MIRROR_PAGE_SIZE      = 200;  // never load more than this in one query

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

// ─── Studio slug → location_id (mirrors paid-trials-realtime-monitor) ───────
// Used as a fallback when a stripe_paid_mirror row's location_id is null.
const STUDIO_LOCATION_IDS: Record<string, string> = {
  williamsburg:    "80536b45-df0e-42d1-880c-e9301372e1cf",
  astoria:         "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45",
  bayside:         "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7",
  "fresh-meadows": "6bbbe077-bcc6-4d9d-a10b-7605c1484752",
};

interface MirrorRow {
  stripe_payment_intent_id: string;
  studio_slug: string | null;
  location_id: string | null;
  amount_cents: number | null;
  paid_at: string;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

interface BeforeState {
  trial_row: boolean;  // non-deleted trial_signups row with completed status
  welcome:   boolean;  // any welcome-path row in email_log for this trial
  mb:        boolean;  // trial_signups.mindbody_id OR mariana_tek_id non-null
  capi:      boolean;  // capi_events row event_name=Purchase, matching event_id
}

interface CustomerReport {
  email: string;
  studio: string;
  paid_at: string;
  trial_id: string | null;
  before: BeforeState;
  actions: string[];
  errors: string[];
}

// Welcome-email send_paths that count as "the customer was welcomed".
// stripe_customer_welcome_email = stripe-webhook real-time path
// manual_welcome_batch          = manual + reconcile dispatches
// Either one means the customer is welcomed; we don't fire a second.
const WELCOME_SEND_PATHS = [
  "stripe_customer_welcome_email",
  "manual_welcome_batch",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const lookbackRaw = Number(body?.lookback_days);
  const lookbackDays = Number.isFinite(lookbackRaw) && lookbackRaw > 0
    ? Math.min(Math.floor(lookbackRaw), MAX_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;
  const dryRun = body?.dry_run === true;
  const customerEmailFilter =
    typeof body?.customer_email === "string" && body.customer_email.trim()
      ? body.customer_email.trim().toLowerCase() : null;

  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SR_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPA_URL || !SR_KEY) {
    return json({ ok: false, error: "supabase env missing" }, 500);
  }
  const sb = createClient(SUPA_URL, SR_KEY);

  const sinceIso = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  // ── 1. Load mirror rows in window. Paginate to keep memory bounded.
  //    stripe_paid_mirror PK is stripe_payment_intent_id (text), so we sort by
  //    paid_at ascending and walk pages of MIRROR_PAGE_SIZE.
  const mirrorRows: MirrorRow[] = [];
  let pageStart = 0;
  // Cap total at 5 pages = 1000 rows — anything bigger and the cron tick can't
  // finish in 60s anyway. Justin can shrink lookback_days if needed.
  const MAX_PAGES = 5;
  while (pageStart < MAX_PAGES * MIRROR_PAGE_SIZE) {
    let q = sb
      .from("stripe_paid_mirror")
      .select(
        "stripe_payment_intent_id, studio_slug, location_id, amount_cents, paid_at, customer_email, customer_name, customer_phone",
      )
      .gte("paid_at", sinceIso)
      .order("paid_at", { ascending: true })
      .range(pageStart, pageStart + MIRROR_PAGE_SIZE - 1);
    if (customerEmailFilter) q = q.ilike("customer_email", customerEmailFilter);

    const { data: page, error } = await q;
    if (error) {
      await writeHeartbeat(sb, 0, {}, `mirror page query failed: ${error.message}`);
      return json({ ok: false, error: `mirror lookup failed: ${error.message}` }, 500);
    }
    if (!page || page.length === 0) break;
    mirrorRows.push(...(page as MirrorRow[]));
    if (page.length < MIRROR_PAGE_SIZE) break;
    pageStart += MIRROR_PAGE_SIZE;
  }

  if (mirrorRows.length === 0) {
    await writeHeartbeat(sb, 0, emptyActions(), null);
    return json({
      ok: true,
      dry_run: dryRun,
      candidates_checked: 0,
      fully_reconciled: 0,
      actions_taken: emptyActions(),
      customers: [],
    });
  }

  // ── 2. Load supporting context in batch — much cheaper than per-customer.
  const emails = uniqLower(mirrorRows.map((r) => r.customer_email));
  const piIds  = mirrorRows.map((r) => r.stripe_payment_intent_id).filter(Boolean);

  // 2a. trial_signups — load EVERY non-deleted row, paginated. Key by
  //     lower(trim(email)) in JS so we sidestep PostgREST's case-sensitive
  //     .in() and avoid timestamp-in-.or() parser glitches.
  //
  // 2026-06-24 iteration history:
  //   - v1 used .in("email", emails) → missed mixed-case / whitespace rows
  //   - v2 used .or("payment_date.gte.X,created_at.gte.Y") → ISO colons
  //     broke .or() parser, returned 0 rows
  //   - v3 (current): no SQL filter, paginate all live rows, do the match
  //     in JS. trial_signups is small (~few thousand rows ever); cheap.
  const trialsByEmail = new Map<string, any>();
  {
    const TRIAL_PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: trials, error: trialErr } = await sb
        .from("trial_signups")
        .select("id, name, email, phone, location_id, payment_status, payment_date, mindbody_id, mariana_tek_id, stripe_session_id, source_category, created_at, deleted_at")
        .is("deleted_at", null)
        .order("payment_status", { ascending: false }) // 'completed' > 'pending'
        .order("created_at", { ascending: false })
        .range(from, from + TRIAL_PAGE - 1);
      if (trialErr) {
        await writeHeartbeat(sb, 0, emptyActions(), `trial_signups query failed: ${trialErr.message}`);
        return json({ ok: false, error: `trial_signups lookup failed: ${trialErr.message}` }, 500);
      }
      if (!trials || trials.length === 0) break;
      for (const t of trials) {
        const k = ((t as any).email ?? "").toLowerCase().trim();
        if (!k) continue;
        if (!trialsByEmail.has(k)) trialsByEmail.set(k, t);
      }
      if (trials.length < TRIAL_PAGE) break;
      from += TRIAL_PAGE;
      if (from > 20000) break; // safety cap
    }
  }

  // 2b. locations.data_source per location_id — needed to decide MB vs MT
  const { data: locs } = await sb
    .from("locations")
    .select("id, name, data_source");
  const dataSourceById = new Map<string, string>();
  const studioNameById = new Map<string, string>();
  for (const l of locs ?? []) {
    dataSourceById.set((l as any).id, (l as any).data_source || "mindbody");
    studioNameById.set((l as any).id, (l as any).name || "");
  }

  // 2c. email_log "any welcome row" by trial_signup_id
  //
  // 2026-08-29 ROOT-CAUSE FIX (the Carlos 47-email incident): this used to be
  // ONE .in() with EVERY trial id (~750 UUIDs ≈ 28KB URL). The request blew
  // past the URL limit and failed — and the error was silently ignored — so
  // welcomeByTrialId came back EMPTY and every candidate looked un-welcomed.
  // stripe-reconcile then re-fired manual-welcome-batch every 15 minutes for
  // any Stripe-paid trial in the 14-day window: the first native Stripe sale
  // (guiqiang qiu, 8/29) got 20+ welcome emails and Bayside got 20+ studio
  // alerts. Fix: chunk the query (same pattern as the capi_events lookup
  // below) and FAIL CLOSED — if a chunk errors, treat all its trials as
  // already-welcomed. Worst case a genuinely missed welcome waits for the
  // next healthy tick; we never machine-gun a customer again.
  const trialIds = Array.from(trialsByEmail.values())
    .map((t: any) => t.id).filter(Boolean);
  const welcomeByTrialId = new Set<string>();
  for (const chunk of chunkArr(trialIds, 100)) {
    const { data: logs, error: logErr } = await sb
      .from("email_log")
      .select("trial_signup_id, send_path")
      .in("trial_signup_id", chunk)
      .in("send_path", WELCOME_SEND_PATHS);
    if (logErr) {
      console.error("welcome-set chunk failed (failing CLOSED):", logErr.message);
      for (const id of chunk) welcomeByTrialId.add(id);
      continue;
    }
    for (const l of logs ?? []) {
      const id = (l as any).trial_signup_id;
      if (id) welcomeByTrialId.add(id);
    }
  }

  // 2d. capi_events: Purchase event_ids we've already fired (ok=true OR ok=false
  //     doesn't matter — we just don't want to re-dispatch; meta-capi-backfill
  //     itself skips already-sent. We use event_id format trial_<session_id>
  //     to match. session_id = stripe_session_id on trial OR PI id on mirror.
  const capiEventIds = new Set<string>();
  // Build candidate event_ids: trial_<stripe_session_id> per trial_signups
  // we already loaded, AND trial_<payment_intent_id> per mirror row (cover
  // both since stripe-webhook uses session_id but reconcile may only have PI).
  const candidateEventIds: string[] = [];
  for (const r of mirrorRows) {
    if (r.stripe_payment_intent_id) candidateEventIds.push(`trial_${r.stripe_payment_intent_id}`);
  }
  for (const t of trialsByEmail.values()) {
    if ((t as any).stripe_session_id) candidateEventIds.push(`trial_${(t as any).stripe_session_id}`);
  }
  if (candidateEventIds.length) {
    // chunk to avoid query-string blow-up
    for (const chunk of chunkArr(uniq(candidateEventIds), 100)) {
      const { data: capi } = await sb
        .from("capi_events")
        .select("event_id")
        .eq("event_name", "Purchase")
        .in("event_id", chunk);
      for (const c of capi ?? []) {
        if ((c as any).event_id) capiEventIds.add((c as any).event_id);
      }
    }
  }

  // ── 3. Per-customer reconciliation loop. Concurrency = 1 (sequential await)
  //    so we don't overrun Twilio. Per-customer try/catch keeps one bad row
  //    from killing the whole tick.
  const customers: CustomerReport[] = [];
  const actions = emptyActions();
  let fullyReconciled = 0;

  for (const r of mirrorRows) {
    const email = (r.customer_email || "").toLowerCase().trim();
    const studio = r.studio_slug || "";
    const locationId = r.location_id
      || (studio && STUDIO_LOCATION_IDS[studio])
      || null;
    const dataSource = locationId ? (dataSourceById.get(locationId) || "mindbody") : "mindbody";

    const report: CustomerReport = {
      email,
      studio,
      paid_at: r.paid_at,
      trial_id: null,
      before: { trial_row: false, welcome: false, mb: false, capi: false },
      actions: [],
      errors: [],
    };

    try {
      // ── 3a. trial_signups present?
      let trial = email ? trialsByEmail.get(email) : null;
      if (trial && trial.payment_status === "completed") {
        report.before.trial_row = true;
        report.trial_id = trial.id;
      } else if (trial) {
        // Row exists but not flagged completed yet — flip it. Counts as a
        // "trial_row before" but we still take the action to fix status.
        report.before.trial_row = false;
        report.trial_id = trial.id;
        if (!dryRun) {
          const { error } = await sb
            .from("trial_signups")
            .update({
              payment_status: "completed",
              payment_date: r.paid_at,
            })
            .eq("id", trial.id);
          if (error) report.errors.push(`flip status: ${error.message}`);
          else report.actions.push("flipped_payment_status");
        } else {
          report.actions.push("would_flip_payment_status");
        }
      } else {
        // No row — upsert one. Use upsert on (location_id, email) since
        // 2026-06-24 unique partial index lives there. Set source_category
        // = 'stripe_checkout' if there's nothing else.
        report.before.trial_row = false;
        if (!email) {
          report.errors.push("cannot insert trial row: mirror row has no email");
        } else if (!locationId) {
          report.errors.push(`cannot insert trial row: unknown location for studio ${studio}`);
        } else if (dryRun) {
          report.actions.push("would_insert_trial_row");
          actions.created_trial_rows++;
        } else {
          const { data: inserted, error } = await sb
            .from("trial_signups")
            .upsert({
              name: r.customer_name || "",
              email,
              phone: r.customer_phone || "",
              location_id: locationId,
              source_category: "stripe_checkout",
              payment_status: "completed",
              payment_date: r.paid_at,
              trial_starts_at: r.paid_at,
              front_desk_stage: "new_lead",
              stripe_session_id: r.stripe_payment_intent_id,
            }, {
              onConflict: "location_id,email",
              ignoreDuplicates: false,
            })
            .select("id, mindbody_id, stripe_session_id")
            .single();
          if (error) {
            report.errors.push(`insert trial row: ${error.message}`);
          } else if (inserted) {
            report.actions.push("inserted_trial_row");
            actions.created_trial_rows++;
            report.trial_id = inserted.id;
            // Re-shape into a trial object for downstream checks
            trial = inserted;
            trialsByEmail.set(email, inserted);
          }
        }
      }

      // If we still don't have a trial_id, skip downstream — can't dispatch
      // worker functions without one.
      if (!report.trial_id) {
        customers.push(report);
        continue;
      }

      // ── 3b. Welcome fired?
      report.before.welcome = welcomeByTrialId.has(report.trial_id);
      if (!report.before.welcome) {
        if (dryRun) {
          report.actions.push("would_fire_welcome");
          actions.welcomes_sent++;
        } else {
          const r2 = await callWelcome(SUPA_URL, SR_KEY, report.trial_id);
          if (r2.ok) {
            report.actions.push("fired_welcome");
            actions.welcomes_sent++;
          } else {
            report.errors.push(`welcome: ${r2.error}`);
          }
        }
      }

      // ── 3c. MindBody (or Mariana Tek) account linked?
      const mbIdNow = (trial as any)?.mindbody_id ?? null;
      const mtIdNow = (trial as any)?.mariana_tek_id ?? null;
      report.before.mb = !!(mbIdNow || mtIdNow);
      if (!report.before.mb) {
        const useMt = dataSource === "mariana_tek";
        if (dryRun) {
          report.actions.push(useMt ? "would_link_mt" : "would_link_mb");
          actions.mb_accounts_linked++;
        } else {
          const r3 = await callCreateTrialClient(SUPA_URL, SR_KEY, report.trial_id, useMt);
          if (r3.ok) {
            report.actions.push(useMt ? "linked_mariana_tek" : "linked_mindbody");
            actions.mb_accounts_linked++;
          } else {
            report.errors.push(`${useMt ? "mariana_tek" : "mindbody"} link: ${r3.error}`);
          }
        }
      }

      // ── 3d. CAPI Purchase fired?
      const sessionId = (trial as any)?.stripe_session_id || r.stripe_payment_intent_id;
      const eventId = sessionId ? `trial_${sessionId}` : null;
      report.before.capi = !!(eventId && capiEventIds.has(eventId));
      if (!report.before.capi) {
        if (dryRun) {
          report.actions.push("would_fire_capi");
          actions.capi_events_fired++;
        } else {
          const r4 = await callMetaBackfill(SUPA_URL, SR_KEY, report.trial_id, r.paid_at);
          if (r4.ok) {
            report.actions.push("fired_capi");
            actions.capi_events_fired++;
          } else {
            report.errors.push(`capi: ${r4.error}`);
          }
        }
      }

      const beforeAllTrue = report.before.trial_row && report.before.welcome
        && report.before.mb && report.before.capi;
      if (beforeAllTrue) fullyReconciled++;
    } catch (e) {
      report.errors.push(`unexpected: ${(e as Error).message}`);
    }

    customers.push(report);
  }

  // ── 4. Heartbeat (best-effort; never throws).
  await writeHeartbeat(sb, mirrorRows.length, actions, null);

  return json({
    ok: true,
    dry_run: dryRun,
    lookback_days: lookbackDays,
    candidates_checked: mirrorRows.length,
    fully_reconciled: fullyReconciled,
    actions_taken: actions,
    debug: {
      trial_rows_in_map: trialsByEmail.size,
      sample_keys: Array.from(trialsByEmail.keys()).slice(0, 5),
      mirror_emails: emails.slice(0, 5),
    },
    customers,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyActions() {
  return {
    created_trial_rows: 0,
    welcomes_sent: 0,
    mb_accounts_linked: 0,
    capi_events_fired: 0,
  };
}

function uniqLower(arr: Array<string | null | undefined>): string[] {
  const s = new Set<string>();
  for (const v of arr) {
    const k = (v ?? "").toLowerCase().trim();
    if (k) s.add(k);
  }
  return Array.from(s);
}
function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function writeHeartbeat(
  sb: any,
  candidatesChecked: number,
  actionsTaken: ReturnType<typeof emptyActions>,
  errorText: string | null,
): Promise<void> {
  try {
    await sb.from("ops_reconcile_runs").insert({
      candidates_checked: candidatesChecked,
      actions_taken: actionsTaken,
      error: errorText,
    });
  } catch (e) {
    // Heartbeat write must never break the main run. Log only.
    console.error("ops_reconcile_runs insert failed:", (e as Error).message);
  }
}

async function callWelcome(
  supaUrl: string,
  serviceRoleKey: string,
  trialId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${supaUrl}/functions/v1/manual-welcome-batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "x-bbb-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({
        trial_ids: [trialId],
        send_owner_sms: false,   // reconcile fills gaps; no owner spam.
        dry_run: false,
      }),
    });
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status}: ${txt}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function callCreateTrialClient(
  supaUrl: string,
  serviceRoleKey: string,
  trialId: string,
  useMarianaTek: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const path = useMarianaTek
    ? "/functions/v1/mariana-tek-create-trial-client"
    : "/functions/v1/mindbody-create-trial-client";
  try {
    const res = await fetch(`${supaUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "x-bbb-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({ trial_signup_id: trialId }),
    });
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status}: ${txt}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function callMetaBackfill(
  supaUrl: string,
  serviceRoleKey: string,
  _trialId: string,
  paidAt: string,
): Promise<{ ok: boolean; error?: string }> {
  // meta-capi-backfill currently accepts since_hours OR explicit since cutoff.
  // We pass an explicit `since` set to 60s before the customer's paid_at so
  // the backfill picks up *just* this customer. The function itself walks
  // stripe_paid_mirror, joins trial_signups by email, dedupes on event_id,
  // then fires. trial_ids is not yet a supported param on backfill — see the
  // TODO below.
  //
  // TODO(stripe-reconcile): extend meta-capi-backfill to accept
  //   { trial_ids: [uuid], event: 'Purchase' } so we can target a single
  //   customer cleanly instead of a tight since window. Until then, narrow
  //   the window enough that this dispatch is effectively 1-event.
  const since = new Date(new Date(paidAt).getTime() - 60_000).toISOString();
  try {
    const res = await fetch(`${supaUrl}/functions/v1/meta-capi-backfill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "x-bbb-secret": ADMIN_SECRET,
      },
      body: JSON.stringify({
        since,
        event: "Purchase",
      }),
    });
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status}: ${txt}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
