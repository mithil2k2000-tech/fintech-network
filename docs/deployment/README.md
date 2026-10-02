# Running it

Three apps, one API, one database. `docker compose up` brings the lot up;
`.env.example` lists every setting, and `docs/security/README.md` covers
the ones that matter for a real deployment.

## Health

| Endpoint | Question | Touches the database |
| --- | --- | --- |
| `GET /health` | Is this process alive? | No |
| `GET /health/ready` | Should traffic come here? | Yes |

The split matters more than it looks. If liveness touched the database,
one database blip would restart every API instance at once — turning a
recoverable outage into a stampede against a database that is already
struggling. Readiness is the one that must ask, because an instance that
can't reach its database can't serve anything; it answers 503 rather
than throwing, so an outage is reported rather than crashing the
process.

## Metrics

`GET /metrics` returns Prometheus text format. It carries **traffic
only**: requests by method, route and status, and a duration histogram.
Those live in the process, reset when it restarts, and are per-instance,
which is fine for traffic and would be a lie about a ledger.

So money and decisions are deliberately *not* counted there. Payments,
cashback and risk outcomes are read live from the tables that own them,
through the operations view below. A counter that resets is the wrong
tool for anything that has to add up.

Route labels are route *patterns* — `/api/v1/payments/:id`, never the
path with the id in it. Two reasons: unbounded label cardinality will
eventually take down the metrics store, and a path with an id in it
quietly publishes who paid what. Anything unmatched collapses to
`unmatched_api` rather than being echoed back.

## Logs

Structured JSON from pino, one line per request, each carrying the
request id that also appears in every error response — so a person
reporting "it said something went wrong, the id was abc123" can be
traced in one search. `LOG_LEVEL` sets the level.

Credentials never reach a log line: `authorization`, `cookie`,
`set-cookie`, and any field called `password` or `token` are redacted at
the logger. A credential in a log is a credential in a backup, a
screenshot and a support ticket.

## The operations view

`GET /api/v1/admin/overview?windowHours=24`, admin only, read-only, and
the admin app (`apps/web-admin`) is a screen over it. It answers the
questions nobody could answer before:

- **Is the ledger sound?** Unbalanced transactions and negative owner
  accounts, counted in the database at the moment you ask.
- **What has cashback cost?** What the reserve has paid out, and its
  balance — which is negative and grows more so, because the reserve is
  funded by nothing. That number is the price of the offer, and it was
  invisible from Phase 10 until now.
- **What is the risk engine deciding?** Assessments by level, and which
  rules actually fire. A rule that never appears is doing nothing; one
  that appears on everything is saying nothing. This still isn't
  calibration — there are no outcomes to learn from — but the
  distribution is finally visible.
- **What's failing, and why?** Payments by status, failures by reason.
- **What has security seen?** Throttled sign-ins, refused admin access,
  expired approvals, rejected assistant drafts.

The module owns no tables. Every figure comes through the exported
function of whichever module owns the data, so this view can be written
without knowing a column name and a schema change doesn't reach it.

## Admin accounts

There is no public path to one, and the admin app does not offer to
create one — that's deliberate, not an omission. An operator promotes an
existing account in the database:

```sql
update users set role = 'admin' where email = 'someone@example.com';
```

The account has to sign in again afterwards, because the role is carried
in the token.

## Still missing

No tracing (no spans, no propagation beyond the request id), no alerting
rules, no log shipping, and no dashboards checked into the repo. Metrics
are per-instance, so a multi-instance deployment needs a scraper that
aggregates them.
