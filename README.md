# FinTech Network (Prototype v0.1)

A mobile-first UK fintech transaction network **prototype**. Working name
only — branding is configurable, never hard-coded into logic.

**This is a prototype using simulated financial infrastructure.**
No real money, no real bank accounts, no real payment credentials.
See `docs/` and the project's Technical & Product Specification v0.1 for
the full architecture, threat model, and regulatory disclaimers.

## Quickstart

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up
```

- **Consumer app: http://localhost:5173** — create an account and you
  start with £500.00 of simulated funds. To have someone to pay,
  register a second account in a **private window**: since Phase 14 a
  session is a cookie, so two tabs of one browser are the same person.
- API health check: http://localhost:3000/health
- **Merchant app: http://localhost:5174** — sign in with any account,
  register a shop, and take a payment. Show the code to a customer in
  the consumer app to see both sides at once.
- **Admin app: http://localhost:5175** — the operations view. Sign in
  with an account you've promoted to admin
  (`update users set role = 'admin' where email = '…';`); an ordinary
  account is told plainly that it isn't one.

First boot installs dependencies once (the `deps` service) before the
apps start, so it's slower than later starts. Use either Docker or a
local `pnpm install`, not both on the same folder: on Windows/macOS the
two produce different native binaries in `node_modules`.

On Windows, `GETTING-STARTED.md` has the same thing with the paths,
the PowerShell quoting and the failure messages spelled out.

## Repository layout

```
apps/            web-consumer, web-merchant, web-admin (React + Vite)
services/api     modular monolith (Fastify) — one folder per domain module
packages/        design-system, app-kit, shared-types (shared across all apps)
infra/           docker-compose.yml, database migrations
docs/            product, architecture, api, security, privacy, fintech,
                 rewards, ai, testing, deployment
```

## Local development without Docker

```bash
corepack enable
pnpm install
pnpm --filter @fintech-network/api dev     # API on :3000
pnpm --filter web-consumer dev             # Consumer app on :5173 (proxies /api to :3000)
```

Postgres is still required for anything beyond the health check — run it
via `docker compose -f infra/docker-compose.yml up postgres` or point
`DATABASE_URL` at your own instance. Apply migrations before using the API:

```bash
pnpm --filter @fintech-network/api migrate up
```

## Auth (Phase 2)

- `POST /api/v1/auth/register` — `{ email, password }` → creates a
  **consumer** account (no public path to merchant/admin) and returns a
  bearer token.
- `POST /api/v1/auth/login` — `{ email, password }` → bearer token.
- `GET /api/v1/users/me` — requires `Authorization: Bearer <token>`.
- `GET /api/v1/admin/ping` — demo RBAC route; 401 with no token, 403 for
  a non-admin, 200 for an admin. There's no public way to create an admin
  account yet, so exercising the 200 case means setting a user's `role`
  to `admin` directly in the database for now.

Passwords are hashed with bcrypt, never stored in plaintext. Every
register/login/denied-access event is written to `audit_events`
(spec §16 Audit System).

## Ledger (Phase 3)

- `GET /api/v1/accounts/me` — requires a bearer token. Returns the
  caller's simulated account and its balance in minor units (pence).
  The account is created the first time it's asked for.
- Every new consumer is seeded with a £500.00 starting balance on
  registration, funded from a `seed_funding` system account — so the
  books balance from the very first transaction, never money appearing
  from nowhere.
- The ledger is double-entry and append-only (spec §10): balances are
  always derived by summing `ledger_entries`, never stored as a mutable
  column. `services/api/src/modules/ledger/index.ts` is the **only**
  code allowed to write to `ledger_accounts` / `transactions` /
  `ledger_entries` — every other module goes through its exported
  functions (`getOrCreateAccountForOwner`, `postTransaction`,
  `getBalanceMinorUnits`, …), so the schema underneath can change later
  without rewriting callers.
- `postTransaction` rejects any set of entries that doesn't sum to zero
  debits = credits, before it opens a database transaction.

## Payments (Phase 4)

A payment is two steps, so the payer always sees what they're agreeing to
before anything moves (spec §9):

1. `POST /api/v1/payments` — `{ recipientEmail, amountMinorUnits, purpose? }`
   creates the payment and runs risk evaluation. Response status is
   `APPROVED` (passed risk, waiting for the payer) with the risk level and
   reasons. No money has moved.
2. `POST /api/v1/payments/:id/confirm` — `{ acknowledgeRisk? }` moves it
   through `PROCESSING` to `COMPLETED` (or `FAILED` with a
   `failureReason` such as `INSUFFICIENT_FUNDS`). A HIGH-risk payment is
   refused with `RISK_ACKNOWLEDGEMENT_REQUIRED` until the payer resends
   with `acknowledgeRisk: true`.

Also: `POST /api/v1/payments/:id/cancel` (before confirming only),
`GET /api/v1/payments/:id`, `GET /api/v1/payments`.

How it's put together, and what's swappable:

- `modules/payments/stateMachine.ts` — the only list of legal status
  changes. Every update goes through it.
- `modules/payments/provider.ts` — `PaymentProvider` interface.
  `SimulatedPaymentProvider` is the only implementation and moves no
  real money. A real provider implements the same interface.
- `modules/payments/risk.ts` — the `RiskEvaluator` interface. The real
  deterministic engine behind it arrived in Phase 12 (see below); the
  placeholder that rated everything LOW is kept only for tests that
  need risk held still.
- Implementations are chosen in one place: `buildApp({ paymentProvider,
  riskEvaluator })` in `src/index.ts`.
- On confirm, the ledger posting and the move to `COMPLETED` commit in
  one database transaction, with the payer's account row locked while
  funds are checked, so concurrent payments can't overspend. The database
  also refuses a `COMPLETED` payment with no ledger transaction.
- Confirming twice is safe: a completed payment is returned as-is.
- A payee only sees a payment once it's completed; someone who is
  neither payer nor payee gets a 404 for any payment id.
- Request bodies are validated strictly: no type coercion (`"2000"` is
  rejected), unknown fields are rejected, and amounts must be whole
  pence between 1 and 1,000,000 (£10,000).

## Receipts and history (Phase 5)

- Every payment gets one **receipt** the moment it completes. It's
  written in the same database transaction as the payment and ledger
  entries, so a completed payment always has a receipt, and a failed one
  never does.
  - `GET /api/v1/receipts/:id`, or `GET /api/v1/payments/:id/receipt`.
  - Payer and payee can both open it, each seeing their own side.
    Anyone else gets a 404.
  - Receipt numbers look like `RCP-7KQ2MX9TRA4P`. They skip 0/O and 1/I
    so they can be read aloud.
  - Names, amount and purpose are fixed at the time of payment. The
    payment's current status (e.g. a later refund) is shown live.
  - Each receipt carries a long random Payment Passport reference. The
    verification view that uses it comes later (`passport.available` is
    `false` until then).
- `GET /api/v1/transactions?limit=&cursor=` is the **activity feed**:
  newest first, built from the ledger, with the balance after each item,
  who the payment was with, its purpose and receipt. Page through with
  the `nextCursor` value. Failed payments aren't listed because no money
  moved.
- Receipts, ledger entries and ledger transactions can't be edited or
  deleted, even directly in the database: a trigger refuses it.
- Each ledger transaction now has a `kind` (`seed`, `payment`,
  `adjustment`). New kinds (refund, cashback) only need adding to the
  `TransactionKind` type in the ledger module, with no schema change.
- `src/routes/transactions.ts` owns no data. It only combines the ledger,
  payments and receipts modules' functions, so any of them can change
  internally without it changing.

## Consumer app

`apps/web-consumer` is the first real screen set, built for phones first:

- **Welcome** — create an account or sign in.
- **Home** — balance, a prompt when someone has asked you for money,
  Pay/Request/Scan/Split, recent activity, and a note that rewards are
  coming.
- **Pay** — amount, recipient email and an optional purpose, then a
  review screen (recipient, purpose, safety check, "nothing has been
  sent yet"), then a result screen with a link to the receipt. It warns
  before you try to send more than your balance. A high-risk payment
  shows a scam warning and a checkbox that must be ticked first.
- **Activity** — grouped by day, with the balance after each item and
  "show older" paging. Rows with a receipt open it.
- **Receipt** — number, date, from/to, purpose, live status, the Payment
  Passport placeholder, and print/save as PDF.
- **Profile** — account details, a prototype notice, and sign out.

Works in light and dark mode, keeps text at 16px+ in inputs (no iOS
zoom), labels every field for screen readers, and never scrolls
sideways at 360px wide.

How it's put together, so screens can change without rewrites:

- `packages/design-system` holds every visual piece: colour and spacing
  tokens, `styles.css`, and components (`AppShell`, `Button`,
  `TextField`, `AmountField`, `BalanceCard`, `TransactionRow`,
  `DetailList`, `Alert`, `Badge`, …). Screens don't carry their own CSS.
  Rebranding is a token change.
- Money is shown and read with `formatMoney` / `parseMoneyInput`, which
  use whole pence and string handling only — never floating point.
- `apps/web-consumer/src/api/client.ts` is the only code that calls the
  API. `src/nav.ts` decides which features are switched on. The app
  name comes from `VITE_APP_NAME`.
- The dev server forwards `/api` to the API (`API_PROXY_TARGET`,
  default `http://localhost:3000`), so the browser never makes
  cross-origin calls.
- The sign-in token is kept in `sessionStorage` (lost when the tab
  closes). Fine for a local prototype; should become an httpOnly cookie
  before anything real.

## QR payments (Phase 6)

Getting paid:

- `POST /api/v1/payment-requests` — `{ amountMinorUnits, purpose?, expiresInMinutes?, toEmail? }`.
  Returns a short `code` (REQ-XXXXXXXX), a long random `token` and an
  expiry (30 minutes by default, 7 days maximum). With `toEmail` it's a
  direct request instead — see Phase 7 below.
- In the app: **Request** → "Show a QR" → amount → "Create QR code". The QR encodes
  `<origin>/pay/r/<token>`, so any camera app opens it too. The screen
  polls and flips to "Paid" by itself, with a link to the receipt.
- `GET /api/v1/payment-requests`, `GET /api/v1/payment-requests/:id`,
  `POST /api/v1/payment-requests/:id/cancel` — owner only.

Paying:

- `GET /api/v1/payment-requests/resolve/:key` — `key` is the token or the
  code (any case). Returns who's asking, how much and what for, and never
  the token or anything about other payers.
- `POST /api/v1/payment-requests/:id/pay` → a payment to review, then the
  normal `confirm` step. Amount and payee come from the stored request,
  so a doctored QR can't change them.
- In the app: **Scan** uses the camera, or a photo of the code, or the
  typed code. The camera needs HTTPS (or localhost), so over a plain
  http:// address on a phone, use the photo or code instead.

Rules:

- A request can be paid **once**. Two people can both scan and start
  paying; the first confirm wins and the other payment fails with
  `PAYMENT_REQUEST_ALREADY_PAID`, having moved no money. The winner is
  decided by flipping the request `OPEN -> PAID` inside the paying
  transaction.
- Cancelled or expired requests can't be paid, including by a payment
  that started while the request was still open. Expiry is worked out
  when read, so nothing has to run on a schedule.
- Paying your own request is refused.

How it extends without rewrites:

- `payments` gained **completion hooks**: functions run inside the same
  transaction that completes a payment. Marking a request paid is one.
  Phase 10's cashback will be another, added to the list in
  `buildApp` — the payment flow itself won't change.
- A hook can throw `PaymentBlockedError(code)` to stop a payment: it
  rolls back and ends `FAILED` with that code.
- Requests store the payee as (type, id) like the ledger does, so
  merchant-owned requests (Phase 9) need no schema change, and the
  `channel` column already separates QR from Phase 7's direct requests.

## Asking a person (Phase 7)

The same request, sent to someone by name instead of shown as a QR.
One table, one payment flow; `channel` is what differs.

- `POST /api/v1/payment-requests` with `toEmail` → `channel: "direct"`,
  addressed to that person, open for 7 days by default. An address
  nobody has registered, and your own address, are both refused with
  `PAYMENT_REQUEST_INVALID_RECIPIENT` and the same wording, so this
  can't be used to find out who has an account.
- `GET /api/v1/payment-requests/incoming` — your inbox, plus
  `waitingCount` for the prompt on Home. It never carries the `token`.
- `POST /api/v1/payment-requests/:id/decline` — recipient only, audited
  as `PAYMENT_REQUEST_DECLINED`. Declining is the recipient saying no;
  cancelling stays the requester withdrawing it.
- Paying is the same two steps as a QR (`/pay`, then `confirm`), so the
  review screen, the risk check and the ledger path are shared.
- In the app: **Request** → "Ask a person" → amount and email. The
  requester's screen updates itself to Paid or Declined. The person
  asked sees a prompt on Home and a **Requests for you** screen with
  Review and pay / Decline.

Who can see and do what:

- A direct request is visible only to the two people named on it.
  Anyone else — including someone holding its code or id — gets the
  same 404 as a request that doesn't exist.
- Only the person it was sent to can pay it; the requester gets
  `PAYMENT_REQUEST_NOT_FOR_YOU` (403). The database enforces this too
  (`payment_requests_direct_payer_is_target`), and the completion hook
  re-checks the target inside the paying transaction.
- A payment started before the request was declined or cancelled fails
  on confirm and moves nothing.
- Scanning is unchanged: the scanner still accepts only a QR token or a
  REQ- code, never a request id.

## Splitting a bill (Phase 8)

A split is bookkeeping on top of Phase 7, not a new way to move money:
the organiser keeps their own share and everyone else gets an ordinary
direct payment request, paid through the same two steps as any other.

- `POST /api/v1/bill-splits` — `{ totalMinorUnits, purpose?, participantEmails[],
  shareMinorUnits?, includeOrganiser?, expiresInMinutes? }`. Creates the
  split and every share in one transaction, so a split can't exist
  half-made. Up to 20 people.
- `GET /api/v1/bill-splits` (yours), `GET /api/v1/bill-splits/:id`
  (everyone named on it), `POST /api/v1/bill-splits/:id/cancel`
  (organiser).
- In the app: **Split** → total, what it's for, who was there. The
  preview shows what each person will owe before anything is sent. The
  split's own screen shows who has paid, declined or not answered yet,
  and updates itself while you watch.

The money rules:

- Shares are whole pence and always add up to the total. £10 between
  three is 334 / 333 / 333 — the odd pennies go to the organiser, not
  into thin air. The rule lives in one pure function
  (`services/api/src/modules/billSplits/shares.ts`) with the app
  mirroring it for the preview only (`apps/web-consumer/src/lib/split.ts`,
  tested against the same examples); the server's answer is what the
  requests are made from.
- Exact amounts can be given instead, and are refused unless they add up
  to the total to the penny — nothing is quietly adjusted to fit.
- Cancelling a split calls off the shares nobody has answered. Anything
  already paid stays paid and stays on the ledger.
- A split is "settled" when nobody still owes anything: worked out from
  the shares when read, so nothing runs on a schedule. Declined counts
  as answered, not paid.
- A share is a normal request, so only the person it was sent to can pay
  it, and it appears in their inbox marked as part of a split.

## Shops (Phase 9, first half)

A shop is a payee, not a login. Nobody signs in "as a shop": a person
signs in as themselves and acts for a shop they're a member of, so the
audit trail says which person took the money. A merchant owns a ledger
account exactly as a person does, which the ledger has allowed since
Phase 3 — paying a shop travels the same double-entry path as paying a
friend.

- `POST /api/v1/merchants` — `{ legalName, tradingName, contactEmail }`.
  The creator becomes its first owner and the shop's ledger account is
  opened, in one transaction. Trading names are unique, since a QR code
  gives the customer nothing else to go on.
- `GET /api/v1/merchants` (yours), `GET /api/v1/merchants/:id`,
  `/account` (balance), `/activity` (takings, same paging as personal
  activity), `/payment-requests` (the till's charges),
  `GET|POST /members`.
- `POST /api/v1/payment-requests` takes `asMerchantId`: the same QR
  charge as Phase 6, taken for the shop instead of for you.

Who can do what:

- Membership is the only thing that authorises acting for a shop. Not
  being a member looks exactly like the shop not existing (404), so
  shop ids can't be probed.
- Owners can add staff and other owners; staff can take money but not
  change the team (403 `MERCHANT_OWNER_ONLY`).
- A colleague can see and cancel a charge someone else rang up.
- A suspended shop can't take money, including through a QR printed
  earlier, but can still see what it took.
- A receipt opens for both sides: the customer, and anyone who works at
  the shop that was paid.

**No business checks are run.** There is no KYB, no company-number
lookup, no document upload and no sanctions screening, so `verification`
only ever says `unverified`. The customer-facing wording says exactly
that — "has an account on this network. We haven't checked the business
itself" — and must keep saying it until real onboarding exists. Real
merchant onboarding is a regulated process and is out of scope here.

## The merchant app (Phase 9, second half)

`apps/web-merchant` is the till. Sign in as yourself, and:

- **Shops** — register one (trading name, registered name, contact), or
  pick between the ones you work for. The screen says plainly that
  registering proves nothing about the business.
- **Till** — what's in the till, one button to take a payment, charges
  still waiting, and recent takings.
- **Take a payment** — amount and what it's for, then a QR code and a
  typeable `REQ-` code. The screen watches for the payment and flips to
  "Paid" by itself, with a link to the receipt. A charge can be called
  off before anyone pays it.
- **Takings** — everything the shop has taken, grouped by day, with the
  balance after each one and "show older" paging.
- **Team** — who can work the till. An owner can add staff or another
  owner; staff see the same list but can't change it.
- **Shop** — the shop's details, the unverified notice again, switching
  shop, and signing out.

The QR points at the *customer's* app, not the till's, so scanning it
with any camera opens the right place. Set `VITE_PAY_ORIGIN` per
environment (docker-compose sets it to the consumer app).

Both apps share `packages/app-kit`: the HTTP client, the sign-in
session, the `useAsync` hook and the date/status wording. Each app keeps
its own endpoints, screens and navigation. The two apps use different
storage keys, so a shopkeeper can be signed in to both at once.

## Cashback (Phase 10)

The first reward, and deliberately the least clever thing that could
work: **1% back when you pay a shop**, £1 minimum spend, £5 cap per
payment. Paying a person earns nothing.

- The rule is a pure function
  (`services/api/src/modules/rewards/rules.ts`): whole pence, integer
  arithmetic only — `(pence × basis points) / 10000`, rounded **down**,
  never `amount * 0.01`. It is deterministic, and nothing about a
  reward is decided by a model.
- It's granted by a **payments completion hook** — the extension point
  built in Phase 6 — so the payment flow itself didn't change to make
  room for it. It runs inside the transaction that completes the
  payment, so the money and the record commit together.
- The money is ordinary ledger movement: a transaction of kind
  `cashback` from a `cashback_reserve` system account to the person, so
  the books still balance and cashback never appears from nowhere. The
  reserve's balance goes negative — that is the cost of the scheme.
- Every grant stores the rate and the rule's version that made it, so
  changing the rate later can never quietly rewrite what someone was
  already given. Grants are immutable, like receipts and ledger entries.
- `payment_id` is unique on the grant, so cashback is payable once per
  payment however often the hook runs.
- `GET /api/v1/rewards/cashback` — what you've earned and what's on
  offer. The app shows the server's rate, never a number of its own.

**A reward must never cost someone a payment.** The hook does its work
inside a `SAVEPOINT`; if anything at all goes wrong it rolls back to
that savepoint, lets the payment complete without cashback, and records
`CASHBACK_FAILED` in the audit trail. There's a test that deliberately
breaks the grant and proves the payment still goes through.

Cashback appears in activity as its own line ("Cashback"), not as a
payment, and on Home as what you've earned so far.

## The rewards tree (Phase 11)

What cashback grows into. The **Rewards** tab shows a tree that grows
through seven stages — Seed, Sprout, Seedling, Sapling, Young tree,
Tree, Old oak — with the stage, the progress bar and the whole ladder
of thresholds all worked out by the server.

- `GET /api/v1/rewards/tree` returns the tree and every stage, so the
  app never repeats a threshold or a rate in a screen.
- It is **derived, never stored**: the stage is counted from
  `cashback_grants` at read time. Those grants are immutable and tied
  to ledger entries, so the tree can't drift from the money and there's
  no second score to keep in step. An integration test checks the tree
  against the grants table it came from.
- The maths is a pure function
  (`services/api/src/modules/rewards/tree.ts`): stages move exactly at
  their threshold and never a penny before, progress is floored so it
  can't read 100% before it's true, and the tree never goes backwards.
- One leaf is drawn per payment that earned something, capped for the
  picture; the real count is still reported.
- The tree is drawn as inline SVG from the numbers the server sent, so
  it works in light and dark with no second asset.

**It is only a picture.** No real tree is planted and nothing is
donated. The wording that says so comes from the API, so no client can
soften it.

## The risk engine (Phase 12)

Every payment is rated LOW, MEDIUM or HIGH before the payer is asked to
confirm it. A HIGH rating warns and requires an explicit
acknowledgement; it does not block. Stopping someone from moving their
own money is also a harm, so the engine's job is to make sure nobody
sends a large sum to a stranger *without noticing*.

Three commitments, which are why this seam has existed since Phase 4:

- **Deterministic.** `services/api/src/modules/risk/rules.ts` is a pure
  function over signals: no randomness, no clock, no network. Same
  signals in, same answer out.
- **Auditable.** Every rule has a name and a weight. Each decision is
  written to `risk_assessments` with the score, which rules fired, and
  **the signals as they stood at the time** — a payer's history moves
  on, so storing the signals is what makes a decision explainable later
  rather than merely repeatable. Assessments are immutable, and the
  payment records which evaluator judged it (`risk_evaluator`).
- **Never a model.** Nothing behind this interface may be an LLM. A
  model can't be held to a rule, reproduced, or explained to someone
  whose payment it stopped.

The rules encode how authorised-push-payment scams actually look:
a payee never paid before, a sum far larger than the payer's usual, a
payment that empties the account, a burst of payments in an hour, a new
account sending a lot. Paying a registered shop skips the rules about
knowing a person — a shop can be found again; a stranger can't.

What the payer sees is the level and the reasons, in plain words
("You haven't paid this person before"). The score and the rule names
stay internal: publishing them would teach anyone paying attention how
to stay under a threshold.

If the engine can't reach a decision, the payment **fails closed** —
it's marked FAILED with `RISK_EVALUATION_ERROR` and no money moves.

## The assistant (Phase 13)

A read-only explainer for your own account, on **Ask** (`/assistant`,
linked from Home and Profile). It answers questions in plain words —
your balance, what you've spent in the last thirty days, cashback
earned, who's asking you for money, your last payment, and why a
payment was flagged.

It cannot move money, approve anything, or change a row. That isn't a
promise made in a prompt; it's the shape of the code:

- **It never calculates money.** Answers are templates with named
  placeholders. A template containing a digit, a currency symbol or a
  percent sign is rejected outright by `assertNoLooseFigures`. The
  values are substituted at the very end, from integers the domain
  modules returned — so every figure a person reads came out of the
  ledger, not out of a sentence.
- **It never decides.** There is no assistant route that changes
  anything, and nothing it can reach writes. Its strongest move is a
  link to a screen where the person does it themselves, and those links
  are checked against an allow-list.
- **It reads only what the question needs.** A deterministic classifier
  decides which question was asked *before* anything is looked up, and
  only that intent's facts are read, always scoped to the asker.
- **It keeps no transcript.** The conversation lives in the screen's
  state and goes when you leave. The audit trail records the intent, the
  model and which figures were quoted — never the question or the
  answer.

`AssistantModel` is the seam a language model would plug into. It
receives the question, the intent and the figure *names*, and returns
prose plus links — there is no field in that type for an amount, a
decision or an action. If a draft quotes a figure it wasn't given,
writes a number of its own or links outside the app, it is thrown away,
the deterministic answer goes out instead, and the rejection is filed as
`ASSISTANT_DRAFT_REJECTED`. The prototype ships with no model at all:
`DeterministicAssistant` writes fixed wording, and every answer says who
wrote it in `provenance`.

Four things it refuses by design, each its own intent so the refusal is
testable: moving money, financial advice, anyone else's account, and a
verdict on whether a particular person is genuine. A scam worry gets
what to *do* instead — check on a channel you already had, take your
time, and know that a sent payment can't be pulled back.

Full argument and limits: `docs/ai/README.md`.

## Security hardening (Phase 14)

The session moved out of `sessionStorage` and into an httpOnly cookie —
one a script on the page cannot read, which is the point. The end-to-end
test asserts `document.cookie` doesn't contain it.

A cookie is ambient, though: the browser sends it on requests the page
never meant to make. Two locks answer that — `SameSite=Strict`, and an
origin check at the door, so a cookie is honoured only when the request
came from one of this deployment's own apps (`ALLOWED_ORIGINS`) or from
something that isn't a browser at all. `Authorization: Bearer` still
works for API clients and tests; it carries no ambient authority, so
neither lock applies to it.

Cookies ignore port numbers, so each app declares itself
(`X-Session-Scope`) and gets a cookie of its own name — otherwise the
consumer app and the till would share one session on a developer's
machine. Signing out is a real endpoint now, because only the server can
tell a browser to drop an httpOnly cookie.

Four more things this phase closed:

- **Sign-ins are throttled per account**, not just per client, counted
  from the audit trail that was already being written — so the thing
  that holds an account off and the record you'd read afterwards can't
  disagree. Failures against addresses that were never registered count
  too, or the throttle would answer "does this account exist?".
- **Naming addresses that don't exist stops being free.** A payer must
  be told when they've mistyped one, so it can't be made opaque; after
  ten misses in an hour they're told nothing more, and every miss is on
  file.
- **An approval goes stale.** A payment left on the review screen past
  fifteen minutes can't be confirmed — its risk decision was made
  against a balance and a history that have moved on. It fails with
  `APPROVAL_EXPIRED`, nothing moves, and the payer starts again.
- **A misconfigured production deployment won't start.** No secret, the
  sample secret, a short secret, no `ALLOWED_ORIGINS`, a wildcard or a
  plain-http origin — all refused at boot, all reported at once.

What's still open — no server-side session revocation, no second factor,
no password reset — is listed with the rest in `docs/security/README.md`.

## Observability (Phase 15)

Two health endpoints, because an orchestrator asks two different
questions: `GET /health` is liveness and must *not* touch the database
(if it did, one database blip would restart every instance at once), and
`GET /health/ready` is readiness and must, answering 503 rather than
throwing.

`GET /metrics` is Prometheus text format carrying **traffic only** —
requests by method, route and status, and a duration histogram. Money
and decisions are deliberately not counted there: an in-process counter
resets when the process does, which is fine for traffic and a lie about
a ledger. Route labels are patterns (`/api/v1/payments/:id`), never the
path with the id in it — unbounded cardinality on one side, and quietly
publishing who paid what on the other.

Logs are structured JSON carrying the request id that also appears in
every error response, and `authorization`, `cookie`, `set-cookie`,
`password` and `token` are redacted at the logger.

**The operations view** — `GET /api/v1/admin/overview`, admin only,
read-only — answers what nothing could answer before: whether the books
balance (checked live, not reported from a stored number), what the
cashback reserve has paid out and what it is therefore costing, what the
risk engine is deciding and which of its rules actually fire, what's
failing and why, and what security has seen. The module owns no tables:
every figure comes through the owning module's exported function.

**The admin app is a real app now** (`apps/web-admin`, port 5175) — a
screen over that view, and the last placeholder shell in the repo. It
signs in like the others, has no way to create an account (there is no
public path to an admin account, by design), and tells an ordinary
account plainly that it isn't an administrator rather than showing it a
screen full of refusals. Promote an account with
`update users set role = 'admin' where email = '…';`.

`docs/deployment/README.md` has the detail, including what's still
missing: no tracing, no alerting rules, no log shipping.

## CI/CD (Phase 16)

Everything above has been run by hand at the end of every phase since
Phase 1. `.github/workflows/ci.yml` now runs it whether anyone remembers
to or not, on every push to `main` and every pull request, in jobs split
by what they *need* rather than what they are — so a type error comes
back in about a minute instead of queueing behind a browser suite.

- **checks** — migration gate, typecheck, unit tests, build. No database.
- **integration** — Postgres service container, migrations applied, the
  full integration suite.
- **e2e** — the same plus Chromium, driving all three apps; traces kept
  for a week on failure only.
- **migrations** — an *empty* database, every migration in order, then
  the newest rolled back and forward. Catches a migration that only
  works against a database with last month's data in it, and a `down`
  that was never tried — which otherwise gets discovered during an
  incident, when rolling back is the only thing anyone wants.
- **image** — builds the API image. Not pushed: there's no registry for a
  prototype that moves no real money, and wiring one up before there's
  somewhere to deploy would be pipeline theatre. It proves the image
  still builds, which is the part that quietly rots.

```bash
pnpm verify   # exactly what CI runs, in the same order
```

That command exists so "it passed locally" and "it passed in CI" mean
the same thing.

**The additive-migration gate** (`scripts/check-migrations.mjs`) fails
the build if a migration's `up()` drops, renames or retypes anything,
raw SQL included. `down()` may do as it likes — that's what a rollback
is. The rule isn't fussiness: a migration that removes something breaks
the running version of the API the moment it lands, because the old code
is still serving requests while the new schema is in place. A deliberate
removal says so in the file, in a comment containing
`DESTRUCTIVE-MIGRATION-APPROVED` — one greppable, reviewable line.

**Images.** `services/api/Dockerfile` builds the API: multi-stage, dev
dependencies pruned, runs as `node` rather than root, healthcheck on
liveness. `apps/Dockerfile` builds any of the three front ends
(`--build-arg APP=web-merchant`) into static files behind nginx, which
also forwards `/api` — same origin, because the session cookie is
`SameSite=Strict` and a cross-origin API would silently sign everyone
out.

What there deliberately isn't: a linter, a coverage threshold, and flake
retries. `docs/testing/README.md` says why.

## Cloud architecture (Phase 17)

The last phase on the roadmap, and mostly a written one: how this would
be deployed, and what would have to change first.
`docs/architecture/README.md` has it. `infra/docker-compose.prod.yml` is
the same arrangement on one machine — built images rather than a source
volume and a dev server, migrations as a job that completes before the
API starts, the database published to nothing, every secret from the
environment with no default to fall back on, and the admin app bound to
loopback because an operations view has no business facing the internet.

Two things in that design are worth repeating here because they're
constraints, not preferences. The apps and the API must be
**same-origin** — the session cookie is `SameSite=Strict`, so
`app.example.com` calling `api.example.com` means the browser quietly
dropping it; path-route `/api` at the load balancer instead. And
**migrations run once, as a deploy step**, never on API start-up, or
every replica races to alter the same schema; the additive-only rule is
what makes applying them while the old version still serves traffic
safe, and it's the same rule that makes rollback just a redeploy.

**Preflight** is the deploy's first step:

```bash
pnpm --filter @fintech-network/api preflight
```

It asks whether this environment is configured to run in production,
whether the database can be reached, and which migrations are pending —
and answers before anything is taken down. It exits non-zero on the
first two; pending migrations are reported rather than refused, because
applying them is the next step.

The document ends with the part that matters most: what would have to
change before any of this touched real money — FCA authorisation and
client-money safeguarding, real payment rails, KYC/AML (the risk engine
is not an AML control and must never be presented as one), KYB on shops,
session revocation, a retention and deletion policy, and a tested
restore. Those are prerequisites, not improvements.

## Testing

```bash
pnpm test                                           # unit tests, no DB needed
pnpm --filter @fintech-network/api test:integration  # needs DATABASE_URL + JWT_SECRET, migrations applied
pnpm e2e                                            # browser tests of the consumer app (same env)
```

`pnpm e2e` uses Playwright. It starts the API and both apps itself
(API on :3100, consumer on :5180, merchant on :5181, admin on :5182,
with rate limits raised for the test) and starts the API and all three apps (the admin app on :5182 for tests)
and drives a phone-sized Chromium through sign-up,
paying, receipts, activity, QR and direct requests, split bills, a shop
taking a payment on its till, the assistant, validation errors, failed
payments and session handling. One test drives both apps at once, so the till and
the customer really meet. First time on a new machine: `pnpm --filter web-consumer exec
playwright install chromium`.

Optional API settings: `RATE_LIMIT_PER_MINUTE` (default 100),
`AUTH_RATE_LIMIT_PER_MINUTE` (sign-up/sign-in, default 10) and
`WRITE_RATE_LIMIT_PER_MINUTE` (payments and requests, default 30).

## Status

**Phase 17 — cloud architecture. The roadmap is complete.** Auth, RBAC, the double-entry ledger,
two-step payments, receipts, activity, QR payment requests, requests
sent to a named person, split bills, shops, cashback, the rewards tree,
a deterministic risk engine, a read-only assistant and cookie-based
sessions and an operations view are live, with a consumer app, a
merchant app and an admin app driving them, a pipeline that runs
every suite on every push, and a written deployment architecture with a
production-shaped stack to go with it.

Every phase in the specification's roadmap (§29, Phases 0–17) is built.
What remains is not a phase: it is the list below, and the prerequisites
in `docs/architecture/README.md` that stand between a prototype and
anything that touches real money.

Known limitations, carried forward:

- People are still identified by email address, so a request between
  two people shows the other person's address. Shops have proper
  trading names now; chosen display names for people would finish it.
- Nothing notifies anyone: a request is seen when the app is opened.
- A split can't be edited after it's made (no adding a latecomer or
  changing a share) — cancel it and make another.
- Nobody is reminded about a share they haven't answered.
- A payment left at APPROVED is never expired.
- Sessions can't be revoked server-side: a token stays valid until it
  expires, so signing out clears the cookie but doesn't kill the token.
- No second factor, no password reset, no account recovery.
- The Payment Passport verification view isn't built.
- No business checks on shops (no KYB), and no refunds from a shop yet.
- A shop can't be closed, and nobody can be taken off a team.
- The assistant understands questions by regular expression, so an
  unusual phrasing gets "I don't know how to answer that one" rather
  than a wrong answer. It has no memory between questions, and
  "recently" is fixed at thirty days.
- Cashback is funded by the network's own reserve, not by the shop, and
  nothing tops the reserve up — the operations view now reports what it
  has cost, but nothing pays for it.
- The rate is one rule for everyone: no per-shop offers, no campaigns.
- No tracing, no alerting rules and no log shipping; metrics are
  per-instance.
- The tree is the only reward on top of cashback: no streaks, no
  sharing, nothing to spend it on beyond the balance itself.
