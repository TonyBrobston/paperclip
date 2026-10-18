# Home server images

Server-side compilation delays deployment and consumes production resources. `.github/workflows/paperclip-image.yml` builds and tests the production Dockerfile on GitHub, publishes a full-SHA GHCR tag and passes its exact digest to the existing deployment runner.

The [infrastructure runbook](https://github.com/TonyBrobston/tbro-server/blob/master/home-automation/PAPERCLIP-IMAGES.md) owns Compose, setup, credentials, recovery and cutover instructions.

Until the confirmed platform variable is set, no image is published. Until `PAPERCLIP_DEPLOY_MODE=images` is approved and set, the legacy workflow remains active and image deployment remains off. Never enable the new mode while an old deployment is queued or running.

The hosted job uses GITHUB_TOKEN with package-write permission. The deploy job uses package-read permission, temporary Docker authentication and the infrastructure script already mounted on the runner. It never checks out application code. PR events run hosted checks only.

The workflow changes are temporary fork-local deployment integration. Record them in FORK.md when landing them on master and retire them if upstream supplies an equivalent pipeline. No application code or Dockerfile changes are introduced.
