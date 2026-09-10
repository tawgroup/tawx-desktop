# TAWX Desktop

A desktop chat app for OpenAI-compatible LLM providers. It runs an
OpenAI-compatible gateway inside its own Electron main process, so the UI, the
provider routing, and the agent runtime are one application with no sidecar and
no separate server to start.

Provider API keys are held by the main process and encrypted with the operating
system keychain. They never reach the renderer, and no HTTP response carries
them.

## Layout

| Directory   | What it is |
|-------------|------------|
| `desktop/`  | Electron main process: the gateway HTTP surface, provider adapters, agent runtime, scheduler, skills, integrations |
| `frontend/` | React UI, bundled into `desktop/web` |
| `etc/`      | The config template copied to `~/tawx-desktop/config.yaml` on first launch |
| `docs/`     | Reference for configuration, providers, semantic routing, metrics and streaming |

## Running from source

```bash
make install     # npm ci in frontend/ and desktop/
make dev         # build the UI, then launch Electron
```

`make dev` serves the app at `http://127.0.0.1:18080`, which is also the
OpenAI-compatible endpoint — any client that speaks the OpenAI API can point at
it:

```bash
curl http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

`make test` runs the frontend lint and tests, then the desktop typecheck and
tests. `make dist` packages a macOS app.

The UI must be built before the app can serve it, which is why `dev`, `build`
and `dist` all depend on `ui`. Running `npm run dev` inside `desktop/` alone
gives a blank window on a fresh clone.

## Providers

Two kinds of provider coexist.

**Configured in Settings.** Added through the app's Settings panel and owned by
the main process. The key is encrypted with the OS keychain and stored in
`providers.json` under the app's user-data directory. These are addressed as
`<providerId>/<model>` — for example `deepseek/deepseek-chat`. The provider
named by the prefix serves the request, so two providers can offer the same
model name without colliding.

**Configured in `config.yaml`.** Read at startup from
`~/tawx-desktop/config.yaml`, and shown in Settings as read-only. Routed by
model name: an `openrouter/` prefix wins first, then `gpt-`, `o1-` and `o3-` go
to OpenAI and `claude-` to Anthropic, and anything else falls through to the
local backend.

Adding a vendor means writing one adapter and adding one entry to
`PROVIDER_KINDS` in `desktop/src/providers/kinds.ts`. Nothing else in the
codebase branches on vendor identity.

`GET /v1/models` lists every configured provider's models with ids qualified as
`<providerId>/<model>`, so whatever it returns can be sent straight back as the
`model` of a completion request.

## Semantic routing

When a request omits `model` or sends `auto`, a three-layer cascade picks one:
keyword heuristics, then embedding similarity, then an LLM classifier. Routes
are declared in `config.yaml`. See `docs/current/semantic-routing.md`.

## History

This project began as a fork of
[openziti/llm-gateway](https://github.com/openziti/llm-gateway), a Go gateway
whose distinguishing feature was reaching inference backends over
[zrok](https://zrok.io) and [OpenZiti](https://openziti.io) overlay networks —
no port forwarding, no VPN. The desktop app never used that, and the Go
implementation was ported to TypeScript so the gateway could run in the Electron
main process. The Go tree, its zrok and OpenZiti transports, its API-key store
and its release pipeline were removed once nothing depended on them; they remain
in git history and upstream.

The UI is based on MIT-licensed
[ChatOpenApi](https://github.com/hrmncode/ChatOpenApi).
