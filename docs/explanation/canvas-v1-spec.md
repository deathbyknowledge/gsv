# Canvas V1 Specification

## Status

Draft v1

## Summary

Canvas is a persistent, interactive task surface in GSV. A canvas is rendered in UI (HTML/JS), but privileged behavior is defined declaratively and executed server-side through existing Gateway and tool dispatch paths.

Core v1 decision:

- No dedicated Canvas Durable Object in v1.
- Canvas state and assets live in R2.
- Gateway remains the authoritative realtime router and executor.
- Canvas actions are mostly equivalent to tool calls.

## Goals

1. Add a persistent non-chat task surface for agent/user operations.
2. Reuse existing tooling model (`gsv__*`, `{nodeId}__*`) instead of inventing a second execution system.
3. Keep action execution deterministic and low-latency by default (no mandatory LLM hop).
4. Preserve optional intelligent path (route action into session/agent loop when needed).
5. Fit current WS protocol model (`req`/`res`/`evt`) and current Gateway singleton architecture.

## Non-goals (v1)

1. No direct browser JS -> privileged tool execution.
2. No arbitrary server-side JS execution for action handlers.
3. No per-canvas Durable Object lifecycle.
4. No multi-tenant sharing model beyond existing Gateway auth scope.
5. No full low-code visual builder in v1.

## Core Concepts

### Canvas

A durable object model with:

1. Descriptor (identity + metadata)
2. State (JSON data model)
3. Optional assets (HTML/CSS/JS)
4. Action registry (declarative action definitions)
5. View bindings (which clients currently display it)

### Action

A named, declarative operation triggered by UI events. Action definitions live in canvas spec/state and are executed by Gateway.

Action types in v1:

1. `tool.call` (default path)
2. `session.send` (optional intelligent path)
3. `state.patch` (local state mutation only)

### Program Model

The "program" is:

1. UI markup (`index.html` + optional `index.js`) for rendering.
2. Declarative action definitions and bindings.
3. State bindings (`data-gsv-*` attributes or equivalent SDK hooks).

The model does not need to learn a large custom action catalog; it reuses known tool names and schemas.

## Architecture

### Control plane ownership

1. Gateway DO is the source of truth for canvas action execution and realtime fanout.
2. Session DO is used optionally for intelligent or multi-step action handling (`session.send` path).
3. R2 stores persistent descriptor/state/assets.

### Why no Canvas DO in v1

1. Keeps one websocket/auth entrypoint (`/ws` to Gateway).
2. Avoids token handoff and direct client->Canvas DO auth complexity.
3. Reuses existing Gateway registries, event delivery, and tool routing.
4. Simplifies rollout and operability.

Canvas DO can be revisited if usage requires hotspot isolation or very high per-canvas event throughput.

## Storage Layout (R2)

Under agent scope:

```text
agents/{agentId}/canvases/{canvasId}/
  descriptor.json
  spec.json
  state/latest.json
  assets/index.html
  assets/index.js
  assets/...
  events/{timestamp}-{eventId}.json  (optional/audit, v1 optional)
```

Descriptor and state are first-class. Assets are optional.

## Data Model

### Descriptor

```json
{
  "canvasId": "deploy-prod",
  "agentId": "main",
  "title": "Deploy Cockpit",
  "ownerSessionKey": "agent:main:main",
  "mode": "html",
  "entryAsset": "assets/index.html",
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000,
  "revision": 1
}
```

### CanvasSpec (v1)

```json
{
  "version": 1,
  "mode": "html",
  "toolPolicy": {
    "allow": ["server-a__Bash", "server-a__Read", "gsv__LogsGet"]
  },
  "state": {
    "service": "api",
    "version": "1.2.7",
    "logsTail": null,
    "lastDeploy": null
  },
  "actions": {
    "deploy": {
      "kind": "tool.call",
      "tool": "server-a__Bash",
      "args": {
        "command": "./deploy {{state.service}} {{state.version}}"
      },
      "saveAs": "lastDeploy",
      "confirm": "always",
      "timeoutMs": 120000
    },
    "refreshLogs": {
      "kind": "tool.call",
      "tool": "server-a__Bash",
      "args": {
        "command": "journalctl -u {{state.service}} -n 80"
      },
      "saveAs": "logsTail"
    },
    "assistantPlan": {
      "kind": "session.send",
      "message": "Given current rollout state, propose next safe steps and risks.",
      "saveAs": "assistant.plan"
    },
    "setDeploying": {
      "kind": "state.patch",
      "patch": [
        { "op": "replace", "path": "/status", "value": "deploying" }
      ]
    }
  },
  "bindings": {
    "buttons.deployNow": "deploy",
    "buttons.refreshLogs": "refreshLogs"
  },
  "refresh": [
    {
      "id": "pollLogs",
      "everyMs": 30000,
      "action": "refreshLogs",
      "enabled": true
    }
  ]
}
```

## Action Types

### `tool.call`

Executes a tool through existing Gateway tool dispatch path.

Required fields:

1. `kind: "tool.call"`
2. `tool`
3. `args` (optional)

Optional fields:

1. `saveAs`: dot-path in canvas state where raw result is stored.
2. `confirm`: `auto` | `always` | `never`.
3. `timeoutMs`.

### `session.send`

Routes a message into a session for LLM-driven handling.

Required fields:

1. `kind: "session.send"`
2. `message`

Optional fields:

1. `sessionKey` (defaults to descriptor owner session).
2. `saveAs`.

### `state.patch`

Applies state mutations without tool execution.

Required fields:

1. `kind: "state.patch"`
2. `patch` (JSON Patch-like operations subset)

Supported ops in v1:

1. `add`
2. `replace`
3. `remove`

## Templating

`tool.call.args` and `session.send.message` support simple interpolation:

1. `{{state.path}}` from canvas state
2. `{{input.path}}` from action trigger payload
3. `{{runtime.now}}` server timestamp

Rules:

1. String substitution only in v1.
2. Missing values resolve to empty string unless `required` is declared (future).
3. No eval or script execution in templates.

## UI Programming Model

### HTML

Canvas UI may be plain HTML with declarative hooks:

1. `data-gsv-action="deploy"` to trigger an action ID
2. `data-gsv-text="state.logsTail.result"` to bind text
3. `data-gsv-model="state.version"` for input binding

### JS

Optional `index.js` is allowed for presentation behavior only.

Exposed browser API (v1 minimal):

1. `window.gsvCanvas.getState()`
2. `window.gsvCanvas.subscribe(listener)`
3. `window.gsvCanvas.runAction(actionId, input?)`

JS cannot invoke privileged tools directly. Privileged operations must go through declarative actions resolved and executed by Gateway.

## API Surface (Gateway RPC)

Add methods:

1. `canvas.list`
2. `canvas.get`
3. `canvas.create`
4. `canvas.upsert`
5. `canvas.patch`
6. `canvas.delete`
7. `canvas.open`
8. `canvas.close`
9. `canvas.action`

Suggested payload examples:

```json
{ "method": "canvas.list", "params": { "agentId": "main" } }
```

```json
{
  "method": "canvas.action",
  "params": {
    "canvasId": "deploy-prod",
    "actionId": "deploy",
    "input": {},
    "expectedRevision": 7
  }
}
```

## Events

Gateway emits:

1. `canvas.updated`
2. `canvas.view.updated`
3. `canvas.action.started`
4. `canvas.action.finished`
5. `canvas.action.failed`

Event payload includes:

1. `canvasId`
2. `revision`
3. `changedPaths` (when available)
4. action metadata (`actionId`, `eventId`, timestamps)

## Execution Flow

### Tool path (default)

1. UI triggers `canvas.action`.
2. Gateway loads descriptor/spec/state.
3. Gateway validates action and policy (`toolPolicy.allow`).
4. Gateway resolves templates against state/input/runtime.
5. Gateway executes via existing tool dispatch.
6. Gateway stores result into state (`saveAs`) and increments `revision`.
7. Gateway emits `canvas.updated` and action completion events.

### Session path (optional)

1. UI triggers action with `kind=session.send`.
2. Gateway sends message to target session (`chatSend` path).
3. Session loop handles model/tooling.
4. Result can be persisted into canvas state via `saveAs` or follow-up canvas patch.

## Concurrency and Revisioning

1. Every state mutation increments monotonic `revision`.
2. Mutating calls accept `expectedRevision`.
3. If mismatch, return conflict and current revision.
4. Clients resync via `canvas.get`.

## Security

### Policy

1. Per-canvas allowlist for tool names.
2. Optional required confirmation level per action.
3. Gateway-side enforcement for every action execution.

### Browser boundary

1. No direct tool invocation from browser JS.
2. No server-side execution of arbitrary user JS.
3. Asset path resolution must deny traversal.

### Auditability

Action execution records should include:

1. actor (`clientId` or `sessionKey`)
2. action ID
3. resolved tool name
4. started/ended timestamps
5. success/failure summary

## Native Tool for Agent Authoring

Add one native tool family:

1. `gsv__Canvas`

Operations:

1. `upsert`
2. `get`
3. `list`
4. `open`
5. `close`
6. `patchState`

This keeps new tool surface minimal. Existing tool catalog remains primary for execution.

## Example: Minimal HTML Canvas

```html
<!doctype html>
<html>
  <body>
    <h1 data-gsv-text="state.service"></h1>
    <input data-gsv-model="state.version" />
    <button data-gsv-action="deploy">Deploy</button>
    <button data-gsv-action="refreshLogs">Refresh Logs</button>
    <pre data-gsv-text="state.logsTail.result"></pre>
  </body>
</html>
```

## Rollout Plan

### Phase 0

1. Spec + types + storage contracts
2. No rendering/runtime yet

### Phase 1

1. CRUD RPC (`list/get/create/upsert/patch/delete`)
2. R2 descriptor/spec/state persistence
3. Basic web renderer route and `canvas.updated` fanout

### Phase 2

1. `canvas.action` execution for `tool.call` + `state.patch`
2. Policy enforcement and revision checks
3. Result-to-state persistence via `saveAs`

### Phase 3

1. `session.send` action path
2. periodic refresh jobs
3. richer UI helper SDK and diagnostics

## Open Questions

1. Should `saveAs` support merge strategies (`replace`, `merge`, `append`) in v1?
2. Which actions require hard confirmation by default based on tool capability?
3. Should action audit logs be mandatory in v1 or deferred to v1.1?

## Acceptance Criteria (v1)

1. Agent can create canvas with state + actions.
2. UI can render canvas and trigger action by ID.
3. Gateway executes allowed tool action without LLM hop.
4. Action result is persisted into state and broadcast live.
5. JS cannot bypass action policy to run tools directly.
6. Canvas persists across reconnects and session resets.
