#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
source_dir="$(realpath "${PAPERCLIP_SOURCE_DIR:-${GITHUB_WORKSPACE:-$HOME/paperclip}}")"
host_home="${PAPERCLIP_HOST_HOME:?Runner must provide PAPERCLIP_HOST_HOME}"
[[ "$host_home" == /* && "$host_home" != /home/runner ]] || fail 'Expected the deployment user host home.'
compose_dir="$(realpath "${PAPERCLIP_COMPOSE_DIR:?Runner must provide PAPERCLIP_COMPOSE_DIR}")"
work_dir="$(realpath "${PAPERCLIP_RUNNER_WORK:?Runner must provide PAPERCLIP_RUNNER_WORK}")"
[[ "$source_dir" == "$work_dir/"* ]] || fail 'Checkout must be inside the host-visible runner work directory.'
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || fail 'Use the local host Docker socket.'
# Keep Docker/Buildx state writable before Compose switches to the host HOME.
export DOCKER_CONFIG="${DOCKER_CONFIG:-${RUNNER_TEMP:-$HOME}/.docker}"
[[ "$DOCKER_CONFIG" == /* ]] || fail 'DOCKER_CONFIG must be an absolute runner path.'
mkdir -p "$DOCKER_CONFIG" || fail 'Cannot create the runner Docker configuration directory.'
[[ -d "$DOCKER_CONFIG" && -w "$DOCKER_CONFIG" && -x "$DOCKER_CONFIG" ]] || fail 'Runner Docker configuration directory must be writable and searchable.'
export HOME="$host_home"
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
project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' paperclip)"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Cannot identify the running Paperclip Compose project.'
[[ -z "${COMPOSE_PROJECT_NAME:-}" || "$COMPOSE_PROJECT_NAME" == "$project" ]] || fail 'Configured project differs from the running service.'
compose=(docker compose -p "$project" --project-directory "$compose_dir" -f "$compose_dir/docker-compose.yml")
export PAPERCLIP_COMPOSE_DIR="$compose_dir" PAPERCLIP_RUNNER_WORK="$work_dir"
docker inspect "$HOSTNAME" | python3 -c '
import json, os, sys
mounts = json.load(sys.stdin)[0]["Mounts"]
for path in (os.environ["PAPERCLIP_SOURCE_DIR"], os.environ["PAPERCLIP_COMPOSE_DIR"]):
    if not any(m["Type"] == "bind" and m["Source"] == m["Destination"] and
               (path == m["Destination"] or path.startswith(m["Destination"].rstrip("/") + "/")) for m in mounts):
        sys.exit("Deployment paths must be bind-mounted at identical host and container paths.")
'
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
[[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id")" == paperclip ]] || fail 'Selected container is not the Paperclip service.'
[[ "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container_id")" == "$compose_dir" ]] || fail 'Compose directory differs from the running project.'
old_image="$(docker inspect --format '{{.Image}}' "$container_id")"
docker image tag "$old_image" tbro/paperclip:previous
"${compose[@]}" build --pull paperclip
docker run --rm --network none --user node --entrypoint node tbro/paperclip:local /opt/paperclip-browser/smoke.cjs
"${compose[@]}" up -d --no-build --pull never --no-deps --force-recreate --wait --wait-timeout 300 paperclip
"${compose[@]}" exec -T paperclip gosu node node /opt/paperclip-browser/smoke.cjs
printf '%s\n' "$revision" > "$state_dir/last-deployed.tmp"
mv "$state_dir/last-deployed.tmp" "$state_dir/last-deployed"
printf 'Paperclip is healthy at source commit %s\n' "$revision"
