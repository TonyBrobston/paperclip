import { describe, expect, it } from "vitest";
import {
  buildPaperclipEnv,
  resolveAgentFacingApiBaseUrl,
} from "./server-utils.js";

/**
 * Regression cover for the reachability guard on the local-API opt-in.
 *
 * `runtime-api.test.ts` asserts that `runtimeCanReachLocalApi` classifies
 * adapters correctly, but nothing asserted that the two consumers of that
 * classification actually honour it. Deleting `options?.runtimeCanReachLocalApi
 * &&` from `resolveAgentFacingApiBaseUrl` left all 139 cases in
 * `server-utils.test.ts` passing, so a remote runtime could be handed the
 * server's own loopback origin — for the managed MCP gateways, the
 * runtime-tools routes and the GitHub credential broker — with nothing red.
 *
 * These live in their own file rather than in `server-utils.test.ts` because
 * upstream edits that file; a file upstream has never seen cannot be dropped by
 * a merge resolution, which is the same class of mistake this guards against.
 */
const LOCAL_ORIGIN = "http://127.0.0.1:3100";
const PUBLIC_ORIGIN = "https://paperclip.example.com";

const LOCAL_API_ENV_KEYS = [
  "PAPERCLIP_ALLOW_LOCAL_API_CALLS",
  "PAPERCLIP_RUNTIME_LOCAL_API_URL",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
  "HOST",
  "PORT",
] as const;

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of LOCAL_API_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, saved.has(key) ? saved.get(key) : process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const OPTED_IN_ENV = {
  PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
  PAPERCLIP_RUNTIME_LOCAL_API_URL: LOCAL_ORIGIN,
  PAPERCLIP_API_URL: PUBLIC_ORIGIN,
};

describe("agent-facing API base reachability scoping", () => {
  it("hands the local origin to a runtime that can reach it", () => {
    expect(
      withEnv(OPTED_IN_ENV, () =>
        resolveAgentFacingApiBaseUrl({ runtimeCanReachLocalApi: true }),
      ),
    ).toBe(LOCAL_ORIGIN);
  });

  it("keeps the public origin for a runtime that cannot reach the local one", () => {
    expect(
      withEnv(OPTED_IN_ENV, () =>
        resolveAgentFacingApiBaseUrl({ runtimeCanReachLocalApi: false }),
      ),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("defaults to the public origin when reachability is not stated", () => {
    // The default is the safe one on purpose: a call site that forgets to opt
    // in keeps today's behaviour, so a missed adapter means "the feature does
    // not apply here" rather than "that adapter is broken".
    expect(
      withEnv(OPTED_IN_ENV, () => resolveAgentFacingApiBaseUrl({})),
    ).toBe(PUBLIC_ORIGIN);
    expect(withEnv(OPTED_IN_ENV, () => resolveAgentFacingApiBaseUrl())).toBe(
      PUBLIC_ORIGIN,
    );
  });

  it("ignores an inherited local origin when the opt-in is off", () => {
    expect(
      withEnv(
        {
          PAPERCLIP_RUNTIME_LOCAL_API_URL: LOCAL_ORIGIN,
          PAPERCLIP_API_URL: PUBLIC_ORIGIN,
        },
        () => resolveAgentFacingApiBaseUrl({ runtimeCanReachLocalApi: true }),
      ),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("rejects an opt-in value outside the accepted closed set", () => {
    expect(
      withEnv(
        { ...OPTED_IN_ENV, PAPERCLIP_ALLOW_LOCAL_API_CALLS: "maybe" },
        () => resolveAgentFacingApiBaseUrl({ runtimeCanReachLocalApi: true }),
      ),
    ).toBe(PUBLIC_ORIGIN);
  });
});

describe("buildPaperclipEnv reachability scoping", () => {
  const agent = { id: "agent-1", companyId: "company-1" };

  it("exports the local origin only for a reachable runtime", () => {
    expect(
      withEnv(
        OPTED_IN_ENV,
        () =>
          buildPaperclipEnv(agent, undefined, {
            runtimeCanReachLocalApi: true,
          }).PAPERCLIP_API_URL,
      ),
    ).toBe(LOCAL_ORIGIN);
  });

  it("exports the public origin when no options are passed", () => {
    // The two remote adapters (cursor-cloud, openclaw-gateway) call it exactly
    // this way, so this is the assertion that keeps them off the loopback
    // origin they would resolve to their own machine.
    expect(
      withEnv(OPTED_IN_ENV, () => buildPaperclipEnv(agent).PAPERCLIP_API_URL),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("agrees with the resolver it delegates to", () => {
    const [envValue, resolved] = withEnv(OPTED_IN_ENV, () => [
      buildPaperclipEnv(agent, undefined, { runtimeCanReachLocalApi: true })
        .PAPERCLIP_API_URL,
      resolveAgentFacingApiBaseUrl({ runtimeCanReachLocalApi: true }),
    ]);
    expect(envValue).toBe(resolved);
  });
});
