# Meta Lead Form Ads — Setup Spec
*Drafted 2026-06-11 for Justin's review before launch.*

## Why we're trying this

Current funnel: Ad → click → trial page → form → Stripe = 1-2% conversion network-wide.

Meta Lead Form ads keep everything inside Facebook/Instagram:
- User taps the ad → form prefills with their FB info → 2 taps to submit.
- No page load, no Stripe, no friction.
- Industry baseline conversion: **5-15%** (3-7× our current rate).
- Tradeoff: lower-quality leads — they didn't click through to read the offer page, so they're "warm interest" not "hot intent."

## How we'd handle the lower quality

**Speed kills hesitation.** Studies show calling a Lead Form lead within 5 minutes converts at 12× the rate of calling within an hour. We already have Twilio + auto-SMS infra. The play:

1. Lead lands in Meta's Lead Center via the form
2. Our Meta webhook (to build) → Edge Function picks it up → writes to `leads` table tagged `source=meta_lead_form_{slug}`
3. Auto-SMS within 60 seconds: "Hi {firstName}! Saw you wanted info on our 2-week trial at {studio}. Want to come this week? Reply YES and I'll set you up."
4. The lead lands on /homebase with a flag for front desk to call same-day
5. Front-desk goal: book them for a class within 24 hours

If we hit even half the industry conversion rate (2.5%), we 2-3× current paid-trial volume.

## Test plan

Start with **one studio** (recommend Williamsburg — best baseline + biggest audience). Run for 14 days.

- **Campaign objective:** OUTCOME_LEADS (Lead generation)
- **Budget:** $40/day for 14 days = $560 test budget
- **Audience:** broad, no interest filtering (same as your current cold ad set), age 25-65, 5-mile radius from studio
- **Placements:** Advantage+ (let Meta optimize)
- **Form fields (minimal — friction kills the whole point):**
  - First name (pre-fill from FB)
  - Email (pre-fill from FB)
  - Mobile phone (pre-fill from FB)
  - ONE qualifying question: "When can you come in?" → multiple choice (this week / next 2 weeks / just curious)
- **Privacy policy URL:** https://betterbodybootcamp.com/privacy

## What I need from you to launch

1. Approve the SMS auto-reply text above (or rewrite — your call)
2. Decide on the qualifying question (or remove it entirely for max conversion)
3. Pick the studio to test on (WB recommended)
4. Confirm $560 budget OK for the test

## What I'll build once you approve

1. New Edge Function `meta-leadgen-webhook` — receives Meta's Lead webhook, writes to `leads` table
2. Auto-SMS within 60 seconds (Twilio)
3. New /homebase column: "Lead Form (call today)" with priority sorting
4. Dashboard card tracking Lead Form → paid trial conversion rate per studio
5. The Meta campaign itself (via API — same way I created the comeback products today)

## Expected outcome (honest)

**Best case:** 50 leads/2 weeks at WB at 5% paid conversion = 2-3 extra paid trials per week = $98-147/week. Not life-changing but proves the channel.

**Worst case:** $560 burned, 30 low-intent leads, 0 conversions. We learn that Lead Form doesn't work for $49 fitness in NYC and don't expand.

**Most likely:** Somewhere in between. Probably 1-2 extra paid trials per week per studio, sustainable, scales with budget.

This is a 14-day test, not a permanent change. We measure honestly and decide what to do at the end.

---

Reply with: "go" + your answers to the 4 questions above, and I'll build everything in one push.
