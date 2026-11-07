import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../../workflows/browser-runtime.yml", import.meta.url);

function assertBrowserTriggers(workflow) {
  const pullRequest = workflow.match(/^  pull_request:\n((?: {4}.*\n|\n)*)/m)?.[1];
  assert.ok(pullRequest);
  const paths = pullRequest.match(/^    paths:\n((?: {6}.*\n)*)/m)?.[1];
  assert.ok(paths);
  for (const path of ["Dockerfile", "docker/browser/**", ".github/workflows/browser-runtime.yml"]) {
    assert.ok(paths.includes(`      - ${path}\n`), `Missing PR path: ${path}`);
  }
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:|^\s*concurrency\s*:|self-hosted/m);
  assert.ok(!workflow.includes("PAPERCLIP_COMPOSE_PROJECT_NAME"));
}

function assertBrowserJob(workflow) {
  const jobs = workflow.split("\njobs:\n")[1];
  assert.ok(jobs);
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]), ["browser-runtime"]);
  assert.match(jobs, /^    runs-on: ubuntu-latest$/m);
  const commands = jobs.match(/^        run: \|\n((?: {10}.*\n)*)/m)?.[1];
  assert.ok(commands);
  assert.deepEqual(commands.trim().split("\n").map((command) => command.trim()), [
    "docker build --target browser-runtime -t paperclip-browser-check .",
    "docker run --rm --network none --user node -e HOME=/tmp --entrypoint node paperclip-browser-check /opt/paperclip-browser/smoke.cjs",
  ]);
}

function assertBrowserPermissions(workflow) {
  assert.match(workflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n/);
  assert.match(workflow, /persist-credentials: false/);
  const permissions = workflow.match(/^permissions:\n((?:[ \t].*\n|\n)*)/m)?.[1];
  assert.equal(permissions?.trim(), "contents: read");
  assert.equal([...workflow.matchAll(/^\s*permissions\s*:/gm)].length, 1);
}

const workflow = readFileSync(workflowUrl, "utf8");

test("browser image changes keep a pull request check and manual dispatch", () => {
  assertBrowserTriggers(workflow);
});

test("the hosted browser check builds and launches Chromium as the agent user", () => {
  assertBrowserJob(workflow);
});

test("the browser check uses a pinned checkout without persisted credentials", () => {
  assertBrowserPermissions(workflow);
});

test("additional pull request event types preserve browser path coverage", () => {
  assertBrowserTriggers(workflow.replace("  pull_request:\n", "  pull_request:\n    types: [opened, synchronize]\n"));
});

test("browser permissions reject package publishing", () => {
  const mutation = workflow.replace("  contents: read\n", "  contents: read\n  packages: write\n");
  assert.throws(() => assertBrowserPermissions(mutation), assert.AssertionError);
});

test("the browser smoke command cannot suppress launch failures", () => {
  const mutation = workflow.replace("/opt/paperclip-browser/smoke.cjs\n", "/opt/paperclip-browser/smoke.cjs || true\n");
  assert.throws(() => assertBrowserJob(mutation), assert.AssertionError);
});

for (const [level, target, replacement] of [
  ["smoke step", "        run: |\n", "        continue-on-error: true\n        run: |\n"],
  ["job", "    runs-on:", "    continue-on-error: true\n    runs-on:"],
]) {
  test(`browser checks reject continue-on-error on the ${level}`, () => {
    const mutation = workflow.replace(target, replacement);
    assert.notEqual(mutation, workflow);
    assert.throws(() => assertBrowserJob(mutation), assert.AssertionError);
  });
}

for (const [level, target, replacement] of [
  ["workflow", "permissions:", "concurrency: browser-check\npermissions:"],
  ["job", "    runs-on:", "    concurrency: browser-check\n    runs-on:"],
]) {
  test(`browser checks reject ${level} concurrency`, () => {
    const mutation = workflow.replace(target, replacement);
    assert.notEqual(mutation, workflow);
    assert.throws(() => assertBrowserTriggers(mutation), assert.AssertionError);
  });
}

test("browser checks reject deployment project configuration", () => {
  const mutation = workflow.replace("    runs-on:", "    env:\n      PAPERCLIP_COMPOSE_PROJECT_NAME: paperclip\n    runs-on:");
  assert.throws(() => assertBrowserTriggers(mutation), assert.AssertionError);
});
