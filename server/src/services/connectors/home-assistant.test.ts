import { describe, expect, it } from "vitest";
import { HOME_ASSISTANT_TOOLS, homeAssistantApiUrl } from "@paperclipai/shared";
import {
  executeHomeAssistantTool,
  homeAssistantBaseUrl,
  isHomeAssistantConnection,
  probeHomeAssistant,
} from "./home-assistant.js";

const connection = {
  transport: "rest_api",
  config: {
    sourceTemplateKey: "home-assistant",
    methodConfig: { baseUrl: "http://ha.example.test:8123" },
  },
};
const headers = { Authorization: "Bearer test-token" };

type Call = { url: string; init: RequestInit };

/** Collects requests and replays canned responses, so no test touches a network. */
function stub(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  let index = 0;
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return typeof next === "function" ? next() : next;
  };
  return { calls, request };
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const run = (
  toolName: string,
  parameters: unknown,
  responses: Array<Response | (() => Response)>,
  target = connection,
) => {
  const { calls, request } = stub(responses);
  return {
    calls,
    result: executeHomeAssistantTool(target, headers, toolName, parameters, {
      allowPrivateNetwork: true,
      request,
    }),
  };
};

const state = (entityId: string, value: string, friendlyName?: string) => ({
  entity_id: entityId,
  state: value,
  last_changed: "2026-10-14T00:00:00+00:00",
  attributes: { ...(friendlyName ? { friendly_name: friendlyName } : {}) },
});

describe("Home Assistant connection identity", () => {
  it("claims only REST connections created from its own catalog entry", () => {
    expect(isHomeAssistantConnection(connection)).toBe(true);
    expect(
      isHomeAssistantConnection({
        transport: "rest_api",
        config: { sourceTemplateKey: "browser-use-cloud" },
      }),
    ).toBe(false);
    // A hand-made generic REST connection must not borrow this tool catalog.
    expect(isHomeAssistantConnection({ transport: "rest_api", config: {} })).toBe(false);
    expect(
      isHomeAssistantConnection({
        transport: "mcp_remote",
        config: { sourceTemplateKey: "home-assistant" },
      }),
    ).toBe(false);
  });

  it("fails a connection with no saved instance address instead of guessing a host", () => {
    expect(() => homeAssistantBaseUrl({ config: { methodConfig: {} } })).toThrowError(
      /no instance address/,
    );
    expect(() => homeAssistantBaseUrl({ config: {} })).toThrowError(/no instance address/);
    expect(homeAssistantBaseUrl(connection)).toBe("http://ha.example.test:8123");
  });

  it("refuses a base URL carrying credentials and tolerates a trailing slash", () => {
    expect(() => homeAssistantApiUrl("http://user:pw@ha.example.test:8123", "/api/")).toThrowError(
      /must not contain credentials/,
    );
    expect(homeAssistantApiUrl("http://ha.example.test:8123/", "/api/states").toString()).toBe(
      "http://ha.example.test:8123/api/states",
    );
    // A stored query or fragment would silently rewrite every built request.
    expect(() => homeAssistantApiUrl("http://ha.example.test:8123?x=1", "/api/")).toThrowError(
      /query or fragment/,
    );
    expect(() => homeAssistantApiUrl("http://ha.example.test:8123#x", "/api/")).toThrowError(
      /query or fragment/,
    );
    // A reverse-proxy path prefix is preserved.
    expect(homeAssistantApiUrl("https://ha.example.test/ha", "/api/states").toString()).toBe(
      "https://ha.example.test/ha/api/states",
    );
  });
});

describe("Home Assistant tool catalog", () => {
  it("classifies exactly one write action and marks the rest read-only", () => {
    const writes = HOME_ASSISTANT_TOOLS.filter((tool) => !tool.annotations.readOnlyHint);
    expect(writes.map((tool) => tool.name)).toEqual(["home_assistant_call_service"]);
    expect(writes[0]!.annotations.destructiveHint).toBe(true);
  });

  it("exposes no tool that writes a Home Assistant configuration file", () => {
    // Writing automations.yaml through /api/config/automation/config/<id>
    // rewrites it in place and conflicts with a Git-managed configuration.
    const names = HOME_ASSISTANT_TOOLS.map((tool) => tool.name).join(" ");
    expect(names).not.toMatch(/automation.*(create|update|upsert|write|delete)/);
    expect(names).not.toMatch(/config.*(write|update|set)/);
  });

  it("accepts no free-form path or request body on any tool", () => {
    for (const tool of HOME_ASSISTANT_TOOLS) {
      const properties = Object.keys(tool.inputSchema.properties);
      expect(properties, tool.name).not.toContain("path");
      expect(properties, tool.name).not.toContain("url");
      expect(properties, tool.name).not.toContain("method");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });
});

describe("home_assistant_list_entities", () => {
  const states = [
    state("light.kitchen", "on", "Kitchen"),
    state("light.porch", "off", "Porch light"),
    state("sensor.outdoor_temperature", "7.5", "Outdoor temperature"),
  ];

  it("filters by domain and returns compact rows", async () => {
    const { result, calls } = run(
      "home_assistant_list_entities",
      { domain: "light" },
      [jsonResponse(states)],
    );
    const value = (await result) as { entities: Array<{ entityId: string }>; totalMatched: number };
    expect(calls[0]!.url).toBe("http://ha.example.test:8123/api/states");
    expect(calls[0]!.init.method).toBe("GET");
    expect(value.totalMatched).toBe(2);
    expect(value.entities.map((entity) => entity.entityId)).toEqual([
      "light.kitchen",
      "light.porch",
    ]);
    expect(value.entities[0]).toMatchObject({ state: "on", friendlyName: "Kitchen" });
  });

  it("matches a case-insensitive substring against entity ID and friendly name", async () => {
    const byFriendlyName = (await run(
      "home_assistant_list_entities",
      { search: "PORCH" },
      [jsonResponse(states)],
    ).result) as { entities: Array<{ entityId: string }> };
    expect(byFriendlyName.entities.map((entity) => entity.entityId)).toEqual(["light.porch"]);

    const byEntityId = (await run(
      "home_assistant_list_entities",
      { search: "outdoor_temp" },
      [jsonResponse(states)],
    ).result) as { entities: Array<{ entityId: string }> };
    expect(byEntityId.entities.map((entity) => entity.entityId)).toEqual([
      "sensor.outdoor_temperature",
    ]);
  });

  it("reports truncation rather than silently dropping rows", async () => {
    const value = (await run("home_assistant_list_entities", { limit: 1 }, [
      jsonResponse(states),
    ]).result) as { totalMatched: number; returned: number; truncated: boolean };
    expect(value).toMatchObject({ totalMatched: 3, returned: 1, truncated: true });
  });

  it("rejects an unknown argument", async () => {
    await expect(
      run("home_assistant_list_entities", { area: "kitchen" }, [jsonResponse(states)]).result,
    ).rejects.toThrow();
  });
});

describe("home_assistant_call_service", () => {
  it("posts to the validated domain and service and summarizes changed states", async () => {
    const { result, calls } = run(
      "home_assistant_call_service",
      { domain: "light", service: "turn_on", entityId: "light.kitchen", data: { brightness_pct: 40 } },
      [jsonResponse([state("light.kitchen", "on", "Kitchen")])],
    );
    const value = (await result) as { service: string; changedStates: Array<{ state: string }> };
    expect(calls[0]!.url).toBe("http://ha.example.test:8123/api/services/light/turn_on");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      brightness_pct: 40,
      entity_id: "light.kitchen",
    });
    expect(value.service).toBe("light.turn_on");
    expect(value.changedStates[0]!.state).toBe("on");
  });

  it("lets the explicit target win over an entity_id smuggled into data", async () => {
    const { result, calls } = run(
      "home_assistant_call_service",
      {
        domain: "lock",
        service: "unlock",
        entityId: "lock.side_door",
        data: { entity_id: "lock.front_door" },
      },
      [jsonResponse([])],
    );
    await result;
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ entity_id: "lock.side_door" });
  });

  it("rejects a domain or service that is not a plain Home Assistant identifier", async () => {
    for (const input of [
      { domain: "../config/core", service: "update" },
      { domain: "light", service: "turn_on?x=1" },
      { domain: "Light", service: "turn_on" },
    ]) {
      await expect(
        run("home_assistant_call_service", input, [jsonResponse([])]).result,
      ).rejects.toThrow();
    }
  });
});

describe("Home Assistant read endpoints", () => {
  it("renders a template and returns the plaintext result", async () => {
    const { result, calls } = run(
      "home_assistant_render_template",
      { template: "{{ states('sensor.outdoor_temperature') }}" },
      [new Response("7.5", { headers: { "content-type": "text/plain" } })],
    );
    expect(await result).toEqual({ rendered: "7.5" });
    expect(calls[0]!.url).toBe("http://ha.example.test:8123/api/template");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      template: "{{ states('sensor.outdoor_temperature') }}",
    });
  });

  it("defaults the history window to the last day and asks for a minimal response", async () => {
    const { result, calls } = run("home_assistant_get_history", { entityId: "light.kitchen" }, [
      jsonResponse([]),
    ]);
    await result;
    const url = new URL(calls[0]!.url);
    expect(url.pathname.startsWith("/api/history/period/")).toBe(true);
    expect(url.searchParams.get("filter_entity_id")).toBe("light.kitchen");
    expect(url.searchParams.has("minimal_response")).toBe(true);
    const start = Date.parse(decodeURIComponent(url.pathname.split("/").pop()!));
    expect(Date.now() - start).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("rejects a history timestamp that is not a date", async () => {
    await expect(
      run("home_assistant_get_history", { entityId: "light.kitchen", startTime: "yesterday" }, [
        jsonResponse([]),
      ]).result,
    ).rejects.toThrow();
  });

  it("returns the tail of the error log and says when it truncated", async () => {
    const log = "x".repeat(5000);
    const value = (await run("home_assistant_get_error_log", { maxBytes: 1024 }, [
      new Response(log, { headers: { "content-type": "text/plain" } }),
    ]).result) as { log: string; truncated: boolean };
    expect(value.truncated).toBe(true);
    expect(value.log.length).toBe(1024);
  });

  it("filters the service registry by domain without a second request", async () => {
    const services = [
      { domain: "light", services: { turn_on: {} } },
      { domain: "climate", services: { set_temperature: {} } },
    ];
    const { result, calls } = run("home_assistant_list_services", { domain: "climate" }, [
      jsonResponse(services),
    ]);
    expect(await result).toEqual([services[1]]);
    expect(calls).toHaveLength(1);
  });
});

describe("Home Assistant failure handling", () => {
  it("asks the operator to reconnect when the token is rejected, without echoing the response", async () => {
    const { result } = run("home_assistant_get_config", {}, [
      new Response("token expired for user admin", { status: 401 }),
    ]);
    await expect(result).rejects.toThrowError(/rejected this long-lived access token/);
    await expect(result).rejects.not.toThrowError(/admin/);
  });

  it("does not leak the configured address when the instance is unreachable", async () => {
    const failing = executeHomeAssistantTool(
      connection,
      headers,
      "home_assistant_get_config",
      {},
      {
        allowPrivateNetwork: true,
        request: async () => {
          throw new Error("connect ECONNREFUSED 192.0.2.10:8123");
        },
      },
    );
    await expect(failing).rejects.toThrowError(/could not be reached at the configured address/);
    await expect(failing).rejects.not.toThrowError(/192\.0\.2\.10/);
  });

  it("rejects an unknown tool name", async () => {
    await expect(
      run("home_assistant_delete_everything", {}, [jsonResponse({})]).result,
    ).rejects.toThrowError(/Unknown Home Assistant tool/);
  });

  it("refuses a response that is not parseable JSON", async () => {
    await expect(
      run("home_assistant_get_config", {}, [
        new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      ]).result,
    ).rejects.toThrowError(/could not parse as JSON/);
  });

  it("probes GET /api/ for health without reading household data", async () => {
    const { calls, request } = stub([jsonResponse({ message: "API running." })]);
    await probeHomeAssistant(connection, headers, { allowPrivateNetwork: true, request });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ha.example.test:8123/api/");
  });

  it("sends the credential header on every request and never in the URL", async () => {
    const { calls, result } = run("home_assistant_get_config", {}, [
      jsonResponse({ version: "2026.10.1" }),
    ]);
    await result;
    const { calls: probed, request } = stub([jsonResponse({})]);
    await probeHomeAssistant(connection, headers, { allowPrivateNetwork: true, request });
    for (const call of [...calls, ...probed]) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-token",
      );
      expect(call.url).not.toContain("test-token");
    }
  });
});
