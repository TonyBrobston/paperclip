import { describe, expect, it } from "vitest";
import {
  relaxSecretRefNodes,
  validateInstanceConfig,
} from "../services/plugin-config-validator.ts";

const SECRET_ID = "11111111-1111-1111-1111-111111111111";
const BINDING = { type: "secret_ref", secretId: SECRET_ID, version: "latest" };

/**
 * The shape every first-party manifest in this repo uses for a credential: the
 * type of the raw value, plus the format that makes the settings form render a
 * secret picker.
 */
const API_KEY_SCHEMA = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string", format: "secret-ref", title: "API key" },
  },
  required: ["baseUrl", "apiKey"],
};

describe("validateInstanceConfig", () => {
  /**
   * The picker submits a binding object, so validating it against the declared
   * `type: "string"` rejected the only value the field can produce — a
   * correctly filled form could not be saved, and the field error said
   * "must be string" with nothing an operator could type instead.
   */
  it("accepts the binding object a secret picker submits for a string field", () => {
    const result = validateInstanceConfig(
      { baseUrl: "https://example.com", apiKey: BINDING },
      API_KEY_SCHEMA,
    );
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a binding with no version and one pinned to a number", () => {
    for (const apiKey of [
      { type: "secret_ref", secretId: SECRET_ID },
      { type: "secret_ref", secretId: SECRET_ID, version: 3 },
    ]) {
      expect(
        validateInstanceConfig({ baseUrl: "https://example.com", apiKey }, API_KEY_SCHEMA).valid,
      ).toBe(true);
    }
  });

  it("still accepts a raw value, which the secrets handler promotes", () => {
    expect(
      validateInstanceConfig(
        { baseUrl: "https://example.com", apiKey: "raw-api-key" },
        API_KEY_SCHEMA,
      ).valid,
    ).toBe(true);
  });

  it("still requires a secret-ref field to be present", () => {
    expect(validateInstanceConfig({ baseUrl: "https://example.com" }, API_KEY_SCHEMA).valid).toBe(
      false,
    );
  });

  it.each([
    ["a different binding kind", { type: "user_secret_ref", secretId: SECRET_ID }],
    ["a binding with no secret id", { type: "secret_ref" }],
    ["an array", [BINDING]],
    ["a number", 7],
  ])("rejects %s for a string-typed secret field", (_label, apiKey) => {
    expect(
      validateInstanceConfig({ baseUrl: "https://example.com", apiKey }, API_KEY_SCHEMA).valid,
    ).toBe(false);
  });

  /**
   * The relaxation is scoped to fields that asked for a picker. Everything
   * else keeps the constraints the manifest declared.
   */
  it("leaves ordinary fields fully constrained", () => {
    const result = validateInstanceConfig(
      { baseUrl: BINDING, apiKey: BINDING },
      API_KEY_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.map((error) => error.field)).toContain("/baseUrl");
  });

  it("accepts a binding for a secret field nested under an object", () => {
    const schema = {
      type: "object",
      properties: {
        provider: {
          type: "object",
          properties: { token: { type: "string", format: "secret-ref" } },
          required: ["token"],
        },
      },
    };
    expect(validateInstanceConfig({ provider: { token: BINDING } }, schema).valid).toBe(true);
    expect(validateInstanceConfig({ provider: { token: 7 } }, schema).valid).toBe(false);
  });

  it("accepts a binding for a secret field inside a composition branch", () => {
    const schema = {
      type: "object",
      anyOf: [
        {
          properties: { token: { type: "string", format: "secret-ref" } },
          required: ["token"],
        },
      ],
    };
    expect(validateInstanceConfig({ token: BINDING }, schema).valid).toBe(true);
  });

  /**
   * A manifest may also declare the binding shape directly — which is what a
   * plugin author does once the string form has rejected them. That has to
   * keep working, or the fix trades one broken declaration for another.
   */
  it("accepts a manifest that declares the binding object itself", () => {
    const schema = {
      type: "object",
      properties: {
        token: {
          type: "object",
          format: "secret-ref",
          properties: { type: { const: "secret_ref" }, secretId: { type: "string" } },
          required: ["type", "secretId"],
        },
      },
      required: ["token"],
    };
    expect(validateInstanceConfig({ token: BINDING }, schema).valid).toBe(true);
    expect(validateInstanceConfig({ token: "raw" }, schema).valid).toBe(false);
  });

  it("validates a schema with no secret-ref fields exactly as before", () => {
    const schema = {
      type: "object",
      properties: { retries: { type: "integer", minimum: 1 } },
      required: ["retries"],
    };
    expect(validateInstanceConfig({ retries: 2 }, schema).valid).toBe(true);
    expect(validateInstanceConfig({ retries: 0 }, schema).valid).toBe(false);
    expect(validateInstanceConfig({}, schema).valid).toBe(false);
  });
});

describe("relaxSecretRefNodes", () => {
  it("does not mutate the schema it is given", () => {
    const schema = structuredClone(API_KEY_SCHEMA);
    relaxSecretRefNodes(schema);
    expect(schema).toEqual(API_KEY_SCHEMA);
  });

  it("keeps the declared constraints as one branch of the union", () => {
    const relaxed = relaxSecretRefNodes(API_KEY_SCHEMA) as {
      properties: { apiKey: { title?: string; anyOf: Record<string, unknown>[] } };
    };
    expect(relaxed.properties.apiKey.title).toBe("API key");
    expect(relaxed.properties.apiKey.anyOf[0]).toMatchObject({
      type: "string",
      format: "secret-ref",
    });
  });

  /**
   * `format` inside a data-bearing keyword is a value, not a constraint.
   */
  it("leaves a default value that happens to carry a format key alone", () => {
    const schema = {
      type: "object",
      properties: {
        shape: { type: "object", default: { format: "secret-ref" } },
      },
    };
    expect(relaxSecretRefNodes(schema)).toEqual(schema);
  });
});
