import { describe, expect, it } from "vitest";
import { gatewayResultToMcpToolResult } from "./gateway-mcp-result.js";

/**
 * The client-side check this conversion has to satisfy. The Claude MCP client
 * validates `structuredContent` as a record and rejects the whole `tools/call`
 * result when the field is present and is anything else — so an absent field is
 * the only safe way to say "no structured data".
 */
function clientAccepts(result: { structuredContent?: unknown }): boolean {
  if (!("structuredContent" in result)) return true;
  const value = result.structuredContent;
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("gatewayResultToMcpToolResult", () => {
  it("forwards a JSON object as structuredContent", () => {
    const result = gatewayResultToMcpToolResult({
      content: "ok",
      data: { version: "1.2.3" },
    });
    expect(result.structuredContent).toEqual({ version: "1.2.3" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(clientAccepts(result)).toBe(true);
  });

  /**
   * The defect. A plugin `ToolResult` is `{ content?, data?, error? }` with
   * every field optional, so a tool reporting a failure as `{ error }` has no
   * `data`. Forwarding `data ?? null` made the client reject the result and the
   * plugin's own message never arrived — every distinct cause read as one
   * identical schema error, and a failing plugin could not say why it failed.
   */
  it("omits structuredContent when the tool returned only an error", () => {
    const result = gatewayResultToMcpToolResult({
      error: "Home Assistant rejected the long-lived access token.",
    });
    expect("structuredContent" in result).toBe(false);
    expect(clientAccepts(result)).toBe(true);
    // The message still reaches the agent, through the one field that is always
    // present.
    expect(result.content[0]!.text).toContain("rejected the long-lived access token");
  });

  it("omits structuredContent for a tool that returned nothing at all", () => {
    const result = gatewayResultToMcpToolResult(undefined);
    expect("structuredContent" in result).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "null" }]);
    expect(clientAccepts(result)).toBe(true);
  });

  /**
   * A list endpoint's natural shape. An array is valid JSON and a perfectly
   * reasonable `data`, but it is not a valid `structuredContent`, so forwarding
   * it discarded a successful result.
   */
  it("keeps an array result readable as text instead of discarding it", () => {
    const rows = [{ entity_id: "light.kitchen" }, { entity_id: "light.hall" }];
    const result = gatewayResultToMcpToolResult({ data: rows });
    expect("structuredContent" in result).toBe(false);
    expect(clientAccepts(result)).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(rows);
  });

  it.each([
    ["a string", "just text"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
  ])("omits structuredContent when data is %s", (_label, data) => {
    const result = gatewayResultToMcpToolResult({ data });
    expect("structuredContent" in result).toBe(false);
    expect(clientAccepts(result)).toBe(true);
  });

  it("prefers the tool's own text content over serializing its data", () => {
    const result = gatewayResultToMcpToolResult({
      content: "human readable",
      data: { ignored: true },
    });
    expect(result.content[0]!.text).toBe("human readable");
  });

  it("falls back to the structured half when there is no text content", () => {
    const result = gatewayResultToMcpToolResult({ data: { a: 1 } });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ a: 1 });
  });

  it("treats a non-object tool result as text", () => {
    const result = gatewayResultToMcpToolResult(["a", "b"]);
    expect("structuredContent" in result).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual(["a", "b"]);
  });

  it("reports isError false, as the route always has", () => {
    expect(gatewayResultToMcpToolResult({ error: "nope" }).isError).toBe(false);
    expect(gatewayResultToMcpToolResult({ data: {} }).isError).toBe(false);
  });
});
