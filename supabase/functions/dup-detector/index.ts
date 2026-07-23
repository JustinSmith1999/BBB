/**
 * dup-detector — catches duplicate (location_id, lower(email)) groups in
 * trial_signups + reports any recent constraint-violation errors from the
 * new unique partial index added in
 * 20260624_trial_signups_unique_email_per_studio.sql.
 *
 * Built 2026-06-24 alongside stripe-reconcile (task #427). The unique index
 * is the structural fix — but a row that slipped in BEFORE the index ships
 * still pollutes the system, and a function that fails on insert because of
 * the constraint silently swallows the error in many code paths. This is the
 * watchdog: it surfaces both classes of problem so they show up on /ops and
 * in the daily ops digest instead of in Justin's mental queue.
 *
 * REQUEST:
 *   POST /functions/v1/dup-detector
 *   { "lookback_hours": 24 }   // default 24; affects constraint-violation
 *                              // count, not the dup-group scan (groups are
 *                              // checked across all non-deleted rows since
 *                              // they're a structural problem regardless of
 *                              // when the duplicate was created).
 *
 * AUTH: x-bbb-secret header.
 *
 * WORK:
 *   1. SELECT lower(email), location_id, count(*) FROM trial_signups
 *      WHERE deleted_at IS NULL
 *      GROUP BY 1,2 HAVING count(*) > 1
 *   2. For each dup group, capture the row IDs.
 *   3. UPSERT findings into ops_dup_detections (PK: hash of
 *      email+location_id; ON CONFLICT (email, location_id) DO UPDATE).
 *   4. Count constraint violations in the lookback window — TODO until log
 *      access lands; for now we return 0 and leave the slot in the response
 *      shape so /ops + digest don't have to change later.
 *
 * RESPONSE:
 *   { ok: true,
 *     dup_groups_found: int,
 *     dup_groups: [{ email, studio, ids, group_size }],
 *     constraint_violations_24h: int }
 *
 * HEARTBEAT: row in ops_dup_detection_runs on every successful run. Same
 * silence-alarm story as stripe-reconcile.
 *
 * Deploy:
 *   supabase functions deploy dup-detector --no-verify-jwt \
 *     --project-ref uracuwugpxqjfgtuobal
 */

// deno-lint-ignore-file
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";

const DEFAULT_LOOKBACK_HOURS = 24;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });

interface DupRow {
  id: string;
  email: string;
  location_id: string;
  name: string | null;
  created_at: string;
  payment_status: string | null;
}

interface DupGroupOut {
  email: string;
  studio: string;
  ids: string[];
  group_size: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch {}

  const lookbackRaw = Number(body?.lookback_hours);
  const lookbackHours = Number.isFinite(lookbackRaw) && lookbackRaw > 0
    ? Math.floor(lookbackRaw)
    : DEFAULT_LOOKBACK_HOURS;

  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SR_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPA_URL || !SR_KEY) {
    return json({ ok: false, error: "supabase env missing" }, 500);
  }
  const sb = createClient(SUPA_URL, SR_KEY);

  // ── 1. Load all non-deleted trial_signups in batches, group by
  //    (lower(email), location_id). Supabase JS doesn't expose raw SQL
  //    GROUP BY — easiest cross-version path is to pull the small column set
  //    and aggregate in JS. trial_signups is ~hundreds of rows, not millions.
  //
  //    NOTE: if trial_signups grows past ~50k rows this should move to a
  //    SECURITY DEFINER RPC. For now (June 2026, ~250 rows total), JS-side
  //    aggregation is fine.
  const allRows: DupRow[] = [];
  const PAGE = 1000;
  let start = 0;
  // Safety cap: 10 pages = 10k rows. Plenty of headroom.
  for (let i = 0; i < 10; i++) {
    const { data, error } = await sb
      .from("trial_signups")
      .select("id, email, location_id, name, created_at, payment_status")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .range(start, start + PAGE - 1);
    if (error) {
      await writeHeartbeat(sb, 0, `query failed: ${error.message}`);
      return json({ ok: false, error: `query failed: ${error.message}` }, 500);
    }
    if (!data || data.length === 0) break;
    allRows.push(...(data as DupRow[]));
    if (data.length < PAGE) break;
    start += PAGE;
  }

  // Group by (lower(email), location_id). Skip rows with empty email — those
  // are synthetic mirror inserts where the dup test is meaningless.
  const groups = new Map<string, DupRow[]>();
  for (const r of allRows) {
    const email = (r.email || "").toLowerCase().trim();
    const loc = r.location_id || "";
    if (!email || !loc) continue;
    const k = `${loc}|${email}`;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  // ── 2. Build dup-group output + collect for upsert into ops_dup_detections.
  const studioNameById = await loadStudioNames(sb);

  const dupGroups: DupGroupOut[] = [];
  const upsertPayloads: any[] = [];
  for (const [k, rows] of groups) {
    if (rows.length < 2) continue;
    const [locationId, email] = splitKey(k);
    const ids = rows.map((r) => r.id);
    const studio = studioNameById.get(locationId) || locationId;
    dupGroups.push({ email, studio, ids, group_size: rows.length });
    upsertPayloads.push({
      email,
      location_id: locationId,
      row_ids: ids,
      group_size: rows.length,
      detected_at: new Date().toISOString(),
    });
  }

  // ── 3. UPSERT into ops_dup_detections so each (email, location_id) gets one
  //    row that tracks current state. ON CONFLICT updates group_size + row_ids
  //    + detected_at so the table reflects the latest scan.
  if (upsertPayloads.length) {
    const { error } = await sb
      .from("ops_dup_detections")
      .upsert(upsertPayloads, {
        onConflict: "email,location_id",
        ignoreDuplicates: false,
      });
    if (error) {
      // Don't blow up — surface the issue but still return the scan results.
      console.error("ops_dup_detections upsert failed:", error.message);
    }
  }

  // ── 4. Constraint-violation count over the lookback window.
  //    TODO(dup-detector): once Supabase function-log access is wired into
  //    this project (probably via the log-ingest connector), search for the
  //    Postgres error string '23505' / 'trial_signups_unique_email_per_studio'
  //    in the last `lookbackHours` and count distinct events. For now we
  //    return 0 so the response shape is stable.
  const constraintViolations = 0;

  // ── 5. Heartbeat (never throws).
  await writeHeartbeat(sb, dupGroups.length, null);

  return json({
    ok: true,
    lookback_hours: lookbackHours,
    dup_groups_found: dupGroups.length,
    dup_groups: dupGroups,
    constraint_violations_24h: constraintViolations,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function splitKey(k: string): [string, string] {
  const idx = k.indexOf("|");
  if (idx < 0) return [k, ""];
  return [k.slice(0, idx), k.slice(idx + 1)];
}

async function loadStudioNames(sb: any): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { data } = await sb.from("locations").select("id, name");
    for (const l of data ?? []) {
      const slug = ((l as any).name || "").toLowerCase().replace(/\s+/g, "-");
      out.set((l as any).id, slug || (l as any).id);
    }
  } catch (e) {
    console.error("loadStudioNames failed:", (e as Error).message);
  }
  return out;
}

async function writeHeartbeat(
  sb: any,
  dupGroupsFound: number,
  errorText: string | null,
): Promise<void> {
  try {
    await sb.from("ops_dup_detection_runs").insert({
      dup_groups_found: dupGroupsFound,
      error: errorText,
    });
  } catch (e) {
    console.error("ops_dup_detection_runs insert failed:", (e as Error).message);
  }
}
