// Supabase Edge Function: mt-verify-payments (2026-09-02)
// =====================================================================
// Payment verification, done right: verify against MARIANA TEK, the
// single source of truth every real customer ends up in — not Stripe
// account archaeology. Replaces the old classify_payment_verification
// behavior that stamped every real web buyer 'disputed' because it
// couldn't see the studios' current Stripe accounts.
//
// Proof ladder for a payment_status='completed' trial_signups row:
//   1. stripe_session_id present        → verified (our webhook set
//      'completed' only on a real checkout.session.completed event)
//   2. email or mariana_tek_id matches a PAID mariana_tek_sales row
//                                        → verified
//   3. mariana_tek_id has an ACTIVE/PENDING membership_instance in the
//      MT Admin API (live check via book-class probe)
//                                        → verified
//   4. none of the above                 → 'unverified' (report-only —
//      staff investigates; we do NOT auto-stamp 'disputed')
//
// Also HEALS rows the old classifier already mis-stamped: any disputed/
// unverified row that passes the ladder gets flipped back to verified
// on every run. Registered in sync-orchestrator so this self-corrects
// continuously.
//
// POST body: { days?: number (default 60), limit?: number (default 200),
//              dry_run?: boolean, live_mt_check?: boolean (default true) }
// Auth: x-bbb-secret. Deploy: bbb deploy-fn mt-verify-payments

// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_SECRET = Deno.env.get('BBB_ADMIN_SECRET') || 'bbb-test-2026-05-27';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bbb-secret, Authorization, Apikey, X-Client-Info',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function mtProbe(path: string): Promise<{ status: number; body?: any }> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/book-class`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bbb-secret': ADMIN_SECRET },
    body: JSON.stringify({ action: 'probe', method: 'GET', path }),
  });
  const b = await r.json().catch(() => ({}));
  return { status: Number(b?.mt_status ?? 0), body: b?.mt_body };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  const secretOk = req.headers.get('x-bbb-secret') === ADMIN_SECRET;
  const hasAuth = (req.headers.get('Authorization') || '').length > 0;
  if (!secretOk && !hasAuth) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const days = Math.min(Number(body.days) || 60, 365);
  const limit = Math.min(Number(body.limit) || 200, 500);
  const dryRun = body.dry_run === true;
  const liveMtCheck = body.live_mt_check !== false;

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const since = new Date(Date.now() - days * 864e5).toISOString();

  // Completed rows that are NOT already verified.
  const { data: rows, error } = await sb
    .from('trial_signups')
    .select('id, name, email, mariana_tek_id, stripe_session_id, verification_status, payment_date')
    .eq('payment_status', 'completed')
    .gte('payment_date', since)
    .or('verification_status.is.null,verification_status.in.(disputed,unverified,provisional)')
    .limit(limit);
  if (error) return json({ ok: false, error: error.message }, 500);

  const out = { checked: (rows ?? []).length, verified_stripe: 0, verified_mt_sale: 0, verified_mt_live: 0, left_unverified: 0, errors: [] as string[] };
  const unverifiedNames: string[] = [];

  for (const r of (rows ?? []) as any[]) {
    let proof: string | null = null;

    // 1. Our own Stripe webhook proof
    if (r.stripe_session_id) proof = 'stripe';

    // 2. Matched paid MT sale (synced table) by mt_id or email
    if (!proof) {
      const em = (r.email || '').toLowerCase();
      let q = sb.from('mariana_tek_sales').select('mt_sale_id').gt('total_cents', 0).limit(1);
      if (r.mariana_tek_id) {
        const { data } = await q.eq('customer_mt_id', String(r.mariana_tek_id));
        if (data && data.length) proof = 'mt_sale';
      }
      if (!proof && em) {
        const { data } = await sb.from('mariana_tek_sales').select('mt_sale_id').gt('total_cents', 0).eq('customer_email', em).limit(1);
        if (data && data.length) proof = 'mt_sale';
      }
    }

    // 3. Live MT membership check (the "FULL API ACCESS" path)
    if (!proof && liveMtCheck && r.mariana_tek_id) {
      try {
        const res = await mtProbe(`/api/membership_instances?user=${r.mariana_tek_id}`);
        const insts = res.body?.data ?? [];
        const active = insts.some((m: any) => {
          const s = String(m?.attributes?.status || '').toLowerCase();
          return s === 'active' || s === 'pending' || s === 'completed';
        });
        if (active) proof = 'mt_live';
      } catch (e) {
        out.errors.push(`mt probe ${r.name}: ${(e as Error).message}`);
      }
    }

    if (proof) {
      if (proof === 'stripe') out.verified_stripe++;
      else if (proof === 'mt_sale') out.verified_mt_sale++;
      else out.verified_mt_live++;
      if (!dryRun) {
        await sb.from('trial_signups').update({ verification_status: 'verified' }).eq('id', r.id);
      }
    } else {
      out.left_unverified++;
      unverifiedNames.push(r.name);
      // Report-only: stamp 'unverified' (NOT disputed) so the board shows a
      // quiet flag without demoting the card out of its column.
      if (!dryRun && r.verification_status !== 'unverified') {
        await sb.from('trial_signups').update({ verification_status: 'unverified' }).eq('id', r.id);
      }
    }
  }

  return json({ ok: true, dry_run: dryRun, days, ...out, unverified_names: unverifiedNames.slice(0, 20) });
});
