# Home Assistant

Updated: 2026-10-14. Status: catalog definition and connector runtime reviewed
against official Home Assistant REST API and authentication documentation;
live account qualification outstanding.

Home Assistant appears in Apps and uses Paperclip's shared vault, catalog,
grants, policies, gateway, and audit trail. It is a resource connection, not
Paperclip sign-in. No plugin, database migration, or UI surface is required.

## Why this is a curated connector and not a pasted MCP URL

Home Assistant ships an official
[MCP Server integration](https://www.home-assistant.io/integrations/mcp_server/),
so the obvious cheap route is **Connect your own MCP server**. That route does
not serve the work people actually hand to an agent.

The integration exposes the tools of the configured Assist LLM API, and clients
"can only control or provide information about entities that are exposed to
them." It is built for voice control. It does not enumerate the entity
registry, list the service registry, render a template, or read history — the
lookups a person otherwise copies out of the Home Assistant UI by hand before
an agent can write a correct automation.

This connector therefore wraps Home Assistant's
[REST API](https://developers.home-assistant.io/docs/api/rest/) instead. An
operator who only wants voice-style device control can still connect
`/api/mcp/{api_id}` (for example `/api/mcp/assist`) through the generic MCP
route; the two capabilities do not overlap.

A second practical difference: a curated method that declares a
`serverUrlTemplate` is required to be HTTPS, because
`normalizeConnectionMethodConfig` rejects a resolved catalog server URL that is
not. An MCP catalog entry for Home Assistant therefore cannot offer a
plain-HTTP LAN instance. This connector declares no template and keeps the
address in `tenantFields`, so a LAN instance with no certificate works where the
deployment permits private egress.

### Relationship to upstream PR #15477

Upstream [paperclipai/paperclip#15477](https://github.com/paperclipai/paperclip/pull/15477)
is an open proposal for a Home Assistant *MCP* connector over
`/api/mcp/assist`, with Home-Assistant-specific risk rules and quarantine for
newly appearing tools. It is HTTPS-only by its own description.

The two are complementary in capability — Assist-governed device control there,
registry and state lookup here — but they are not complementary in the
repository. Both use the slug `home-assistant`, this file path, the same brand
manifest entry, and the same permission-review app key, so they collide
directly on:

```text
doc/connections/HOME-ASSISTANT.md
doc/connections/README.md
doc/connections/tool-method-permission-reviews.json
packages/shared/src/app-definitions/home-assistant.json
packages/shared/src/app-definitions{,.test,.generated}.ts
server/src/services/tool-access.ts
ui/public/brands/apps/{home-assistant.svg,manifest.json}
```

Their method key is `mcp-access-token`; this one is `rest-token`. If both are
wanted, the cleanest resolution is one `home-assistant` definition carrying both
methods, with the REST method keeping its `tenantFields` address and the MCP
method keeping its HTTPS template. Keeping them as two definitions would need a
distinct slug for one of them, at the cost of two Home Assistant cards in
Browse.

## Shape

| Axis | Value |
| --- | --- |
| Transport | `rest_api`, executed by this connector, not the MCP gateway |
| Authentication | `api_key` — a long-lived access token in `Authorization: Bearer` |
| OAuth client ownership | not applicable |
| Credential source | `paperclip_vault` |
| Grant identity | `organization` (Home Assistant tokens are per-account, not per-agent) |

Home Assistant is self-hosted, so there is no catalog endpoint. The instance
address is a required `tenantFields` setting (`baseUrl`) rather than
`defaults.serverUrl`, for two reasons:

- there is no sensible default host to fall back to; and
- `normalizeConnectionMethodConfig` requires a resolved catalog server URL to
  be HTTPS, and the common Home Assistant deployment is a LAN address with no
  certificate.

The connector is admitted to the `provider_rest` execution path by
`REST_CONNECTOR_SLUGS`, the same reviewed set that admits Browser Use Cloud.
That set — rather than a per-provider branch — is what gives the connection a
`rest_api` tool application and routes its calls to this module; a `rest_api`
connection outside it gets no tool application and therefore no catalog.

`http` is therefore accepted in the field pattern. Reachability is still
decided by `remote-http-endpoint-guard`, not by this connector: private ranges
are permitted only in deployments that are not simultaneously `authenticated`
and `public`, and link-local addresses are refused in every deployment mode. A
publicly exposed Paperclip deployment cannot reach a LAN Home Assistant, and
will say so.

## Tool catalog

The catalog in `packages/shared/src/home-assistant.ts` is a fixed list. Each
tool maps to one documented endpoint and builds its own path from validated
input. No tool accepts a path, URL, HTTP method, or pass-through request body,
so an agent cannot reach an endpoint the permission review does not cover.

Read actions: `list_entities`, `get_state`, `list_services`, `render_template`,
`get_config`, `check_config`, `get_history`, `get_logbook`, `get_error_log`.

Write actions: `call_service`, and only that one.

`home_assistant_call_service` is classified **destructive** rather than
`write`. Home Assistant's service registry is how a caller unlocks a lock,
reloads configuration, or stops the instance, and the risk of the action
depends on arguments rather than on the tool name.

Because of that, `recommendedDefaultsForApp` ships this connector with
`askFirstRiskLevels: ["destructive"]`, so a new connection has
`call_service` on **Ask first** and all nine reads **Allowed**. That is a
narrow provider policy of the kind the playbook allows, and it follows the
Enterpret precedent; it does not change the repository-wide default for any
other connector. An operator can still move it to Allowed or Off on
**Permissions**.

### No configuration writes, deliberately

There is no tool for `POST /api/config/automation/config/<id>` and no tool that
writes any other configuration file.

That endpoint rewrites `automations.yaml` in place. For a Home Assistant
configuration kept in Git and deployed from CI, that is a silent conflict: the
file on the instance no longer matches the repository, and the next deploy
either clobbers the API-authored automation or refuses to run against a dirty
tree. The failure appears at deploy time, far from the agent that caused it.

Automation authoring belongs in the configuration repository, where review and
deploy already exist. The read tools exist so that YAML can be written
correctly the first time: `list_entities` for real entity IDs,
`list_services` for a service's real fields, `render_template` to check a
`value_template` or condition against live state, `check_config` to validate,
and `get_logbook`/`get_error_log` to see what happened after a deploy.

An operator who does want API-authored automations should raise that as its own
reviewed change, together with a decision about how it interacts with their
deploy pipeline. It is not a missing tool; it is a different product decision.

## Credential boundary

A Home Assistant long-lived access token inherits every permission of the
account that created it. Home Assistant has no mechanism to scope a token to
specific entities, domains, or read-only use, and Paperclip cannot reduce an
already-issued token's permissions.

Two consequences, both recorded in the method's `warnings` and in
[`tool-method-permission-reviews.json`](./tool-method-permission-reviews.json):

- the credential field tells the operator to issue the token from an account
  carrying only the access its agents need; and
- the per-action policy, not the token, is where write access is narrowed.

Revoking the token in the Home Assistant profile screen is the immediate
cut-off. Removing the Paperclip connection clears the grant, gateway access,
and owned secret material in the usual way.

The connector never echoes the configured address, the token, or Home
Assistant response text in an exception. A rejected credential becomes
"reconnect this connection"; an unreachable instance becomes "could not be
reached at the configured address".

## Health and discovery

Discovery probes `GET /api/`, the documented liveness endpoint, which still
requires the token. A successful probe proves both reachability and a valid
credential without reading any household data. Discovery then returns the fixed
catalog; a Home Assistant instance cannot expand it.

## Bounded responses

`GET /api/states` returns the whole installation, and `GET /api/error_log`
returns an unpaged plaintext log. Both are bounded:

- a response body over 8 MiB is refused with an actionable message rather than
  buffered;
- `list_entities` filters by domain and substring, caps rows at
  `HOME_ASSISTANT_ENTITY_PAGE_MAX`, and reports `truncated` instead of silently
  dropping rows; and
- `get_error_log` returns a tail of at most
  `HOME_ASSISTANT_LOG_TAIL_MAX_BYTES` and reports whether it truncated.

## Files

```text
scripts/app-definition-overrides/home-assistant.json   # authored definition source
packages/shared/src/app-definitions/home-assistant.json # generated definition
packages/shared/src/app-definitions.generated.ts       # generated registry
packages/shared/src/app-definitions.ts                 # CONNECTABLE_APP_SLUGS, REST_CONNECTOR_SLUGS
packages/shared/src/home-assistant.ts                  # reviewed tool catalog
server/src/services/connectors/home-assistant.ts       # predicate, client, execution
server/src/services/tool-access.ts                     # discovery probe, risk class
server/src/services/tool-gateway.ts                    # eligibility, execution branch
ui/public/brands/apps/home-assistant.svg               # official logomark
ui/public/brands/apps/manifest.json                    # branding path
doc/connections/tool-method-permission-reviews.json    # method permission review
```

## Verification

```sh
pnpm exec vitest run \
  server/src/services/connectors/home-assistant.test.ts \
  packages/shared/src/app-definitions.test.ts \
  server/src/__tests__/tool-access-service.test.ts \
  ui/src/pages/apps/AppsConnect.test.tsx \
  ui/src/pages/apps/Browse.test.tsx
node scripts/check-app-brand-assets.mjs
```

Live qualification still owed, per the playbook's production-validation step:
connect a real instance, confirm the catalog lists ten actions with one Write,
run a read, run one narrow `call_service` against a harmless entity, revoke the
token and confirm the next call fails, then record the evidence in the method's
permission review. Fixture-backed tests prove Paperclip behavior; they do not
prove a provider account.

Artwork is the official Home Assistant colored logomark from the vendor brand
archive, used unmodified.
