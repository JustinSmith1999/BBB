// Supabase Edge Function: vapi-calls-sync
//
// Pulls calls from the Vapi REST API for every assistant in `vapi_assistants`
// and upserts them into `calls` keyed by `vapi_call_id`. Designed to run
// every 15 minutes via pg_cron.
//
// POST body (optional):
//   { studio_slug?: string,     // run for one studio (default: all active)
//     window_hours?: number,    // pull calls created in last N hours (default 72)
//     dry_run?: boolean }       // log results, don't write
//
// Required secrets:
//   VAPI_API_KEY                — Vapi private (workspace) key

// deno-lint-ignore-file
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

type Assistant = { assistant_id: string; studio_slug: string; display_name: string };

interface VapiCall {
  id: string;
  assistantId?: string;
  type?: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt?: string;
  cost?: number;
  customer?: { number?: string; name?: string };
  phoneNumber?: { number?: string };
  summary?: string;
  analysis?: { summary?: string; successEvaluation?: unknown };
  transcript?: string;
  recordingUrl?: string;
}

function mapDirection(t: string | undefined): string {
  if (!t) return 'inbound';
  if (t.startsWith('outbound') || t === 'webCall') return 'outbound';
  return 'inbound';
}

function durationSeconds(c: VapiCall): number {
  if (!c.startedAt || !c.endedAt) return 0;
  const ms = new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime();
  return Math.max(0, Math.round(ms / 1000));
}

async function fetchCallsForAssistant(
  apiKey: string,
  assistantId: string,
  createdAtGt: string
): Promise<{ calls: VapiCall[]; status: number; error?: string }> {
  const url = new URL('https://api.vapi.ai/call');
  url.searchParams.set('assistantId', assistantId);
  url.searchParams.set('limit', '100');
  url.searchParams.set('createdAtGt', createdAtGt);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) {
    const txt = await r.text();
    return { calls: [], status: r.status, error: txt.slice(0, 300) };
  }
  const data = await r.json();
  // Fix #15: Vapi has shipped both bare-array and {data: [...]} shapes over
  // time. Handle both and log loudly when the shape changes so we catch
  // future envelope shifts before they silently zero-out our dashboards.
  let calls: any[] = [];
  if (Array.isArray(data)) {
    calls = data;
  } else if (Array.isArray((data as any)?.data)) {
    calls = (data as any).data;
  } else if (Array.isArray((data as any)?.results)) {
    calls = (data as any).results;
  } else {
    console.warn(
      `Vapi response unexpected shape for assistant ${assistantId}; sample:`,
      JSON.stringify(data).slice(0, 300),
    );
  }
  return { calls, status: 200 };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const body: { studio_slug?: string; window_hours?: number; dry_run?: boolean } =
    req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const windowHours = Math.max(1, Math.min(720, Number(body.window_hours ?? 72)));
  const dryRun = !!body.dry_run;

  const apiKey = Deno.env.get('VAPI_API_KEY') ?? '';
  if (!apiKey) return json({ ok: false, error: 'VAPI_API_KEY secret not set' }, 500);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  let q = sb.from('vapi_assistants').select('assistant_id, studio_slug, display_name').eq('active', true);
  if (body.studio_slug) q = q.eq('studio_slug', body.studio_slug);
  const { data: assistants, error: aerr } = await q;
  if (aerr) return json({ ok: false, error: aerr.message }, 500);
  if (!assistants || assistants.length === 0) {
    return json({ ok: true, note: 'no active assistants', studios: [] });
  }

  const createdAtGt = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const results: Record<string, unknown>[] = [];

  for (const a of assistants as Assistant[]) {
    const r: Record<string, unknown> = {
      studio: a.studio_slug,
      assistant: a.display_name,
      window_hours: windowHours,
      vapi_status: null as number | null,
      calls_returned: 0,
      calls_upserted: 0,
      error: null as string | null,
    };

    try {
      const { calls, status, error } = await fetchCallsForAssistant(apiKey, a.assistant_id, createdAtGt);
      r.vapi_status = status;
      r.calls_returned = calls.length;
      if (error) { r.error = error; results.push(r); continue; }

      if (!dryRun && calls.length > 0) {
        const rows = calls.map((c) => {
          const direction = mapDirection(c.type);
          const fromNumber = direction === 'inbound' ? (c.customer?.number ?? null) : (c.phoneNumber?.number ?? null);
          const toNumber   = direction === 'inbound' ? (c.phoneNumber?.number ?? null) : (c.customer?.number ?? null);
          return {
            vapi_call_id: c.id,
            studio_slug: a.studio_slug,
            direction,
            summary: c.analysis?.summary ?? c.summary ?? null,
            cost_cents: c.cost ? Math.round(c.cost * 100) : 0,
            raw_payload: {
              vapi: c,
              meta: {
                assistant_id: a.assistant_id,
                from_number: fromNumber,
                to_number: toNumber,
                duration_seconds: durationSeconds(c),
                status: c.status ?? null,
                ended_reason: c.endedReason ?? null,
                started_at: c.startedAt ?? null,
                ended_at: c.endedAt ?? null,
                recording_url: c.recordingUrl ?? null,
              },
            },
          };
        });
        const { error: upErr, count } = await sb
          .from('calls')
          .upsert(rows, { onConflict: 'vapi_call_id', count: 'exact' });
        if (upErr) throw new Error(upErr.message);
        r.calls_upserted = count ?? rows.length;
      } else if (dryRun) {
        r.dry_run_sample = calls.slice(0, 1).map((c) => ({
          id: c.id,
          type: c.type,
          status: c.status,
          startedAt: c.startedAt,
          endedAt: c.endedAt,
          duration_s: durationSeconds(c),
          cost: c.cost,
          summary: (c.analysis?.summary ?? c.summary ?? '').slice(0, 200),
          customer: c.customer?.number,
        }));
      }
    } catch (e) {
      r.error = String((e as Error).message ?? e);
    }
    results.push(r);
  }

  return json({
    ok: true,
    window_hours: windowHours,
    assistants_processed: results.length,
    studios: results,
  });
});
