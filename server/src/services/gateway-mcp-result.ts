/**
 * Convert a tool-gateway result into an MCP `tools/call` result.
 *
 * MCP makes `structuredContent` optional and requires it to be a JSON object.
 * Clients enforce that: the Claude MCP client validates the field as a record
 * and rejects the **whole** result when it is anything else — the text content
 * included. So an explicit `null` there is not a harmless "no structured data"
 * signal; it discards the response.
 *
 * That mattered because a plugin `ToolResult` is `{ content?, data?, error? }`
 * with every field optional. A tool reporting a failure as `{ error }` carries
 * nothing in either forwarded field, so forwarding `data ?? null` turned every
 * such failure into a transport-level schema error at the client, with the
 * plugin's own message never arriving. A plugin could not even report *why* it
 * failed. The same applied to a successful tool whose `data` was a top-level
 * array, which is the natural shape of a list endpoint.
 *
 * This omits `structuredContent` unless the tool supplied a JSON object, and
 * keeps the result's text content as the channel that always works.
 */
export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function gatewayResultToMcpToolResult(toolResult: unknown): McpToolCallResult {
  const record = asRecord(toolResult);
  const contentText = typeof record?.content === "string"
    ? record.content
    // No text content: fall back to the structured half, then to the whole
    // result — which is what carries `error` for a tool that sets only that.
    : JSON.stringify(record?.data ?? toolResult ?? null);
  const structured = asRecord(record?.data);
  return {
    content: [{ type: "text", text: contentText }],
    ...(structured === null ? {} : { structuredContent: structured }),
    // Unchanged: the gateway reports a transport-level failure by throwing, and
    // a tool's own `error` field has never set this flag. Narrowing that is a
    // separate change with a wider blast radius than the discard fixed here.
    isError: false,
  };
}
