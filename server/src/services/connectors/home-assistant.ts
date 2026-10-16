import { z } from "zod";
import {
  HOME_ASSISTANT_ENTITY_PAGE_MAX,
  HOME_ASSISTANT_LOG_TAIL_MAX_BYTES,
  homeAssistantApiUrl,
} from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";

/** Largest response body accepted from Home Assistant, before parsing. */
const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

export class HomeAssistantError extends HttpError {}

/**
 * A Home Assistant connection is a `rest_api` connection created from this
 * connector's catalog entry. The same shape as the Browser Use predicate:
 * `sourceTemplateKey` is set by setup from the app definition slug, so a
 * hand-made generic REST connection cannot borrow this tool catalog.
 */
export function isHomeAssistantConnection(connection: {
  transport: string;
  config?: Record<string, unknown>;
}) {
  return (
    connection.transport === "rest_api" &&
    connection.config?.sourceTemplateKey === "home-assistant"
  );
}

/**
 * The operator-entered instance address.
 *
 * Home Assistant is self-hosted, so this lives in the connection's method
 * config rather than in a catalog `serverUrl`. A connection saved before the
 * setting existed, or edited to drop it, fails here rather than falling back to
 * some default host.
 */
export function homeAssistantBaseUrl(connection: {
  config?: Record<string, unknown>;
}): string {
  const methodConfig = connection.config?.methodConfig;
  const baseUrl =
    methodConfig && typeof methodConfig === "object" && !Array.isArray(methodConfig)
      ? (methodConfig as Record<string, unknown>).baseUrl
      : undefined;
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new HomeAssistantError(
      422,
      "This Home Assistant connection has no instance address. Reconnect it and enter the address you open Home Assistant at.",
    );
  }
  return baseUrl.trim();
}

type RequestOptions = {
  /** Mirrors the gateway's deployment rule for operator-supplied endpoints. */
  allowPrivateNetwork: boolean;
  /** Test seam matching the gateway's injected remote HTTP request. */
  request?: (url: string, init: RequestInit) => Promise<Response>;
};

async function call(
  baseUrl: string,
  headers: Record<string, string>,
  path: string,
  options: RequestOptions,
  body?: unknown,
  /** Return only the last N bytes, streaming past the response cap. */
  tailBytes?: number,
): Promise<{ text: string; contentType: string; truncated: boolean }> {
  let url: URL;
  try {
    url = homeAssistantApiUrl(baseUrl, path);
  } catch {
    // Stored config can be older than the setup field pattern, or hand-edited.
    // Surface it as operator-fixable configuration rather than a server fault,
    // and do not echo the stored address back.
    throw new HomeAssistantError(
      422,
      "This Home Assistant connection has an unusable instance address. Reconnect it and enter the address you open Home Assistant at, with no query string, fragment or embedded credentials.",
    );
  }
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      ...headers,
      Accept: "application/json, text/plain",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  let response: Response;
  try {
    response = await (options.request
      ? options.request(url.toString(), init)
      : guardedRemoteHttpFetch(url, init, {
          allowPrivateNetwork: options.allowPrivateNetwork,
          error: (message, code) =>
            new HomeAssistantError(
              422,
              code === "remote_http_private_endpoint"
                ? "This Paperclip deployment cannot reach private network addresses. Use an address that is reachable from the Paperclip server."
                : "Home Assistant could not be reached at the configured address.",
            ),
        }));
  } catch (error) {
    // A Home Assistant address and token are operator configuration; never echo
    // the attempted URL or provider response text back through an exception.
    if (error instanceof HomeAssistantError) throw error;
    throw new HomeAssistantError(
      502,
      "Home Assistant could not be reached at the configured address.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HomeAssistantError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      response.status === 401 || response.status === 403
        ? "Home Assistant rejected this long-lived access token. Reconnect the connection with a current token."
        : response.status === 404
          ? "Home Assistant has no such entity, service or endpoint."
          : `Home Assistant request failed (${response.status}).`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const { text, truncated } = await readBounded(response, tailBytes);
  return { text, contentType, truncated };
}

/**
 * Read a bounded response body.
 *
 * Home Assistant streams a whole-installation state dump on `/api/states`, so
 * a response that has to arrive whole to be parsed is capped and refused past
 * `RESPONSE_LIMIT_BYTES`.
 *
 * A log tail is different. `/api/error_log` serves the entire current
 * `home-assistant.log` with no paging and no `Range` support, so on a
 * long-running instance with a chatty integration the whole file exceeds that
 * cap — and refusing would make the diagnostic tool fail every time until
 * someone truncated the log on the host. When `tailBytes` is set, earlier
 * chunks are dropped as the window moves instead, so the caller gets the tail
 * it asked for and memory stays bounded by `tailBytes` plus one chunk.
 */
async function readBounded(
  response: Response,
  tailBytes?: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Buffer[] = [];
  let held = 0;
  let dropped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(Buffer.from(value));
      held += value.byteLength;
      if (tailBytes === undefined) {
        if (held > RESPONSE_LIMIT_BYTES) {
          throw new HomeAssistantError(
            502,
            "Home Assistant returned more data than Paperclip will read in one call. Narrow the request with a domain, search or time window.",
          );
        }
        continue;
      }
      // Drop a leading chunk only while the rest still covers the window.
      while (chunks.length > 1 && held - chunks[0]!.byteLength >= tailBytes) {
        held -= chunks.shift()!.byteLength;
        dropped = true;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buffer = Buffer.concat(chunks);
  if (tailBytes === undefined || buffer.byteLength <= tailBytes) {
    return { text: buffer.toString("utf8"), truncated: dropped };
  }
  return {
    text: buffer.subarray(buffer.byteLength - tailBytes).toString("utf8"),
    truncated: true,
  };
}

function json(payload: { text: string; contentType: string }): unknown {
  if (!payload.text) return null;
  try {
    return JSON.parse(payload.text);
  } catch {
    throw new HomeAssistantError(
      502,
      "Home Assistant returned a response Paperclip could not parse as JSON.",
    );
  }
}

const entityIdSchema = z.string().min(1).max(255);
const timestampSchema = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Timestamp must be an ISO 8601 date-time",
  });

const schemas = {
  home_assistant_list_entities: z
    .object({
      domain: z.string().max(64).optional(),
      search: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(HOME_ASSISTANT_ENTITY_PAGE_MAX).optional(),
    })
    .strict(),
  home_assistant_get_state: z.object({ entityId: entityIdSchema }).strict(),
  home_assistant_list_services: z
    .object({ domain: z.string().max(64).optional() })
    .strict(),
  home_assistant_render_template: z
    .object({ template: z.string().min(1).max(8192) })
    .strict(),
  home_assistant_get_config: z.object({}).strict(),
  home_assistant_check_config: z.object({}).strict(),
  home_assistant_get_history: z
    .object({
      entityId: entityIdSchema,
      startTime: timestampSchema.optional(),
      endTime: timestampSchema.optional(),
      minimalResponse: z.boolean().optional(),
    })
    .strict(),
  home_assistant_get_logbook: z
    .object({
      entityId: entityIdSchema.optional(),
      startTime: timestampSchema.optional(),
      endTime: timestampSchema.optional(),
    })
    .strict(),
  home_assistant_get_error_log: z
    .object({
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(HOME_ASSISTANT_LOG_TAIL_MAX_BYTES)
        .optional(),
    })
    .strict(),
  home_assistant_call_service: z
    .object({
      domain: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_]+$/, "Domain must be lowercase letters, digits or underscores"),
      service: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_]+$/, "Service must be lowercase letters, digits or underscores"),
      entityId: z
        .union([entityIdSchema, z.array(entityIdSchema).max(50)])
        .optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
} as const;

type HomeAssistantState = {
  entity_id?: unknown;
  state?: unknown;
  attributes?: Record<string, unknown>;
  last_changed?: unknown;
};

/** The compact row shape used by list_entities; the full object stays behind get_state. */
function summarizeState(state: HomeAssistantState) {
  const attributes = state.attributes ?? {};
  return {
    entityId: state.entity_id,
    state: state.state,
    friendlyName: attributes.friendly_name ?? null,
    deviceClass: attributes.device_class ?? null,
    unitOfMeasurement: attributes.unit_of_measurement ?? null,
    lastChanged: state.last_changed ?? null,
  };
}

function defaultWindow(startTime?: string, endTime?: string) {
  const start = startTime ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return { start, end: endTime };
}

/**
 * Execute one reviewed Home Assistant action.
 *
 * Every branch builds its own path from validated input. No branch accepts a
 * caller-supplied path or forwards an arbitrary request body, so an agent
 * cannot reach an endpoint this connector's permission review does not cover.
 */
export async function executeHomeAssistantTool(
  connection: { transport: string; config?: Record<string, unknown> },
  credentialHeaders: Record<string, string>,
  toolName: string,
  parameters: unknown,
  options: RequestOptions,
): Promise<unknown> {
  const baseUrl = homeAssistantBaseUrl(connection);
  const run = (path: string, body?: unknown, tailBytes?: number) =>
    call(baseUrl, credentialHeaders, path, options, body, tailBytes);

  switch (toolName) {
    case "home_assistant_list_entities": {
      const input = schemas.home_assistant_list_entities.parse(parameters ?? {});
      const states = json(await run("/api/states"));
      if (!Array.isArray(states)) {
        throw new HomeAssistantError(502, "Home Assistant returned an unexpected state list.");
      }
      const search = input.search?.toLowerCase();
      const matched = (states as HomeAssistantState[]).filter((state) => {
        const id = typeof state.entity_id === "string" ? state.entity_id : "";
        if (input.domain && !id.startsWith(`${input.domain}.`)) return false;
        if (!search) return true;
        const friendly = state.attributes?.friendly_name;
        return (
          id.toLowerCase().includes(search) ||
          (typeof friendly === "string" && friendly.toLowerCase().includes(search))
        );
      });
      const limit = input.limit ?? HOME_ASSISTANT_ENTITY_PAGE_MAX;
      return {
        totalMatched: matched.length,
        returned: Math.min(matched.length, limit),
        truncated: matched.length > limit,
        entities: matched.slice(0, limit).map(summarizeState),
      };
    }
    case "home_assistant_get_state": {
      const input = schemas.home_assistant_get_state.parse(parameters ?? {});
      return json(await run(`/api/states/${encodeURIComponent(input.entityId)}`));
    }
    case "home_assistant_list_services": {
      const input = schemas.home_assistant_list_services.parse(parameters ?? {});
      const services = json(await run("/api/services"));
      if (!Array.isArray(services)) {
        throw new HomeAssistantError(502, "Home Assistant returned an unexpected service list.");
      }
      return input.domain
        ? services.filter(
            (entry) =>
              entry && typeof entry === "object" && (entry as { domain?: unknown }).domain === input.domain,
          )
        : services;
    }
    case "home_assistant_render_template": {
      const input = schemas.home_assistant_render_template.parse(parameters ?? {});
      const result = await run("/api/template", { template: input.template });
      return { rendered: result.text };
    }
    case "home_assistant_get_config":
      schemas.home_assistant_get_config.parse(parameters ?? {});
      return json(await run("/api/config"));
    case "home_assistant_check_config":
      schemas.home_assistant_check_config.parse(parameters ?? {});
      return json(await run("/api/config/core/check_config", {}));
    case "home_assistant_get_history": {
      const input = schemas.home_assistant_get_history.parse(parameters ?? {});
      const { start, end } = defaultWindow(input.startTime, input.endTime);
      const query = new URLSearchParams({ filter_entity_id: input.entityId });
      if (end) query.set("end_time", end);
      if (input.minimalResponse ?? true) query.set("minimal_response", "");
      return json(
        await run(`/api/history/period/${encodeURIComponent(start)}?${query.toString()}`),
      );
    }
    case "home_assistant_get_logbook": {
      const input = schemas.home_assistant_get_logbook.parse(parameters ?? {});
      const { start, end } = defaultWindow(input.startTime, input.endTime);
      const query = new URLSearchParams();
      if (input.entityId) query.set("entity", input.entityId);
      if (end) query.set("end_time", end);
      const suffix = query.toString();
      return json(
        await run(
          `/api/logbook/${encodeURIComponent(start)}${suffix ? `?${suffix}` : ""}`,
        ),
      );
    }
    case "home_assistant_get_error_log": {
      const input = schemas.home_assistant_get_error_log.parse(parameters ?? {});
      const maxBytes = input.maxBytes ?? HOME_ASSISTANT_LOG_TAIL_MAX_BYTES;
      // The tail is applied while the body streams. Trimming after the fact
      // would mean the whole log had to fit under the response cap first, which
      // on an instance whose log has grown is exactly when this tool is wanted.
      const log = await run("/api/error_log", undefined, maxBytes);
      return { truncated: log.truncated, log: log.text };
    }
    case "home_assistant_call_service": {
      const input = schemas.home_assistant_call_service.parse(parameters ?? {});
      const body: Record<string, unknown> = { ...(input.data ?? {}) };
      // The explicit target wins over anything the caller smuggled into `data`.
      if (input.entityId !== undefined) body.entity_id = input.entityId;
      const changed = json(
        await run(`/api/services/${input.domain}/${input.service}`, body),
      );
      return {
        service: `${input.domain}.${input.service}`,
        changedStates: Array.isArray(changed)
          ? (changed as HomeAssistantState[]).map(summarizeState)
          : changed,
      };
    }
    default:
      throw new HomeAssistantError(404, `Unknown Home Assistant tool: ${toolName}`);
  }
}

/**
 * Health/discovery probe. `GET /api/` is the documented liveness endpoint and
 * still requires the token, so a successful probe proves both reachability and
 * a valid credential without reading any household data.
 */
export async function probeHomeAssistant(
  connection: { transport: string; config?: Record<string, unknown> },
  credentialHeaders: Record<string, string>,
  options: RequestOptions,
): Promise<void> {
  await call(homeAssistantBaseUrl(connection), credentialHeaders, "/api/", options);
}
