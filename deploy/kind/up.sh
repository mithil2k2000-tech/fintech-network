#!/usr/bin/env bash
# Builds a local Kubernetes cluster with the whole app on it:
#
#   kind cluster -> Traefik ingress -> Prometheus + Grafana -> the chart
#
# Needs docker, kind, kubectl, helm and openssl. Run from the repository
# root:  ./deploy/kind/up.sh        (SKIP_MONITORING=1 to leave out
# Prometheus and Grafana, SKIP_BUILD=1 to reuse images already loaded)
#
# Then open https://app.localtest.me (localtest.me always resolves to
# 127.0.0.1). The certificate is self-signed, so the browser warns once.
set -euo pipefail

CLUSTER=fintech
NS=fintech
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/.local"        # generated secrets; git-ignored
mkdir -p "$STATE"
cd "$ROOT"

step() { printf '\n==> %s\n' "$*"; }

for tool in docker kind kubectl helm openssl; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done

step "Cluster"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config "$HERE/kind-config.yaml" --wait 120s
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  step "Building images"
  docker build -f services/api/Dockerfile -t fintech-network/api:local .
  for app in web-consumer web-merchant web-admin; do
    docker build -f apps/Dockerfile --build-arg APP="$app" -t "fintech-network/$app:local" .
  done
  step "Loading images into the cluster"
  kind load docker-image --name "$CLUSTER" \
    fintech-network/api:local fintech-network/web-consumer:local \
    fintech-network/web-merchant:local fintech-network/web-admin:local
fi

step "Helm repositories"
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

step "Ingress controller (Traefik)"
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
  -f "$HERE/traefik-values.yaml" --wait --timeout 5m

if [ "${SKIP_MONITORING:-0}" != "1" ]; then
  step "Prometheus and Grafana"
  [ -f "$STATE/grafana-password" ] || openssl rand -hex 16 > "$STATE/grafana-password"
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    -n monitoring --create-namespace -f "$HERE/monitoring-values.yaml" \
    --set grafana.adminPassword="$(cat "$STATE/grafana-password")" \
    --wait --timeout 10m
fi

step "TLS certificate for *.localtest.me (self-signed)"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if [ ! -f "$STATE/tls.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$STATE/tls.key" -out "$STATE/tls.crt" \
    -subj "/CN=*.localtest.me" \
    -addext "subjectAltName=DNS:*.localtest.me,DNS:localtest.me" 2>/dev/null
fi
kubectl -n "$NS" create secret tls fintech-tls --cert "$STATE/tls.crt" --key "$STATE/tls.key" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

step "The app"
# Generated once and kept, so an upgrade doesn't change the database
# password under a database that already has one.
[ -f "$STATE/jwt-secret" ] || openssl rand -hex 32 > "$STATE/jwt-secret"
[ -f "$STATE/db-password" ] || openssl rand -hex 16 > "$STATE/db-password"
helm upgrade --install fintech "$ROOT/deploy/helm/fintech-network" -n "$NS" \
  -f "$HERE/values-kind.yaml" \
  --set secrets.jwtSecret="$(cat "$STATE/jwt-secret")" \
  --set postgresql.password="$(cat "$STATE/db-password")" \
  --wait --timeout 10m

kubectl -n "$NS" get pods

cat <<MSG

Ready.
  Consumer app:  https://app.localtest.me
  Merchant app:  https://till.localtest.me
  Admin app:     https://admin.localtest.me
MSG
if [ "${SKIP_MONITORING:-0}" != "1" ]; then
  cat <<MSG
  Grafana:       kubectl -n monitoring port-forward svc/monitoring-grafana 3001:80
                 then http://localhost:3001  (admin / $(cat "$STATE/grafana-password"))
                 Dashboards -> "FinTech Network API"
MSG
fi
echo "  Tear down:     kind delete cluster --name $CLUSTER"
