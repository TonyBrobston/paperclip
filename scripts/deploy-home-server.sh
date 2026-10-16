#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
source_dir="$(realpath "${PAPERCLIP_SOURCE_DIR:-${GITHUB_WORKSPACE:-$HOME/paperclip}}")"
compose_dir="$(realpath "${PAPERCLIP_COMPOSE_DIR:-$HOME/tbro-server/home-automation}")"
state_dir="${PAPERCLIP_DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/paperclip-deploy}"
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -w 60 9 || fail 'Another Paperclip deployment holds the lock.'
[[ -n "${COMPOSE_PROJECT_NAME:-}" ]] || unset COMPOSE_PROJECT_NAME
[[ "$(git -C "$source_dir" rev-parse --show-toplevel)" == "$source_dir" ]] || fail 'Source must be a Git repository root.'
[[ "$(git -C "$source_dir" symbolic-ref --short HEAD)" == master ]] || fail 'Source must be on master.'
[[ -z "$(git -C "$source_dir" status --porcelain)" ]] || fail 'Source checkout must be clean.'
revision="$(git -C "$source_dir" rev-parse HEAD)"
export PAPERCLIP_SOURCE_DIR="$source_dir"
compose=(docker compose --project-directory "$compose_dir" -f "$compose_dir/docker-compose.yml")
"${compose[@]}" config --format json | python3 -c '
import json, os, sys
service = json.load(sys.stdin)["services"]["paperclip"]
build = service.get("build", {})
if not isinstance(build, dict) or os.path.realpath(build.get("context", "")) != os.environ["PAPERCLIP_SOURCE_DIR"]:
    sys.exit("Paperclip build context does not match the selected source checkout.")
if build.get("target") != "production":
    sys.exit("Paperclip must use the production Docker target.")
if service.get("image") != "tbro/paperclip:local":
    sys.exit("Expected the tbro/paperclip:local image.")
if not service.get("healthcheck") or service["healthcheck"].get("disable"):
    sys.exit("Paperclip needs an enabled container health check.")
'
container_id="$("${compose[@]}" ps -q paperclip)"
[[ -n "$container_id" ]] || fail 'Paperclip must already be running in this Compose project.'
old_image="$(docker inspect --format '{{.Image}}' "$container_id")"
docker image tag "$old_image" tbro/paperclip:previous
"${compose[@]}" build --pull paperclip
"${compose[@]}" up -d --no-build --pull never --no-deps --force-recreate --wait --wait-timeout 300 paperclip
printf '%s\n' "$revision" > "$state_dir/last-deployed.tmp"
mv "$state_dir/last-deployed.tmp" "$state_dir/last-deployed"
printf 'Paperclip is healthy at source commit %s\n' "$revision"
