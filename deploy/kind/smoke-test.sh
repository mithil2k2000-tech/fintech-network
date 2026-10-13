#!/usr/bin/env bash
# Checks the running local cluster from the outside, the way a user
# arrives: through the ingress, over HTTPS. Used by CI after up.sh.
set -euo pipefail

HOST=app.localtest.me
# --resolve: don't depend on public DNS for localtest.me.
curl_() { curl -sk --resolve "$HOST:443:127.0.0.1" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

code=$(curl_ -o /dev/null -w '%{http_code}' "https://$HOST/")
[ "$code" = 200 ] || fail "GET / returned $code, want 200"
echo "ok   front end served"

code=$(curl_ -o /dev/null -w '%{http_code}' "https://$HOST/api/v1/users/me")
[ "$code" = 401 ] || fail "GET /api/v1/users/me without a session returned $code, want 401"
echo "ok   API reached through the ingress, refuses without a session"

# Any unknown path returns the app's index.html (it's a single-page
# app), so check the content, not the status code.
if curl_ "https://$HOST/metrics" | grep -q http_requests_total; then
  fail "the API's /metrics is reachable from outside"
fi
echo "ok   API metrics not exposed"

# A real round trip through the database: register, then read the
# account the registration funded. Proves migrations ran.
email="smoke-$(date +%s)@example.com"
jar=$(mktemp)
code=$(curl_ -c "$jar" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -H "origin: https://$HOST" \
  -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-123\"}" \
  "https://$HOST/api/v1/auth/register")
case "$code" in 200|201) ;; *) fail "register returned $code" ;; esac
echo "ok   registered $email"

balance=$(curl_ -b "$jar" -H "origin: https://$HOST" "https://$HOST/api/v1/accounts/me")
echo "$balance" | grep -q '50000' || fail "account doesn't show the £500.00 starting balance: $balance"
echo "ok   new account holds the £500.00 starting balance"

echo
echo "Smoke test passed."
