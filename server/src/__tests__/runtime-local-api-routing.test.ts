import { describe, expect, it } from "vitest";
import {
  configuredPaperclipApiBaseUrl,
  paperclipApiBaseUrl,
} from "../services/heartbeat/run-preparation.js";

/**
 * Regression cover for the reachability guard where the server resolves the
 * base URL used for managed MCP gateway endpoints, the runtime-tools REST
 * routes and the GitHub credential broker.
 *
 * Dropping `runtimeCanReachLocalApi &&` from `configuredPaperclipApiBaseUrl`
 * left every one of the 67 cases in `runtime-api.test.ts` and
 * `server-startup-feedback-export.test.ts` passing. Upstream has also moved
 * these two functions between modules once already, and git presents that as
 * "ours modified / theirs deleted" — a resolution that accepts the deletion
 * compiles cleanly. These assertions are what make either mistake red.
 */
const LOCAL_ORIGIN = "http://127.0.0.1:3100";
const PUBLIC_ORIGIN = "https://paperclip.example.com";

const LOCAL_API_ENV_KEYS = [
  "PAPERCLIP_ALLOW_LOCAL_API_CALLS",
  "PAPERCLIP_RUNTIME_LOCAL_API_URL",
  "PAPERCLIP_API_URL",
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

describe("configuredPaperclipApiBaseUrl reachability scoping", () => {
  it("returns the local origin for a runtime that can reach it", () => {
    expect(
      withEnv(OPTED_IN_ENV, () => configuredPaperclipApiBaseUrl(true)),
    ).toBe(LOCAL_ORIGIN);
  });

  it("returns the public origin for a runtime that cannot", () => {
    expect(
      withEnv(OPTED_IN_ENV, () => configuredPaperclipApiBaseUrl(false)),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("defaults to the public origin when reachability is not stated", () => {
    expect(withEnv(OPTED_IN_ENV, () => configuredPaperclipApiBaseUrl())).toBe(
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
        () => configuredPaperclipApiBaseUrl(true),
      ),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("rejects an opt-in value outside the accepted closed set", () => {
    expect(
      withEnv(
        { ...OPTED_IN_ENV, PAPERCLIP_ALLOW_LOCAL_API_CALLS: "maybe" },
        () => configuredPaperclipApiBaseUrl(true),
      ),
    ).toBe(PUBLIC_ORIGIN);
  });

  it("trims a trailing slash and /api suffix from either origin", () => {
    expect(
      withEnv(
        {
          ...OPTED_IN_ENV,
          PAPERCLIP_RUNTIME_LOCAL_API_URL: `${LOCAL_ORIGIN}/api/`,
        },
        () => configuredPaperclipApiBaseUrl(true),
      ),
    ).toBe(LOCAL_ORIGIN);
  });
});

describe("paperclipApiBaseUrl reachability scoping", () => {
  it("carries the reachability decision through to callers", () => {
    expect(withEnv(OPTED_IN_ENV, () => paperclipApiBaseUrl(true))).toBe(
      LOCAL_ORIGIN,
    );
    expect(withEnv(OPTED_IN_ENV, () => paperclipApiBaseUrl(false))).toBe(
      PUBLIC_ORIGIN,
    );
    expect(withEnv(OPTED_IN_ENV, () => paperclipApiBaseUrl())).toBe(
      PUBLIC_ORIGIN,
    );
  });

  it("throws rather than inventing an origin when none is configured", () => {
    expect(() => withEnv({}, () => paperclipApiBaseUrl(true))).toThrow(
      /PAPERCLIP_API_URL is required/,
    );
  });
});
