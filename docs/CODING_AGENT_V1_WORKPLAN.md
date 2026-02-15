# Coding-Agent V1 Workplan

## Context

GSV currently exposes `shell.exec` capability via the node `Bash` tool, but execution is synchronous and single-shot.  
To support coding-agent workflows (Codex/Claude/OpenCode/Pi), we need an async execution lifecycle:

- start command
- optionally return early (background/yield)
- monitor/interact with running process
- receive completion signal later
- wake/continue the owning session when completion arrives

This V1 focuses on that lifecycle only.

## Goal (V1)

Make coding-agent sessions operational in GSV with:

1. async `shell.exec` contract on nodes
2. background process control (`process` tool)
3. node -> gateway completion events
4. gateway -> session wake/continuation on completion

## Non-goals (for V1)

- Elevated/approval/security host execution modes
- Package manager/install orchestration
- Full OpenClaw parity (allowlists/env/os gates beyond current skill probe path)
- Renaming `Bash` tool to `Exec` (compat rename can happen later)

## Units of Work

### 1. Protocol: Async Exec Event Surface

Add protocol types/methods for node-originated async exec lifecycle events.

- New gateway RPC method: `node.exec.event`
- Payload includes:
  - process `sessionId`
  - lifecycle `event` (`started`, `finished`, `failed`, `timed_out`)
  - optional `exitCode`, `signal`, `outputTail`, timestamps
- Allow only `mode=node` callers to invoke this method

Why: completion cannot rely on in-memory callbacks in a distributed DO system.

### 2. CLI: `shell.exec` V1 Async Contract (Bash Tool)

Extend node `Bash` tool arguments/results:

- Args: `background?: boolean`, `yieldMs?: number`, `pty?: boolean` (PTY optional in first pass if blocked by deps)
- Result details:
  - sync completion: `{ status: "completed" | "failed", ... }`
  - running/background: `{ status: "running", sessionId, pid?, startedAt, tail? }`

Behavior:

- If `background=true`, return immediately with running status
- If `yieldMs` is set, wait up to that duration then background if still running
- Keep process registry for running/finished sessions with TTL cleanup
- Emit `node.exec.event` on exit for backgrounded sessions

### 3. CLI: Process Control Tool

Add a `process` tool for background sessions:

- `list`, `poll`, `log`, `write`, `submit`, `kill` (minimum set)
- Operates on `sessionId` returned by async `Bash`
- Supports incremental log retrieval and stdin interaction for interactive CLIs

Why: coding-agent CLIs need follow-up interaction and monitoring.

### 4. Gateway: Async Session Routing & Persistence

Persist mapping for async exec sessions:

- Keyed by node + process `sessionId`
- Value includes originating GSV `sessionKey`, source tool call id, created/updated timestamps

Flow:

- On `tool.result` with `status:"running"`, register async session mapping
- On `node.exec.event`, resolve mapping and route completion to owning session
- Keep retry-safe/idempotent handling (ignore unknown or already-closed mappings)
- Add TTL/GC via DO alarm

Why: DO hibernation/eviction requires persisted routing state.

### 5. Session: Completion Ingestion + Wake/Continue

Add session-side API to ingest async exec completion events.

Expected behavior:

- Persist an internal tool/system event message with completion details
- If run is idle, start a continuation turn
- If run is active, queue follow-up event for next turn
- No in-memory promise maps

Why: completion may arrive long after original tool call resolved.

### 6. Tests

Add/extend E2E coverage for:

- background `Bash` returns running result with `sessionId`
- `process` tool can inspect running/finished state
- node completion event wakes/continues owning session
- reconnect/DO hibernation-safe routing behavior (state persists)
- stale async session mapping GC

## Initial Sequencing

1. Protocol + gateway handler skeleton (`node.exec.event`)
2. CLI async `Bash` + process registry
3. CLI `process` tool
4. Gateway persisted async mapping + routing
5. Session event ingestion/continuation API
6. E2E pass and hardening

## Known Risks

- PTY support in Rust may require additional crate integration and platform handling.
- Session continuation semantics must avoid duplicate runs if multiple completion events arrive.
- Existing `toolMs` timeout behavior should not regress normal synchronous tools.

