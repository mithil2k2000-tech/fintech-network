# Deploying this for real

What the prototype would become if it were run properly, and — more
useful — what would have to change first. Nothing here has been
deployed; it is a design and it says so. `infra/docker-compose.prod.yml`
is the same arrangement on one machine, so it can be argued with rather
than imagined.

Read `docs/security/README.md` and `docs/deployment/README.md` first;
this page assumes both.

## The shape

```
                    ┌──────────────┐
   browsers ───────▶│     CDN      │  static app bundles, cached hard
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ load balancer │  TLS ends here; /api goes on
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │      API (2+ replicas)  │  stateless; readiness-gated
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   managed PostgreSQL    │  primary + standby, PITR
              └─────────────────────────┘
```

Three app bundles, one API, one database. The apps are static files and
belong on a CDN. The API is stateless — no sessions in memory, no files
on disk, nothing a second replica wouldn't have — so it scales by adding
replicas, and a replica can be destroyed mid-request without anyone
losing money, because every write is a database transaction.

**The apps and the API must be same-origin.** The session cookie is
`SameSite=Strict`, so `app.example.com` calling `api.example.com` would
mean the browser silently dropping it. Serve the API under
`app.example.com/api` — path-routed at the load balancer, the same shape
the Vite proxy and the nginx image already use in development.

## Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Database | container | managed, small | managed, HA, PITR |
| Secrets | `.env` | secret manager | secret manager |
| Data | synthetic | synthetic | synthetic (it is still a prototype) |
| `NODE_ENV` | not production | production | production |

Staging matters more than usual here, because production is the only
place the config guard (Phase 14) does anything: a deployment that isn't
`NODE_ENV=production` never exercises the refusal. Staging should be
production in every respect except size.

## The database

Managed, not a container. The reasons are all the same reason: someone
else should be awake for this. Point-in-time recovery, a standby with
automatic failover, minor version patching, and backups that are
restored on a schedule — a backup nobody has restored is a hypothesis.

Three things this schema needs from whoever runs it:

- **Connection limits.** Each API replica holds a pool; replicas ×
  pool size must stay under the server's limit, or a deploy that doubles
  replicas takes the database down. A pooler (PgBouncer in transaction
  mode) is the usual answer, and this codebase is compatible with one —
  it holds no session state in the connection and takes explicit
  transactions where it needs them.
- **The ledger is append-only and grows forever.** `ledger_entries` is
  the biggest table and every payment adds rows. Partitioning by month
  is the obvious move, and nothing in the code reads it in a way that
  would object.
- **Immutability is enforced by triggers**, not by convention
  (`forbid_mutation` on entries, transactions, receipts, cashback grants
  and risk assessments). Any tooling that bulk-edits rows — a migration
  framework doing a rewrite, an ORM, a well-meaning script — will hit
  those triggers, and that is working as intended.

## Secrets

`JWT_SECRET` and the database credentials come from the platform's
secret manager, injected as environment variables at start-up, never in
an image, a repository or a workflow file. CI's `JWT_SECRET` is a
throwaway string in the workflow file precisely because it guards
nothing.

Rotating the signing secret invalidates every session at once, because a
token is only verified against the current secret. That's acceptable for
an emergency and unpleasant as routine; supporting two secrets during a
rotation window is the fix and isn't built.

## Deploying

```
preflight → migrate → deploy → verify → (rollback)
```

1. **Preflight** (`pnpm --filter @fintech-network/api preflight`) asks
   the three questions worth asking before anything is taken down: is
   this environment configured to run in production, is the database
   reachable, and which migrations are pending. It exits non-zero on the
   first two; pending migrations are reported, not refused, because
   applying them is the next step.
2. **Migrate**, once, as a job that runs to completion — not on API
   start-up, or four replicas would race to alter the same schema. The
   additive-only rule (Phase 16) is what makes this safe to do while the
   old version is still serving: the new schema doesn't break the old
   code.
3. **Deploy** the new replicas. They are gated on `/health/ready`, so
   traffic only reaches one that can actually reach the database.
4. **Verify**: readiness, then the operations view — does the ledger
   still balance, are payments completing, has anything started failing
   for a new reason.
5. **Rollback** is redeploying the previous image. It works precisely
   because migrations are additive: the old code still runs against the
   new schema. A migration that removed something takes that away, which
   is why removing one needs two deploys and a deliberate decision.

## What would have to change before this touched real money

Not a to-do list — a statement of what this prototype is not. Every item
is a prerequisite, not an improvement.

- **Authorisation.** Handling other people's money in the UK needs FCA
  authorisation or an agency arrangement with someone who has it. Client
  money has to be safeguarded — held apart, reconciled daily — and none
  of that exists here. The prototype must not be described as compliant,
  because it isn't.
- **Real payment infrastructure.** `SimulatedPaymentProvider` is a stub
  behind an interface. Real rails bring settlement timing, returns,
  chargebacks, scheme rules and reconciliation — none of which the
  two-step payment flow currently models.
- **KYC and AML.** No identity verification, no sanctions or PEP
  screening, no transaction monitoring beyond a risk engine that exists
  to warn a payer, no suspicious-activity reporting. The risk engine is
  not an AML control and should never be presented as one.
- **KYB on shops.** `verification` can only say `unverified`, and the
  customer-facing wording says exactly that.
- **Session revocation.** A token is valid until it expires; signing out
  clears the cookie but doesn't kill the token. Real money needs a
  session store or short-lived tokens with refresh.
- **Data protection.** A retention policy, a deletion path, a data map,
  a DPIA. The audit trail is append-only by design, which makes "delete
  my data" a question that needs an answer before anyone's real data is
  in it.
- **Resilience.** No disaster-recovery plan, no tested restore, no
  runbooks, nobody on call.

## Smaller things, honestly

- Metrics are per-instance and in-process; a multi-replica deployment
  needs a scraper that aggregates them.
- No tracing, no alerting rules, no log shipping.
- The login throttle and the recipient-lookup limit count rows in
  `audit_events` with a JSON filter. Correct, and it wants an index
  before it is fast at volume.
- No registry or CD: CI builds the image and stops there, because there
  is nowhere to deploy a prototype that moves no real money.
