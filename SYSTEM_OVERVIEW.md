# Better Body Bootcamp — How Everything Works (End to End)

*Last updated: July 2026. This is the map of how a customer flows from an ad to a
booked class, and every system behind it.*

---

## 1. The big picture — what the pieces are

There are **three layers**:

1. **Mariana Tek (MT)** — the system of record for classes, schedules, bookings,
   memberships, and payments. (It replaced MindBody in the June 2026 cutover.
   MindBody still holds the *historical* data before that.)
2. **The BBB website + custom UI** — `betterbodybootcamp.com`, hosted on Netlify.
   This is the marketing site, the trial-signup pages, the custom booking screens,
   and the two dashboards.
3. **The Supabase backend (the "glue")** — a set of Edge Functions and a Postgres
   database that mirror MT's data, run all the automation (syncs, emails, tracking),
   and power the dashboards.

Supporting services: **Netlify** (hosting), **Resend** (email), **Twilio** (SMS),
**Meta** (ad-conversion tracking), **Stripe** (payments for Bayside only — see §3).

---

## 2. The customer journey in one line

> Sees an ad → lands on `/trial/<studio>` → buys the $49 two-week trial → gets an
> account + sets a password → books their first class → attends → (ideally) converts
> to a paying member.

Everything below is the machinery that makes each of those steps work and get tracked.

---

## 3. Buying the trial — there are TWO different checkouts

This is the single most important thing to understand, because the two paths behave
differently afterward.

**Astoria, Fresh Meadows, Williamsburg — Mariana Tek's own widget.**
The `/trial/<studio>` page embeds MT's native `/buy/` widget. MT owns the whole
transaction: it creates the customer's account, takes the payment, and issues the
$49 intro pass. Because they authenticated inside MT's widget, they now have a
**live MT session in that browser**.

**Bayside — Stripe.**
Bayside runs through the old Stripe checkout (`create-trial-checkout` function) that
redirects to `/trial-success`. This is a deliberate workaround: MT's buy widget was
mis-routing Bayside purchases to Astoria's checkout, so Bayside was reverted to
Stripe. The consequence: a Bayside buyer has **no MT session** — they've paid, but
they aren't logged into Mariana Tek.

---

## 4. Account + password (the part that trips people up)

When a trial is created, the `mariana-tek-create-trial-client` function tells MT to
send a **"set your password" email** (`send_password_reset_email`). That password is
what the customer later uses to log in and book on the web.

**Key point:** right after paying, a customer does **not** have a usable password yet.
They have to open that MT email and set one first. This is the friction behind "they
can't book immediately."

---

## 5. After they pay — the success page (`/trial-success`)

Recently rebuilt. When someone lands here it:

- Fires the **Meta "Purchase" pixel** (per-studio pixel id) so the ad conversion is
  attributed.
- Shows **the studio's live MT booking schedule right on the page** so they can pick
  a class and reserve. For the MT-widget studios their existing MT session carries in,
  so it's close to one-tap. For Bayside (Stripe) MT will still ask them to sign in.
- Demotes "Download the app" to a secondary option and adds a "set your password"
  nudge for next time.

*(Note: the Resend welcome email currently still links to the older `/schedule` page,
not this smoother flow — a consistency gap worth closing.)*

---

## 6. Booking a class — three routes to the same place

All three ultimately create a reservation in Mariana Tek.

1. **Web `/schedule/<studio>`** → the `NativeClassList` component (which pulls live
   class data through the `mt-public-classes` proxy so it can render in BBB's own
   styling) → the `MTBookingModal`. To reserve, the modal calls `mt-customer-auth`
   (Mariana Tek's OAuth **password grant** using the public client id) to get a token,
   then `mt-customer-reserve` to book. **This route requires the customer's MT
   password.**
2. **The MT native widget** embedded on `/trial-success` — uses the shared MT session,
   so no separate password prompt for MT-widget buyers.
3. **The mobile app** ("Better Body Studios").

**The one unverified link in the whole chain:** route #1's password-grant auth. We've
confirmed the page loads and the reserve form appears, but not that a brand-new
customer's real credentials pass all the way through to "You're booked." That's the
thing to test end-to-end once.

---

## 7. Emails & SMS

- **Resend (email):** welcome email with a "Book My First Class" link
  (`manual-welcome-batch`), plus abandoned-cart, comeback/win-back, and
  trial-convert follow-up sequences.
- **Twilio (SMS):** welcome text, owner alerts on every new paid trial
  (Carlos for Bayside + Fresh Meadows; Chris & Steve for Astoria + Williamsburg),
  comeback texts, and inbound-reply handling.
- **Mariana Tek (email):** the "set your password" + account emails.

---

## 8. The data backbone — how Supabase stays in sync with MT

This runs on a schedule so the dashboards and automation always have fresh data:

- **`mt-orders-sync` (every 5 min):** pulls new MT orders → mirrors every sale into
  `mariana_tek_sales`, inserts any new trial into `trial_signups`, and kicks off the
  CAPI events + welcome emails for brand-new trials.
- **`mariana-tek-visits-sync` (hourly):** pulls class reservations and check-ins into
  `mariana_tek_visits`. (This is what feeds the "Attended" data — it was previously
  manual and is now automatic.)
- **`sync-orchestrator`:** one cron entry point that fans out to all the syncs on
  tiered schedules (every 5 / 15 / 60 min) so they don't overload the queue.
- **`sync-health-watchdog`:** if any critical table goes stale beyond its threshold,
  it **texts you** so a silent breakage can't hide.
- **MT authentication:** the syncs talk to MT with an OAuth token that auto-refreshes.
  The fully-durable version needs one more secret (`MT_OAUTH_CLIENT_ID`); until that's
  set, the access token has a ~7-day life as a fallback.

---

## 9. Attribution & tracking (so ad spend is measurable)

- **Meta Pixel:** a per-studio pixel fires a PageView on `/trial/<studio>` and a
  Purchase on `/trial-success`.
- **Meta CAPI (`mariana-tek-capi-purchase-sync`):** sends the same Purchase/Subscribe
  events **server-side** from the actual MT sales, so conversions still count even
  when browsers block the pixel. (This was the function that had been undeployed and
  is now live + backfilled.)
- **Tracked links:** `/ig/<studio>`, `/email/<studio>`, `/flyer/<studio>`,
  `/gbp/<studio>`, and `/review/<studio>` all log the click and stamp the eventual
  signup with the right UTM source, so the dashboard can tell you where a trial came
  from.

---

## 10. The two dashboards

- **`/dashboard` (owner view, `bbbmarketing`):** the KPI view — spend pulse, the
  "Bottom Line" (now showing **real cash collected** with committed/projected value as
  a labeled secondary), converted members, the funnel, and ad performance.
- **`/homebase` (front-desk Kanban, `frontdesk.html`):** cards move
  **New Lead → Contacted → Booked → Attended → Member → Lost**. A card now
  **auto-advances to Attended** when Mariana Tek records a real check-in for that
  person. Access is scoped per studio (Bayside/Fresh Meadows can't see all four).

---

## 11. SEO / discoverability layer

- A static schema graph (Organization + all four studios, with addresses/geo/hours)
  is baked into the served HTML so AI crawlers see it without running JavaScript.
- The location and Queens-hub pages are **prerendered** to static HTML for the same
  reason, and cross-link to each other so Google can crawl the whole local cluster.

---

## 12. What runs itself vs. what still needs a human

**Automated:** the MT syncs, CAPI events, welcome emails/SMS, the Attended
auto-promotion, the dashboards, and the health-watchdog alerts.

**Still needs attention / known weak points:**
- The **web booking auth** (§6) is wired but unproven end-to-end — test one real
  reservation to be sure.
- **Bayside is on Stripe**, not the MT widget, so its buyers don't get the seamless
  in-session booking the other three do.
- The **MT token** is durable only once `MT_OAUTH_CLIENT_ID` is set; until then it's a
  7-day fallback.
- **MindBody historical reports** are gated by a limited software plan, so deep
  before-cutover reporting has to be reconstructed from exports rather than pulled.
