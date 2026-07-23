# URGENT FIX · 2026-06-10 · Trial Form Silent Failure

## What broke

Today's "0 form fills network-wide" was a **silent backend failure**, not a Meta delivery problem.

### Symptoms observed:
- 7 leads landed in `leads` table (frontend form submit succeeded)
- 0 rows in `trial_signups`
- 16 ghost CAPI Lead events fired with empty user_data
- $85 ad spend through 5 PM ET with zero attributable conversions
- 22 PageView CAPI events landed normally
- All 4 trial pages returned HTTP 200

### Root cause:
**The `trial_signups` table is missing the `fbp` column.**

`create-trial-checkout` Edge Function has been writing `fbp: <value>` since the
CAPI attribution upgrade. PostgREST rejects every insert with:

```
PGRST204: Could not find the 'fbp' column of 'trial_signups' in the schema cache
```

The try/catch at create-trial-checkout/index.ts:415-417 swallows the exception
silently and the function continues past line 419 to fire the CAPI Lead event.
So Meta sees a "Lead", the leads table gets the upsert, but the customer never
reaches a Stripe Checkout session — they see a broken redirect or generic error
and leave.

The `fbc` column DOES exist (an earlier migration added it). `fbp` was added to
the code path later and the column migration was never run on prod.

## What's affected

**Today** (12:24-21:17 ET): 7 known customers couldn't sign up:

| Time | Studio | Name | Email |
|---|---|---|---|
| 12:24 | wburg | Xi | ximenaonefolg@gmail.com |
| 15:05 | wburg | Nicole Domingo | nicoledomingo02@gmail.com |
| 17:15 | wburg | Brian Burns | burnspatrickbrian@gmail.com |
| 18:34 | astoria | Julie Wu | juliewuliewu@gmail.com |
| 20:07 | wburg | Meredith Bogan | anlibogan@gmail.com |
| 21:17 | bayside | Eun jeong Bang | saekom2@hotmail.com |

(Justin's diagnostic submission at 13:52 excluded.)

**Looking back**: every "zero-fill day" in the last 9 days (today, 6/7, 6/2)
likely has the same cause. The bug has been silent since the day fbp got added
to the insert.

## The fix (2 migrations, deploy in order)

### 1. Add the missing column

```bash
cat ~/Desktop/betterbodybootcamp-site/supabase/migrations/20260610_add_fbp_column.sql | pbcopy
```

Paste in Supabase SQL editor and Run. Adds `fbp text` column + reloads PostgREST schema.

### 2. Recover today's 6 lost customers

```bash
cat ~/Desktop/betterbodybootcamp-site/supabase/migrations/20260610_backfill_today_lost_leads.sql | pbcopy
```

Paste in SQL editor and Run. Reconstructs trial_signups rows from `leads` table
for the 6 affected customers + tags them with an AUTO-BACKFILL note so front
desk knows they need outreach (the customer never got their checkout link).

### 3. Verify

After deploy, every form submission landing in `leads` should also land in
`trial_signups` within seconds. CAPI Lead events should carry real user_data
(em/ph/fn populated). Stripe Checkout sessions should be reachable.

## Follow-up tasks (later, not blocking)

- Add a heartbeat alert: if leads-table inserts exceed trial_signups inserts
  for ≥3 hours, page Justin (this same bug class could happen again)
- Make the catch block at create-trial-checkout/index.ts:415-417 log the
  insert error to a dedicated `edge_function_errors` table so silent
  failures aren't invisible
- Audit every trial_signups insert path for similar missing-column risks
