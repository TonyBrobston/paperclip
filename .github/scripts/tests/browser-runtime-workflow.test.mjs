import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../../workflows/browser-runtime.yml", import.meta.url);

test("browser image changes keep a pull request check and manual dispatch", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  assert.match(workflow, /^  pull_request:\n    paths:\n/m);
  for (const path of ["Dockerfile", "docker/browser/**", ".github/workflows/browser-runtime.yml"]) {
    assert.ok(workflow.includes(`      - ${path}\n`), `Missing PR path: ${path}`);
  }
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  push:|^concurrency:|self-hosted/m);
});

test("the hosted browser check builds and launches Chromium as the agent user", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  const jobs = workflow.split("\njobs:\n")[1];
  assert.ok(jobs);
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]), ["browser-runtime"]);
  assert.match(jobs, /^    runs-on: ubuntu-latest$/m);
  assert.ok(jobs.includes("docker build --target browser-runtime -t paperclip-browser-check ."));
  assert.ok(jobs.includes("docker run --rm --network none --user node -e HOME=/tmp --entrypoint node paperclip-browser-check /opt/paperclip-browser/smoke.cjs"));
});

test("the browser check uses a pinned checkout without persisted credentials", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  assert.match(workflow, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
});
