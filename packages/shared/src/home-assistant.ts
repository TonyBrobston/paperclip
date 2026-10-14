/**
 * Home Assistant connector contract.
 *
 * Home Assistant is self-hosted, so the instance address is a connection
 * setting rather than a fixed catalog endpoint. Everything else about this
 * connector is ordinary: a vaulted long-lived access token, a reviewed tool
 * catalog, and the normal gateway policy/audit path.
 *
 * The catalog below is deliberately a fixed list of endpoints. Home Assistant's
 * REST API is broad and its service-call surface can reconfigure a house, so a
 * generic "call any path" tool would put an unreviewable action behind one
 * policy decision. Each tool here maps to one documented endpoint.
 */

/**
 * The instance base URL, without the `/api` suffix.
 *
 * `http` is accepted because the common deployment is a LAN address with no
 * certificate. The remote endpoint guard still decides whether that address is
 * reachable: private ranges are permitted only in deployments that are not
 * simultaneously `authenticated` and `public`, and link-local addresses are
 * refused everywhere.
 */
export const HOME_ASSISTANT_BASE_URL_PATTERN = "^https?://[^\\s/?#]+(?:/[^\\s?#]*)?$";

/** Caps a `/api/states` response so a large installation cannot flood a run. */
export const HOME_ASSISTANT_ENTITY_PAGE_MAX = 500;
/** Home Assistant returns the error log as plaintext with no paging. */
export const HOME_ASSISTANT_LOG_TAIL_MAX_BYTES = 64 * 1024;

export function homeAssistantApiUrl(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // A base URL carrying credentials, a query or a fragment would silently
  // rewrite every request built from it. The setup field pattern already
  // rejects these; re-check here because this runs against stored config.
  const base = new URL(trimmed);
  // `new URL("ha.example.test:8123")` parses as the scheme `ha.example.test:`
  // with an opaque path rather than throwing, so a stored address that lost its
  // scheme would build a nonsense request instead of failing here.
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Home Assistant base URL must start with http:// or https://");
  }
  if (base.username || base.password) {
    throw new Error("Home Assistant base URL must not contain credentials");
  }
  if (base.search || base.hash) {
    throw new Error("Home Assistant base URL must not contain a query or fragment");
  }
  return new URL(`${trimmed}${path}`);
}

const entityId = {
  type: "string",
  description: "Entity ID such as light.kitchen or sensor.outdoor_temperature.",
  maxLength: 255,
} as const;

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  read = false,
) {
  return {
    name,
    title: name.replace(/^home_assistant_/, "").replaceAll("_", " "),
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: read,
      destructiveHint: !read,
      idempotentHint: read,
      openWorldHint: true,
    },
  };
}

/**
 * Reviewed catalog. Read tools cover the lookup work a person otherwise has to
 * copy out of the Home Assistant UI by hand; `home_assistant_call_service` is
 * the single write action and reaches any Home Assistant service, so it is
 * classified destructive and is the one an operator will most want to put
 * behind **Ask first**.
 *
 * There is intentionally no tool that writes `automations.yaml` through
 * `/api/config/automation/config/<id>`. That endpoint rewrites the file in
 * place, which conflicts with a Git-managed configuration: the next deploy sees
 * local modifications it did not author. Automation authoring belongs in the
 * configuration repository; `home_assistant_render_template` and
 * `home_assistant_list_entities` exist so that YAML can be written correctly
 * the first time, against real entity IDs and real state.
 */
export const HOME_ASSISTANT_TOOLS = [
  tool(
    "home_assistant_list_entities",
    "List entities with their current state. Filter by domain and/or a substring matched against the entity ID and friendly name. Returns a compact row per entity; use home_assistant_get_state for the full attribute set. Start here instead of guessing an entity ID.",
    {
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light, sensor, switch, binary_sensor or automation.",
        maxLength: 64,
      },
      search: {
        type: "string",
        description: "Case-insensitive substring matched against entity ID and friendly name.",
        maxLength: 128,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: HOME_ASSISTANT_ENTITY_PAGE_MAX,
        description: `Maximum rows to return (default ${HOME_ASSISTANT_ENTITY_PAGE_MAX}).`,
      },
    },
    [],
    true,
  ),
  tool(
    "home_assistant_get_state",
    "Read one entity's full state object, including every attribute and the last changed/updated timestamps.",
    { entityId },
    ["entityId"],
    true,
  ),
  tool(
    "home_assistant_list_services",
    "List callable services and their accepted fields, optionally for one domain. Use this to confirm a service name and its parameters before calling it.",
    {
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light, climate, automation or script.",
        maxLength: 64,
      },
    },
    [],
    true,
  ),
  tool(
    "home_assistant_render_template",
    "Render a Home Assistant Jinja template against live state and return the result as text. Use this to verify a template condition or value_template before putting it in a YAML automation.",
    {
      template: {
        type: "string",
        description: "Template source, for example {{ states('sensor.outdoor_temperature') }}.",
        maxLength: 8192,
      },
    },
    ["template"],
    true,
  ),
  tool(
    "home_assistant_get_config",
    "Read the instance configuration summary: version, unit system, time zone, location and loaded components.",
    {},
    [],
    true,
  ),
  tool(
    "home_assistant_check_config",
    "Validate the instance's YAML configuration and return either a valid result or the specific errors. This only validates; it changes nothing and reloads nothing.",
    {},
    [],
    true,
  ),
  tool(
    "home_assistant_get_history",
    "Read state history for one entity over a time window, for diagnosing why an automation did or did not fire.",
    {
      entityId,
      startTime: {
        type: "string",
        description: "ISO 8601 start timestamp. Defaults to one day before now.",
        maxLength: 64,
      },
      endTime: {
        type: "string",
        description: "ISO 8601 end timestamp. Defaults to now.",
        maxLength: 64,
      },
      minimalResponse: {
        type: "boolean",
        description: "Omit attributes from each history point. Defaults to true.",
      },
    },
    ["entityId"],
    true,
  ),
  tool(
    "home_assistant_get_logbook",
    "Read human-readable logbook entries, optionally for one entity, over a time window. Shows what happened and what triggered it.",
    {
      entityId: { ...entityId, description: "Optional entity ID to restrict the logbook to." },
      startTime: {
        type: "string",
        description: "ISO 8601 start timestamp. Defaults to one day before now.",
        maxLength: 64,
      },
      endTime: {
        type: "string",
        description: "ISO 8601 end timestamp. Defaults to now.",
        maxLength: 64,
      },
    },
    [],
    true,
  ),
  tool(
    "home_assistant_get_error_log",
    "Read the tail of the Home Assistant error log. Use this after a failed reload or a broken automation.",
    {
      maxBytes: {
        type: "integer",
        minimum: 1024,
        maximum: HOME_ASSISTANT_LOG_TAIL_MAX_BYTES,
        description: `Bytes to return from the end of the log (default ${HOME_ASSISTANT_LOG_TAIL_MAX_BYTES}).`,
      },
    },
    [],
    true,
  ),
  tool(
    "home_assistant_call_service",
    "Call a Home Assistant service, such as light.turn_on, automation.trigger, automation.reload or script.turn_on. This acts on the real house: it can switch devices, unlock locks, and reload configuration. Confirm the service and its fields with home_assistant_list_services first, and target the narrowest entity that does the job.",
    {
      domain: {
        type: "string",
        description: "Service domain, such as light, automation, script or homeassistant.",
        maxLength: 64,
      },
      service: {
        type: "string",
        description: "Service name within the domain, such as turn_on, trigger or reload.",
        maxLength: 64,
      },
      entityId: {
        // anyOf rather than oneOf: the two branches are disjoint, so the
        // exclusivity oneOf adds buys nothing, and tool-calling clients
        // handle anyOf more consistently.
        anyOf: [
          { type: "string", maxLength: 255 },
          { type: "array", items: { type: "string", maxLength: 255 }, maxItems: 50 },
        ],
        description: "Target entity ID, or a list of entity IDs.",
      },
      data: {
        type: "object",
        description: "Additional service fields, such as brightness_pct or temperature.",
        additionalProperties: true,
      },
    },
    ["domain", "service"],
    false,
  ),
];

export type HomeAssistantToolName = (typeof HOME_ASSISTANT_TOOLS)[number]["name"];
