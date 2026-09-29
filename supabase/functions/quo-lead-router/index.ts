// quo-lead-router — the ONE place a new lead / trial / membership becomes a
// per-customer item in Quo, instead of a text blasted into the shared relay
// thread (+1 877-286-0293) where staff replies bounce with "Could not tell who
// this reply is for."
//
// For each event it:
//   1. upserts a NAMED Quo contact on the studio line (number resolves to the
//      person → one-tap call/text lands in THEIR own conversation), and
//   2. creates a Quo TASK on that studio line ("<Name> · NEW TRIAL", desc =
//      phone/email/context/next-action). Staff work it from the Tasks tab and
//      reply straight to the customer — no shared thread, no bounce.
//
// It sends NO message to the customer (staff reach out themselves — the
// standing "no auto-text" rule). Bayside + Fresh Meadows only (the studios on
// Quo); Astoria/Williamsburg return {skipped:"not on quo"} so callers keep
// their existing email/owner path for those two.
//
// Call (fire-and-forget) from any emitter, header x-bbb-secret:
//   POST { name, phone, email, studio_slug, kind, note }
//     kind: "inquiry" | "trial" | "membership"   (default "inquiry")
//   {"dry_run":true, ...}  -> validate + echo the contact/task it WOULD create
//
// Needs QUO_API_KEY.  Deploy: bbb deploy-fn quo-lead-router

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Studio → Quo phone-number id (the line the contact + task live on). Only the
// studios live on Quo. Accepts the common slug spellings callers use.
const STUDIO: Record<string, { pn: string; label: string }> = {
  "bayside":        { pn: "PN53tm8BYn", label: "Bayside" },
  "fresh-meadows":  { pn: "PNrbRXue3z", label: "Fresh Meadows" },
  "freshmeadows":   { pn: "PNrbRXue3z", label: "Fresh Meadows" },
  "fresh_meadows":  { pn: "PNrbRXue3z", label: "Fresh Meadows" },
};
const TAG: Record<string, string>     = { inquiry: "NEW LEAD", trial: "NEW TRIAL", membership: "NEW MEMBER" };
const COMPANY: Record<string, string> = { inquiry: "Website Lead", trial: "Paid Trial", membership: "New Member" };
const CUE: Record<string, string>     = {
  inquiry: "Call today — website inquiry, wants info.",
  trial: "Call today to book class 1.",
  membership: "Welcome call — new membership.",
};

const digits = (p: string) => (p || "").replace(/\D/g, "");
function toE164(p: string): string | null {
  const d = digits(p);
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
async function quoPost(path: string, body: unknown, key: string): Promise<{ ok: boolean; id?: string; status: number; error?: string }> {
  const r = await fetch(`https://api.quo.com/v1/${path}`, {
    method: "POST",
    headers: { "Authorization": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, status: r.status, id: (j as any)?.data?.id || (j as any)?.data?.taskId };
  return { ok: false, status: r.status, error: (j as any)?.message || `HTTP ${r.status}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if ((req.headers.get("x-bbb-secret") || "") !== ADMIN_SECRET) return json({ ok: false, error: "bad secret" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const dryRun = body.dry_run === true;
  const rawSlug = String(body.studio_slug ?? "").trim().toLowerCase();
  const studio = STUDIO[rawSlug];
  // Not on Quo (Astoria / Williamsburg): tell the caller so it keeps its old path.
  if (!studio) return json({ ok: true, skipped: "not on quo", studio_slug: rawSlug });

  const e164 = toE164(String(body.phone ?? ""));
  if (!e164) return json({ ok: false, error: "valid phone required" }, 400);

  const kind = ["inquiry", "trial", "membership"].includes(String(body.kind)) ? String(body.kind) : "inquiry";
  const nm = String(body.name ?? "").trim().split(/\s+/);
  const first = nm[0] || (kind === "trial" ? "Trial" : "Website");
  const last = nm.slice(1).join(" ") || (kind === "membership" ? "Member" : "Lead");
  const email = String(body.email ?? "").trim() || null;
  const note = String(body.note ?? "").trim().replace(/\s+/g, " ");

  const title = `${first} ${last}`.trim() + ` · ${TAG[kind]}`;
  const desc = [
    `📞 ${e164}`,
    email ? `✉️ ${email}` : "",
    `📍 ${studio.label}`,
    "",
    note ? `Note: ${note.slice(0, 200)}` : "",
    CUE[kind],
    "",
    "Tap the number to call/text them here, then check this off when contacted.",
  ].filter((l) => l !== "").join("\n");

  if (dryRun) {
    return json({ ok: true, dry_run: true, studio: studio.label, would_create: { contact: `${first} ${last}`, phone: e164, task_title: title, description: desc } });
  }

  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ ok: false, error: "QUO_API_KEY not set" }, 400);

  // 1) named contact so the number resolves to the person (one-tap call/text).
  const contact = await quoPost("contacts", {
    defaultFields: {
      firstName: first, lastName: last,
      company: `${COMPANY[kind]} · ${studio.label}`,
      phoneNumbers: [{ name: "mobile", value: e164 }],
      ...(email ? { emails: [{ name: "email", value: email }] } : {}),
    },
    source: `lead-${kind}`,
  }, key);

  // 2) the task on the studio line (this is the "alert" staff act on).
  const task = await quoPost("tasks", { title, description: desc, phoneNumberId: studio.pn }, key);

  if (!task.ok) return json({ ok: false, error: `task create failed: ${task.error}`, contact_ok: contact.ok }, 502);
  return json({ ok: true, studio: studio.label, kind, task_id: task.id ?? null, contact_ok: contact.ok });
});
