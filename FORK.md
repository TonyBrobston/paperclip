# Fork maintenance

This is a fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip).
It carries the changes this deployment needs before they land upstream.

The deployment builds this repository's `master`, so every fork-local change
belongs on `master`. A change that sits only on its own branch ships nothing,
even when its pull request is open and green.

## Fork-local changes on `master`

| Change | Came from | Upstream |
| --- | --- | --- |
| `PAPERCLIP_ALLOW_LOCAL_API_CALLS`: send agent-facing requests to the container's own listener, so agent runtimes behind an authenticating edge can still reach the API, the MCP gateways, and the GitHub credential broker | `feat/allow-local-runtime-api-calls`, merged by [#1](https://github.com/TonyBrobston/paperclip/pull/1) | not submitted |
| Launch the installed web app in standalone display mode, so the Android PWA installs as an app instead of a shortcut. Also retargets `ui/src/lib/pwa-install-mode.test.ts`, whose upstream copy pins the old value | `fix/android-pwa-master`, merged by [#3](https://github.com/TonyBrobston/paperclip/pull/3) | open upstream as [#13756](https://github.com/paperclipai/paperclip/pull/13756) and [#13461](https://github.com/paperclipai/paperclip/pull/13461); drop this row once either lands |

Add a row when a change lands on `master`, and drop one once upstream ships the
same behavior and a merge brings it in.

### Why the display mode is a fork-local change

A browser installs a web app only when the manifest's `display` is
`fullscreen`, `standalone`, or `minimal-ui`. Upstream ships `display: browser`,
which Chrome reads as "this origin does not want to be an app": it offers a
home-screen shortcut that opens in a tab and never an install. Upstream already
contains the other half of the feature — the icon set, the service worker, and
`StandaloneBrowserControls`, which only renders in a chromeless display mode —
so the fork is ahead of upstream here rather than carrying a local preference.
That is also why two upstream pull requests propose the same one-line change.

Installing also needs `/site.webmanifest` and both `android-chrome-*.png` icons
to be fetchable through whatever sits in front of the server. An
authenticating edge that challenges those three requests blocks the install
independently of this manifest value, and the symptom is identical. That part
is deployment configuration, not a code change, so it is not in the table.

## Refreshing from upstream

Merge upstream into the fork. Never reset `master` to `upstream/master` or force
push it, because that silently discards the table above.

```sh
git fetch upstream
git switch master
git merge upstream/master
```

Then list what the fork still adds on top of upstream:

```sh
git log --oneline --no-merges upstream/master..master
```

Every change in the table must still be in that list. If one is missing, the
merge dropped it; fix the merge before pushing.

## Checking that a branch is really in `master`

```sh
git fetch origin
git merge-base --is-ancestor origin/<branch> origin/master && echo in-master
```

A merged pull request is the usual reason this passes, but it is the ancestry
check, not the pull request state, that says what the deployment will build.
