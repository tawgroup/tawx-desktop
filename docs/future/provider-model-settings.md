# Provider and model settings research

This note separates source facts from the proposed TAWX Desktop design. Sources were checked on 2026-09-09.

## Source findings

### Oh My Pi

Oh My Pi (OMP) treats a provider and a model as different identities instead of flattening both into a model string.

- [`ModelRegistry`](https://github.com/can1357/oh-my-pi/blob/9effebbb192e415c32939b4946caf6bb6b7811f1/packages/coding-agent/src/config/model-registry.ts) loads bundled providers/models, adds runtime-discovered and custom providers, and projects only models whose provider can authenticate. It tracks discovery state separately from the catalog.
- [`PROVIDER_REGISTRY` and `getProviderDefinition`](https://github.com/can1357/oh-my-pi/blob/9effebbb192e415c32939b4946caf6bb6b7811f1/packages/ai/src/registry/registry.ts) compile provider authentication policy independently from transport. The registry has a compile-time completeness check for catalog providers and dispatches environment-key, login, refresh, and OAuth behavior through provider policy.
- The useful boundary for TAWX is therefore: provider definition → credential resolution → connection/discovery state → provider-scoped model catalog → selected route. TAWX should copy that separation, not OMP's terminal-specific UI or process environment assumptions.

### Provider APIs

- OpenRouter uses an OpenAI-compatible API at `https://openrouter.ai/api/v1`, bearer authentication, namespaced model IDs such as `openai/gpt-5.2`, and `GET /api/v1/models`. It can route one model across upstream providers, so an OpenRouter route is not the same route as a direct vendor connection. [OpenRouter API overview](https://openrouter.ai/docs/api-reference/overview) and [model listing](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
- OpenAI exposes `GET /v1/models`; model records contain an `id` and owner metadata. Authentication uses a bearer API key. [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list).
- DeepSeek exposes an OpenAI-compatible API at `https://api.deepseek.com`, using bearer authentication and direct DeepSeek model IDs. [DeepSeek API docs](https://api-docs.deepseek.com/).
- Anthropic's native API uses `POST /v1/messages`, `GET /v1/models`, an API key, an `anthropic-version` header, and a different message shape from OpenAI compatibility. [Anthropic API overview](https://platform.claude.com/docs/en/api/overview) and [Messages API](https://platform.claude.com/docs/en/api/messages).
- Ollama's local API defaults to `http://localhost:11434/api`; local installations normally do not require a key. Its native endpoints differ from OpenAI compatibility, although Ollama also offers compatibility endpoints. [Ollama API introduction](https://docs.ollama.com/api/introduction).

### TAWX before implementation

- `frontend/src/types.ts` identified a provider with one local UUID plus `name`, `baseUrl`, `apiKey`, and one selected `model`.
- `frontend/src/store/useSettings.ts` supported add, update, remove, and active selection, but had no enabled state, provider kind, auth kind, connection state, or provider-scoped model catalog.
- `frontend/src/components/SettingsModal.tsx` assumed every provider was OpenAI-compatible.
- The implementation below retains browser-profile credential storage for compatibility. Moving credentials behind a desktop-only secure-store boundary remains separate hardening work.

## Decision

Use a provider-first settings model. A provider connection owns authentication, transport, health, and discovered models. A model route is identified by both provider connection and provider-native model ID.

The stable route key is:

```text
providerConnectionId + modelId
```

Display names are not identity. The same logical model may therefore appear more than once:

```text
DeepSeek V4 Pro · DeepSeek Direct
DeepSeek V4 Pro · OpenRouter
```

These routes may differ in price, latency, retention policy, availability, rate limits, supported parameters, and billing account. They must never be silently deduplicated by model name.

## Target desktop state model

```ts
type ProviderKind =
  | 'openrouter'
  | 'openai-compatible'
  | 'anthropic'
  | 'ollama';

type AuthKind = 'api-key' | 'bearer' | 'none';

type ConnectionState =
  | 'disabled'
  | 'untested'
  | 'testing'
  | 'connected'
  | 'error';

interface ProviderConnection {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authKind: AuthKind;
  credentialRef?: string;
  enabled: boolean;
  state: ConnectionState;
  lastCheckedAt?: string;
  lastError?: string;
}

interface ProviderModel {
  routeId: string; // `${providerConnectionId}:${modelId}` or an opaque equivalent
  providerConnectionId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    contextTokens?: number;
  };
}
```

Persist connection configuration and model enablement separately. Never persist raw credentials in exported chat/settings JSON. The renderer receives only `hasCredential`, never the credential value after submission.

## Settings information architecture

### Providers list

Each provider card shows:

- provider name and kind;
- base URL;
- enabled toggle;
- connection badge: Disabled, Untested, Testing, Connected, or Error;
- discovered/enabled model counts;
- last successful check or a concise redacted error;
- actions: Configure, Test, Models, Disable/Enable, Delete.

Disabling preserves configuration and model choices but removes every route from pickers and routing. Deleting requires confirmation, removes the credential from secure storage, removes discovered models, and moves any default route to the next enabled route or `auto`.

### Add or configure flow

1. Choose provider kind.
2. Apply a kind-specific base URL default.
3. Choose supported authentication and submit the credential to the desktop process.
4. Test authentication and transport.
5. Discover models.
6. Enable desired models.
7. Optionally make one route the Chat default.

The Save action may store an untested connection, but it must remain visibly Untested. “Test and save” is the primary action.

### Model picker

Group routes by provider connection, not by normalized model name. Search matches model ID, display name, and provider name. Every row includes a provider badge. `auto` remains separate because semantic routing is not a provider.

Example:

```text
Auto

DeepSeek Direct
  DeepSeek V4 Flash            deepseek-v4-flash
  DeepSeek V4 Pro              deepseek-v4-pro

OpenRouter
  DeepSeek V4 Pro              deepseek/deepseek-v4-pro
  Claude Sonnet                anthropic/claude-sonnet-4
```

The selected value is a route ID. Requests resolve the route ID to the connection and provider-native model ID server-side.

## Future desktop API boundary

Recommended local-only endpoints:

```text
GET    /desktop/providers
POST   /desktop/providers
PATCH  /desktop/providers/:id
DELETE /desktop/providers/:id
POST   /desktop/providers/:id/credential
DELETE /desktop/providers/:id/credential
POST   /desktop/providers/:id/test
POST   /desktop/providers/:id/discover
PATCH  /desktop/providers/:id/models/:modelId
```

Mutations validate IDs, URL schemes, body sizes, and provider-kind/auth compatibility. Responses redact credentials and upstream response bodies. The desktop process serializes mutations and writes private files atomically without following symlinks.

## Future credential hardening

- Store credentials in the OS credential store from the Electron main process. If the required secure-store dependency is unavailable, use a private desktop file only as an explicit interim implementation and never expose values back to the renderer.
- The renderer submits a credential once over the local same-origin endpoint and receives only `hasCredential`.
- Permit `https:` remote provider URLs. Permit `http:` only for loopback local providers such as Ollama or LM Studio.
- Do not accept arbitrary auth headers from the renderer. Provider kind chooses the allowed header policy.
- Redact keys, authorization headers, upstream bodies, and query credentials from logs, errors, audits, exports, and connection-test responses.
- Connection tests use bounded timeouts and response sizes. Model discovery is explicit and refreshable, not performed on every picker open.
- Enabling a provider without a required credential leaves it in Error/Untested and contributes no active routes.

## Provider examples

| Provider | Kind | Base URL | Auth | Model identity example |
| --- | --- | --- | --- | --- |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | Bearer key | `openrouter-1:deepseek/deepseek-v4-pro` |
| DeepSeek direct | `openai-compatible` | `https://api.deepseek.com` | Bearer key | `deepseek-1:deepseek-v4-pro` |
| OpenAI | `openai-compatible` | `https://api.openai.com/v1` | Bearer key | `openai-1:gpt-5.2` |
| Anthropic | `anthropic` | `https://api.anthropic.com` | API key plus version policy | `anthropic-1:claude-sonnet-4` |
| Ollama | `ollama` | `http://localhost:11434` | None by default | `ollama-1:llama3.3` |

DeepSeek direct and DeepSeek through OpenRouter are two routes even when the displayed model family matches. The UI should make the provider difference visible at selection time and in every response footer.

## Failure states

- Invalid URL: reject before saving.
- Missing credential: save as Untested/Error; no active routes.
- Unauthorized: show “Authentication failed”; never include the upstream body or key.
- Model endpoint unsupported: allow manual model entry only for OpenAI-compatible connections and mark it Manual.
- Timeout/offline: retain the last successful model catalog, mark it stale, and exclude the provider only when its connection state is explicitly disabled or authentication is invalid.
- Deleted active provider: atomically select another enabled route or `auto`.
- Duplicate base URL: allow it because separate credentials/accounts are valid; require distinct connection names.
- Duplicate model across providers: keep both provider-scoped routes.

## Future secure-store migration

For every existing browser provider:

1. Infer `openrouter` from the OpenRouter host, `ollama` from a loopback Ollama URL, otherwise `openai-compatible`.
2. Create one desktop provider connection with the existing UUID where valid.
3. Move the key to secure desktop storage, then remove it from renderer persistence.
4. Create one enabled model route from the existing `model` field.
5. Convert `activeProviderId + model` into the new route ID.
6. Keep the old browser record only until the desktop confirms migration; then delete it.

Migration must be idempotent and must not export or log the credential.

## Implemented

The desktop UI now implements the provider-first route identity and lifecycle for gateway, OpenRouter, OpenAI-compatible, and Ollama-compatible connections:

1. Existing browser provider records migrate in place with inferred kind, authorization, enabled state, health, and a provider-scoped catalog.
2. Settings supports presets, add/configure, bearer or no authorization, test-and-discover, enable/disable, and confirmed deletion.
3. The composer identifies a route by provider connection plus model ID and labels duplicate model IDs with their provider names.
4. Assistant response headers persist the provider name beside the concrete model.
5. Absolute provider requests use a bounded gateway proxy available only to loopback callers; remote targets require HTTPS and local HTTP is limited to loopback hosts.

## Remaining hardening

1. Move raw credentials from IndexedDB to the OS credential store and expose only `hasCredential` to the renderer.
2. Add Anthropic-native authorization and transport instead of presenting it as OpenAI-compatible.
3. Store capability metadata and per-model enablement separately from the discovered catalog.
