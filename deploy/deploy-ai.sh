#!/usr/bin/env bash
#
# Deploy mps-ai on the MY PT STUDIO box as its own Compose project, verify the
# commit the process actually serves, and roll back the image if it does not.
#
#   bash deploy/deploy-ai.sh <40-character-commit-sha>
#
# Called by .github/workflows/deploy.yml over SSH, and runnable by hand on the
# box. The verification lives here, not inline in the workflow, because a
# multi-line SSH script block has silently skipped its tail before — see
# 619-erp-backend/scripts/deploy/verify-serving.sh for that post-mortem.
#
# "Container is healthy" is not success: a cached layer, a build that failed
# and left the old image in place, or a compose file resolving elsewhere all
# produce a healthy container serving yesterday's code. So the last thing this
# script checks is that /health names the commit it just built.
set -euo pipefail

REPO_DIR="${AI_REPO_DIR:-/opt/myptstudio/mps-ai}"
REPO_URL="https://github.com/abhishek21lift-oss/mps-ai.git"
ENV_FILE="${AI_ENV_FILE:-/opt/myptstudio/.env}"
MARKER="${AI_DEPLOYED_MARKER:-/opt/myptstudio/.mps-ai-deployed-sha}"
CONTAINER="${AI_CONTAINER:-myptstudio-ai}"
HEALTH_URL="${AI_HEALTH_URL:-http://127.0.0.1:4100/health}"
ERP_CONTAINER="${AI_ERP_CONTAINER:-myptstudio-backend}"
PROJECT="mps-ai"
IMAGE="mps-ai:current"
PREVIOUS_IMAGE="mps-ai:previous"
HEALTH_ATTEMPTS="${AI_HEALTH_ATTEMPTS:-90}"
VERIFY_ATTEMPTS="${AI_VERIFY_ATTEMPTS:-30}"
POLL_SECONDS="${AI_POLL_SECONDS:-2}"

# Same whitespace-tolerant parse as the backend's verify-serving.sh: a future
# pretty-print of the health payload must not turn the deploy gate into one
# that always fails (gates people learn to bypass protect nothing).
parse_sha() {
  sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' | head -1
}

serving_sha() {
  curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null | parse_sha || true
}

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$REPO_DIR/deploy/compose.ai.yml" "$@"
}

# The deploy has already replaced the container by the time this can run, so a
# failure must leave the last known-good image serving rather than nothing.
rollback_and_fail() {
  local reason="$1"
  echo "::error::$reason" >&2
  docker logs --tail 100 "$CONTAINER" 2>/dev/null || true

  if docker image inspect "$PREVIOUS_IMAGE" >/dev/null 2>&1; then
    echo "rolling back to $PREVIOUS_IMAGE"
    docker tag "$PREVIOUS_IMAGE" "$IMAGE"
    compose up -d --no-deps --force-recreate ai || true
    echo "rollback container recreated; /health currently reports '$(serving_sha)'"
  else
    # No known-good image exists (first deploy). Serving an unverified build
    # is worse than serving nothing: nginx gets a clean 502 either way, but a
    # wrong image could answer with the wrong config.
    echo "no previous image; stopping $CONTAINER instead of serving an unverified build"
    compose stop ai || true
  fi
  exit 1
}

main() {
  local target_sha="${1:-}"

  if ! printf '%s' "$target_sha" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "usage: deploy-ai.sh <40-character lowercase commit sha>" >&2
    exit 2
  fi

  [ -f "$ENV_FILE" ] || {
    echo "::error::missing $ENV_FILE" >&2
    exit 1
  }
  # Presence only. The values are never printed, copied or rotated here.
  local key
  for key in OPENROUTER_API_KEY SERVICE_AUTH_SECRET AI_ALLOWED_ORIGINS; do
    grep -q "^${key}=." "$ENV_FILE" || {
      echo "::error::$ENV_FILE has no $key — see docs/DEPLOYMENT.md" >&2
      exit 1
    }
  done

  # The snippet this replaces parked its service on the same host port. If it
  # is still there, `up` would fail after a full build; say so up front.
  local port_holder
  port_holder="$(docker ps --filter 'publish=4100' --format '{{.Names}}' | head -n1)"
  if [ -n "$port_holder" ] && [ "$port_holder" != "$CONTAINER" ]; then
    echo "::error::port 4100 is already published by '$port_holder'; remove the old ai service before deploying" >&2
    exit 1
  fi

  # The network name depends on how the base project was created, so read it
  # off the running backend instead of assuming `myptstudio_network`.
  local network
  network="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$ERP_CONTAINER" 2>/dev/null | head -n1 || true)"
  [ -n "$network" ] || {
    echo "::error::$ERP_CONTAINER is not running, so the ERP network cannot be resolved" >&2
    exit 1
  }
  export AI_NETWORK_NAME="$network"
  echo "deploy: using ERP network $network"

  if [ ! -d "$REPO_DIR/.git" ]; then
    git clone "$REPO_URL" "$REPO_DIR"
  fi
  git -C "$REPO_DIR" fetch --prune origin
  git -C "$REPO_DIR" cat-file -e "${target_sha}^{commit}" 2>/dev/null || {
    echo "::error::commit $target_sha is not present on origin" >&2
    exit 1
  }

  # Keep the image the box is serving now. Tagging by ID (not by name) means a
  # build that replaces :current without ever starting leaves this intact.
  local previous_id
  previous_id="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
  if [ -n "$previous_id" ]; then
    docker tag "$previous_id" "$PREVIOUS_IMAGE"
    echo "deploy: saved current image as $PREVIOUS_IMAGE"
  fi

  # Detached checkout: the box is a deploy target, not a workspace, and this
  # also makes a rollback to an older sha an ordinary deploy.
  git -C "$REPO_DIR" checkout --detach --force "$target_sha"
  target_sha="$(git -C "$REPO_DIR" rev-parse HEAD)"

  export GIT_SHA="$target_sha"
  export BUILD_TIME
  BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "deploy: building $GIT_SHA"
  compose config --quiet
  compose build ai

  echo "deploy: starting container"
  if ! compose up -d --no-deps ai; then
    rollback_and_fail "compose up failed for $GIT_SHA"
  fi

  local attempt status=''
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER" 2>/dev/null || true)"
    if [ "$status" = "healthy" ]; then
      break
    fi
    if [ "$status" = "unhealthy" ] || [ "$status" = "no-healthcheck" ]; then
      rollback_and_fail "container is $status after starting $GIT_SHA"
    fi
    sleep "$POLL_SECONDS"
  done
  [ "$status" = "healthy" ] || rollback_and_fail "container did not become healthy (last: ${status:-absent})"

  local serving=''
  for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++)); do
    serving="$(serving_sha)"
    if [ "$serving" = "$target_sha" ]; then
      break
    fi
    sleep "$POLL_SECONDS"
  done
  [ "$serving" = "$target_sha" ] || rollback_and_fail "expected $target_sha at /health, got '${serving:-no sha}'"

  # Only a verified deploy advances the marker. A rollback keeps naming the
  # last commit that actually served.
  printf '%s\n' "$target_sha" >"$MARKER"
  echo "deploy verified: $CONTAINER is serving $serving"

  # Dangling layers only, scoped to this compose project: tagged images such as
  # mps-ai:previous are never touched.
  docker image prune -f --filter "label=com.docker.compose.project=$PROJECT" >/dev/null 2>&1 || true
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
