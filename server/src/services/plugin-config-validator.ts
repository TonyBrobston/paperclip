/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * @module server/services/plugin-config-validator
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@paperclipai/shared";

export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

/**
 * The binding object a secret picker submits for a `format: "secret-ref"`
 * field. Kept deliberately loose: `parseSecretRefBindingObject` in
 * `json-schema-secret-refs.ts` is the authoritative check and runs in the
 * secrets handler straight after this validator, so tightening the shape here
 * only moves a precise error to a vague one.
 */
const SECRET_REF_BINDING_SCHEMA = {
  type: "object",
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string" },
  },
  required: ["type", "secretId"],
} as const;

type SchemaNode = Record<string, unknown>;

function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite every `format: "secret-ref"` node to also accept a secret binding
 * object.
 *
 * A plugin declares such a field with the type of the *raw* value it wants —
 * `type: "string"` for an API key, which is what every first-party manifest in
 * this repo does. The settings form then renders a secret picker for it, and
 * the picker submits `{ type: "secret_ref", secretId, version }`. Validating
 * that object against the declared type rejected the only value the field can
 * produce, so a correctly filled form could not be saved at all: the field
 * error read "must be string" and there was no value an operator could type
 * instead.
 *
 * Both shapes are legitimate — a raw value is still accepted, since the
 * secrets handler promotes one — so each node becomes a union of what it
 * declared and the binding rather than being replaced by it.
 */
export function relaxSecretRefNodes(schema: JsonSchema): JsonSchema {
  /** Keywords whose value is a map of name → subschema. */
  const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;
  /** Keywords whose value is a subschema, or an array of them. */
  const SUBSCHEMA_SLOTS = [
    "items",
    "prefixItems",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
  ] as const;

  function relax(node: unknown): unknown {
    if (!isSchemaNode(node)) return node;

    // Only recurse through keywords that hold subschemas. Walking every key
    // would also rewrite data-bearing ones — `default`, `const`, `examples` —
    // where a `format` key is a value rather than a constraint.
    const rewritten: SchemaNode = { ...node };
    for (const keyword of SUBSCHEMA_MAPS) {
      const map = node[keyword];
      if (!isSchemaNode(map)) continue;
      rewritten[keyword] = Object.fromEntries(
        Object.entries(map).map(([name, child]) => [name, relax(child)]),
      );
    }
    for (const keyword of SUBSCHEMA_SLOTS) {
      const slot = node[keyword];
      if (slot === undefined) continue;
      rewritten[keyword] = Array.isArray(slot) ? slot.map(relax) : relax(slot);
    }

    if (node.format !== "secret-ref") return rewritten;

    // `title` and `description` stay on the wrapper so a schema-driven form
    // keeps reading them at the same place.
    const { title, description, ...constraints } = rewritten;
    return {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      anyOf: [constraints, SECRET_REF_BINDING_SCHEMA],
    };
  }

  return relax(schema) as JsonSchema;
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // Register the secret-ref format used by plugin manifests to mark fields that
  // hold a Paperclip secret UUID rather than a raw value. The format is a UI
  // hint only — UUID validation happens in the secrets handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(relaxSecretRefNodes(schema));
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}
