// _shared/studios.ts — ONE source of truth for per-studio config.
//
// Why: studio phone numbers, MT location IDs, location UUIDs, addresses, etc.
// were hardcoded (and drifted) across a dozen edge functions — which is why a
// single number change meant editing 10 files. Import from here instead.
//
// Migration is ADDITIVE: functions move onto this module one at a time, each
// verified after deploy. Nothing is removed from callers until they're switched.
//
// Deno import from a function:  import { STUDIOS, studioBySlug } from "../_shared/studios.ts";

export type StudioSlug = "astoria" | "bayside" | "fresh-meadows" | "williamsburg";

export interface Studio {
  slug: StudioSlug;
  name: string;
  /** Mariana Tek location id (admin/config-location/<id>). */
  mtLocationId: number;
  /** Supabase locations.id UUID. */
  locationUuid: string;
  /** Street address (as shown to customers). */
  address: string;
  /** Number shown publicly on the website (E.164). */
  publicPhone: string;
  /** Quo shared-inbox line for texting/calls (E.164). null = not on Quo yet. */
  quoNumber: string | null;
  /** Studio front-desk mailbox. */
  mailbox: string;
  /** Vapi voice-assistant id for this studio. */
  vapiAssistantId: string;
  /** Meta ad account (act_...). null = not confirmed in code yet — fill when known. */
  metaAdAccount: string | null;
}

export const STUDIOS: Record<StudioSlug, Studio> = {
  "astoria": {
    slug: "astoria",
    name: "Astoria",
    mtLocationId: 48717,
    locationUuid: "dcf94b47-dcc8-4176-96e9-f0cdd0fc6b45",
    address: "31-18 Steinway St, Astoria, NY 11103",
    publicPhone: "+17187049954",
    quoNumber: null,
    mailbox: "astoria@betterbodybootcamp.com",
    vapiAssistantId: "87c3f6f5-b2f0-494d-8bf8-97b3c31a5837",
    metaAdAccount: "act_1367835402069398",
  },
  "bayside": {
    slug: "bayside",
    name: "Bayside",
    mtLocationId: 48718,
    locationUuid: "5c0e8383-dd2f-4f8f-bfea-5cc477cec4c7",
    address: "34-47 Bell Blvd, Bayside, NY 11361",
    publicPhone: "+19178770759",
    quoNumber: "+19178770759",
    mailbox: "bayside@betterbodybootcamp.com",
    vapiAssistantId: "c25f7798-678f-4231-9d6f-617246cf0fb5",
    metaAdAccount: null,
  },
  "fresh-meadows": {
    slug: "fresh-meadows",
    name: "Fresh Meadows",
    mtLocationId: 48719,
    locationUuid: "6bbbe077-bcc6-4d9d-a10b-7605c1484752",
    address: "76-46 164th St, Fresh Meadows, NY 11366",
    publicPhone: "+16468876483",
    quoNumber: "+16468876483",
    mailbox: "freshmeadows@betterbodybootcamp.com",
    vapiAssistantId: "dab5cc9a-3344-420a-ad2a-013f8eff8a25",
    metaAdAccount: null,
  },
  "williamsburg": {
    slug: "williamsburg",
    name: "Williamsburg",
    mtLocationId: 48720,
    locationUuid: "80536b45-df0e-42d1-880c-e9301372e1cf",
    address: "487 Driggs Ave, Brooklyn, NY 11211",
    publicPhone: "+17186831864",
    quoNumber: null,
    mailbox: "williamsburg@betterbodybootcamp.com",
    vapiAssistantId: "31ef462d-f14e-4a64-bd72-d253f004f6f9",
    metaAdAccount: "act_26739874695621849",
  },
};

// Shared workspace defaults (not per-studio).
export const TWILIO_FROM = "+18772860293";       // legacy shared SMS relay
export const QUO_API_BASE = "https://api.quo.com";

// ── Lookup helpers ──────────────────────────────────────────────────────────
const norm = (s: string) => (s || "").toLowerCase().trim();

/** Accepts a slug ("fresh-meadows"), a name ("Fresh Meadows"), or a squashed
 *  key ("freshmeadows") — the three forms scattered across the old code. */
export function studioBySlug(input: string): Studio | null {
  const k = norm(input).replace(/\s+/g, "-");
  if ((STUDIOS as Record<string, Studio>)[k]) return (STUDIOS as Record<string, Studio>)[k];
  const squashed = norm(input).replace(/[^a-z]/g, "");
  return Object.values(STUDIOS).find((s) => s.slug.replace(/-/g, "") === squashed) ?? null;
}

export function studioByMtLocationId(id: number | string): Studio | null {
  const n = Number(id);
  return Object.values(STUDIOS).find((s) => s.mtLocationId === n) ?? null;
}

export function studioByLocationUuid(uuid: string): Studio | null {
  return Object.values(STUDIOS).find((s) => s.locationUuid === uuid) ?? null;
}

/** Studios that currently text/call from a Quo line (Bayside, Fresh Meadows). */
export function quoStudios(): Studio[] {
  return Object.values(STUDIOS).filter((s) => s.quoNumber);
}
