#!/usr/bin/env bash
# Usage:
#   ./test-api.sh [BASE_URL] [USER1:PASS1] [USER2:PASS2]
#
# Defaults to the Lambda endpoint with placeholders — override from the command line:
#   ./test-api.sh https://g4zeui4e9b.execute-api.us-east-1.amazonaws.com alice:secret1 bob:secret2
#
# For ECS (ALB):
#   ./test-api.sh http://file-a-Alb6F-7tegQQlZWf6A-89572750.us-east-1.elb.amazonaws.com alice:secret1 bob:secret2

set -euo pipefail

BASE_URL="${1:-https://g4zeui4e9b.execute-api.us-east-1.amazonaws.com}"
CREDS_1="${2:-alice:changeme}"
CREDS_2="${3:-bob:changeme}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_1="${SCRIPT_DIR}/fixtures/hello.txt"
FIXTURE_2="${SCRIPT_DIR}/fixtures/data.csv"

PASS=0
FAIL=0

# ── helpers ────────────────────────────────────────────────────────────────────

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }

assert_status() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  if [ "$actual" -eq "$expected" ]; then
    green "  PASS  $label (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    red   "  FAIL  $label — expected HTTP $expected, got HTTP $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"

  if echo "$haystack" | grep -q "$needle"; then
    green "  PASS  $label (found: $needle)"
    PASS=$((PASS + 1))
  else
    red   "  FAIL  $label — '$needle' not found in response"
    FAIL=$((FAIL + 1))
  fi
}

# ── tests ──────────────────────────────────────────────────────────────────────

echo ""
echo "Base URL : $BASE_URL"
echo "User 1   : ${CREDS_1%%:*}"
echo "User 2   : ${CREDS_2%%:*}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Health (no auth)
echo ""
echo "── Health ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health")
assert_status "GET /health" 200 "$STATUS"

# 2. Health body
BODY=$(curl -s "${BASE_URL}/health")
assert_contains "GET /health body" '"healthy"' "$BODY"

# 3. Unauthenticated request → 401
echo ""
echo "── Auth guard ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/files")
assert_status "GET /files without auth → 401" 401 "$STATUS"

# 4. Wrong password → 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -u "${CREDS_1%%:*}:wrongpassword" "${BASE_URL}/files")
assert_status "GET /files wrong password → 401" 401 "$STATUS"

# 5. User 1 — upload hello.txt
echo ""
echo "── User 1 : ${CREDS_1%%:*} ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$CREDS_1" \
  -F "file=@${FIXTURE_1}" \
  "${BASE_URL}/upload")
assert_status "POST /upload hello.txt" 201 "$STATUS"

# 6. User 1 — upload data.csv
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$CREDS_1" \
  -F "file=@${FIXTURE_2}" \
  "${BASE_URL}/upload")
assert_status "POST /upload data.csv" 201 "$STATUS"

# 7. User 1 — list files (should contain both)
BODY=$(curl -s -u "$CREDS_1" "${BASE_URL}/files")
assert_contains "GET /files contains hello.txt" "hello.txt" "$BODY"
assert_contains "GET /files contains data.csv"  "data.csv"  "$BODY"

# 8. User 2 — upload hello.txt (isolated namespace)
echo ""
echo "── User 2 : ${CREDS_2%%:*} ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$CREDS_2" \
  -F "file=@${FIXTURE_1}" \
  "${BASE_URL}/upload")
assert_status "POST /upload hello.txt" 201 "$STATUS"

# 9. User 2 — list files (only their own)
BODY=$(curl -s -u "$CREDS_2" "${BASE_URL}/files")
assert_contains "GET /files contains hello.txt" "hello.txt" "$BODY"

# 10. Namespace isolation — user 2 cannot see user 1's data.csv
if echo "$BODY" | grep -q "data.csv"; then
  red   "  FAIL  Namespace isolation — user 2 should NOT see user 1's data.csv"
  FAIL=$((FAIL + 1))
else
  green "  PASS  Namespace isolation (user 2 does not see user 1's data.csv)"
  PASS=$((PASS + 1))
fi

# 11. Invalid filename → 400
echo ""
echo "── Validation ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$CREDS_1" \
  -F "file=@${FIXTURE_1};filename=../../etc/passwd" \
  "${BASE_URL}/upload")
assert_status "POST /upload path traversal → 400" 400 "$STATUS"

# 12. User 1 — delete data.csv
echo ""
echo "── Cleanup ──"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "$CREDS_1" \
  -X DELETE \
  "${BASE_URL}/files/data.csv")
assert_status "DELETE /files/data.csv" 204 "$STATUS"

# 13. Confirm deletion
BODY=$(curl -s -u "$CREDS_1" "${BASE_URL}/files")
if echo "$BODY" | grep -q "data.csv"; then
  red   "  FAIL  data.csv still present after DELETE"
  FAIL=$((FAIL + 1))
else
  green "  PASS  data.csv removed from listing"
  PASS=$((PASS + 1))
fi

# ── summary ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Passed : $PASS"
echo "  Failed : $FAIL"
echo ""

[ "$FAIL" -eq 0 ]
