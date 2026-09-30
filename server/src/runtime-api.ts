import os from "node:os";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function isLinkLocalHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized.startsWith("169.254.")) return true;
  // IPv6 link-local block is fe80::/10 (fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  return false;
}

function formatOrigin(protocol: string, host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
    ? `[${host}]`
    : host;
  return `${protocol}//${normalizedHost}:${port}`;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  rawUrl: string | null | undefined,
): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  try {
    const normalized = new URL(trimmed).origin;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  } catch {
    // Ignore malformed candidates.
  }
}

export function choosePrimaryRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
}): string {
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim();
  if (explicitPublicBaseUrl) {
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      // Fall through to derived candidates if config parsing drifted.
    }
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost) && isLoopbackHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  const allowedHostname = input.allowedHostnames
    .map((value) => value.trim())
    .find(Boolean);
  if (allowedHostname) {
    return formatOrigin("http:", allowedHostname, input.port);
  }

  if (bindHost && !isWildcardHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  return formatOrigin("http:", "localhost", input.port);
}

/**
 * Whether the operator opted into local API calls for agent runtimes.
 *
 * A self-hosted deployment often puts an authenticating edge in front of the
 * public origin (Cloudflare Access, an SSO reverse proxy, a WAF). That origin is
 * the right one for browsers, OAuth callbacks, and inbound webhooks, but an
 * agent process has no interactive session at that edge, so every request it
 * makes to `PAPERCLIP_API_URL` is answered with a login redirect instead of the
 * API. Opting in keeps the public origin for user-facing links and points agent
 * runtimes at the server's own listener instead.
 */
export function localRuntimeApiCallsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = normalizeHost(env.PAPERCLIP_ALLOW_LOCAL_API_CALLS).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * The origin agent runtimes should call when local API calls are allowed, or
 * `null` when the operator has not opted in (the default, which leaves every
 * existing deployment on its public origin).
 *
 * `PAPERCLIP_LOCAL_API_URL` overrides the derived origin for deployments where
 * the runtime reaches the server on a specific address — a LAN IP when the agent
 * runs in a bridged container, or a tailnet address.
 */
export function resolveLocalRuntimeApiUrl(input: {
  bindHost: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = input.env ?? process.env;
  if (!localRuntimeApiCallsEnabled(env)) return null;

  const explicit = normalizeHost(env.PAPERCLIP_LOCAL_API_URL);
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      // A malformed override falls through to the derived origin rather than
      // failing startup: losing the opt-in is recoverable, a dead server is not.
    }
  }

  const bindHost = normalizeHost(input.bindHost);
  // A wildcard or loopback listener always answers on loopback. A specific
  // non-loopback bind host is the only address the listener answers on, so it
  // has to be used verbatim.
  const host =
    !bindHost || isWildcardHost(bindHost) || isLoopbackHost(bindHost)
      ? "127.0.0.1"
      : bindHost;
  return formatOrigin("http:", host, input.port);
}

export function collectReachableInterfaceHosts(input: {
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
} = {}): string[] {
  const interfaces = input.networkInterfacesMap ?? os.networkInterfaces();
  const rankedHosts: Array<{ host: string; rank: number; index: number }> = [];
  const seen = new Set<string>();
  let index = 0;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeHost(entry.address);
      if (!host || isLoopbackHost(host) || isWildcardHost(host) || isLinkLocalHost(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      rankedHosts.push({
        host,
        rank: entry.family === "IPv4" ? 0 : 1,
        index: index++,
      });
    }
  }

  return rankedHosts
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.host);
}

export function buildRuntimeApiCandidateUrls(input: {
  /**
   * Opt-in local origin from {@link resolveLocalRuntimeApiUrl}. It leads the list
   * because an authenticating edge in front of the public origin rejects agent
   * runtimes outright, so falling back to it first would waste every retry.
   */
  localApiUrl?: string | null;
  preferredApiUrl?: string | null;
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim() ?? "";
  const explicitOrigin = (() => {
    if (!explicitPublicBaseUrl) return null;
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      return null;
    }
  })();
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

  pushCandidate(candidates, seen, input.localApiUrl);
  pushCandidate(candidates, seen, input.preferredApiUrl);
  pushCandidate(candidates, seen, explicitOrigin);

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(protocol, bindHost, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(protocol, "host.docker.internal", input.port));
    }
  }

  for (const host of collectReachableInterfaceHosts({ networkInterfacesMap: input.networkInterfacesMap })) {
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.authPublicBaseUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}
