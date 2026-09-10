# Cursor `agent.v1` wire protocol

Notes from reverse-engineering `omp` v18.1.5 (`/opt/homebrew/Cellar/omp/18.1.5/bin/omp`),
which reaches Cursor subscription models by impersonating the Cursor CLI. Written so the
TAWX `cursor` provider adapter can be built without re-deriving any of it.

## Transport

| | |
|---|---|
| Host | `https://api2.cursor.sh`, **HTTP/2 only** (`node:http2`, not `fetch`) |
| RPCs | `/agent.v1.AgentService/Run` (chat), `/agent.v1.AgentService/GetUsableModels` (catalog) |
| Encoding | Connect RPC, binary protobuf |
| `content-type` | `application/connect+proto` for `Run` (bidi stream), `application/proto` for `GetUsableModels` (unary) |

Required headers (omitting any of these is what makes a hand-rolled client 401 or hang):

```
:method            POST
:path              /agent.v1.AgentService/Run
content-type       application/connect+proto
connect-protocol-version 1
te                 trailers
authorization      Bearer <cursor oauth access token>
x-ghost-mode       true
x-cursor-client-version  cli-2026.07.23-e383d2b
x-cursor-client-type     cli
x-request-id       <uuid v4>
```

`x-cursor-client-version` is a real released Cursor CLI build string. The server appears to
gate on it; a made-up value is a needless risk.

### Envelope framing

Connect streaming frames, identical in both directions:

```
[flags: u8][length: u32 big-endian][payload: protobuf]
```

`flags = 0x00` is a normal message. `flags = 0x02` is the end-of-stream frame, whose payload
is **JSON**, not protobuf: `{}` on success, `{"error":{"code":"...","message":"..."}}` on failure.

## Auth

OAuth, not an API key:

1. Open `https://cursor.com/loginDeepControl` (device-style flow).
2. Poll `https://api2.cursor.sh/auth/poll`.
3. Exchange at `https://api2.cursor.sh/auth/exchange_user_api_key`.

`omp` stores the result in `~/.omp/agent/agent.db`, table `auth_credentials`,
`provider = 'cursor'`, `credential_type = 'oauth'`, `data = {access, refresh, expires, authorizedAt}`.
`omp token cursor` prints the current access token, refreshing it if needed. Reading it from
there is the fastest way to get a working token into TAWX before the login flow is built.

`CURSOR_ACCESS_TOKEN` is the env var `omp` also accepts.

## `Run` is an agent loop, not a completion call

This is the part that makes "just paste the token into an OpenAI-compatible provider"
impossible. The server drives the client:

```
client → AgentClientMessage { runRequest }
server → AgentServerMessage { kvServerMessage: getBlobArgs }      "send me blob <sha256>"
client → AgentClientMessage { kvClientMessage: getBlobResult }
server → AgentServerMessage { execServerMessage: requestContextArgs }  "describe your workspace"
client → AgentClientMessage { execClientMessage: requestContextResult }
server → AgentServerMessage { kvServerMessage: setBlobArgs }      "store this turn blob"
client → AgentClientMessage { kvClientMessage: setBlobResult }
server → AgentServerMessage { interactionUpdate: thinkingDelta | textDelta | tokenDelta }
server → AgentServerMessage { interactionUpdate: turnEnded }
```

A client that only writes a request and reads deltas will stall: the blob and
request-context round trips are mandatory.

If tools are offered, the server additionally sends `execServerMessage` tool calls
(`piBashArgs`, `piEditArgs`, `piReadArgs`, …) in Cursor's own tool vocabulary and waits for
the matching `*Result`. TAWX's Chat mode does not need this — send no tools and the server
stays in text mode.

## Blob store

Content-addressed, client-held:

- `blobId = sha256(content)`, keyed as lowercase hex.
- The system prompt is chunked and each chunk stored as a blob whose content is
  `JSON.stringify({ role: "system", content: <chunk> })`. Their hashes go in
  `AgentRunRequest.conversationState.rootPromptMessagesJson`.
- Prior turns are stored as blobs of **serialized protobuf** (`UserMessage` and
  `ConversationStep` messages), hashes in `conversationState.turns`.
- The server asks for any blob it does not have cached, which is why the same prompt costs
  less to resend on later turns.

## `AgentRunRequest`

Verified payload for a single-turn, no-tools request (379 bytes on the wire):

```jsonc
{
  "conversationState": {
    "rootPromptMessagesJson": ["<sha256 hex>", "<sha256 hex>"],
    "turns": [],
    "todos": [], "pendingToolCalls": [], "previousWorkspaceUris": [],
    "fileStates": {}, "fileStatesV2": {}, "summaryArchives": [],
    "turnTimings": [], "subagentStates": {}, "selfSummaryCount": 0, "readPaths": []
  },
  "action": {
    "userMessageAction": {
      "userMessage": { "text": "say OK", "messageId": "<uuid>", "mode": 0 }
    }
  },
  "modelDetails": {
    "modelId": "composer-2.5", "displayModelId": "composer-2.5", "displayName": "Composer 2.5"
  },
  "requestedModel": {
    "modelId": "composer-2.5", "maxMode": false,
    "parameters": [{ "id": "fast", "value": "false" }]
  },
  "conversationId": "<uuid>"
}
```

Multi-turn: the server streams `conversationCheckpointUpdate` (a whole
`ConversationStateStructure`); cache it per conversation and send it back as
`conversationState` on the next request. The turn contents stay opaque blobs, so the client
never has to model Cursor's message history itself.

`requestedModel.parameters` carries reasoning effort. Model ids ending in an effort suffix
(`claude-opus-5-high`) are split into a base `modelId` plus parameters before sending.

## Response stream

`AgentServerMessage.interactionUpdate` is the oneof that matters for Chat:

| variant | meaning |
|---|---|
| `textDelta { text }` | assistant token(s) |
| `thinkingDelta { text }` | reasoning token(s) |
| `thinkingCompleted { thinkingDurationMs }` | end of reasoning block |
| `tokenDelta { tokens }` | running output token count |
| `heartbeat {}` | keepalive, ignore |
| `turnEnded {}` | turn complete |
| `toolCallStarted` / `toolCallCompleted` | only when tools were offered |

## Schema

All 571 `agent.v1` messages are embedded in the omp binary as descriptor literals of the
form `V("agent.v1.Name", [{ no, name, kind, repeat?, optional?, T }])`. To regenerate a
`.proto` from a given omp build:

```sh
strings -n 4 "$(readlink -f "$(which omp)")" > omp.strings
# descriptors live in one contiguous block; find its bounds with:
grep -n 'V("agent\.v1\.' omp.strings | head -1
grep -n 'V("agent\.v1\.' omp.strings | tail -1
```

then evaluate the block with `V = (name, fields) => ({name, fields})` and walk the
`T: () => Var` thunks to resolve message references. Enum types are not in the block; they
are plain `int32` on the wire.

## Debugging against omp

`omp` has a wire tracer that is worth more than reading its code:

```sh
DEBUG_CURSOR=2 DEBUG_CURSOR_LOG=/tmp/wire.jsonl \
  omp -p --no-tools --no-session --no-skills --model cursor/composer-2.5 "say OK"
```

Every client and server frame lands in `wire.jsonl` as decoded JSON, including the full
`AgentRunRequest` under `subtype: "builtRunRequest"`.

## Terms of service

Cursor's terms cover use through their own clients. This adapter presents itself as the
Cursor CLI against a subscription the user pays for. That is the user's call to make; it is
recorded here so the trade-off is not rediscovered as a surprise.
