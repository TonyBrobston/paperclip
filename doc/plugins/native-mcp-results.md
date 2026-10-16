# Native MCP tool results

The native gateway unwraps the plugin dispatcher response (`pluginId`, `toolName`, and `result`) before it converts the plugin SDK `ToolResult`.

- String `content` is preserved as a text block, including an empty string.
- Non-null object `data` is sent as `structuredContent`. If content is absent, the object is also serialized as JSON text.
- Arrays, strings, numbers, booleans, and explicit null data are serialized as a separate JSON text block. This retains data even when a plugin supplies a text summary. These values are never sent as `structuredContent`.
- Absent data does not produce a structured field. Empty results fall back to JSON text for the unwrapped payload (or `null` for an absent payload).
- A string `error` sets `isError: true` and is preserved in a text block. An error identical to content is not repeated.

The HTTP regression suite validates emitted results with the MCP SDK `CallToolResultSchema`:

```sh
pnpm exec vitest run server/src/__tests__/tool-gateway-mcp-result.test.ts
```

After an operator updates a host with this change, use an authorized native BigCommerce connection to call `get_store_info`, then `list_orders` with `limit: 1` and `page: 1`. Confirm both results pass native client validation, store data is an object, and order array data remains available as JSON text. Do not retain customer order details in validation logs.
