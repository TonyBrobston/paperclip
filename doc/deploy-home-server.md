# Deploy Paperclip through the Docker runner

Pushes to `TonyBrobston/paperclip:master` and manual dispatch on master deploy the latest master. Jobs serialize through GitHub concurrency and a persistent filesystem lock. Only the `paperclip` service is built and recreated. No production deployment is part of preparing this change.

## Architecture

The companion tbro-server change adds `github-runner-paperclip`. It builds a separate image from the existing `tbro/github-runner:local` image and adds Python 3, flock, and a Paperclip-only registration entrypoint. The Home Assistant Dockerfile, entrypoint, service, credentials, and registration remain unchanged. No host systemd runner is used.

The new service uses its own repository token, name, container credentials, and host work directory. Its label is `paperclip-deploy`. The runner user stays UID/GID 1000 and receives the Docker socket group through `DOCKER_GROUP_ID`, as the existing runner does. If the deployment account has a different UID/GID, review both the runner user and directory ownership before startup.

The server repository and runner work directory are mounted at their exact absolute host paths inside the runner. Actions checks out into that persistent work directory. BuildKit receives the fresh checkout as its build context. The script verifies the runner mounts through Docker inspect before building. A translated path such as `/home/runner/_work` is rejected.

The script sets HOME to the deployment user's host home only for the deployment process, so existing `~/...` plugin mounts resolve to host paths. Before changing HOME, the script preserves an explicit `DOCKER_CONFIG` or defaults it to `$RUNNER_TEMP/.docker` (the runner home’s `.docker` directory outside Actions). It requires an absolute path, creates the directory, and verifies it is writable and searchable before invoking Docker. Docker and Buildx can therefore write client state without requiring write access to the host home. The runner itself keeps `/home/runner` as HOME. Compose reads the existing host `docker-compose.yml`, `.env`, and `paperclip.env` through the read-only repository mount. The project name comes from the running Paperclip container's Compose label, and its project directory must match. `COMPOSE_PROJECT_NAME`, if provided as a repository variable, must match that label.

No Paperclip service settings are replaced. Keep all existing environment variables, plugin and capacity mounts, `/srv/paperclip/data`, backup mounts, and the `/api/health` health check. If production uses additional Compose override files or a different project directory, adapt and review the script's Compose invocation before enabling the runner. Never print resolved Compose JSON; it contains secrets.

Docker bind mounts resolve on the daemon host: [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/). An explicit project name prevents an accidental second project: [Compose project names](https://docs.docker.com/compose/how-tos/project-name/).

## Review and one-time setup

1. Review both companion PRs before applying server changes. Keep the Paperclip workflow disabled in GitHub Actions while replacing the old architecture; enabling a newly registered runner can immediately pick up an older queued job. Cancel any queued deployment runs before enabling the workflow. Do not merge the workflow change until the server configuration is reviewed.
2. On the host, as the account that owns `~/tbro-server`, verify the current Paperclip project using `docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' paperclip` and its directory using the `com.docker.compose.project.working_dir` label. Keep current env files and local Compose customizations. Apply only the new runner service and supporting files; do not overwrite the running Paperclip service with a sample.
3. Create `~/github-runner-paperclip/work` and `~/github-runner-paperclip/state` as that account. Ensure UID 1000 can write them. These are separate from `~/actions-runner-paperclip` and all Home Assistant runner directories.
4. Copy `github-runner-paperclip.env.example` to `github-runner-paperclip.env` in `home-automation`, set mode 600, and enter a separate fine-grained token locally. Scope it to `TonyBrobston/paperclip`, with repository Administration write access for runner registration. Keep it out of Git and task comments. Do not reuse Home Assistant's token or a temporary registration token. Keep the separate runner name unique. The entrypoint removes the token from the process environment before starting the listener.
5. Confirm `.env` has the host Docker socket group ID, using `stat -c '%g' /var/run/docker.sock`. Keep the existing value if it is correct. No change to the Home Assistant service is required.
6. After review, build the base image if it is absent: `docker compose build github-runner`. This builds an image; it does not recreate the existing runner. Then run `docker compose build github-runner-paperclip` and `docker compose up -d --no-deps --no-build github-runner-paperclip` with the existing project name and from the actual host Compose directory. Do not run a project-wide `up`, `down`, or restart command.
7. Confirm the new runner is Idle in [Paperclip runner settings](https://github.com/TonyBrobston/paperclip/settings/actions/runners) with label `paperclip-deploy`. Check `docker compose exec github-runner-paperclip docker compose version` and `docker compose exec github-runner-paperclip python3 --version`. Confirm the existing Home Assistant runner remains registered and healthy. Rebuild the separate image periodically for runner security updates; registration disables automatic runner binary updates like the existing image.
8. Before the first reviewed deployment, verify a restorable database/data backup and schedule an interruption window. Merge the Paperclip PR and enable the workflow only after review. Pushes to master and manual dispatch can then recreate Paperclip. Confirm the Actions job and container health succeed.

The runner has host Docker authority. Restrict it to trusted code on the fork's master branch. There is no pull-request deployment trigger.

## Clean up the unused host installation safely

Do not start `~/actions-runner-paperclip/run.sh` or install `svc.sh`. If a foreground configuration or listener is still running there, interrupt that specific terminal process. Do not stop processes by a generic runner name; that could affect Home Assistant.

If configuration completed, remove only that host runner's registration using `./config.sh remove` from `~/actions-runner-paperclip` and a fresh removal token obtained locally from its GitHub settings. Verify the exact runner name before removing it. If configuration never completed, there is no registration to remove. If a host service was previously installed, use `sudo ./svc.sh stop` and `sudo ./svc.sh uninstall` only from that exact directory after checking `sudo ./svc.sh status`. These commands remove an accidental service; they do not create one.

Once stopped and deregistered, rename the directory to `~/actions-runner-paperclip-unused` for inspection. Do not copy its credentials into the Docker runner. Delete it later only after confirming the new runner works and nothing references it. Leave Home Assistant's installation untouched.

## Failure handling and recovery

A preflight or build failure exits before recreation. A health failure makes the job fail and leaves the last successful revision marker unchanged. The old image is tagged `tbro/paperclip:previous` before building. No automatic database rollback occurs. Startup migrations can make an old image incompatible with new data; restore the matching backup when necessary.

For recovery, disable the workflow and stop only the new runner to prevent another queued deployment. After inspecting the failure and backup compatibility, tag the known-good image as `tbro/paperclip:local` and run the existing project command with `up -d --no-build --pull never --no-deps --force-recreate --wait --wait-timeout 300 paperclip`. Do not use `down` or recreate other services. Keep backup retention independent of runner work cleanup.

If a build fails with `mkdir /home/tony/.docker: permission denied`, use the deployment script revision that creates a writable runner Docker configuration directory before invoking Docker. Do not mount the entire host home or loosen its permissions. An explicit `DOCKER_CONFIG`, if configured, must be writable inside the runner.

## Verification

Run `python3 scripts/test_deploy_home_server.py` and `bash -n scripts/deploy-home-server.sh`. In tbro-server run `python3 home-automation/test-paperclip-runner.py` and `bash -n home-automation/github-runner/register-paperclip-and-run.sh`.

Tests use temporary Git repositories and fake Docker/registration commands. They do not deploy or contact a Docker daemon. A real image build, runner registration, Compose validation with production env files, and health verification require the actual server after review. Full application typecheck, Vitest, and build are separate checks.

Browser dependencies and the required image/deployment smoke checks are documented in [browser runtime and recovery](agent-browser-runtime.md).
