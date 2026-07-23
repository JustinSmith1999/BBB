/**
 * mindbody-list-trial-products — discovery probe for the BBB Trial Pass.
 *
 * BBB runs ONE MindBody site with 4 locations (1=Williamsburg, 2=Astoria,
 * 3=Fresh Meadows, 6=Bayside).
 *
 * In MindBody, a "2-Week Trial Pass" is almost always a SERVICE (class pass /
 * intro pass), not a Product (which is retail like water bottles). Contracts
 * are recurring memberships. This probe queries all three and surfaces any
 * names matching /trial|2.?week|intro|new[-]?member/.
 *
 * Auth: source credentials (same as mindbody-sales-sync). Read-only.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bbb-secret",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const ADMIN_SECRET = Deno.env.get("BBB_ADMIN_SECRET") || "bbb-test-2026-05-27";
const MB_BASE = "https://api.mindbodyonline.com/public/v6";

const LOCATION_TO_SLUG: Record<number, string> = {
  1: "williamsburg",
  2: "astoria",
  3: "fresh-meadows",
  6: "bayside",
};

function mbHeaders(): Record<string, string> {
  const apiKey  = Deno.env.get("MINDBODY_API_KEY") ?? "";
  const siteId  = Deno.env.get("MINDBODY_SITE_ID") ?? "";
  const srcName = Deno.env.get("MINDBODY_SOURCE_NAME") ?? "";
  const srcPass = Deno.env.get("MINDBODY_SOURCE_PASSWORD") ?? "";
  if (!apiKey || !siteId) throw new Error("Missing MINDBODY_API_KEY or MINDBODY_SITE_ID");
  if (!srcName || !srcPass) throw new Error("Missing MINDBODY_SOURCE_NAME / MINDBODY_SOURCE_PASSWORD");
  return {
    "Api-Key": apiKey,
    "SiteId": siteId,
    "SourceCredentials": `${srcName}|${srcPass}`,
    "Content-Type": "application/json",
  };
}

async function mbGet(path: string): Promise<{ ok: boolean; status: number; data: any; text: string }> {
  const r = await fetch(`${MB_BASE}${path}`, { headers: mbHeaders() });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, data, text };
}

async function listAll(path: string, arrayKey: string, locationId?: number): Promise<{ items: any[]; status: number; error?: string }> {
  const out: any[] = [];
  let offset = 0;
  const limit = 200;
  let lastStatus = 0;
  for (let i = 0; i < 25; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const locFilter = locationId ? `&LocationId=${locationId}` : "";
    const full = `${path}${sep}Limit=${limit}&Offset=${offset}${locFilter}`;
    const { ok, status, data, text } = await mbGet(full);
    lastStatus = status;
    if (!ok) {
      return { items: out, status, error: `HTTP ${status}: ${text.slice(0, 200)}` };
    }
    const batch = (data?.[arrayKey] ?? []) as any[];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return { items: out, status: lastStatus };
}

const looksLikeTrial = (name: string) =>
  /trial|2[\s-]?week|intro|new[\s-]?member|first[\s-]?time|starter|welcome|kickstart/i.test(name);

function summarizeItem(it: any) {
  return {
    Id: it.Id ?? it.ProductId ?? it.ServiceId ?? it.ContractId ?? it.ProgramId,
    Name: it.Name ?? it.ProductName ?? it.ServiceName,
    Price: it.Price ?? it.OnlinePrice ?? it.ContractPrice,
    OnlinePrice: it.OnlinePrice,
    SellOnline: it.SellOnline ?? it.OnlineStoreItem,
    ProgramId: it.ProgramId,
    Type: it.Type,
    Count: it.Count,
    Description: String(it.Description ?? "").slice(0, 160),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const secret = req.headers.get("x-bbb-secret") || req.headers.get("X-Bbb-Secret");
  if (secret !== ADMIN_SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const result: any = { ok: true, by_location: {} };

  for (const [locIdStr, slug] of Object.entries(LOCATION_TO_SLUG)) {
    const locId = Number(locIdStr);
    const studio: any = { location_id: locId };
    try {
      // Services = class passes / intro packs / drop-ins / multi-class
      const services = await listAll("/sale/services", "Services", locId);
      // Products = retail (water bottles, t-shirts) — probably not the trial pass
      const products = await listAll("/sale/products", "Products", locId);
      // Contracts = recurring memberships
      const contracts = await listAll("/sale/contracts", "Contracts", locId);

      studio.counts = {
        services: services.items.length,
        products: products.items.length,
        contracts: contracts.items.length,
      };
      studio.api_status = {
        services: services.status, services_error: services.error,
        products: products.status, products_error: products.error,
        contracts: contracts.status, contracts_error: contracts.error,
      };

      studio.trial_candidates = {
        services: services.items.filter((i: any) => looksLikeTrial(String(i.Name ?? ""))).map(summarizeItem),
        products: products.items.filter((i: any) => looksLikeTrial(String(i.Name ?? ""))).map(summarizeItem),
        contracts: contracts.items.filter((i: any) => looksLikeTrial(String(i.Name ?? i.ContractName ?? ""))).map(summarizeItem),
      };

      // Surface sample names so you can eyeball if naming doesn't match the regex
      studio.sample_service_names = services.items.slice(0, 40).map(summarizeItem);
    } catch (e) {
      studio.error = (e as Error).message;
    }
    result.by_location[slug] = studio;
  }

  return json(result);
});
