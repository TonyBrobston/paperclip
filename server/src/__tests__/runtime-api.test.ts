import { describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  localRuntimeApiCallsEnabled,
  resolveLocalRuntimeApiUrl,
} from "../runtime-api.js";

describe("runtime API discovery", () => {
  it("prefers the explicit public base URL for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "https://paperclip.example.com/base/path",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("https://paperclip.example.com");
  });

  it("prefers the loopback bind host over allowed hostnames for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["192.168.1.50"],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("builds ordered callback candidates from explicit, allowed, bind, and interface hosts", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10", "runtime-host.example.test", "203.0.113.42"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {
          en0: [
            {
              address: "203.0.113.42",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "203.0.113.42/24",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "http://198.51.100.10:3102",
      "http://runtime-host.example.test:3102",
      "http://203.0.113.42:3102",
    ]);
  });

  it("tries the preferred API URL before derived callback candidates", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        preferredApiUrl: "https://agent-entry.example.test/base/path",
        authPublicBaseUrl: "https://paperclip.example.test/app",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "https://agent-entry.example.test",
      "https://paperclip.example.test",
      "https://198.51.100.10:3102",
    ]);
  });

  it("adds host.docker.internal when the explicit base URL is loopback", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://127.0.0.1:3102",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3102",
      "http://host.docker.internal:3102",
    ]);
  });

  it("leads the candidate list with the opt-in local API URL", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        localApiUrl: "http://127.0.0.1:3100",
        preferredApiUrl: "https://paperclip.example.test",
        authPublicBaseUrl: "https://paperclip.example.test",
        allowedHostnames: ["paperclip.example.test"],
        bindHost: "0.0.0.0",
        port: 3100,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3100",
      "https://paperclip.example.test",
      "https://paperclip.example.test:3100",
    ]);
  });

  it("prefers usable interface hosts and skips link-local addresses", () => {
    expect(
      collectReachableInterfaceHosts({
        networkInterfacesMap: {
          en0: [
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
            {
              address: "192.168.6.178",
              family: "IPv4",
              internal: false,
              netmask: "255.255.252.0",
              cidr: "192.168.6.178/22",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fd7a:115c:a1e0::8a3a:a11d",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff::",
              cidr: "fd7a:115c:a1e0::8a3a:a11d/48",
              mac: "00:00:00:00:00:00",
              scopeid: 0,
            },
          ],
          en1: [
            {
              address: "169.254.10.20",
              family: "IPv4",
              internal: false,
              netmask: "255.255.0.0",
              cidr: "169.254.10.20/16",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "192.168.6.178",
      "fd7a:115c:a1e0::8a3a:a11d",
    ]);
  });
});

describe("local runtime API opt-in", () => {
  it("stays disabled by default so existing deployments keep the public origin", () => {
    expect(localRuntimeApiCallsEnabled({})).toBe(false);
    expect(
      resolveLocalRuntimeApiUrl({ bindHost: "0.0.0.0", port: 3100, env: {} }),
    ).toBeNull();
  });

  it("accepts the common truthy spellings and rejects everything else", () => {
    for (const value of ["true", "TRUE", " 1 ", "yes"]) {
      expect(
        localRuntimeApiCallsEnabled({ PAPERCLIP_ALLOW_LOCAL_API_CALLS: value }),
      ).toBe(true);
    }
    for (const value of ["false", "0", "no", "", "maybe"]) {
      expect(
        localRuntimeApiCallsEnabled({ PAPERCLIP_ALLOW_LOCAL_API_CALLS: value }),
      ).toBe(false);
    }
  });

  it("derives a loopback origin on the real listen port for a wildcard bind host", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("keeps a specific non-loopback bind host, the only address the listener answers on", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "198.51.100.10",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
      }),
    ).toBe("http://198.51.100.10:3100");
  });

  it("honors an explicit local URL override and normalizes it to an origin", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "http://198.51.100.10:3100/api/",
        },
      }),
    ).toBe("http://198.51.100.10:3100");
  });

  it("falls back to the derived origin when the override is malformed", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "not a url",
        },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("ignores an override when the opt-in is off", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { PAPERCLIP_LOCAL_API_URL: "http://198.51.100.10:3100" },
      }),
    ).toBeNull();
  });
});
