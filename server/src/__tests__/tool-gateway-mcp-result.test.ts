import express from "express";
import request from "supertest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { ToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";

const pluginResult = (result: unknown) => ({ pluginId: "store-plugin", toolName: "read", result });

async function call(result: unknown) {
  const executeTool = vi.fn().mockResolvedValue({ status: "completed", result });
  const gateway = { executeTool } as unknown as ToolGatewayService;
  const app = express();
  app.use(express.json());
  app.use(mcpGatewayProtocolRoutes(gateway));
  const response = await request(app)
    .post("/mcp/gateways/test")
    .set("authorization", "Bearer test-token")
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "store-plugin:read", arguments: {} } })
    .expect(200);
  expect(response.body.id).toBe(1);
  expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({ tool: "store-plugin:read" }));
  // Validate the actual JSON response with the same schema used by MCP clients.
  const wire = response.body.result;
  expect(CallToolResultSchema.safeParse(wire).success).toBe(true);
  expect(wire.structuredContent).not.toBeNull();
  return wire;
}

describe("native MCP gateway result formatting", () => {
  it("unwraps object data and preserves plugin content", async () => {
    expect(await call(pluginResult({ content: "Store info", data: { id: 12, name: "Test store" } })))
      .toEqual({ content: [{ type: "text", text: "Store info" }], structuredContent: { id: 12, name: "Test store" }, isError: false });
  });

  it("serializes object data when no content is supplied", async () => {
    const result = await call(pluginResult({ data: { ok: true } }));
    expect(result.structuredContent).toEqual({ ok: true });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it.each(["hello", ""])("preserves content-only results (%j)", async (content) => {
    expect(await call(pluginResult({ content })))
      .toEqual({ content: [{ type: "text", text: content }], isError: false });
  });

  it.each([{}, { data: null }, undefined, null])("handles absent/null data (%j)", async (payload) => {
    const result = await call(pluginResult(payload));
    expect(result).not.toHaveProperty("structuredContent");
    expect(result.isError).toBe(false);
    expect(result.content[0].text).not.toContain("pluginId");
  });

  it.each([[{ id: 1 }], [], "value", "", 0, 42, false, true].map((data) => [data]))("preserves non-object data (%j)", async (data) => {
    for (const content of [undefined, "summary"]) {
      const result = await call(pluginResult({ content, data }));
      expect(result).not.toHaveProperty("structuredContent");
      expect(JSON.parse(result.content.at(-1).text)).toEqual(data);
      if (content !== undefined) expect(result.content[0].text).toBe(content);
    }
  });

  it.each([
    { error: "Store unavailable" },
    { content: "Partial result", data: { partial: true }, error: "Store unavailable" },
    { content: "Store unavailable", error: "Store unavailable" },
    { error: "" },
  ])("preserves plugin errors (%j)", async (payload) => {
    const result = await call(pluginResult(payload));
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: payload.error });
    if (payload.content) expect(result.content[0].text).toBe(payload.content);
  });

  it("keeps non-plugin provider results in their existing shape", async () => {
    const data = { result: { id: 1 } };
    expect(await call({ content: "provider text", data })).toEqual({
      content: [{ type: "text", text: "provider text" }], structuredContent: data, isError: false,
    });
  });
});
