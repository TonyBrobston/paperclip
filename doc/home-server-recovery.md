# Home-server image updates and recovery

The [tbro-server image workflow](https://github.com/TonyBrobston/tbro-server/blob/master/.github/workflows/paperclip-image.yml) builds, verifies and publishes the Paperclip GHCR image. Paperclip is updated by hand from that image. This fork's [browser check](../.github/workflows/browser-runtime.yml) validates browser image changes on pull requests; it does not update the server.

## Preserve deployment state

Before updating, verify a restorable database/data backup and schedule an interruption window. Keep the existing Paperclip data at `/srv/paperclip/data`, secrets, database backups, Compose files, `.env`, `paperclip.env`, plugin mounts and capacity mounts. Keep backup retention independent of image and build-cache cleanup. Never print resolved Compose JSON; it contains secrets.

Use the existing Compose project name and directory. Read them from the running Paperclip container's `com.docker.compose.project` and `com.docker.compose.project.working_dir` labels. Keep existing service settings, overrides and the `/api/health` health check.

## Recover a failed update

Record the running image digest before updating and retain that image until verification succeeds. A failed build does not replace the running service. A failed manual update needs operator inspection; there is no automatic rollback.

Startup migrations can make an older image incompatible with newer data. Confirm image/database compatibility before rollback. Restore the matching database/data backup when necessary, together with the existing secrets and Compose configuration. Select the retained known-good image in the existing deployment configuration and recreate only the Paperclip service. On the first GHCR update, the retained image is the local `tbro/paperclip:previous`. Use the commands in tbro-server's [PAPERCLIP-IMAGES.md](https://github.com/TonyBrobston/tbro-server/blob/master/home-automation/PAPERCLIP-IMAGES.md#update-manually). Do not use a project-wide `down` or recreate other services.

After recovery, confirm container health and run the [browser smoke test](agent-browser-runtime.md) as the non-root agent user. The image supplies OS packages, pinned Playwright and Chromium. Do not restore browser caches or install packages in the running container.
