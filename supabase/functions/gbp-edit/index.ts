// Supabase Edge Function: gbp-edit
//
// WRITE side of the GBP integration. Pushes edits to Google Business Profile
// without ever opening a browser. Pairs with gbp-sync (read-only metrics) —
// same OAuth client + same scope, just different REST endpoints.
//
// Built specifically to kill the "Google's Edit-profile modal is bot-hostile"
// problem we hit driving Chrome MCP: the modal times out document_idle every
// session. The official API has no such issue.
//
// OPERATIONS SUPPORTED:
//   update_description  → PATCH location.profile.description (750-char limit)
//   update_categories   → PATCH location.categories (primary + 9 secondary)
//   update_services     → PATCH location.serviceItems (free-form service items)
//   create_post         → POST localPost (Google Posts / "What's new") — V4 API
//                         NOTE: V4 deprecated but Local Posts has no V1 replacement
//   ask_and_answer_qa   → POST a question + upsert its owner answer (Q&A API)
//   set_owner_response  → PATCH a review's owner response (review reply)
//
// AUTH: Reuses GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN secrets
// from gbp-sync. Same scope `business.manage` grants read AND write — so once
// the OAuth Playground exchange is done (one time), this function can edit.
//
// PER-LOCATION OWNERS: locations.gbp_refresh_token can override the env var
// per-row, because each studio is owned by a different Google account
// (Carlos for Astoria, Devonte/Salim for Fresh Meadows, Justin for Bayside +
// Williamsburg). Each owner does their own OAuth Playground exchange once,
// pastes their refresh token into locations.gbp_refresh_token — done.
//
// USAGE (single op):
//   POST { studio_slug: "bayside", op: "update_description",
//          description: "<745-char description text>" }
//
// USAGE (multi-op, atomic-ish):
//   POST { studio_slug: "bayside",
//          ops: [
//            { op: "update_description", description: "..." },
//            { op: "update_categories", primary: "gym", additional: [...] },
//            { op: "update_services",   services: [{ displayName: "..." }] },
//            { op: "create_post",       title: "...", body: "...", cta_url: "..." }
//          ] }
//
// USAGE (all-studios bulk):
//   POST { studios: ["bayside","astoria","fresh-meadows"],
//          ops: [...]    // applied to each in sequence
//   }
//
// API DOCS:
//   Location PATCH:
//     https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/patch
//   Local Posts (V4 — still alive):
//     https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
//   Q&A:
//     https://developers.google.com/my-business/reference/qanda/rest/v1/locations.questions/create
//     https://developers.google.com/my-business/reference/qanda/rest/v1/locations.questions.answers/upsert
//
// DEPLOY:
//   supabase functions deploy gbp-edit --no-verify-jwt --project-ref uracuwugpxqjfgtuobal

// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ─────────────────────────────────────────────────────────────────────────────
// OAuth — shared with gbp-sync. Cache access tokens per refresh token within
// a single function invocation.
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessToken(refreshTokenOverride?: string | null): Promise<string> {
  const clientId     = Deno.env.get("GBP_CLIENT_ID")     ?? "";
  const clientSecret = Deno.env.get("GBP_CLIENT_SECRET") ?? "";
  const refreshToken = refreshTokenOverride && refreshTokenOverride.trim() !== ""
    ? refreshTokenOverride
    : (Deno.env.get("GBP_REFRESH_TOKEN") ?? "");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GBP_CLIENT_ID / GBP_CLIENT_SECRET / refresh_token. " +
      "Use OAuth Playground → scope https://www.googleapis.com/auth/business.manage",
    );
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.access_token as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION PATCH — used by update_description, update_categories, update_services
//
// Endpoint: PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/{locationId}
// Required: updateMask query param listing exactly which fields to overwrite.
// ─────────────────────────────────────────────────────────────────────────────
async function patchLocation(
  accessToken: string,
  locationId: string,
  updateMask: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${locationId}?updateMask=${encodeURIComponent(updateMask)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const resBody = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`location PATCH ${updateMask} HTTP ${r.status}: ${JSON.stringify(resBody).slice(0, 500)}`);
  }
  return resBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORIES — secondary categories must be resolved from category ID strings.
// Most common BBB categories resolve to:
//   categories/gcid:gym                             → primary
//   categories/gcid:personal_trainer
//   categories/gcid:fitness_center
//   categories/gcid:physical_fitness_program
//   categories/gcid:boot_camp
//   categories/gcid:group_fitness_class
//   categories/gcid:strength_and_conditioning_training_gym
//   categories/gcid:weight_training_service
//   categories/gcid:wellness_center
//
// Anything else → call the categories API to search:
//   GET /v1/categories:search?filter=displayName=...&languageCode=en&regionCode=US
// ─────────────────────────────────────────────────────────────────────────────
function categoryRef(slugOrId: string): { name: string } {
  // Accept either a raw gcid (e.g. "gym") or a pre-formed "categories/gcid:gym".
  if (slugOrId.startsWith("categories/")) return { name: slugOrId };
  return { name: `categories/gcid:${slugOrId.replace(/[-\s]/g, "_").toLowerCase()}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL POSTS (the "What's new" updates) — V4 API. Still alive as of mid-2026
// because Local Posts has no V1 equivalent. Each post can have a topic type,
// summary text, optional CTA, optional media.
//
// Endpoint:
//   POST https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/localPosts
//
// Body shape (minimum):
//   { languageCode: "en-US",
//     summary: "<post body text>",
//     topicType: "STANDARD" | "OFFER" | "EVENT" | "ALERT",
//     callToAction: { actionType: "LEARN_MORE" | "SIGN_UP" | ..., url: "..." } }
// ─────────────────────────────────────────────────────────────────────────────
async function createLocalPost(
  accessToken: string,
  accountId: string,
  locationId: string,
  post: { summary: string; ctaUrl?: string; ctaType?: string; topicType?: string },
): Promise<unknown> {
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`;
  const body: Record<string, unknown> = {
    languageCode: "en-US",
    summary: post.summary.slice(0, 1500),
    topicType: post.topicType ?? "STANDARD",
  };
  if (post.ctaUrl) {
    body.callToAction = {
      actionType: post.ctaType ?? "LEARN_MORE",
      url: post.ctaUrl,
    };
  }
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const resBody = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`localPost POST HTTP ${r.status}: ${JSON.stringify(resBody).slice(0, 500)}`);
  }
  return resBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// Q&A — Owner asks a question, then upserts the owner answer.
//
// Create question:
//   POST https://mybusinessqanda.googleapis.com/v1/locations/{locationId}/questions
//   body: { text: "<question>" }
//
// Upsert owner answer:
//   POST .../questions/{questionId}/answers:upsert
//   body: { answer: { text: "<answer>" } }
// ─────────────────────────────────────────────────────────────────────────────
async function createQAndA(
  accessToken: string,
  locationId: string,
  question: string,
  answer: string,
): Promise<unknown> {
  // 1) Post the question.
  const qUrl = `https://mybusinessqanda.googleapis.com/v1/locations/${locationId}/questions`;
  const qRes = await fetch(qUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: question }),
  });
  const qBody = await qRes.json().catch(() => ({}));
  if (!qRes.ok) {
    throw new Error(`question POST HTTP ${qRes.status}: ${JSON.stringify(qBody).slice(0, 400)}`);
  }
  // Question name format: locations/{locationId}/questions/{questionId}
  const questionName = qBody.name as string;

  // 2) Upsert the owner answer.
  const aUrl = `https://mybusinessqanda.googleapis.com/v1/${questionName}/answers:upsert`;
  const aRes = await fetch(aUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answer: { text: answer } }),
  });
  const aBody = await aRes.json().catch(() => ({}));
  if (!aRes.ok) {
    throw new Error(`answer upsert HTTP ${aRes.status}: ${JSON.stringify(aBody).slice(0, 400)}`);
  }
  return { question: qBody, answer: aBody };
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER REVIEW REPLY — useful for the review-response cadence in the playbook.
//
// PUT https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply
//   body: { comment: "<reply text>" }
// ─────────────────────────────────────────────────────────────────────────────
async function setOwnerReviewReply(
  accessToken: string,
  accountId: string,
  locationId: string,
  reviewId: string,
  comment: string,
): Promise<unknown> {
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ comment }),
  });
  const resBody = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`review reply HTTP ${r.status}: ${JSON.stringify(resBody).slice(0, 400)}`);
  }
  return resBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACE ACTION LINKS — the "Book", "Order online", "Appointment" CTA buttons
// that show up in the GBP knowledge panel on Google Search + Maps.
//
// For fitness studios, the right type is APPOINTMENT — that renders as the
// blue "Book online" / "Book" button. The uri is the destination URL.
//
// Endpoints (mybusinessplaceactions.googleapis.com, v1, business.manage scope):
//   LIST:   GET    /v1/locations/{loc}/placeActionLinks
//   CREATE: POST   /v1/locations/{loc}/placeActionLinks
//   UPDATE: PATCH  /v1/{name}?updateMask=uri
//   DELETE: DELETE /v1/{name}
//
// Behavior of upsert_appointment_link:
//   1. List existing links
//   2. If one of type APPOINTMENT (or ONLINE_APPOINTMENT) exists → PATCH its uri
//   3. Otherwise → POST a fresh APPOINTMENT link
//
// NOTE: If the location currently uses "Reserve with Google" via a booking
// partner (e.g. MindBody, Mariana Tek), that partner-managed link takes
// precedence over custom placeActionLinks. Custom URL only takes over once
// the merchant disconnects the booking partner in GBP admin → Bookings.
// Listing existing links will surface partner-managed entries so we know.
// ─────────────────────────────────────────────────────────────────────────────
async function listPlaceActionLinks(
  accessToken: string,
  locationId: string,
): Promise<any[]> {
  const url = `https://mybusinessplaceactions.googleapis.com/v1/locations/${locationId}/placeActionLinks`;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`placeActionLinks LIST HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return (body.placeActionLinks ?? []) as any[];
}

async function createPlaceActionLink(
  accessToken: string,
  locationId: string,
  placeActionType: string,
  uri: string,
): Promise<unknown> {
  const url = `https://mybusinessplaceactions.googleapis.com/v1/locations/${locationId}/placeActionLinks`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerType: "MERCHANT",
      placeActionType,
      uri,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`placeActionLinks CREATE HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

async function updatePlaceActionLinkUri(
  accessToken: string,
  name: string,
  uri: string,
): Promise<unknown> {
  const url = `https://mybusinessplaceactions.googleapis.com/v1/${name}?updateMask=uri`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uri }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`placeActionLinks PATCH HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

async function deletePlaceActionLink(
  accessToken: string,
  name: string,
): Promise<unknown> {
  const url = `https://mybusinessplaceactions.googleapis.com/v1/${name}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`placeActionLinks DELETE HTTP ${r.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { deleted: name };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVER LOCATIONS — enumerate every GBP account + location the token can
// see. Used to populate locations.gbp_location_id rows that are NULL.
//
// 1) GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
//    Returns:  [{ name: "accounts/12345", ... }, ...]
// 2) For each account:
//    GET https://mybusinessbusinessinformation.googleapis.com/v1/{name}/locations
//        ?readMask=name,title,storefrontAddress.locality
//    Returns: [{ name: "locations/67890", title: "BBB Bayside", ... }, ...]
// ─────────────────────────────────────────────────────────────────────────────
async function discoverMyLocations(accessToken: string): Promise<any[]> {
  const accountsRes = await fetch(
    "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const accountsBody = await accountsRes.json().catch(() => ({}));
  if (!accountsRes.ok) {
    throw new Error(`accounts LIST HTTP ${accountsRes.status}: ${JSON.stringify(accountsBody).slice(0, 400)}`);
  }
  const accounts: any[] = accountsBody.accounts ?? [];
  const out: any[] = [];
  for (const acc of accounts) {
    const accountName = acc.name; // "accounts/12345"
    const locUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress,metadata.placeId&pageSize=100`;
    const locRes = await fetch(locUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const locBody = await locRes.json().catch(() => ({}));
    if (!locRes.ok) {
      out.push({ account: accountName, error: `locations LIST HTTP ${locRes.status}`, body: locBody });
      continue;
    }
    for (const loc of (locBody.locations ?? [])) {
      // loc.name is "locations/<NUMERIC_ID>" — that's what we store in DB.
      const numericId = String(loc.name ?? "").replace(/^locations\//, "");
      out.push({
        account: accountName,
        location_resource: loc.name,
        location_id: numericId,
        title: loc.title,
        city: loc.storefrontAddress?.locality ?? null,
        place_id: loc.metadata?.placeId ?? null,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// OP DISPATCHER — runs one operation against one location.
// ─────────────────────────────────────────────────────────────────────────────
type Op = Record<string, unknown> & { op: string };

async function runOp(
  accessToken: string,
  accountId: string,
  locationId: string,
  op: Op,
): Promise<unknown> {
  switch (op.op) {
    case "update_description": {
      const desc = String(op.description ?? "");
      if (!desc) throw new Error("update_description requires non-empty description");
      if (desc.length > 750) throw new Error(`description ${desc.length} > 750 char limit`);
      return await patchLocation(accessToken, locationId, "profile.description", {
        profile: { description: desc },
      });
    }
    case "update_categories": {
      const primary  = String(op.primary ?? "gym");
      const extra    = (op.additional ?? []) as string[];
      if (extra.length > 9) throw new Error("max 9 additional categories");
      return await patchLocation(accessToken, locationId, "categories", {
        categories: {
          primaryCategory:     categoryRef(primary),
          additionalCategories: extra.map(categoryRef),
        },
      });
    }
    case "update_services": {
      // services: array of { displayName: string, price?: number, description?: string }
      const services = (op.services ?? []) as Array<Record<string, unknown>>;
      const items = services.map((s) => ({
        freeFormServiceItem: {
          label: {
            displayName: String(s.displayName ?? ""),
            description: s.description ? String(s.description) : undefined,
          },
          ...(s.categoryId ? { categoryId: String(s.categoryId) } : {}),
        },
      }));
      return await patchLocation(accessToken, locationId, "serviceItems", {
        serviceItems: items,
      });
    }
    case "create_post": {
      const summary = String(op.summary ?? op.body ?? "");
      if (!summary) throw new Error("create_post requires summary/body");
      return await createLocalPost(accessToken, accountId, locationId, {
        summary,
        ctaUrl:  op.cta_url   ? String(op.cta_url)   : undefined,
        ctaType: op.cta_type  ? String(op.cta_type)  : "LEARN_MORE",
        topicType: op.topic_type ? String(op.topic_type) : "STANDARD",
      });
    }
    case "ask_and_answer_qa": {
      const q = String(op.question ?? "");
      const a = String(op.answer   ?? "");
      if (!q || !a) throw new Error("ask_and_answer_qa requires question + answer");
      return await createQAndA(accessToken, locationId, q, a);
    }
    case "set_owner_response": {
      const reviewId = String(op.review_id ?? "");
      const comment  = String(op.comment   ?? "");
      if (!reviewId || !comment) throw new Error("set_owner_response requires review_id + comment");
      return await setOwnerReviewReply(accessToken, accountId, locationId, reviewId, comment);
    }
    case "discover_my_locations": {
      // Enumerate every account + location this refresh token can see.
      // Useful for populating locations.gbp_location_id (NULL for Astoria + WB).
      return await discoverMyLocations(accessToken);
    }
    case "list_place_action_links": {
      // No-op surfacing of every existing CTA on this location. Useful before
      // upsert_appointment_link to confirm partner-managed links (Reserve with
      // Google) aren't going to override the custom one we set.
      return await listPlaceActionLinks(accessToken, locationId);
    }
    case "upsert_appointment_link": {
      // Flip the Book button. If an APPOINTMENT (or ONLINE_APPOINTMENT) link
      // already exists, PATCH its uri. Otherwise create a fresh one.
      const uri  = String(op.uri ?? "");
      const type = String(op.place_action_type ?? "APPOINTMENT");
      if (!uri) throw new Error("upsert_appointment_link requires uri");
      const existing = await listPlaceActionLinks(accessToken, locationId);
      const match = existing.find((l: any) =>
        l.placeActionType === type ||
        l.placeActionType === "APPOINTMENT" ||
        l.placeActionType === "ONLINE_APPOINTMENT",
      );
      if (match?.name) {
        const updated = await updatePlaceActionLinkUri(accessToken, match.name, uri);
        return { action: "patched", previous_uri: match.uri, updated };
      }
      const created = await createPlaceActionLink(accessToken, locationId, type, uri);
      return { action: "created", created };
    }
    case "delete_place_action_link": {
      // Pass either { name: "locations/.../placeActionLinks/..." } or
      // { place_action_type: "APPOINTMENT" } to delete by type.
      const explicit = String(op.name ?? "");
      if (explicit) return await deletePlaceActionLink(accessToken, explicit);
      const type = String(op.place_action_type ?? "");
      if (!type) throw new Error("delete_place_action_link requires name or place_action_type");
      const existing = await listPlaceActionLinks(accessToken, locationId);
      const match = existing.find((l: any) => l.placeActionType === type);
      if (!match?.name) return { skipped: `no ${type} link to delete` };
      return await deletePlaceActionLink(accessToken, match.name);
    }
    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ ok: false, error: "POST only" }, 405);

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "JSON body required" }, 400);
  }

  // Accept three shapes for ergonomic CLI use:
  //   single op:           { studio_slug, op, ...params }
  //   multi-op one studio: { studio_slug, ops: [...] }
  //   multi-op N studios:  { studios: [...], ops: [...] }
  const dryRun = !!payload.dry_run;
  const studios: string[] = payload.studios ?? (payload.studio_slug ? [payload.studio_slug] : []);
  if (studios.length === 0) {
    return json({ ok: false, error: "Pass studio_slug or studios:[...]" }, 400);
  }
  let ops: Op[] = [];
  if (Array.isArray(payload.ops)) {
    ops = payload.ops as Op[];
  } else if (payload.op) {
    ops = [{ ...payload, op: String(payload.op) } as Op];
    // Strip routing keys from per-op payload so we don't leak them into API bodies.
    delete (ops[0] as any).studio_slug;
    delete (ops[0] as any).studios;
    delete (ops[0] as any).ops;
    delete (ops[0] as any).dry_run;
  } else {
    return json({ ok: false, error: "Pass op or ops:[...]" }, 400);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Pull active locations. The `locations` table has no `slug` column — we
  // derive the studio slug from `name` (same pattern as gbp-sync). If name
  // is "BBB Bayside" we strip the "BBB " prefix → "bayside".
  const { data: locs, error: locErr } = await sb
    .from("locations")
    .select("name, gbp_account_id, gbp_location_id, gbp_refresh_token, is_active")
    .eq("is_active", true);

  if (locErr) return json({ ok: false, error: `locations: ${locErr.message}` }, 500);

  function slugify(name: string): string {
    return String(name).toLowerCase()
      .replace(/^bbb\s+/, "")        // strip "BBB " prefix
      .trim()
      .replace(/\s+/g, "-");          // spaces → hyphens
  }
  const want = new Set(studios.map((s) => s.toLowerCase()));
  const matched = (locs ?? []).filter((l) => want.has(slugify(l.name)));

  if (matched.length === 0) {
    return json({
      ok: false,
      error: "no matching studios found",
      searched: studios,
      available_locations: (locs ?? []).map((l) => ({
        name: l.name,
        derived_slug: slugify(l.name),
        has_gbp_location_id: !!l.gbp_location_id,
      })),
    });
  }

  // Cache access tokens per refresh token within this invocation.
  const tokenCache: Record<string, string> = {};
  async function tokenFor(rt: string | null | undefined): Promise<string> {
    const key = rt && rt.trim() !== "" ? rt : "__env__";
    if (tokenCache[key]) return tokenCache[key];
    const t = await getAccessToken(rt);
    tokenCache[key] = t;
    return t;
  }

  const results: any[] = [];
  for (const loc of matched) {
    const studioSlug = String(loc.name).toLowerCase().replace(/\s+/g, "-");
    const locResult: any = {
      studio: studioSlug,
      gbp_location_id: loc.gbp_location_id,
      using_per_location_token: !!loc.gbp_refresh_token,
      ops: [] as any[],
    };
    if (!loc.gbp_location_id) {
      locResult.ok = false;
      locResult.error = "gbp_location_id not set on locations row";
      results.push(locResult);
      continue;
    }

    let accessToken: string;
    try {
      accessToken = await tokenFor(loc.gbp_refresh_token as string | null);
    } catch (e) {
      locResult.ok = false;
      locResult.error = (e as Error).message;
      results.push(locResult);
      continue;
    }

    for (const op of ops) {
      const opResult: any = { op: op.op };
      if (dryRun) {
        opResult.dry_run = true;
        opResult.payload = op;
      } else {
        try {
          opResult.result = await runOp(
            accessToken,
            String(loc.gbp_account_id ?? ""),
            String(loc.gbp_location_id),
            op,
          );
          opResult.ok = true;
        } catch (e) {
          opResult.ok = false;
          opResult.error = (e as Error).message;
        }
      }
      locResult.ops.push(opResult);
      // Audit log so /ops can show what changed.
      try {
        await sb.from("gbp_edit_log").insert({
          studio_slug: studioSlug,
          op: op.op,
          payload: op,
          ok: opResult.ok ?? null,
          error: opResult.error ?? null,
          result: opResult.result ?? null,
        });
      } catch { /* table may not exist yet — see migration */ }
    }

    locResult.ok = locResult.ops.every((o: any) => o.ok !== false);
    results.push(locResult);
  }

  return json({
    ok: results.every((r) => r.ok !== false),
    studios_processed: results.length,
    dry_run: dryRun,
    results,
  });
});
