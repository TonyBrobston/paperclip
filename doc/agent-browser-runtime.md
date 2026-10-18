# Browser runtime and recovery

Local adapters run in the Paperclip production container. The production image uses Debian 13 (`node:24-trixie-slim`); the entrypoint runs the server and local agent children as `node` (default UID/GID 1000, configurable with USER_UID/USER_GID). Installing dependencies in the GitHub runner does not fix agent browser launches.

The production target installs pinned Playwright 1.64.1 from `docker/browser/package-lock.json`. Playwright's `install --with-deps chromium` uses Debian apt packages and installs its matching Chromium. Both are image contents. `PLAYWRIGHT_BROWSERS_PATH=/opt/paperclip-browser/browsers` keeps binaries outside the persistent `/paperclip` mount. Public browser files are readable and executable by remapped non-root users. No new service or startup download is required.

Agents can import the image-owned package:

```js
const { chromium } = require('/opt/paperclip-browser/node_modules/playwright');
```

Use this package with its matching browser. An independently installed Playwright version can require a different browser revision. Update the exact dependency and lockfile together when upgrading. Keep the production Docker target, browser install layer and deployment checks during upstream merges.

## Deployment checks

Pull requests that change the image, browser files or deployment checks build the `browser-runtime` stage on a hosted GitHub runner and run its non-root smoke test. Master deployments require the same job before using the self-hosted deployment runner.

The existing home-server GitHub workflow calls `scripts/deploy-home-server.sh`. The image build runs the smoke test as `node`. Deployment runs it again in a disposable container before recreation, then inside the healthy service through `gosu node`. It opens a loopback HTTP test page, verifies HTTP status, title and JavaScript execution, and closes the browser and server. A failure before recreation leaves the running container intact. A failure afterward fails the workflow and preserves the prior successful deployment marker.

```sh
node /opt/paperclip-browser/smoke.cjs
```

Run this as the non-root agent user; it rejects root. It needs no external website, credentials or application database. It uses Playwright's standard launch defaults and adds no Docker capabilities or privileged mode.

## Recovery

Restore the existing Paperclip data, secrets, database backup, Compose files and runner configuration as described in [home-server deployment](deploy-home-server.md). Deploy the reviewed fork revision through the existing workflow. A fresh image rebuild restores OS packages, pinned Playwright and Chromium; do not restore browser caches or run post-deployment package commands. The workflow must pass both health and browser checks before recording success.

For rollback follow the matching image/database recovery procedure in the deployment guide. Revisions before this browser layer do not provide the browser capability. Browser readiness does not approve any application PR: retain its exact-commit review, running-host permissions tests and merge approvals.

References: [Paperclip Docker](https://docs.paperclip.ing/reference/deploy/docker/), [Agent Browser skill](https://docs.paperclip.ing/reference/skills/optional/browser/agent-browser/), [Playwright Docker](https://playwright.dev/docs/docker).
