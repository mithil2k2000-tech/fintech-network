# Security

What this prototype does to protect a session and an account, and —
just as important — what it does not do. It is not an authorised
financial service, it moves no real money, and nothing here should be
read as a claim that it is ready to.

## The session

Until Phase 14 the signed-in token lived in `sessionStorage`, where any
script on the page could read it. One cross-site-scripting bug and a
session walks out of the door. It now lives in a cookie the browser
marks `httpOnly`, which JavaScript cannot read at all. The end-to-end
test asserts exactly that: `document.cookie` does not contain it.

That trade has a cost, and the rest of the design pays it. A cookie is
*ambient* — the browser attaches it to requests the page never meant to
make, which is what cross-site request forgery exploits. Two locks:

1. `SameSite=Strict`, so the browser won't send it on a request that
   started from another site at all.
2. An origin check at the door. A cookie is honoured only when the
   request says it came from one of this deployment's own apps
   (`ALLOWED_ORIGINS`), or says nothing at all — a request with no
   `Origin` and no `Referer` isn't a browser and has no ambient cookie
   to ride.

The `Authorization: Bearer` header still works, for API clients and
tests. It carries no ambient authority, so neither rule applies to it,
and an explicit credential beats an ambient one when both are present.

**Cookie scope.** Cookies ignore port numbers, so on one machine the
consumer app (:5180) and the merchant app (:5181) share a cookie jar.
Each app therefore declares itself (`X-Session-Scope`) and gets a cookie
of its own name. This is a namespace, not a permission — a session is
the same session whichever name it sits under — and the accepted values
are a fixed list so a client can't invent a cookie name.

**What the app still keeps.** One flag: "someone signed in in this tab".
It is not a credential and opens nothing. Without it the app couldn't
tell an expired session from a first visit — both are a 401 — and would
either greet a new visitor with "your session has ended" or drop a
returning one at the sign-in screen with no explanation.

**Signing out** is a real endpoint now. The app can't drop an httpOnly
cookie itself; only the server can tell the browser to. It needs no
authentication: someone asking to be signed out is always allowed to be,
including after their token has already expired.

## Guessing at accounts

The per-client rate limit doesn't help against an account guessed at
from many addresses, so failed sign-ins are also counted **per account**,
from the audit trail that was already being written. Ten failures in
fifteen minutes and that address is held off, including from the right
password — which is the cost of this defence and the reason the window
is short.

Failures against an address that was never registered are counted the
same way. Otherwise the throttle itself would answer "does this account
exist?", refusing quickly for real accounts and not for others.

Counting from the audit trail rather than a counter of its own means the
thing that decides to hold an account off and the thing you would read
afterwards to explain why are the same record. They cannot disagree. The
cost, said plainly: it is a scan over a JSON field, and at real volumes
it wants an index or a counter in front of it.

## Who is registered

Paying by email address has an awkward property: telling a payer that
nobody holds that address also tells anyone else. The payer has to be
told — they might have typed it wrong — so this can't be made opaque
without breaking the thing it protects.

What it can do is stop being free. A payer who names ten addresses that
don't exist within an hour stops being told anything, and every miss and
every refusal is on file. Someone mistyping an address once is not
affected. Creating a payment request was already opaque (Phase 7): there
the payer has a person in mind, so the same answer serves both cases.

## Stale approvals

A payment left on the review screen used to sit there indefinitely, and
could be confirmed hours later. The risk decision it carried was made
against a balance and a history that had moved on since, and a stale
approval is not an approval. Past fifteen minutes
(`PAYMENT_APPROVAL_TTL_MINUTES`) confirming fails the payment with
`APPROVAL_EXPIRED` and nothing moves; the payer starts it again, against
today's facts.

## Refusing to start

A production deployment that is only configured like a development one
does not come up. `loadConfig` refuses when `JWT_SECRET` is missing, is
still the sample value from `.env.example`, or is shorter than 32
characters; when `ALLOWED_ORIGINS` is unset, a wildcard, or contains a
plain-`http` origin. It reports everything that's wrong at once rather
than one problem per restart.

The dangerous failure here was never a crash — it was a deployment that
quietly ran with the sample secret and localhost origins, looking fine.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | the local apps | Origins CORS allows, and the only origins a cookie is honoured from. Required in production. |
| `SECURE_COOKIES` | off (on in production) | Adds the `Secure` flag. Can only ever add it. |
| `PAYMENT_APPROVAL_TTL_MINUTES` | 15 | How long a started payment may sit unconfirmed. |
| `LOGIN_FAILURE_LIMIT` / `LOGIN_FAILURE_WINDOW_MINUTES` | 10 / 15 | Failed sign-ins per account before it's held off. |
| `RECIPIENT_LOOKUP_FAILURE_LIMIT` | 10 | Unknown addresses one payer may name per hour. |
| `RATE_LIMIT_PER_MINUTE` / `AUTH_…` / `WRITE_…` | 100 / 10 / 30 | Per-client request limits. |

## Still open

- Sessions can't be revoked server-side: a JWT is valid until it
  expires, so signing out clears the cookie but doesn't invalidate the
  token. A session store or short-lived tokens with refresh would fix
  it, and that is a real gap rather than a nicety.
- No second factor, no password reset, no account recovery.
- No CSP beyond helmet's defaults, and the apps are served by a dev
  server rather than anything hardened.
- No secret rotation, no key management, no encryption at rest beyond
  whatever Postgres is given.
- The audit trail is append-only by convention and trigger, but nothing
  signs it or ships it anywhere.
- No KYB on shops, no sanctions screening, no real KYC anywhere: this
  prototype deliberately has none of the checks a regulated service
  would be required to run.
