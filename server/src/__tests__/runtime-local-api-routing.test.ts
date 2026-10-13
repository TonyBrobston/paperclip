import { readFileSync } from "node:fs";
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

/**
 * Cover for the production call sites, which are a separate failure mode from
 * the guards above.
 *
 * The guards default to the public origin, so a call site that loses its
 * reachability argument fails closed — it compiles, every assertion above
 * still passes, and the only symptom is that an agent on this host silently
 * goes back to calling the authenticating edge the opt-in exists to bypass.
 *
 * That is not hypothetical. The v2026.1012.0 refresh moved four of these five
 * call sites out of `heartbeat.ts` into `heartbeat/runtime-execution.ts`
 * wholesale, which git presents as "ours modified / theirs deleted": taking
 * the deletion would have dropped all four at once with nothing going red.
 *
 * Asserting over the source text rather than over behavior is deliberate. The
 * call sites sit inside a run-dispatch path that needs a live database and a
 * spawned runtime, so reaching them from a unit test costs more than the
 * invariant is worth — while the invariant itself is purely syntactic: no
 * production caller of these helpers may omit the reachability decision. The
 * rule also covers a call site upstream adds later, which would otherwise
 * inherit the default without anyone choosing it.
 */
const REACHABILITY_SCOPED_HELPERS = [
  "configuredPaperclipApiBaseUrl",
  "paperclipApiBaseUrl",
  "buildPaperclipRuntimeMcpServers",
  "createAdapterRuntimeToolAccess",
] as const;

/** The call sites as they stand, so deleting one outright is red too. */
const EXPECTED_CALL_SITES: Record<string, Partial<Record<string, number>>> = {
  "../services/heartbeat.ts": {
    configuredPaperclipApiBaseUrl: 1,
  },
  "../services/heartbeat/runtime-execution.ts": {
    configuredPaperclipApiBaseUrl: 1,
    paperclipApiBaseUrl: 1,
    buildPaperclipRuntimeMcpServers: 2,
    createAdapterRuntimeToolAccess: 1,
  },
};

/** The argument text of every `name(...)` call, parentheses balanced. */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

describe("local API reachability is stated at every call site", () => {
  for (const [relativePath, expected] of Object.entries(EXPECTED_CALL_SITES)) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

    for (const helper of REACHABILITY_SCOPED_HELPERS) {
      const calls = callArguments(source, helper);
      const expectedCount = expected[helper] ?? 0;

      it(`${relativePath} calls ${helper} ${expectedCount} time(s)`, () => {
        // A changed count is not necessarily wrong, but it means a call site
        // moved, appeared or vanished, and that decision belongs to a person.
        expect(calls.length).toBe(expectedCount);
      });

      for (const [position, args] of calls.entries()) {
        it(`${relativePath} states reachability at ${helper} call ${position + 1}`, () => {
          expect(args).toContain("canReachLocalApi");
        });
      }
    }
  }
});
