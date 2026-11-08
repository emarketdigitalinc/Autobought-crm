# Autobought CRM

The sales pipeline for **signing dealerships**. It sits next to the lead bank
and dealer portal (`autobought-lead-bank-v2`): ads bring in dealer leads, Mike
works them, and a signed dealer is handed to the lead bank with a portal login,
their categories, markets and monthly quota, and a welcome email.

Node 22 + Express + SQLite (one file), plain HTML pages. The same stack as the
lead bank, so the same person can look after both.

```
Meta Instant Form ─┐                     ┌─ text + email Mike (Twilio / Resend)
                   ├─► inbox ─► intake ──┤
autobought.ca/     │   (stored    │      └─ "I'm shopping for a vehicle"
dealers (Jotform) ─┘    first)    │          └─► lead bank consumer funnel
                                  ▼
          New ─► Contacted ─► Working ─► Signed ─► lead bank: dealer, contracts,
                    │            │          │       portal login, welcome email
                    └── Lost (reason)       └─► Meta CAPI "Signed"
                                 └─► Meta CAPI "Working"
```

## Screens

| Page | What it's for |
|---|---|
| **Leads** (`/index.html`) | One table, stage filter tabs, A/B filter, search. Shows market open/taken, minutes to first contact (or how long it has been waiting), and a Call button. Average time to first contact at the top. Becomes cards on a phone. |
| **Lead** (`/lead.html?id=`) | Tap-to-call, details, market availability per category, stage buttons (Lost asks for a reason, Signed asks for the deal), call/text/email/note log, the full activity history, where it came from, what was sent to Meta, and the deal + handoff status. |
| **Dashboard** (`/dashboard.html`) | Ad spend, cost per lead / Working / Signed, A vs B and by ad, with a date filter. Revenue and commission by month and account manager, 12-month trend. Team settings: who gets new-lead texts, commission %. |
| **Market map** (`/markets.html`) | Every market × Automotive / Powersport / RV/Marine, open or taken and by whom, plus how many dealer leads each market has produced. Add markets and nearby-town aliases. |

## How each part works

**1. Intake.** Every webhook delivery is written to `inbox` before anything
else, then processed. If processing fails (Meta's API down, an expired token)
the scheduler retries it, so a lead is never lost to a bad minute. Meta and
Jotform retries of the same submission are recognised and ignored.

- **A, Instant Form.** Meta's webhook only carries a lead id; the answers plus
  campaign, ad set and ad are fetched from the Graph API.
- **B, landing page.** Jotform's own webhook. Fields are recognised from the
  question labels (both the *Check AutoBought Lead Availability* and *AutoBought
  Dealer Inquiry* forms map correctly). Campaign and ad come from UTM hidden
  fields: add hidden fields named `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `utm_term` to the form and have Jotform prefill them from the
  URL. In the ad, set URL parameters such as
  `utm_source=facebook&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.id}}`
  so each lead is credited to the exact ad.
- **Duplicates** merge on phone (digits only, with or without the leading 1)
  or email. The merged lead keeps its first source and ad credit, gains any
  fields it was missing, shows "×2", and Mike is alerted again ("submitted AGAIN").
- **Shoppers.** A role of "I'm shopping for a vehicle" never becomes a dealer
  lead: it is posted to the lead bank's webhook into `CONSUMER_FUNNEL_ID`.

**2. Speed to lead.** Everyone with *Text me new leads* on (Dashboard › Team)
gets a text and an email the moment a lead lands: name, dealership, city, role,
phone, a tap-to-call link and a link to the lead. First contact is recorded
the first time a call, text or email is logged (tapping Call logs one), or when
the lead is moved to Contacted / Working / Signed. Minutes are measured from
when the person submitted.

**3. Pipeline.** New, Contacted, Working, Signed, Lost. Lost requires one of:
Not a dealer, Wrong person, Not interested, Went with competitor, No response,
Other (Other needs a note). Every change, note, call and system event is in the
lead's activity log.

**4. Ad cost.** Once a day (and from the *Sync spend* button) the last week of
spend per ad per day is pulled from the Insights API; Meta revises recent days,
so they are re-pulled. Each ad is A or B from its ad set's destination
(Instant Form = A, website = B); the dashboard lets you correct one. Cost per
Working / Signed means spend on the leads created in the date range divided by
how many of those leads went on to Working / Signed.

**5. Conversions API.** Reaching Working and Signed each sends one event
(`action_source: system_generated`, `event_source: crm`) matched on the Meta
lead id plus hashed email, phone, name and city. `event_id` is fixed per lead
and stage, so retries and moving a lead back and forth never double count.
Uses `META_DATASET_ID` / `META_CAPI_TOKEN`, the same names the dealer portal's
CAPI setup uses; `src/capi.js` has no CRM-specific dependencies beyond the
`db` module and can be dropped into the portal. In Events Manager, set the
dataset up for *conversion leads* and pick **Signed** (or Working) as the
optimisation event.

**6. Market availability.** A market is a city plus nearby towns (aliases) in a
province; 20 Canadian markets are pre-loaded and editable. An active or paused
deal holds each of its markets for each category it has a quota in. Leads are
matched to a market by city; if none matches, pick one on the lead.

**7. Signed → portal.** The Signed form takes the package, price, categories
with monthly quotas, markets, account manager and portal email. The CRM then,
through the lead bank's own staff API:
1. creates the dealer (contact details, account manager, start date, and the
   provinces of their markets so the lead bank only sends them local leads),
2. sets a contract per category (RV/Marine → `rv`, see `LEADBANK_CATEGORY_MAP`)
   with the monthly quota and Essential/Application,
3. creates their dealer portal login with a temporary password,
4. emails the welcome (portal link, login, password, package, markets),
   BCC'd to the account manager.

Each step is remembered, so if one fails the lead shows **Retry handoff** and
carries on where it stopped (no duplicate dealers). If the welcome email has to
be resent, a fresh password is issued, because the first one was never stored.

**8. Deals and commission.** Per signed dealer: package, leads/month, price per
lead, monthly value (leads × price unless set), start date, status
(active/paused/cancelled), account manager and commission rate (copied from the
account manager when signed; Mike = 20%, change it on the Team table). The
revenue report counts a deal in every month from its start date until its end
date. Pausing stops it counting from the current month on; months already past
are unchanged. Months are billed in full (no part-month proration).

Not built, on purpose: automated follow-up sequences.

## Run it locally

```bash
cd autobought-crm
npm install
npm run add-user -- --email you@autobought.ca --name "You" --password "at-least-10-chars" --admin
npm run add-user -- --email mike@autobought.ca --name Mike --password "..." --phone 7805550100 --commission 0.2 --notify
npm start                          # http://localhost:3100
npm test                           # end-to-end, with Meta / Twilio / Resend / lead bank faked
```

Send yourself a test lead:

```bash
curl -X POST localhost:3100/webhooks/lead -H 'x-webhook-secret: <WEBHOOK_SECRET>' \
  -H 'content-type: application/json' \
  -d '{"source":"B","name":"Test Dealer","phone":"7805550142","email":"t@test.ca","city":"Red Deer","dealership":"Test Motors","sells":"used cars","leads_wanted":"20"}'
```

## Deploy (Railway)

1. New service from this repo, **Root Directory `autobought-crm`** (it has its
   own `railway.json`). Add a volume mounted at `/data` and set `DATA_DIR=/data`.
2. Set the variables in `.env.example`. At minimum: `NODE_ENV`, `APP_URL`,
   `DATA_DIR`, `BOOTSTRAP_ADMIN_*` for the first boot.
3. In the lead bank, create a **staff** login for the CRM (Settings › Users) and
   put it in `LEADBANK_EMAIL` / `LEADBANK_PASSWORD`. Create (or choose) the
   consumer funnel shoppers should go to and set `CONSUMER_FUNNEL_ID`.
4. Point the Meta leadgen webhook and the Jotform webhook at the CRM (URLs in
   `.env.example`). If Zapier currently sends dealer leads anywhere, switch
   that off once these are live, or the CRM will just merge the duplicates.
5. Sign in, open Dashboard › Team, and make sure Mike has his mobile number and
   *Text me new leads* ticked.

## API

Webhooks: `GET/POST /webhooks/meta`, `POST /webhooks/jotform?secret=`, `POST /webhooks/lead`.
Staff (cookie session): `/api/leads`, `/api/leads/:id` (GET, PATCH),
`/api/leads/:id/stage`, `/api/leads/:id/activities`, `/api/leads/:id/handoff`,
`/api/deals/:id`, `/api/dashboard`, `/api/ads/sync`, `/api/ads/:id/source`,
`/api/revenue?month=`, `/api/markets`, `/api/users`.
