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

## What the fork does not carry

Every row above costs conflicts on each upstream merge — the 2026-10-09 refresh
produced fourteen, all in the local-API surface. So a change earns a row only
when the deployment needs it *and* upstream will not take it as-is. A fix that
is correct for everyone belongs upstream, where it arrives through the next
refresh instead of being re-merged forever.

Recorded example: [#4](https://github.com/TonyBrobston/paperclip/pull/4) made
`/site.webmanifest` revalidate instead of sitting on its one-hour TTL, while
`index.html` and `sw.js` already revalidate. The observation is legitimate and
entirely generic, with nothing fork-specific in it, so it was closed here on
2026-10-09 rather than becoming a fork-local `server/` divergence. The branch
`fix/revalidate-web-app-manifest` is kept for an upstream submission.

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

### A refresh is not merged by its own pull request

A refresh pull request can never go green, so do not ask a reviewer to merge
one. Raise it to collect the CI signal, then land the reviewed tip by pushing
`master`. Every refresh before this one is a direct merge commit on `master`.

Why the pull request is permanently red:

- **`ci / policy` rejects it.** The "Block manual lockfile edits" step fails any
  pull request whose diff touches `pnpm-lock.yaml`, because CI owns the
  lockfile. A refresh always touches it — upstream's own `chore(lockfile)`
  commits are part of what is being merged.
- **Its one exemption cannot be borrowed.** The step skips for head ref
  `chore/refresh-lockfile`, but `.github/workflows/refresh-lockfile.yml` force
  pushes that branch on every push to `master`. Naming a refresh branch that way
  to dodge the check means the automation overwrites the refresh.
- **`ci / verify` and `ci / e2e` fail with `policy`.** Both are aggregator gates
  that require it, so one structural failure reads as three red checks. Their
  logs print each input: on a refresh every substantive one (typecheck, general
  tests, runner verification, build, docker context integrity, e2e shards) reads
  `success` while only `POLICY_RESULT` reads `failure`.
- **`review` fails** until Dependency graph is enabled for this fork under
  Settings → Code security. That is a repository setting on a fork, it is not
  settable through the REST API, and it is unrelated to the merge.

Raise the pull request anyway, because it is the only thing that runs the test
suite: `pr.yml` triggers on `pull_request` only, and no workflow runs the general
tests on a push to `master`. Judge the refresh on those substantive checks, then
fast-forward `master` onto the exact tip CI covered:

```sh
git fetch origin
git merge-base --is-ancestor origin/master <reviewed-tip>   # must pass
git push origin <reviewed-tip>:refs/heads/master \
  --force-with-lease=refs/heads/master:<current-master>
```

The ancestry check keeps this a fast-forward rather than a rewrite, and the
lease fails the push instead of overwriting someone else's work if `master`
moved since the check. `master` is not branch protected, so this needs no
override — but the reviewer should never be the one deciding which red X is safe
to ignore.

There is nothing to close afterwards. Pushing the head commits onto the base
branch makes GitHub mark the pull request **merged**, not closed, so the review
and its CI run stay attached to the commits that shipped. Any earlier pull
request whose commits the refresh carries is marked merged by the same push.

Worked example, the 2026-10-09 refresh: `master` went from `d2ea9a6ec` to
`6256574f1`, picking up 146 upstream commits through `3fc64c515`. Fourteen
conflicts, all in the local-API surface — upstream had added an `identity`
parameter to `buildPaperclipEnv` and moved the MCP and broker base-URL helpers
into `heartbeat/run-preparation.ts`. [#7](https://github.com/TonyBrobston/paperclip/pull/7)
collected the CI signal and [#5](https://github.com/TonyBrobston/paperclip/pull/5)
went merged along with it.

## Checking that a branch is really in `master`

Ask whether the branch carries any fork-local commit `master` is missing:

```sh
git fetch origin
git log --oneline --no-merges origin/master..origin/<branch>
```

Empty output means the deployment already builds everything that branch adds.
A merged pull request is the usual reason it comes out empty, but it is the
commit range, not the pull request state, that says what the deployment builds.

The stricter ancestry form asks whether the branch *tip* is in `master`:

```sh
git merge-base --is-ancestor origin/<branch> origin/master && echo in-master
```

Prefer the range. The ancestry check gives a false negative on any branch that
is still being maintained after it merged: merging `upstream/master` into a
stale feature branch puts a commit on its tip that `master` does not have, and
the check then reports the feature as missing when nothing is missing.
`feat/allow-local-runtime-api-calls` is in exactly that state — its tip
`45481fd81` is an upstream merge made after [#1](https://github.com/TonyBrobston/paperclip/pull/1)
landed, while the feature itself has been on `master` since 2026-09-30.

Branches whose work is on `master` are better deleted than refreshed. Keeping
one alive invites a second copy of the same change to grow on it.
