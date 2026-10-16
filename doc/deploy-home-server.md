# Deploy the Paperclip fork to the home server

Pushes to `TonyBrobston/paperclip:master` deploy through `.github/workflows/deploy-home-server.yml`. Manual dispatch from master retries a failed deployment. Each job checks out the latest master, builds the production image with the existing server Compose configuration, recreates only Paperclip, and waits up to five minutes for the container health check. Jobs run one at a time. GitHub can replace older pending runs; the intent is to deploy the newest master.

## One-time server setup

The existing Home Assistant runner is registered to its repository. Keep it running. Register a second runner for Paperclip on the same Ubuntu Docker server. This workflow uses a native host runner so Docker Compose sees the host paths in the existing configuration. Do not run these steps inside the Paperclip application container or reuse Home Assistant's runner directory.

1. Use the Linux account that owns the existing `~/tbro-server/home-automation` deployment. It needs Bash, Git, Python 3, util-linux (`flock`), Docker, and Docker Compose v2 with `up --wait --wait-timeout` support. Confirm `docker compose version` and `docker compose up --help` as that account. Docker must work without sudo.
2. Confirm that `~/tbro-server/home-automation/docker-compose.yml` is the actual running project. Keep all its current env files and bind mounts. Its Paperclip service must use `image: tbro/paperclip:local`, `target: production`, and `build.context: ${PAPERCLIP_SOURCE_DIR:-${HOME}/paperclip}`. It must have the existing `/api/health` container health check. No Compose file changes are required if those settings already match. Do not print resolved Compose configuration into Actions logs; it contains secrets.
3. In [Paperclip runner settings](https://github.com/TonyBrobston/paperclip/settings/actions/runners), select **New self-hosted runner**, then Linux and your server architecture. Follow GitHub's current download and checksum instructions in a new directory, such as `~/actions-runner-paperclip`. At the configuration step use the displayed temporary registration token locally, give the runner a unique name such as `paperclip-home-server`, and add the custom label `paperclip-deploy`. Keep the default `self-hosted` and `linux` labels. Never post the token in a task or commit it.
4. From that new runner directory, install and start its service as the deployment user:
   ```bash
   sudo ./svc.sh install "$USER"
   sudo ./svc.sh start
   sudo ./svc.sh status
   ```
5. Confirm the runner appears **Idle** in Paperclip's runner settings. The service must have the deployment user's home directory and Docker access. If Docker group membership changed, restart the runner service.
6. If the Compose directory differs, set the repository Actions variable `PAPERCLIP_COMPOSE_DIR` to its absolute path. If the running project uses a custom project name, set `PAPERCLIP_COMPOSE_PROJECT_NAME` to that exact name. Otherwise leave both variables unset. From the host, confirm that `docker compose --project-directory "$HOME/tbro-server/home-automation" -f "$HOME/tbro-server/home-automation/docker-compose.yml" ps paperclip` identifies the current container. Adapt the path and `-p` option for a custom deployment.
7. Verify a recent, restorable database and instance-data backup before the first deploy. Pause active agent work for the first test. Merge the workflow PR, then use the **Deploy Paperclip to the home server** Actions run to verify it. Merge itself triggers the first deployment; wait to merge until the server is ready.

The workflow uses GitHub's read-only job token to check out source. It does not need a new long-lived GitHub token, a deploy key, an inbound port, or a webhook. The server runner still needs outbound access to GitHub and the registries used by the Docker build.

## What changes during deployment

The build source is the runner's fresh master checkout. The workflow does not modify an existing `~/paperclip` working tree. It exports `PAPERCLIP_SOURCE_DIR` for Compose to use the fresh checkout. Plugin bind mounts, env files, project identity, and persistent data stay governed by the existing server Compose file.

The script requires the current Paperclip container to exist. It validates the build context, target, image name, and health-check presence before changing the container. It saves the current image as `tbro/paperclip:previous`, builds while Paperclip is still running, then executes `compose up` for Paperclip with `--no-deps --force-recreate --wait`. This recreates the container with the new image; `compose restart` alone would keep the old image.

A failed build leaves the current container running. A failed startup or health check fails the job and can leave the new container unhealthy. The script updates `~/.local/state/paperclip-deploy/last-deployed` only after successful health verification. Manual dispatch retries the latest master even if it was built before. There is no automatic retry loop or automatic rollback.

Restarting Paperclip interrupts the server and can interrupt active runs. Startup can apply database migrations. An old image tag is not a database backup and does not guarantee schema compatibility. The health check verifies the HTTP health endpoint, not every integration or agent workflow.

## Disable and recover

Disable **Deploy Paperclip to the home server** in Actions before manual recovery. Revert the faulty commit through Git, then re-enable and dispatch the workflow on master after review. Every automatic or manual run checks out current master; rerunning an old run is not a way to deploy its old commit.

For an emergency image recovery, first assess database compatibility and restore data if required. The previous image is local to the Docker host. With automatic deployment disabled, tag `tbro/paperclip:previous` back to `tbro/paperclip:local`, then recreate only Paperclip with the correct Compose project and `--no-build --pull never --no-deps`. Do not use `compose down -v`. The previous tag is replaced at the next deployment attempt, so preserve a known-good image separately before repeated attempts.

Only trusted master code should reach this host. The deployment runner has Docker access. Keep branch review protections enabled and do not add pull-request triggers to this deployment workflow.

## Verification

Run `python3 scripts/test_deploy_home_server.py` and `bash -n scripts/deploy-home-server.sh`. Tests use temporary Git repositories and a fake Docker executable; they do not connect to a Docker daemon or restart a service.

Full application typecheck, tests, and build are separate checks. The deployment build and live health test still need the actual server.

References: [GitHub runner setup](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners), [GitHub runner service setup](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application), and [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/).
