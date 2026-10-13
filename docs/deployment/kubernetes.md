# Running it on Kubernetes

The same app on Kubernetes, packaged as a Helm chart, with Prometheus
and Grafana watching it. It runs on a free local cluster (kind), and the
same chart is what a managed cluster such as EKS would install.

```
          your browser  https://app.localtest.me
                │
        ┌───────▼────────┐
        │    Traefik     │  ingress: TLS, host and path routing
        └──┬──────────┬──┘
   /api/*  │          │  everything else
     ┌─────▼────┐ ┌───▼─────────────────────────┐
     │   API    │ │ consumer · merchant · admin │  nginx, static files
     │ (1–3,HPA)│ └─────────────────────────────┘
     └─────┬────┘
     ┌─────▼────┐        ┌────────────────────────────┐
     │ Postgres │        │ Prometheus  ← scrapes /metrics
     └──────────┘        │ Grafana     ← dashboard     │
                         └────────────────────────────┘
```

## What's in the chart

`deploy/helm/fintech-network/`

| Template | What it does |
| --- | --- |
| `api.yaml` | Deployment with liveness on `/health`, readiness on `/health/ready`, rolling updates that never drop capacity; Service; autoscaler; disruption budget |
| `migrations-job.yaml` | Applies migrations once per install or upgrade, as a Helm hook that runs *before* the new API version rolls out |
| `web.yaml` | One nginx Deployment and Service per front end |
| `ingress.yaml` | One host per front end, `/api` on each host to the API so app and API share an origin (the session cookie needs it) |
| `postgres.yaml` | A single PostgreSQL pod with a volume, for local and test clusters only |
| `secret.yaml` | Database URL and signing secret; refuses a signing secret under 32 characters |
| `networkpolicy.yaml` | Only the ingress controller, the front ends and Prometheus may reach the API; only the API and the migration job may reach the database |
| `monitoring.yaml` | ServiceMonitor (Prometheus scrapes the API), alert rules, and the Grafana dashboard |

Hardening on the API and migration containers: non-root, read-only root
filesystem, no privilege escalation, all Linux capabilities dropped, no
service-account token, default seccomp profile.

## Running it locally

Needs Docker Desktop, [kind](https://kind.sigs.k8s.io/), `kubectl` and
`helm`. On Windows run it from Git Bash or WSL:

```
./deploy/kind/up.sh
```

It creates the cluster, builds and loads the four images, installs
Traefik, Prometheus and Grafana, makes a self-signed certificate, and
installs the chart. First run takes ten minutes or so, mostly image
builds. Then:

- https://app.localtest.me — the consumer app (accept the certificate
  warning once). `localtest.me` is a public name that always points at
  127.0.0.1, so there's nothing to add to a hosts file.
- https://till.localtest.me and https://admin.localtest.me
- Grafana: the command and password are printed at the end. The
  dashboard is "FinTech Network API".

`SKIP_MONITORING=1 ./deploy/kind/up.sh` leaves out Prometheus and
Grafana if your machine is short of memory. `./deploy/kind/smoke-test.sh`
checks it from the outside. `kind delete cluster --name fintech` removes
everything.

## Things to try

- **Kill a pod** and watch it come back:
  `kubectl -n fintech delete pod -l app.kubernetes.io/component=api`
  while refreshing the app.
- **Roll out a broken version**: `helm upgrade fintech deploy/helm/fintech-network -n fintech --reuse-values --set image.tag=does-not-exist`.
  The new pod never becomes ready, the old one keeps serving
  (`maxUnavailable: 0`), and `helm rollback fintech -n fintech` puts it right.
- **Watch the metrics move**: use the app for a minute, then look at
  requests by route and latency in Grafana.
- **See the network policy work**:
  `kubectl -n fintech run probe --rm -it --image=postgres:16-alpine -- pg_isready -h fintech-postgres`
  hangs, because that pod isn't the API.

## Checked in CI

`.github/workflows/kubernetes.yml` does what `up.sh` does inside a
GitHub runner on every change to the chart or the app: lints the chart,
validates every rendered object against the Kubernetes and Prometheus
Operator schemas, builds a kind cluster, installs everything, runs the
smoke test (including a real sign-up through the ingress), confirms
Prometheus is scraping the API and Grafana has the dashboard, then
upgrades the release and tests again.

## On a managed cluster later

The chart doesn't change. What does:

- `postgresql.enabled=false` and either `externalDatabase.url` or
  `secrets.existingSecret` (with the secret coming from a secret
  manager, not from Helm values).
- `image.registry` set to the ECR registry the pipeline already pushes
  to, and `image.tag` to a commit SHA.
- A real certificate (cert-manager with Let's Encrypt) instead of the
  self-signed one, and the real host names in `web.apps`.
- metrics-server installed, so the autoscaler has CPU figures to act on.
