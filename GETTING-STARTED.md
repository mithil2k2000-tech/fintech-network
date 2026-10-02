# Running it on your machine (Windows)

Written for Windows. Everything below runs from the project folder —
wherever you keep it, for example:

```
...\Desktop\Fintech App - Paperless & Cardless\fintech-network-app
```

If your path contains spaces or an **ampersand**, quote it. PowerShell
reads a bare `&` as a command separator:

```powershell
cd "C:\path\to\Fintech App - Paperless & Cardless\fintech-network-app"
```

Unquoted, you'll get `The ampersand (&) character is not allowed` — that
error is the path, not the project.

---

## The short version

With Docker Desktop installed and **running**:

```powershell
cd "C:\path\to\fintech-network-app"
docker compose -f infra/docker-compose.yml up
```

Then open **http://localhost:5173** and create an account. You start with
£500 of simulated money.

The first run installs dependencies inside the container and takes a few
minutes — longer on Windows, where the bind mount is slow. It's finished
when the log stops scrolling and shows the Vite banners for ports 5173,
5174 and 5175. `Ctrl+C` stops everything; `docker compose -f
infra/docker-compose.yml down` cleans up.

Use Docker **or** a local `pnpm install` on this folder, not both: they
produce different native binaries in `node_modules` and the second one
fails confusingly. If you've done both already, delete `node_modules`
and pick one.

## Without Docker

You need Node 22 and a PostgreSQL 16 you can reach. If you have Docker
but would rather run the apps natively, use it for the database alone:

```powershell
docker compose -f infra/docker-compose.yml up postgres
```

Then, in the project folder:

```powershell
corepack enable
pnpm install

# One terminal: the API
$env:DATABASE_URL="postgres://fintech:fintech@localhost:5432/fintech_network"
$env:JWT_SECRET="dev-only-change-me"
pnpm --filter @fintech-network/api migrate up
pnpm dev:api

# A second terminal: the apps
pnpm --filter web-consumer dev    # http://localhost:5173
pnpm --filter web-merchant dev    # http://localhost:5174
pnpm --filter web-admin dev       # http://localhost:5175
```

Each app forwards `/api` to the API itself, so the browser only ever
talks to one origin. That isn't a convenience — the session cookie is
`SameSite=Strict`, and a cross-origin API would be silently dropped.

---

## The tour

**The consumer app — http://localhost:5173**

Create an account with any email (nothing is sent anywhere). You'll have
£500 of simulated money.

1. **Pay someone.** You need a second person: open a *private* window —
   not another tab — and register a second account there. A session is a
   cookie now, so two tabs of the same browser are the same person. Pay
   them, watch the review screen, open the receipt.
2. **Ask for money.** *Request* makes a QR code; *Scan* reads one from a
   photo if the camera won't start (it needs HTTPS or localhost).
3. **Split a bill.** £10 three ways is £3.34 for you and £3.33 each —
   the odd penny goes to the organiser, visibly.
4. **Ask.** The *Ask about your money* card on Home. Try "what's my
   balance", then "pay Sam £50" to watch it refuse.
5. **Trip the risk engine.** Send £450 of your £500 to someone you've
   never paid. It flags it, and the Pay button stays disabled until you
   tick the box.

**The merchant app — http://localhost:5174**

Sign in as yourself, register a shop, put a charge on the till, and pay
it from the consumer app in your other window. The till flips to Paid on
its own, and the payment earns 1% cashback — watch the tree on the
Rewards tab.

**The admin app — http://localhost:5175**

Signing in with an ordinary account tells you plainly that it isn't an
administrator. There's no way to create one from the app, deliberately.
Promote yourself in the database:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U fintech -d fintech_network `
  -c "update users set role = 'admin' where email = 'you@example.com';"
```

Sign out and back in — the role is carried in the session token, so the
old one doesn't know about it. You'll see whether the books balance,
what cashback has cost, which risk rules are actually firing, and what
security has seen.

---

## Running the tests

```powershell
$env:DATABASE_URL="postgres://fintech:fintech@localhost:5432/fintech_network"
$env:JWT_SECRET="dev-only-change-me"
pnpm verify
```

That's the whole sequence CI runs: migration gate, typecheck, unit
tests, build, integration tests, browser tests. The browser tests start
their own copies of the API and all three apps on ports 3100, 5180, 5181
and 5182, so stop nothing — they don't collide with the stack above.

First time only: `pnpm --filter web-consumer exec playwright install
chromium`.

---

## When something breaks

**`The ampersand (&) character is not allowed`** — the folder path.
Quote it, as at the top of this page.

**`error during connect` / `docker: command not found`** — Docker
Desktop isn't running, or isn't installed. It has to be started first;
it doesn't start with Windows unless you've told it to.

**`port is already allocated` / `EADDRINUSE`** — something else is on
3000, 5173, 5174, 5175 or 5432. `netstat -ano | findstr :5173` names the
process id; Task Manager turns that into a name.

**`Refusing to start: this looks like a production deployment…`** —
`NODE_ENV` is set to `production` in that terminal. That refusal is
deliberate (it's what stops a real deployment running on the sample
secret), and locally you just want `NODE_ENV` unset.

**The app loads but everything says "we couldn't load your account"** —
the API isn't up or can't reach Postgres. Check
http://localhost:3000/health/ready; it reports which of the two is
wrong.

**Signing into one app signs you out of another** — expected between two
*tabs of one browser* for the same app. Cookies belong to a browser, not
a tab. The consumer and merchant apps have separate cookies and can be
open together; two different people need two browsers, or one private
window.

**Nothing moves and no money appears** — correct. Every balance here is
simulated, no bank is connected, and nothing in this prototype touches
real money.


---

## Putting it on GitHub

The repository is prepared: `.gitignore` keeps `node_modules`, builds,
logs and any real `.env` out; `.gitattributes` normalises line endings
so a Windows checkout doesn't show every file as modified; and `LICENSE`
states that copyright is retained and no licence is granted.

**Public and all rights reserved are not a contradiction.** Public means
anyone can read it. A permissive licence (MIT, Apache) is what would
give away the right to copy and reuse — so there isn't one here, and
`LICENSE` says so explicitly rather than leaving it to be inferred.

Worth knowing before you push: public means permanently public in
practice. Anyone can read it, GitHub's own terms let other users fork it
within the site whatever the licence says, and it will be scraped. If
any of that isn't what you want, make the repository private instead —
everything below is identical apart from `--public`.

From the project folder:

```powershell
git init -b main
git add .
git commit -m "Project FinTech Network - prototype v0.1"
```

Then create the repository and push. With the GitHub CLI installed:

```powershell
gh auth login
gh repo create fintech-network --public --source . --push
```

Without it: create an **empty** repository on github.com (no README, no
.gitignore, no licence — this repo has all three), then:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/fintech-network.git
git push -u origin main
```

Windows will prompt you to sign in to GitHub the first time; the
credential manager remembers it afterwards.

### One file needs moving first

`ci-workflow.yml` sits at the top of the project folder. GitHub only
runs a workflow from `.github/workflows/`, so move it before committing:

```powershell
mkdir .github\workflows
move ci-workflow.yml .github\workflows\ci.yml
```

(It arrives at the top level because tools that write to your machine
remotely are not allowed to create files under `.github/workflows` —
a file there executes code on every push, which is exactly the sort of
thing that shouldn't be written without you seeing it.)

### What is safe to publish, and why

Nothing in this repository is a credential. The only secret-shaped
string is `dev-only-change-me`, which is a deliberate placeholder: the
API refuses to start in production if that is still the signing secret
(see `services/api/src/config.ts`). Real secrets come from the
environment and have never been in these files. Test data uses
`example.com` addresses.
