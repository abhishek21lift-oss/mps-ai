#!/usr/bin/env bash
# Hermetic checks for deploy-ai.sh. No Docker, no network, no VPS.
#
# The deploy itself cannot be exercised in CI without the box, but the part
# that silently rots can: the /health parsing and the input guard. The parser
# is the deploy gate, so it gets the cases that have broken gates before
# (whitespace, a missing sha, a sha-shaped string that is not one).
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=/dev/null
source ./deploy-ai.sh

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_sha() {
  local body="$1" want="$2" got
  got="$(printf '%s' "$body" | parse_sha)"
  [ "$got" = "$want" ] || fail "parse_sha($body) = '$got', want '$want'"
}

expect_sha '{"status":"ok","service":"mps-ai","sha":"a0bf02bde67ecedc426f5fe70c5aab3017ce0113"}' \
  'a0bf02bde67ecedc426f5fe70c5aab3017ce0113'
expect_sha '{ "sha" : "abc1234" }' 'abc1234'
expect_sha '{"status":"ok","service":"mps-ai"}' ''
expect_sha '{"sha":"not-a-sha"}' ''

# Usage errors exit 2 (not 1, which means a deploy failure).
set +e
bash ./deploy-ai.sh >/dev/null 2>&1
code=$?
bash ./deploy-ai.sh 'not-a-sha' >/dev/null 2>&1
bad_code=$?
set -e
[ "$code" -eq 2 ] || fail "no argument exited $code, want 2"
[ "$bad_code" -eq 2 ] || fail "invalid sha exited $bad_code, want 2"

echo "deploy-ai.sh self-test: ok"
