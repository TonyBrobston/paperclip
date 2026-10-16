/** Convert gateway tool results to the MCP tools/call wire shape. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function gatewayResultToMcpToolResult(value: unknown) {
  const envelope = asRecord(value);
  // Plugin dispatch adds routing metadata around the SDK ToolResult. Do not
  // unwrap arbitrary provider data that happens to contain a `result` field.
  const payload = typeof envelope?.pluginId === "string" && typeof envelope.toolName === "string"
    ? envelope.result
    : value;
  const result = asRecord(payload);
  const data = result?.data;
  const structuredContent = asRecord(data);
  const content: Array<{ type: "text"; text: string }> = [];
  if (typeof result?.content === "string") {
    content.push({ type: "text", text: result.content });
  }
  // MCP structuredContent accepts objects only. Keep arrays and scalars as a
  // separate JSON text block, even when the plugin also supplied human text.
  if (data !== undefined && (structuredContent === null || content.length === 0)) {
    content.push({ type: "text", text: JSON.stringify(data) });
  }
  const isError = typeof result?.error === "string";
  if (isError && result.error !== result.content) {
    content.push({ type: "text", text: result.error as string });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(payload ?? null) });
  }
  return {
    content,
    ...(structuredContent === null ? {} : { structuredContent }),
    isError,
  };
}
