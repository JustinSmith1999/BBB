// ─────────────────────────────────────────────────────────────────────────────
// sheet-sync — multi-studio activity-sheet sync.
//
// Fetches the Publish-to-web CSV for each studio's tracking sheet and upserts
// every prospect row into public.staff_sheet_entries. Designed for hourly
// cron. Per-studio parsers handle the different sheet formats:
//   • Astoria + Williamsburg — Chris's STRAT format (banner + labels row,
//     17 columns including "Type Membership Sold" and dollar value)
//   • Fresh Meadows + Bayside — Devonte's tracking format (labels row 0,
//     12-13 columns including "JOINED Y/N" + "JOINED DATE")
//
// Each run REPLACES rows for the studio being synced — Chris/Devonte edit
// the sheets daily, so deletes happen naturally and we want the source of
// truth to be the sheet content right now.
// ─────────────────────────────────────────────────────────────────────────────
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SHEET_URLS: Record<string, string> = {
  astoria:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vSxRFR6qxC49rg5nRUNgKCiCO6r6rpIikF-vuwPO2mwM-yXI4NUOqzYszQTQM9-qogCkNBhyTezuExl/pub?output=csv",
  williamsburg:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vS6rPe9uR-M4EHAakjtdTCSfpyf3HAxdER-zOxORMp7nT8nictIBmn-qn3u_PYu-i5S9l7Ry3fPmjsn/pub?output=csv",
  "fresh-meadows":
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTAfB97zzshCXvTNR_2mlhmLsdmzoLnn8Fulh2PGuokiI2o4C2LbPMOXh5kPIUJMkeissYhzohMTLaY/pub?output=csv",
  bayside:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTfzp85ICQudQCqKpaQRQKJDHmjHtufWp-Fa3Ln1K08FNg7w4BB17cPulOHjQJhp45U9ksEf3UKZ_TB/pub?output=csv",
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── CSV parser (handles quoted fields with embedded commas/newlines) ────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cur.push(field); field = ""; }
      else if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (ch === "\r") {/* skip */}
      else field += ch;
    }
  }
  if (field !== "" || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

function parseDate(s: string): string | null {
  const t = (s || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mo, d, y] = m;
  let year = parseInt(y);
  if (year < 100) year += 2000;
  const month = parseInt(mo).toString().padStart(2, "0");
  const day = parseInt(d).toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseUsd(s: string): number | null {
  const t = (s || "").trim().replace(/[$,]/g, "");
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function parseBool(s: string): boolean | null {
  const t = (s || "").trim().toUpperCase();
  if (t === "TRUE" || t === "Y" || t === "YES") return true;
  if (t === "FALSE" || t === "N" || t === "NO") return false;
  return null;
}

interface SheetRow {
  studio_slug: string;
  start_date: string | null;
  end_date: string | null;
  prospect_name: string | null;
  phone: string | null;
  email: string | null;
  visit_type: string | null;
  referral_source: string | null;
  joined: boolean | null;
  joined_date: string | null;
  membership_sold: string | null;
  membership_value_usd: number | null;
  staff_member: string | null;
  notes: string | null;
  contract_signed: boolean | null;
  raw: Record<string, unknown>;
  fetched_at: string;
}

// ─── Per-studio parsers ─────────────────────────────────────────────────────
function parseStratFormat(studio: string, rows: string[][]): SheetRow[] {
  // Astoria + Williamsburg — Chris's STRAT layout
  // Row 0 = section banner ("STRAT Schedule, , STRAT conducted, ...")
  // Row 1 = column labels
  // Row 2+ = data
  if (rows.length < 3) return [];
  const header = rows[1].map((s) => (s || "").trim());
  const idx = (name: string) =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const colStart = idx("Start Date");
  const colEnd = idx("End Date");
  const colName = idx("Prospect Name");
  const colPhone = idx("Phone Number");
  const colVisit = idx("Visit Type");
  const colReferral = idx("Referral Source");
  const colContact = idx("1st Contact");
  const colMembershipSold = idx("Type Membership Sold");
  const colValue = idx("Membership Overall Value");
  const colNotes = idx("STRAT Notes");
  const colContractSigned = idx("Contract Signed");

  const out: SheetRow[] = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const startDate = colStart >= 0 ? parseDate(r[colStart]) : null;
    const name = colName >= 0 ? (r[colName] || "").trim() : "";
    const phone = colPhone >= 0 ? (r[colPhone] || "").trim() : "";
    if (!startDate && !name && !phone) continue;
    const sold = colMembershipSold >= 0 ? (r[colMembershipSold] || "").trim() : "";
    const contractSigned = colContractSigned >= 0 ? parseBool(r[colContractSigned]) : null;
    out.push({
      studio_slug: studio,
      start_date: startDate,
      end_date: colEnd >= 0 ? parseDate(r[colEnd]) : null,
      prospect_name: name || null,
      phone: phone || null,
      email: null, // STRAT sheet has no email column
      visit_type: colVisit >= 0 ? (r[colVisit] || "").trim() || null : null,
      referral_source: colReferral >= 0 ? (r[colReferral] || "").trim() || null : null,
      // joined = ONLY true if contract was actually signed.
      // Type-sold-without-signature is a lead, not a customer.
      joined: contractSigned === true,
      joined_date: null,
      membership_sold: sold || null,
      membership_value_usd: colValue >= 0 ? parseUsd(r[colValue]) : null,
      staff_member: colContact >= 0 ? (r[colContact] || "").trim() || null : null,
      notes: colNotes >= 0 ? (r[colNotes] || "").trim() || null : null,
      contract_signed: contractSigned,
      raw: { row_index: i, format: "strat", csv_row: r },
      fetched_at: new Date().toISOString(),
    });
  }
  return out;
}

function parseDevonteFormat(studio: string, rows: string[][]): SheetRow[] {
  // Fresh Meadows + Bayside — Devonte's tracking layout
  // Row 0 = column labels
  // Row 1+ = data
  // Columns: NAME, PHONE, EMAIL, TRIAL TYPE, START DATE, END DATE,
  //          [TRAINER or CONTACT DATE], CONTACT DATE/TRAINER, JOINED Y/N,
  //          JOINED DATE, REASON FOR NOT JOINING, FOLLOW UP, NOTES
  if (rows.length < 2) return [];
  const header = rows[0].map((s) => (s || "").trim());
  const idx = (re: RegExp) => header.findIndex((h) => re.test(h));

  const colName = idx(/name/i);
  const colPhone = idx(/phone/i);
  const colEmail = idx(/email/i);
  const colTrialType = idx(/trial type/i);
  const colStart = idx(/start date/i);
  const colEnd = idx(/end date/i);
  const colTrainer = idx(/trainer/i);
  const colContact = idx(/contact date/i);
  const colJoinedYN = idx(/joined y\/n/i);
  const colJoinedDate = idx(/joined date/i);
  const colReason = idx(/reason for not joining/i);
  const colNotes = idx(/notes/i);

  const out: SheetRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    let name = colName >= 0 ? (r[colName] || "").trim() : "";
    // FM has "Last, First" — flip it
    if (studio === "fresh-meadows" && name.includes(",")) {
      const parts = name.split(",").map((s) => s.trim());
      if (parts.length === 2) name = `${parts[1]} ${parts[0]}`;
    }
    const startDate = colStart >= 0 ? parseDate(r[colStart]) : null;
    const phone = colPhone >= 0 ? (r[colPhone] || "").trim() : "";
    if (!startDate && !name && !phone) continue;
    const joinedYN = colJoinedYN >= 0 ? parseBool(r[colJoinedYN]) : null;
    out.push({
      studio_slug: studio,
      start_date: startDate,
      end_date: colEnd >= 0 ? parseDate(r[colEnd]) : null,
      prospect_name: name || null,
      phone: phone || null,
      email: colEmail >= 0 ? (r[colEmail] || "").trim() || null : null,
      visit_type: colTrialType >= 0 ? (r[colTrialType] || "").trim() || null : null,
      referral_source: null,
      joined: joinedYN,
      joined_date: colJoinedDate >= 0 ? parseDate(r[colJoinedDate]) : null,
      membership_sold: joinedYN === true ? "Joined" : null,
      membership_value_usd: null,
      staff_member: colTrainer >= 0 ? (r[colTrainer] || "").trim() || null : null,
      notes: colNotes >= 0 ? (r[colNotes] || "").trim() || null : null,
      contract_signed: joinedYN, // Devonte format: Joined Y/N implies contract signed
      raw: { row_index: i, format: "devonte", csv_row: r },
      fetched_at: new Date().toISOString(),
    });
  }
  return out;
}

const PARSERS: Record<string, (studio: string, rows: string[][]) => SheetRow[]> = {
  astoria: parseStratFormat,
  williamsburg: parseStratFormat,
  "fresh-meadows": parseDevonteFormat,
  bayside: parseDevonteFormat,
};

// ─── Sync a single studio ───────────────────────────────────────────────────
async function syncStudio(sb: any, studio: string) {
  const url = SHEET_URLS[studio];
  if (!url) throw new Error(`no sheet URL for ${studio}`);
  const parser = PARSERS[studio];
  if (!parser) throw new Error(`no parser for ${studio}`);

  const t0 = Date.now();
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  const csv = await res.text();
  const rows = parseCsv(csv);
  const entries = parser(studio, rows);

  // Wipe + reinsert this studio's rows
  const { error: delErr } = await sb
    .from("staff_sheet_entries")
    .delete()
    .eq("studio_slug", studio);
  if (delErr) throw new Error(`delete failed: ${delErr.message}`);

  let inserted = 0;
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    const { error } = await sb.from("staff_sheet_entries").insert(batch);
    if (error) throw new Error(`insert failed: ${error.message}`);
    inserted += batch.length;
  }
  return {
    studio,
    csv_rows: rows.length,
    parsed: entries.length,
    inserted,
    ms: Date.now() - t0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const body = await req.json().catch(() => ({}));
    const targets: string[] = body.studio_slug
      ? [String(body.studio_slug)]
      : Object.keys(SHEET_URLS);

    const results: any[] = [];
    for (const s of targets) {
      try { results.push(await syncStudio(sb, s)); }
      catch (e) { results.push({ studio: s, ok: false, error: (e as Error).message }); }
    }

    return new Response(JSON.stringify({ ok: true, results }, null, 2), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
