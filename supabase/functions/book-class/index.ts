import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// book-class — native 1-tap class booking via the MT Admin API (2026-08-28).
//
// Kills the MT-widget login wall. Flow:
//   1. {action:"send_code", email}
//        → find MT user (Admin API), generate 6-digit code, SMS it to the
//          phone on their MT account (fallback: email via Resend). Code hash
//          stored in booking_codes, 10-min expiry, max 3 sends/hour/email.
//   2. {action:"book", email, class_session_id, code? , device_token?}
//        → verify code OR a previously-issued device_token, then create the
//          reservation as that user via POST /api/reservations. On success,
//          mint/refresh a device token (180d) so future bookings skip codes.
//   3. {action:"probe", ...} — x-bbb-secret gated; returns MT's raw response
//        for a reservation-create attempt. Used ONCE during integration to
//        discover the exact payload MT accepts, then leave for debugging.
//
// Auth to MT: MT_ADMIN_API_KEY (production bearer from Xplor/Joe, 2026-08-28)
// with fallback to the mt_oauth browser token row. Rate limits: MT allows
// 200 req/min; this function makes ≤3 MT calls per booking.
//
// Tables (supabase/migrations/20260828_booking_codes_devices.sql):
//   booking_codes(email, code_hash, expires_at, created_at)
//   booking_devices(token, email, mt_user_id, created_at, last_used_at)
//
// Deploy: bbb deploy-fn book-class
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "bbb-test-2026-05-27";
const MT_BASE = "https://betterbodybootcamp.marianatek.com";
const MT_ACCEPT = "application/vnd.api+json";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

function sb() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}

async function mtToken(client: ReturnType<typeof sb>): Promise<string | null> {
  const adminKey = Deno.env.get("MT_ADMIN_API_KEY");
  if (adminKey && adminKey.trim()) return adminKey.trim();
  try {
    const { data } = await client.from("mt_oauth").select("access_token").eq("id", "default").maybeSingle();
    return (data as { access_token?: string } | null)?.access_token || null;
  } catch { return null; }
}

async function mtGet(token: string, path: string) {
  const r = await fetch(`${MT_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}
async function mtPost(token: string, path: string, payload: unknown) {
  const r = await fetch(`${MT_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: MT_ACCEPT, "Content-Type": MT_ACCEPT },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function findMtUser(token: string, email: string): Promise<{ id: string; first: string; phone: string | null } | null> {
  const { status, body } = await mtGet(token, `/api/users?query=${encodeURIComponent(email)}&page_size=5`);
  if (status !== 200) return null;
  const hits = ((body as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> }).data ?? [])
    .filter((u) => String(u.attributes?.email || "").toLowerCase() === email);
  if (!hits.length) return null;
  const a = hits[0].attributes ?? {};
  return { id: hits[0].id, first: String(a.first_name || ""), phone: (a.phone_number as string) || null };
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskPhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  return d.length >= 4 ? `•••-•••-${d.slice(-4)}` : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
  const action = String(body.action || "");
  const client = sb();
  const token = await mtToken(client);
  if (!token) return json({ ok: false, error: "booking temporarily unavailable" }, 503);

  // ── probe (admin only): surface MT's raw response for integration work ────
  if (action === "probe") {
    if (req.headers.get("x-bbb-secret") !== ADMIN_SECRET) return json({ ok: false }, 401);
    const path = String(body.path || "/api/reservations");
    const method = String(body.method || "POST");
    const res = method === "GET" ? await mtGet(token, path) : await mtPost(token, path, body.payload ?? {});
    return json({ ok: true, mt_status: res.status, mt_body: res.body });
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "valid email required" }, 400);

  // ── send_code ─────────────────────────────────────────────────────────────
  if (action === "send_code") {
    // throttle: max 3 codes per hour per email
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await client.from("booking_codes")
      .select("*", { count: "exact", head: true })
      .eq("email", email).gte("created_at", hourAgo);
    if ((count ?? 0) >= 3) return json({ ok: false, error: "Too many codes requested. Try again in an hour." }, 429);

    const user = await findMtUser(token, email);
    if (!user) return json({ ok: false, error: "no_account" });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await client.from("booking_codes").insert({
      email, code_hash: await sha256(code),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    let channel: "sms" | "email" | null = null;
    const twSid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const twTok = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const twFrom = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
    if (user.phone && twSid && twTok && twFrom) {
      const digits = user.phone.replace(/\D/g, "");
      const to = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : null;
      if (to) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
          method: "POST",
          headers: { Authorization: "Basic " + btoa(`${twSid}:${twTok}`), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ From: twFrom, To: to, Body: `Better Body Bootcamp booking code: ${code}. Expires in 10 minutes.` }),
        });
        if (r.ok) channel = "sms";
      }
    }
    if (!channel) {
      const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
      if (resendKey) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("FROM_EMAIL") || "Better Body Bootcamp <hello@betterbodybootcamp.com>",
            to: [email],
            subject: `${code} is your Better Body booking code`,
            html: `<p style="font-family:Arial,sans-serif;font-size:16px">Your Better Body Bootcamp booking code is</p><p style="font-family:Arial,sans-serif;font-size:36px;font-weight:bold;letter-spacing:6px">${code}</p><p style="font-family:Arial,sans-serif;font-size:13px;color:#888">It expires in 10 minutes. If you didn't request this, ignore this email.</p>`,
          }),
        });
        if (r.ok) channel = "email";
      }
    }
    if (!channel) return json({ ok: false, error: "could not send code" }, 502);
    return json({ ok: true, sent: channel, phone_hint: channel === "sms" ? maskPhone(user.phone) : null, first: user.first });
  }

  // ── book ──────────────────────────────────────────────────────────────────
  if (action === "book") {
    const sessionId = String(body.class_session_id || "").trim();
    if (!sessionId) return json({ ok: false, error: "class_session_id required" }, 400);

    // verify: device token OR fresh code
    let verified = false;
    const deviceToken = typeof body.device_token === "string" ? body.device_token : null;
    if (deviceToken) {
      const { data } = await client.from("booking_devices")
        .select("token").eq("token", deviceToken).eq("email", email).maybeSingle();
      if (data) verified = true;
    }
    if (!verified && typeof body.code === "string" && /^\d{6}$/.test(body.code)) {
      const hash = await sha256(body.code);
      const { data } = await client.from("booking_codes")
        .select("email").eq("email", email).eq("code_hash", hash)
        .gte("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1);
      if (data && data.length) verified = true;
    }
    if (!verified) return json({ ok: false, error: "verification_required" }, 401);

    const user = await findMtUser(token, email);
    if (!user) return json({ ok: false, error: "no_account" });

    // ── 2026-08-28: THE 403 FIX (per Joe/Xplor + MT admin-app source) ────────
    // Reservation create requires the payment_options attribute, populated from
    // GET /api/payment_options for this user+session. Verified end-to-end on
    // Justin's account (reservation 372466 created 201 + cancelled).
    // Shape (from MT's own admin UI serializer):
    //   payment_options: [{ type, payment_option_id, count: 1 }]
    const po = await mtGet(token, `/api/payment_options?class_session=${sessionId}&user=${user.id}`);
    const options = ((po.body as {
      data?: Array<{ attributes?: { payment_option_id?: number; payment_option_type?: string; is_active?: boolean; error_message?: string | null } }>;
    })?.data ?? []).filter((o) => o.attributes?.is_active !== false && !o.attributes?.error_message);
    if (po.status !== 200) {
      console.error("book-class payment_options failed", po.status, JSON.stringify(po.body).slice(0, 300));
      return json({ ok: false, error: "Could not check your account's credits. Try again in a minute." });
    }
    if (!options.length) {
      // No active membership, trial, or credits usable for this class.
      return json({ ok: false, error: "no_payment_option" });
    }
    const best = options[0].attributes!;
    const res = await mtPost(token, "/api/reservations", {
      data: {
        type: "reservations",
        attributes: {
          reservation_type: "standard",
          payment_options: [{ type: best.payment_option_type, payment_option_id: best.payment_option_id, count: 1 }],
        },
        relationships: {
          user: { data: { type: "users", id: user.id } },
          class_session: { data: { type: "class_sessions", id: sessionId } },
        },
      },
    });

    if (res.status === 201 || res.status === 200) {
      // mint/refresh device token so next booking is instant
      let newToken = deviceToken;
      if (!newToken) {
        newToken = crypto.randomUUID();
        await client.from("booking_devices").insert({ token: newToken, email, mt_user_id: user.id });
      } else {
        await client.from("booking_devices").update({ last_used_at: new Date().toISOString() }).eq("token", newToken);
      }
      const rid = (res.body as { data?: { id?: string } })?.data?.id ?? null;
      return json({ ok: true, booked: true, reservation_id: rid, device_token: newToken, first: user.first });
    }

    // Surface a friendly version of MT's rejection (full / no credits / etc.)
    const raw = JSON.stringify(res.body).slice(0, 500);
    let friendly = "Could not complete the booking.";
    if (/full|capacity/i.test(raw)) friendly = "That class just filled up.";
    else if (/credit|payment|no eligible/i.test(raw)) friendly = "No eligible credits or membership on this account — grab a trial or ask the front desk.";
    else if (/already|duplicate/i.test(raw)) friendly = "You're already booked into this class.";
    console.error("book-class MT reject", res.status, raw);
    return json({ ok: false, error: friendly, mt_status: res.status });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
