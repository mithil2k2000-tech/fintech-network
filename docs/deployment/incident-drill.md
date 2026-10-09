# Incident drill: a release that cannot start

A rehearsal, done on purpose, of the most ordinary kind of outage: a
change that passes every test and still can't run in production. The
point is to watch the safety nets work, and to have written an incident
report about something that really happened.

## The failure

The API refuses to start in production if `ALLOWED_ORIGINS` contains a
plain-`http` origin (`services/api/src/config.ts`). That is a
configuration mistake, not a code one, so CI can't see it: the tests are
green and the image builds. It only shows when a container tries to
start with the real settings.

The Terraform variable `incident_drill_break_api` makes exactly that
mistake.

## What should happen

1. Migrations run and succeed (they don't read that setting).
2. ECS starts a container with the new configuration. It exits at once.
3. ECS tries again, and again. The old container is still running and
   still serving, because the service keeps 100% healthy during a
   deploy — **users should notice nothing**.
4. The deployment circuit breaker gives up and rolls back.
5. The Deploy workflow fails, saying the version was rolled back.
6. You get an email: "Deployment FAILED and was rolled back."

If any of those doesn't happen, that is the finding.

## Running it

Open the dashboard first (`terraform output dashboard_url`), and keep
the consumer app open in a browser so you can use it throughout.

**Break it.** Note the time.

```
cd infra/terraform/app
terraform apply -var="incident_drill_break_api=true"
```

Then Actions → Deploy → Run workflow. Watch, and write down what you
see and when:

- ECS → cluster → `fintech-network-prod-api` → Deployments and Events.
- CloudWatch → `/ecs/fintech-network-prod/api`: the new container's own
  explanation of why it won't start.
- The dashboard: healthy task count, errors.
- The app in your browser: does it keep working?
- Your inbox.

The workflow can take up to ten minutes to fail; ECS retries a few times
before it gives up.

**Fix it.** Note the time.

```
terraform apply
```

Then run the Deploy workflow again and confirm it goes green.

## The write-up

Fill this in from what you recorded. Every time and number should come
from the workflow run, the ECS events or the logs — if you didn't
measure it, leave it out rather than estimating.

```
# Incident report: failed API release, <date>

Summary
  One or two sentences. What was released, what happened, and whether
  users were affected.

Impact
  Did any request fail? (Dashboard: API 5xx, load balancer 5xx.)
  For how long was the new version unavailable to deploy?

Timeline (UTC)
  hh:mm  Change applied
  hh:mm  Deploy workflow started            (workflow run)
  hh:mm  Migrations completed               (workflow run)
  hh:mm  First new task stopped             (ECS events)
  hh:mm  Circuit breaker triggered rollback (ECS events)
  hh:mm  Alert email received               (inbox)
  hh:mm  Workflow failed                    (workflow run)
  hh:mm  Fix applied
  hh:mm  Deploy succeeded

Detection
  What told you first: the workflow, the email, or the dashboard?
  How long after the bad release started?

Root cause
  The exact log line the container printed, and why CI could not have
  caught it.

What went well
  What limited the damage without anyone doing anything.

What didn't
  Anything slower, noisier or less clear than you expected.

Actions
  Changes that would catch this earlier or make it clearer. For example:
  run the API's preflight check against the real configuration before
  deploying; alert on stopped tasks, not only on the final rollback.
```

Commit the finished report as `docs/deployment/incidents/<date>-failed-api-release.md`.
