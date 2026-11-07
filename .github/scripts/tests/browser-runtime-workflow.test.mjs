import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../../workflows/browser-runtime.yml", import.meta.url);

function assertBrowserTriggers(workflow) {
  assert.match(workflow, /^  pull_request:\n    paths:\n/m);
  for (const path of ["Dockerfile", "docker/browser/**", ".github/workflows/browser-runtime.yml"]) {
    assert.ok(workflow.includes(`      - ${path}\n`), `Missing PR path: ${path}`);
  }
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:|^concurrency:|self-hosted/m);
}

function assertBrowserJob(workflow) {
  const jobs = workflow.split("\njobs:\n")[1];
  assert.ok(jobs);
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]), ["browser-runtime"]);
  assert.match(jobs, /^    runs-on: ubuntu-latest$/m);
  assert.ok(jobs.includes("docker build --target browser-runtime -t paperclip-browser-check ."));
  assert.ok(jobs.includes("docker run --rm --network none --user node -e HOME=/tmp --entrypoint node paperclip-browser-check /opt/paperclip-browser/smoke.cjs"));
}

function assertBrowserPermissions(workflow) {
  assert.match(workflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
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
